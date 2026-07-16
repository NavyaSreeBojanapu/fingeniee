/**
 * db.js
 * -----
 * SQLite setup for the FinGenie backend, using better-sqlite3
 * (synchronous, zero-config, single-file database — good fit for
 * a small Express API like this one).
 *
 * The DB file path is read from .env (DB_PATH), defaulting to
 * ./fingenie.db if not set.
 */

require('dotenv').config();
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'fingenie.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL'); // better concurrent read/write behavior

/* ------------------------------------------------------------------ */
/*  Schema                                                             */
/* ------------------------------------------------------------------ */

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    username     TEXT PRIMARY KEY,
    passwordHash TEXT NOT NULL,
    question     TEXT NOT NULL,
    answerHash   TEXT NOT NULL,
    createdAt    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token     TEXT PRIMARY KEY,
    username  TEXT NOT NULL,
    device    TEXT,
    location  TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    lastSeen  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS family_members (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    name     TEXT NOT NULL,
    role     TEXT NOT NULL,
    access   TEXT NOT NULL,
    initial  TEXT NOT NULL,
    color    TEXT NOT NULL
  );

  -- One row per user: the numbers shown on the dashboard overview.
  CREATE TABLE IF NOT EXISTS overview_stats (
    username         TEXT PRIMARY KEY,
    netMonthlyIncome REAL NOT NULL DEFAULT 85400,
    activeDebtBalance REAL NOT NULL DEFAULT 214000,
    savingsRunwayMonths REAL NOT NULL DEFAULT 6.2,
    stabilityIndex   INTEGER NOT NULL DEFAULT 68,
    FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
  );

  -- One row per family goal (kept singular for now; extend with a familyId
  -- column if you later support multiple families).
  CREATE TABLE IF NOT EXISTS family_goal (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    name    TEXT NOT NULL,
    target  REAL NOT NULL,
    current REAL NOT NULL
  );

  -- Every agent-console chat turn, so history survives restarts and can
  -- be scrolled back through per user.
  CREATE TABLE IF NOT EXISTS agent_messages (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    username  TEXT NOT NULL,
    agent     TEXT NOT NULL,
    message   TEXT,
    reply     TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
  );

  -- Stability index snapshots, one per calculation, so trends can be charted.
  CREATE TABLE IF NOT EXISTS stability_snapshots (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    username          TEXT NOT NULL,
    idx               INTEGER NOT NULL,
    verdict           TEXT NOT NULL,
    incomeConsistency INTEGER NOT NULL,
    expenseVolatility INTEGER NOT NULL,
    debtLoad          INTEGER NOT NULL,
    emergencyBuffer   INTEGER NOT NULL,
    note              TEXT,
    createdAt         TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
  );

  -- Money-leak scan results, one row per scan run.
  CREATE TABLE IF NOT EXISTS leak_scans (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    username  TEXT NOT NULL,
    leaksJson TEXT NOT NULL,
    total     REAL NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
  );

  -- Financial digital-twin projections, one row per "run projection".
  CREATE TABLE IF NOT EXISTS twin_projections (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    username     TEXT NOT NULL,
    savings      REAL NOT NULL,
    years        REAL NOT NULL,
    ratePercent  REAL NOT NULL,
    finalBalance REAL NOT NULL,
    pointsJson   TEXT NOT NULL,
    createdAt    TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
  );

  -- Loan document analyses, one row per uploaded document.
  CREATE TABLE IF NOT EXISTS loan_analyses (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    username        TEXT NOT NULL,
    filename        TEXT NOT NULL,
    sizeKb          REAL NOT NULL,
    flagsJson       TEXT NOT NULL,
    integrityScore  INTEGER NOT NULL,
    verdict         TEXT NOT NULL,
    createdAt       TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
  );

  -- Real audit-log events for the Privacy & Trust center (replaces the
  -- previously hardcoded "Jul 14 — New device sign-in" style strings).
  CREATE TABLE IF NOT EXISTS trust_events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    username  TEXT NOT NULL,
    event     TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
  );
`);

// Seed default family members only if the table is empty, so re-running
// the server doesn't duplicate rows.
const familyCount = db.prepare('SELECT COUNT(*) AS n FROM family_members').get().n;
if (familyCount === 0) {
  const insertMember = db.prepare(
    'INSERT INTO family_members (name, role, access, initial, color) VALUES (?, ?, ?, ?, ?)'
  );
  const seed = [
    { name: 'Priya', role: 'Parent', access: 'Full access', initial: 'P', color: '#4F7965' },
    { name: 'Arjun', role: 'Parent', access: 'Full access', initial: 'A', color: '#7B6DB0' },
    { name: 'Kavya', role: 'Teen', access: 'Restricted', initial: 'K', color: '#C9A227' },
  ];
  const insertMany = db.transaction((rows) => {
    for (const r of rows) insertMember.run(r.name, r.role, r.access, r.initial, r.color);
  });
  insertMany(seed);
}

const goalCount = db.prepare('SELECT COUNT(*) AS n FROM family_goal').get().n;
if (goalCount === 0) {
  db.prepare('INSERT INTO family_goal (name, target, current) VALUES (?, ?, ?)').run(
    'Family emergency fund', 300000, 186000
  );
}

/* ------------------------------------------------------------------ */
/*  Prepared statements (exported for reuse across routes)             */
/* ------------------------------------------------------------------ */

module.exports = {
  db,

  // users
  getUser: db.prepare('SELECT * FROM users WHERE username = ?'),
  createUser: db.prepare(
    'INSERT INTO users (username, passwordHash, question, answerHash) VALUES (?, ?, ?, ?)'
  ),

  // sessions
  createSession: db.prepare(
    'INSERT INTO sessions (token, username, device, location) VALUES (?, ?, ?, ?)'
  ),
  getSessionUser: db.prepare('SELECT username FROM sessions WHERE token = ?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  getSessionsForUser: db.prepare(
    'SELECT token, device, location, createdAt, lastSeen FROM sessions WHERE username = ? ORDER BY lastSeen DESC'
  ),

  // family members / goal
  getFamilyMembers: db.prepare('SELECT name, role, access, initial, color FROM family_members ORDER BY id'),
  addFamilyMember: db.prepare(
    'INSERT INTO family_members (name, role, access, initial, color) VALUES (?, ?, ?, ?, ?)'
  ),
  getFamilyGoal: db.prepare('SELECT name, target, current FROM family_goal ORDER BY id DESC LIMIT 1'),

  // overview stats
  getOverviewStats: db.prepare('SELECT * FROM overview_stats WHERE username = ?'),
  seedOverviewStats: db.prepare(
    'INSERT OR IGNORE INTO overview_stats (username) VALUES (?)'
  ),

  // agent console chat history
  addAgentMessage: db.prepare(
    'INSERT INTO agent_messages (username, agent, message, reply) VALUES (?, ?, ?, ?)'
  ),
  getAgentMessages: db.prepare(
    'SELECT agent, message, reply, createdAt FROM agent_messages WHERE username = ? ORDER BY id DESC LIMIT ?'
  ),

  // stability snapshots
  addStabilitySnapshot: db.prepare(
    `INSERT INTO stability_snapshots
      (username, idx, verdict, incomeConsistency, expenseVolatility, debtLoad, emergencyBuffer, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ),
  getLatestStability: db.prepare(
    'SELECT * FROM stability_snapshots WHERE username = ? ORDER BY id DESC LIMIT 1'
  ),

  // leak scans
  addLeakScan: db.prepare(
    'INSERT INTO leak_scans (username, leaksJson, total) VALUES (?, ?, ?)'
  ),
  getLeakScans: db.prepare(
    'SELECT leaksJson, total, createdAt FROM leak_scans WHERE username = ? ORDER BY id DESC LIMIT ?'
  ),

  // twin projections
  addTwinProjection: db.prepare(
    `INSERT INTO twin_projections
      (username, savings, years, ratePercent, finalBalance, pointsJson)
     VALUES (?, ?, ?, ?, ?, ?)`
  ),
  getTwinProjections: db.prepare(
    'SELECT * FROM twin_projections WHERE username = ? ORDER BY id DESC LIMIT ?'
  ),

  // loan analyses
  addLoanAnalysis: db.prepare(
    `INSERT INTO loan_analyses
      (username, filename, sizeKb, flagsJson, integrityScore, verdict)
     VALUES (?, ?, ?, ?, ?, ?)`
  ),
  getLoanAnalyses: db.prepare(
    'SELECT filename, sizeKb, flagsJson, integrityScore, verdict, createdAt FROM loan_analyses WHERE username = ? ORDER BY id DESC LIMIT ?'
  ),

  // trust events
  addTrustEvent: db.prepare('INSERT INTO trust_events (username, event) VALUES (?, ?)'),
  getTrustEvents: db.prepare(
    'SELECT event, createdAt FROM trust_events WHERE username = ? ORDER BY id DESC LIMIT ?'
  ),

  // admin: aggregate real counts instead of hardcoded numbers
  countUsers: db.prepare('SELECT COUNT(*) AS n FROM users'),
  countLoanAnalyses: db.prepare('SELECT COUNT(*) AS n FROM loan_analyses'),
  listUsersForAdmin: db.prepare(`
    SELECT u.username AS user,
           (SELECT COUNT(*) FROM loan_analyses la WHERE la.username = u.username AND la.integrityScore < 80) AS flags,
           (SELECT MAX(lastSeen) FROM sessions s WHERE s.username = u.username) AS lastActive
    FROM users u
    ORDER BY u.createdAt DESC
  `),
};