/**
 * FinGenie backend
 * -----------------
 * Plain Node.js + Express API server. Everything that used to live as
 * localStorage / Math.random() logic inside the single HTML file now
 * lives here instead, behind a small REST API that the frontend calls
 * with fetch().
 *
 * Run:
 *   cd backend
 *   npm install
 *   npm start        (listens on http://localhost:4000)
 */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const {
  getUser,
  createUser,
  createSession,
  getSessionUser,
  deleteSession,
  getSessionsForUser,
  getFamilyMembers,
  addFamilyMember,
  getFamilyGoal,
  getOverviewStats,
  seedOverviewStats,
  addAgentMessage,
  getAgentMessages,
  addStabilitySnapshot,
  getLatestStability,
  addLeakScan,
  getLeakScans,
  addTwinProjection,
  addLoanAnalysis,
  addTrustEvent,
  getTrustEvents,
  countUsers,
  listUsersForAdmin,
} = require('./db');
const { isConfigured: aiConfigured, chatReply, chatJSON } = require('./claude');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// Serve the frontend (index.html, styles.css, app.js) from this same folder,
// so the whole site runs from one server on one port.
app.use(express.static(__dirname));

/* ------------------------------------------------------------------ */
/*  Everything user-facing now lives in SQLite (see db.js):            */
/*  users, sessions, family_members, family_goal, overview_stats,      */
/*  agent_messages, stability_snapshots, leak_scans, twin_projections, */
/*  loan_analyses, trust_events.                                       */
/*                                                                     */
/*  What stays as static, in-memory content: the canned agent reply   */
/*  pools and debate scripts below — these are fixed "content"        */
/*  (like copy on a page), not per-user data, so a DB table would     */
/*  add nothing. If you want editable agent scripts later, those      */
/*  could become a `content` table too.                                */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function sha256(text) {
  return crypto.createHash('sha256').update(String(text).trim().toLowerCase()).digest('hex');
}

function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

function maskUsername(u) {
  if (u.length <= 2) return u[0] + '•••';
  return u[0] + '•'.repeat(Math.max(3, u.length - 2)) + u[u.length - 1];
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const row = token && getSessionUser.get(token);
  if (!row) return res.status(401).json({ ok: false, error: 'Not authenticated.' });
  req.username = row.username;
  next();
}

const passwordRules = (pass) => ({
  len: pass.length >= 8,
  letter: /[a-zA-Z]/.test(pass),
  number: /[0-9]/.test(pass),
  special: /[@!#$%^&*()_\-+=[\]{};:'",.<>/?\\|`~]/.test(pass),
});

const questionText = {
  school: 'What was the name of your first school?',
  city: 'What city were you born in?',
  pet: 'What was the name of your first pet?',
};

/* ------------------------------------------------------------------ */
/*  Auth routes                                                        */
/* ------------------------------------------------------------------ */

app.post('/api/auth/register', (req, res) => {
  const { username, password, question, answer } = req.body || {};
  if (!username || !password || !answer) {
    return res.status(400).json({ ok: false, error: 'Fill in username, password, and a recovery answer.' });
  }
  const rules = passwordRules(password);
  if (!(rules.len && rules.letter && rules.number && rules.special)) {
    return res.status(400).json({ ok: false, error: 'Password needs 8+ characters, a letter, a number, and @ or a special character.' });
  }
  if (getUser.get(username)) {
    return res.status(409).json({ ok: false, error: 'That username is already registered.' });
  }
  createUser.run(username, sha256(password), question || 'school', sha256(answer));
  seedOverviewStats.run(username);
  addTrustEvent.run(username, 'Account created');
  res.json({ ok: true, message: 'Account created — password and answer stored only as SHA-256 hashes.' });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const record = getUser.get(username);
  if (!record) return res.status(404).json({ ok: false, error: 'No account found — create one first.' });
  if (sha256(password) !== record.passwordHash) {
    return res.status(401).json({ ok: false, error: 'Incorrect password.' });
  }
  const token = newToken();
  const device = req.headers['user-agent'] || 'Unknown device';
  const location = req.ip || 'Unknown location';
  createSession.run(token, username, device, location);
  addTrustEvent.run(username, 'Signed in');
  res.json({ ok: true, token, username, maskedUsername: maskUsername(username) });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.slice(7);
  deleteSession.run(token);
  addTrustEvent.run(req.username, 'Signed out');
  res.json({ ok: true });
});

app.post('/api/auth/recover/question', (req, res) => {
  const { username } = req.body || {};
  const record = getUser.get(username);
  if (!record) return res.status(404).json({ ok: false, error: `No account found for "${username}" on this server.` });
  res.json({ ok: true, question: questionText[record.question] });
});

app.post('/api/auth/recover/verify', (req, res) => {
  const { username, answer } = req.body || {};
  const record = getUser.get(username);
  if (!record) return res.status(404).json({ ok: false, error: 'No account found.' });
  const match = sha256(answer) === record.answerHash;
  res.json({
    ok: match,
    message: match
      ? 'Verified. In production this would issue a short-lived reset token (~5 minutes) instead of showing your password directly.'
      : 'That answer does not match our records. Try again, or contact support.',
  });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ ok: true, username: req.username, maskedUsername: maskUsername(req.username) });
});

/* ------------------------------------------------------------------ */
/*  Dashboard overview                                                  */
/* ------------------------------------------------------------------ */

app.get('/api/overview', requireAuth, (req, res) => {
  seedOverviewStats.run(req.username); // safety net for accounts created before this table existed
  const row = getOverviewStats.get(req.username);
  const mask = (s) => s.replace(/[0-9]/g, '•');
  const income = `₹${row.netMonthlyIncome.toLocaleString('en-IN')}`;
  const debt = `₹${row.activeDebtBalance.toLocaleString('en-IN')}`;
  const runway = `${row.savingsRunwayMonths} mo`;
  const stability = `${row.stabilityIndex} / 100`;
  res.json({
    ok: true,
    stats: {
      netMonthlyIncome: { real: income, masked: mask(income) },
      activeDebtBalance: { real: debt, masked: mask(debt) },
      savingsRunway: { real: runway, masked: mask(runway) },
      stabilityIndex: { real: stability, masked: mask(stability) },
    },
  });
});

/* ------------------------------------------------------------------ */
/*  Agent console (chat)                                                */
/* ------------------------------------------------------------------ */

const agentNames = {
  budget: 'Budgeting Agent',
  debt: 'Debt Agent',
  savings: 'Savings Agent',
  loan: 'Legal / Loan Agent',
  tax: 'Taxation Agent',
};

const agentReplies = {
  budget: [
    "Your fixed costs take up about 54% of income this month. There's roughly ₹9,200 of flexible spend left before your savings target is at risk.",
    'Discretionary spending is up 12% versus last month — dining and subscriptions are driving it.',
  ],
  debt: [
    "You're carrying three open balances. Paying the highest-interest one first would save an estimated ₹4,300 in interest over the next year.",
    'Your debt-to-income ratio sits at 38% — lenders get cautious above 43%, so you have some cushion.',
  ],
  savings: [
    "At your current pace you'll rebuild a 9-month runway in about 5 months. Shifting half your dining budget would shorten that by three weeks.",
    'Your savings rate is 14% of net income. A 20% target is realistic if dining comes down.',
  ],
  loan: [
    'I reviewed the uploaded agreement: clause 4.2 allows a 3% prepayment penalty, above the usual ceiling for this loan category.',
    "No document is loaded yet — open the Loan Analyzer and I'll walk through the fine print with you.",
  ],
  tax: [
    'Routing an extra ₹12,000 into a tax-saving instrument before year end could reduce your liability by roughly ₹3,600.',
    'Your current deductions cover about 60% of what you are eligible to claim — there is room to optimise.',
  ],
};

app.post('/api/agents/chat', requireAuth, async (req, res) => {
  const { agent, message } = req.body || {};
  const agentKey = agent || 'budget';
  const label = agentNames[agentKey] || 'Agent';

  let reply;
  if (aiConfigured && message) {
    try {
      seedOverviewStats.run(req.username);
      const stats = getOverviewStats.get(req.username);
      const systemPrompt =
        `You are the ${label} for FinGenie, a personal finance app for Indian users. ` +
        `User's net monthly income: ₹${stats.netMonthlyIncome}, active debt: ₹${stats.activeDebtBalance}, ` +
        `savings runway: ${stats.savingsRunwayMonths} months, stability index: ${stats.stabilityIndex}/100. ` +
        `Answer the user's question in 2-4 sentences, concrete and specific, using ₹ figures where relevant. ` +
        `Stay strictly within the ${label}'s domain.`;
      reply = await chatReply(systemPrompt, message);
    } catch (err) {
      console.error('Claude agent chat failed, falling back to canned reply:', err.message);
    }
  }

  if (!reply) {
    const pool = agentReplies[agentKey] || agentReplies.budget;
    reply = pool[Math.floor(Math.random() * pool.length)];
  }

  addAgentMessage.run(req.username, agentKey, message || null, reply);
  res.json({ ok: true, agent: agentKey, agentLabel: label, reply });
});

app.get('/api/agents/history', requireAuth, (req, res) => {
  const limit = Number(req.query.limit) || 50;
  const rows = getAgentMessages.all(req.username, limit);
  res.json({ ok: true, messages: rows.reverse() }); // oldest first for display
});

/* ------------------------------------------------------------------ */
/*  AI debate room                                                      */
/* ------------------------------------------------------------------ */

const debateScripts = {
  prepay: {
    a: [
      "Investing the surplus in a diversified index fund at ~11% historical return beats your loan's 9% interest over a 10-year horizon.",
      "Even after tax drag, the growth agent's math favors investing for anyone with more than 5 years left on the loan.",
    ],
    b: [
      'A guaranteed 9% return from prepayment beats an uncertain 11% market return — markets do not move in a straight line.',
      'Prepaying also frees up monthly cash flow immediately, which matters if income is variable.',
    ],
    verdict: 'Verdict: if your emergency fund is already solid and the loan has 5+ years left, lean toward investing the surplus — otherwise, split it 50/50.',
  },
  rent: {
    a: [
      'Renting keeps capital liquid for higher-return investments and avoids maintenance costs and property tax drag.',
      'Renting gives you mobility — valuable if your job market or family situation might change in the next 3-5 years.',
    ],
    b: [
      'Buying builds forced equity and shields you from rent inflation over a 15-20 year horizon.',
      'A stable job and a 7+ year time horizon usually make ownership the lower lifetime-cost option.',
    ],
    verdict: 'Verdict: under a 5-year horizon, renting usually wins on flexibility; beyond 7 years in one city, ownership tends to win on total cost.',
  },
  rate: {
    a: [
      'A floating rate has historically cost less over the life of a loan, since it tracks the market average rather than a locked-in premium.',
      'If rates are near a cyclical high right now, floating gives you room to benefit when they ease.',
    ],
    b: [
      'A fixed rate protects your budget from shocks — critical if your income is tight relative to the EMI.',
      "Predictability has real value: it's easier to plan around a number that never moves.",
    ],
    verdict: 'Verdict: choose fixed if your monthly budget has little slack; choose floating if you have a buffer and the current rate cycle looks elevated.',
  },
};

app.get('/api/debate/:topic', requireAuth, async (req, res) => {
  const topicKey = req.params.topic;
  const canned = debateScripts[topicKey];

  if (aiConfigured) {
    try {
      const topicLabel = canned ? topicKey : topicKey.replace(/[-_]/g, ' ');
      const systemPrompt =
        `You are simulating a financial debate between two agents, Agent A and Agent B, arguing opposite ` +
        `sides of a personal-finance decision for an Indian user. Return ONLY a JSON object, no markdown, ` +
        `no prose outside the JSON, shaped exactly like: ` +
        `{"a": ["point 1", "point 2"], "b": ["point 1", "point 2"], "verdict": "Verdict: ..."}. ` +
        `Each point should be one concrete sentence. The verdict should be a single balanced sentence.`;
      const script = await chatJSON(systemPrompt, `Debate topic: ${topicLabel}`);
      return res.json({ ok: true, script });
    } catch (err) {
      console.error('Claude debate generation failed, falling back:', err.message);
    }
  }

  if (!canned) return res.status(404).json({ ok: false, error: 'Unknown debate topic.' });
  res.json({ ok: true, script: canned });
});

/* ------------------------------------------------------------------ */
/*  Family workspace                                                    */
/* ------------------------------------------------------------------ */

app.get('/api/family', requireAuth, (req, res) => {
  res.json({
    ok: true,
    members: getFamilyMembers.all(),
    goal: getFamilyGoal.get(),
  });
});

app.post('/api/family/invite', requireAuth, (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ ok: false, error: 'Enter an email to invite.' });
  const member = { name: email, role: 'Invited', access: 'Invitation sent', initial: email[0].toUpperCase(), color: 'var(--gold)' };
  addFamilyMember.run(member.name, member.role, member.access, member.initial, member.color);
  res.json({ ok: true, member });
});

/* ------------------------------------------------------------------ */
/*  Financial Stability Engine                                          */
/* ------------------------------------------------------------------ */

app.get('/api/stability', requireAuth, async (req, res) => {
  let snap = getLatestStability.get(req.username);
  if (!snap) {
    let note = 'Expense volatility is your biggest drag this quarter — dining and subscription spend swing widely month to month.';
    const metrics = { incomeConsistency: 81, expenseVolatility: 54, debtLoad: 62, emergencyBuffer: 73 };

    if (aiConfigured) {
      try {
        const systemPrompt =
          `You are the Financial Stability Engine for a personal finance app. Given these 0-100 metrics for a ` +
          `user (higher is better, except note debtLoad/expenseVolatility where lower is healthier), write ONE ` +
          `sentence identifying the biggest drag on their stability and a concrete next step. Plain text only, no JSON.`;
        note = await chatReply(systemPrompt, JSON.stringify(metrics), 120);
      } catch (err) {
        console.error('Claude stability note failed, falling back:', err.message);
      }
    }

    addStabilitySnapshot.run(
      req.username, 68, 'Moderately stable',
      metrics.incomeConsistency, metrics.expenseVolatility, metrics.debtLoad, metrics.emergencyBuffer,
      note
    );
    snap = getLatestStability.get(req.username);
  }
  res.json({
    ok: true,
    index: snap.idx,
    verdict: snap.verdict,
    metrics: {
      incomeConsistency: snap.incomeConsistency,
      expenseVolatility: snap.expenseVolatility,
      debtLoad: snap.debtLoad,
      emergencyBuffer: snap.emergencyBuffer,
    },
    note: snap.note,
  });
});

/* ------------------------------------------------------------------ */
/*  Money leak detector                                                 */
/* ------------------------------------------------------------------ */

app.post('/api/leak-scan', requireAuth, async (req, res) => {
  const { transactions } = req.body || {}; // optional: array of {desc, amount, date} the frontend can send
  let leaks;

  if (aiConfigured && Array.isArray(transactions) && transactions.length > 0) {
    try {
      const systemPrompt =
        `You are a money-leak detector for a personal finance app. Given a list of transactions, find ` +
        `recurring or wasteful charges (unused subscriptions, duplicate charges, fee creep, etc). Return ` +
        `ONLY a JSON object shaped exactly like: ` +
        `{"leaks": [{"name": "...", "detail": "...", "amt": 1234}]}. Amounts in ₹, integers. Max 5 leaks.`;
      const result = await chatJSON(systemPrompt, JSON.stringify(transactions));
      leaks = result.leaks;
    } catch (err) {
      console.error('Claude leak scan failed, falling back to demo leaks:', err.message);
    }
  }

  if (!leaks) {
    leaks = [
      { name: 'Unused streaming subscription', detail: 'No activity in 4 months', amt: 499 * 12 },
      { name: 'Duplicate insurance premium', detail: 'Charged on two linked cards', amt: 2400 },
      { name: 'Bank maintenance fee creep', detail: 'Fee rose 3x without notice', amt: 1200 },
    ];
  }

  const total = leaks.reduce((sum, l) => sum + l.amt, 0);
  addLeakScan.run(req.username, JSON.stringify(leaks), total);
  res.json({ ok: true, leaks, total });
});

app.get('/api/leak-scan/history', requireAuth, (req, res) => {
  const limit = Number(req.query.limit) || 20;
  const rows = getLeakScans.all(req.username, limit).map((r) => ({
    leaks: JSON.parse(r.leaksJson),
    total: r.total,
    createdAt: r.createdAt,
  }));
  res.json({ ok: true, scans: rows });
});

/* ------------------------------------------------------------------ */
/*  Financial digital twin (compound-growth projection)                 */
/* ------------------------------------------------------------------ */

app.post('/api/twin/project', requireAuth, (req, res) => {
  const savings = Number(req.body?.savings) || 0;
  const years = Number(req.body?.years) || 1;
  const rate = (Number(req.body?.ratePercent) || 0) / 100;

  const months = years * 12;
  const monthlyRate = rate / 12;
  let balance = 0;
  const points = [];
  for (let m = 0; m <= months; m++) {
    balance = balance * (1 + monthlyRate) + savings;
    if (m % Math.max(1, Math.floor(months / 40)) === 0 || m === months) points.push(Number(balance.toFixed(2)));
  }

  const narrative = `Saving an extra ₹${savings.toLocaleString('en-IN')} a month at an assumed ${(rate * 100).toFixed(1)}% annual return grows to roughly ₹${Math.round(balance).toLocaleString('en-IN')} after ${years} years.`;

  addTwinProjection.run(
    req.username, savings, years, rate * 100, Math.round(balance), JSON.stringify(points)
  );

  res.json({
    ok: true,
    points,
    finalBalance: Math.round(balance),
    narrative,
  });
});

/* ------------------------------------------------------------------ */
/*  Loan document analyzer (mock clause-scanning)                       */
/* ------------------------------------------------------------------ */

app.post('/api/loan/analyze', requireAuth, async (req, res) => {
  const { filename, sizeKb, text } = req.body || {}; // frontend should extract text client-side and send it
  let flags, integrityScore, verdict;

  if (aiConfigured && text) {
    try {
      const systemPrompt =
        `You are a loan document analyzer for a personal finance app. Read the loan/agreement text and find ` +
        `clauses that are unfavorable, unusually costly, or vaguely worded (penalties, fees, rate resets, ` +
        `lock-ins). Return ONLY a JSON object shaped exactly like: ` +
        `{"flags": [{"t": "Clause reference or short title", "d": "one sentence explanation"}], ` +
        `"integrityScore": 0-100, "verdict": "short verdict phrase"}. Max 6 flags.`;
      const result = await chatJSON(systemPrompt, text, 900);
      flags = result.flags;
      integrityScore = result.integrityScore;
      verdict = result.verdict;
    } catch (err) {
      console.error('Claude loan analysis failed, falling back to demo flags:', err.message);
    }
  }

  if (!flags) {
    flags = [
      { t: 'Clause 4.2', d: 'Prepayment penalty of 3% — above the typical regulatory ceiling for this loan category.' },
      { t: 'Clause 7.1', d: 'Processing fee described as "up to 2.5%" without a fixed figure.' },
      { t: 'Clause 9.4', d: 'Variable rate reset clause lacks a stated cap.' },
    ];
    integrityScore = 72;
    verdict = 'Suspicious clauses found';
  }

  addLoanAnalysis.run(
    req.username, filename || 'document.pdf', sizeKb || 0, JSON.stringify(flags), integrityScore, verdict
  );
  res.json({
    ok: true,
    filename: filename || 'document.pdf',
    sizeKb: sizeKb || 0,
    flags,
    integrityScore,
    verdict,
  });
});

/* ------------------------------------------------------------------ */
/*  Privacy & trust center                                              */
/* ------------------------------------------------------------------ */

app.get('/api/trust/sessions', requireAuth, (req, res) => {
  const header = req.headers.authorization || '';
  const currentToken = header.startsWith('Bearer ') ? header.slice(7) : null;
  const rows = getSessionsForUser.all(req.username).map((s) => ({
    device: s.device,
    location: s.location,
    lastActive: s.lastSeen,
    current: s.token === currentToken,
  }));
  res.json({ ok: true, sessions: rows });
});

app.get('/api/trust/events', requireAuth, (req, res) => {
  const limit = Number(req.query.limit) || 20;
  const rows = getTrustEvents.all(req.username, limit).map((e) => `${e.createdAt} — ${e.event}`);
  res.json({ ok: true, events: rows });
});

/* ------------------------------------------------------------------ */
/*  Admin panel                                                         */
/* ------------------------------------------------------------------ */

app.get('/api/admin/stats', requireAuth, (req, res) => {
  const activeUsers = countUsers.get().n;
  res.json({
    ok: true,
    stats: {
      activeUsers,
      docsAnalyzedToday: 312, // still a placeholder metric — no per-day rollup table yet
      flagsRaised: 57,        // same: would need a scheduled aggregation job to be real
      avgResponseTime: '1.8s',
    },
  });
});

app.get('/api/admin/users', requireAuth, (req, res) => {
  const rows = listUsersForAdmin.all().map((r) => ({
    user: r.user,
    flags: r.flags,
    lastActive: r.lastActive || 'Never',
    status: r.flags >= 3 ? 'Under review' : 'Active',
  }));
  res.json({ ok: true, users: rows });
});

/* ------------------------------------------------------------------ */

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'fingenie-backend' }));

app.listen(PORT, () => {
  console.log(`FinGenie backend listening on http://localhost:${PORT}`);
});