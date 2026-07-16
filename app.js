/* ==========================================================================
   FinGenie frontend
   ------------------
   All state that used to live in localStorage / inline mock data now comes
   from the backend REST API (see ../backend/server.js). This file only
   handles UI rendering, navigation, and fetch() calls.
   ========================================================================== */

const API_BASE = window.FINGENIE_API_BASE || '/api';

function authHeaders() {
  const token = localStorage.getItem('fingenie_token');
  return token ? { Authorization: 'Bearer ' + token } : {};
}

async function api(path, options = {}) {
  const res = await fetch(API_BASE + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

/* ---------------- Navigation ---------------- */
const validPages = ['overview','console','debate','family','stability','leak','twin','loan','trust','admin','account'];
function showPage(id, skipHash){
  if(!validPages.includes(id)) id = 'overview';
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.getElementById('page-'+id).classList.add('active');
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.toggle('active', n.dataset.page===id));
  window.scrollTo({top:0, behavior:'smooth'});
  if(!skipHash) location.hash = '/'+id;
  if(id==='overview') loadOverview();
  if(id==='family') loadFamily();
  if(id==='stability') loadStability();
  if(id==='trust') loadTrustCenter();
  if(id==='admin') loadAdminPanel();
  if(id==='account'){ document.getElementById('profileUser').textContent = currentMaskedUser || '—'; }
}
document.getElementById('sidebar').addEventListener('click', e=>{
  const item = e.target.closest('.nav-item');
  if(item) showPage(item.dataset.page);
});
window.addEventListener('hashchange', ()=>{
  if(document.getElementById('appShell').style.display==='none') return;
  const id = location.hash.replace('#/','') || 'overview';
  showPage(id, true);
});

/* ---------------- Reveal / mask toggle ---------------- */
let revealed = false;
function toggleReveal(){
  revealed = !revealed;
  document.querySelectorAll('.stat-value').forEach(el=>{ el.textContent = revealed ? el.dataset.real : el.dataset.masked; });
  document.getElementById('revealLabel').textContent = revealed ? 'Hide figures' : 'Reveal figures';
}

/* ---------------- Toast ---------------- */
function showToast(msg){
  const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(window._toastTimer); window._toastTimer = setTimeout(()=>t.classList.remove('show'), 2600);
}

/* ---------------- Overview (backend-driven) ---------------- */
async function loadOverview(){
  try{
    const { stats } = await api('/overview');
    const map = {
      netMonthlyIncome: 0, activeDebtBalance: 1, savingsRunway: 2, stabilityIndex: 3,
    };
    const cards = document.querySelectorAll('#page-overview .stat-value');
    Object.entries(map).forEach(([key, idx])=>{
      const el = cards[idx]; if(!el) return;
      el.dataset.real = stats[key].real;
      el.dataset.masked = stats[key].masked;
      el.textContent = revealed ? stats[key].real : stats[key].masked;
    });
  }catch(err){ /* not signed in yet, or backend unavailable */ }
}

/* ---------------- Agent console ---------------- */
let activeAgent = 'budget';
const agentNames = { budget:'Budgeting Agent', debt:'Debt Agent', savings:'Savings Agent', loan:'Legal / Loan Agent', tax:'Taxation Agent' };
document.getElementById('agentRail').addEventListener('click', e=>{
  const item = e.target.closest('.agent-item'); if(!item) return;
  document.querySelectorAll('.agent-item').forEach(i=>i.classList.remove('active'));
  item.classList.add('active'); activeAgent = item.dataset.agent;
});
function appendMsg(role, text, agentLabel){
  const log = document.getElementById('chatLog'); const div = document.createElement('div'); div.className = 'msg '+role;
  if(role==='agent'){ const tag = document.createElement('span'); tag.className='tag'; tag.textContent = agentLabel; div.appendChild(tag); }
  div.appendChild(document.createTextNode(text)); log.appendChild(div); log.scrollTop = log.scrollHeight;
}
async function sendChat(){
  const input = document.getElementById('chatInput'); const text = input.value.trim(); if(!text) return;
  appendMsg('user', text); input.value=''; const status = document.getElementById('consoleStatus');
  status.textContent = 'Status: '+agentNames[activeAgent]+' is analysing…';
  try{
    const { reply, agentLabel } = await api('/agents/chat', { method:'POST', body:{ agent: activeAgent, message: text } });
    appendMsg('agent', reply, agentLabel);
    speakText(reply, document.getElementById('langSelect').value);
  }catch(err){
    appendMsg('agent', 'Sorry — I could not reach the server (' + err.message + ').', agentNames[activeAgent]);
  }finally{
    status.textContent='Status: idle';
  }
}
document.getElementById('chatInput').addEventListener('keydown', e=>{ if(e.key==='Enter') sendChat(); });

/* ---------------- Voice ---------------- */
const micBtn = document.getElementById('micBtn');
let recognition = null;
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if(SR){ recognition = new SR(); recognition.interimResults = false; }
micBtn.addEventListener('click', ()=>{
  if(!recognition){ showToast('Voice recognition needs a Chromium-based browser with microphone permission.'); return; }
  if(window.speechSynthesis.speaking) window.speechSynthesis.cancel();
  recognition.lang = document.getElementById('langSelect').value;
  micBtn.classList.add('listening');
  document.getElementById('consoleStatus').textContent = 'Status: listening in '+recognition.lang+'…';
  recognition.start();
});
if(recognition){
  recognition.onresult = e=>{ document.getElementById('chatInput').value = e.results[0][0].transcript; sendChat(); };
  recognition.onerror = ()=>{ document.getElementById('consoleStatus').textContent = 'Status: could not hear that — try again.'; };
  recognition.onend = ()=>{ micBtn.classList.remove('listening'); };
}
function speakText(text, lang){ if(!('speechSynthesis' in window)) return; const u = new SpeechSynthesisUtterance(text); u.lang = lang; window.speechSynthesis.speak(u); }

/* ---------------- AI Debate Room (script fetched from backend) ---------------- */
async function startDebate(){
  const topic = document.getElementById('debateTopic').value;
  const colA = document.getElementById('debateA'); const colB = document.getElementById('debateB');
  colA.innerHTML=''; colB.innerHTML=''; document.getElementById('debateVerdict').style.display='none';
  let script;
  try{
    ({ script } = await api('/debate/'+topic));
  }catch(err){ showToast('Could not load debate script: '+err.message); return; }
  let delay = 0;
  script.a.forEach(line=>{ delay += 500; setTimeout(()=>{ const d=document.createElement('div'); d.className='debate-bubble'; d.textContent=line; colA.appendChild(d); }, delay); });
  delay = 250;
  script.b.forEach(line=>{ delay += 500; setTimeout(()=>{ const d=document.createElement('div'); d.className='debate-bubble'; d.textContent=line; colB.appendChild(d); }, delay); });
  setTimeout(()=>{ const v=document.getElementById('debateVerdict'); v.style.display='block'; v.textContent = script.verdict; }, delay+500);
}

/* ---------------- Family Workspace (backend-driven) ---------------- */
async function loadFamily(){
  try{
    const { members, goal } = await api('/family');
    const list = document.getElementById('familyList');
    list.innerHTML = members.map(m=>`
      <div class="family-row">
        <div style="display:flex; align-items:center; gap:10px;">
          <div class="avatar" style="background:${m.color};">${m.initial}</div>
          <div><div style="font-weight:600; font-size:13.5px;">${m.name} · ${m.role}</div><div style="font-size:12px; color:#8a8371;">${m.access}</div></div>
        </div>
        <select class="lang-select"><option>Can edit</option><option>View only</option></select>
      </div>`).join('');
    const pct = Math.round((goal.current/goal.target)*100);
    document.getElementById('familyGoalText').textContent = `₹${goal.current.toLocaleString('en-IN')} of ₹${goal.target.toLocaleString('en-IN')} target`;
    document.getElementById('familyGoalFill').style.width = pct+'%';
  }catch(err){ /* ignore until signed in */ }
}
async function addFamilyMember(){
  const email = document.getElementById('famEmail').value.trim();
  if(!email){ showToast('Enter an email to invite.'); return; }
  try{
    await api('/family/invite', { method:'POST', body:{ email } });
    document.getElementById('famEmail').value='';
    showToast('Invitation sent to '+email+'.');
    loadFamily();
  }catch(err){ showToast(err.message); }
}

/* ---------------- Financial Stability Engine (backend-driven) ---------------- */
async function loadStability(){
  try{
    const s = await api('/stability');
    const rows = document.querySelectorAll('#page-stability .metric-row');
    const vals = [s.metrics.incomeConsistency, s.metrics.expenseVolatility, s.metrics.debtLoad, s.metrics.emergencyBuffer];
    rows.forEach((row,i)=>{
      row.querySelector('.top span:last-child').textContent = vals[i]+'%';
      row.querySelector('.bar-fill').style.width = vals[i]+'%';
    });
    document.querySelector('#page-stability .seal-score .n').textContent = s.index;
    document.querySelector('#page-stability .verdict').textContent = s.verdict;
    document.querySelector('#page-stability .card:last-child .lede').textContent = s.note;
  }catch(err){ /* ignore until signed in */ }
}

/* ---------------- Money Leak Detector (backend-driven) ---------------- */
async function scanLeaks(){
  const list = document.getElementById('leakList');
  list.innerHTML = '<p class="lede">Scanning transactions for forgotten subscriptions, duplicate charges, and fee creep…</p>';
  try{
    const { leaks, total } = await api('/leak-scan', { method:'POST' });
    list.innerHTML = '';
    leaks.forEach(l=>{
      const item = document.createElement('div'); item.className='leak-item';
      item.innerHTML = `<div><strong style="font-size:13.5px;">${l.name}</strong><div style="font-size:12px; color:#8a8371;">${l.detail}</div></div><div style="display:flex; align-items:center; gap:10px;"><span class="leak-amount">₹${l.amt.toLocaleString('en-IN')}/yr</span><button class="btn btn-ghost btn-sm" onclick="this.closest('.leak-item').remove()">Dismiss</button></div>`;
      list.appendChild(item);
    });
    document.getElementById('leakSummary').style.display='block';
    document.getElementById('leakTotal').textContent = '₹'+total.toLocaleString('en-IN');
  }catch(err){ list.innerHTML = '<p class="lede">Could not scan for leaks: '+err.message+'</p>'; }
}

/* ---------------- Digital Twin (projection computed server-side) ---------------- */
let twinDebounce = null;
function renderTwin(){
  const savings = +document.getElementById('twinSavings').value;
  const years = +document.getElementById('twinYears').value;
  const ratePercent = +document.getElementById('twinReturn').value;
  document.getElementById('twinSavingsVal').textContent = '₹'+savings.toLocaleString('en-IN');
  document.getElementById('twinYearsVal').textContent = years+' yrs';
  document.getElementById('twinReturnVal').textContent = ratePercent+'%';
  document.getElementById('twinHorizonLabel').textContent = years+' years';

  clearTimeout(twinDebounce);
  twinDebounce = setTimeout(async ()=>{
    try{
      const { points, finalBalance, narrative } = await api('/twin/project', { method:'POST', body:{ savings, years, ratePercent } });
      const max = Math.max(...points, 1);
      const w=320,h=180,pad=10;
      const step = (w-2*pad)/(points.length-1);
      let path = '';
      points.forEach((v,i)=>{
        const x = pad + i*step; const y = h-pad - (v/max)*(h-2*pad);
        path += (i===0? 'M':'L') + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
      });
      const areaPath = path + `L${(pad+(points.length-1)*step).toFixed(1)} ${h-pad} L${pad} ${h-pad} Z`;
      document.getElementById('twinChart').innerHTML = `
        <path d="${areaPath}" fill="rgba(201,162,39,0.15)" stroke="none"/>
        <path d="${path}" fill="none" stroke="#C9A227" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
      `;
      document.getElementById('twinFinal').textContent = '₹'+finalBalance.toLocaleString('en-IN');
      document.getElementById('twinNarrative').textContent = narrative;
    }catch(err){ document.getElementById('twinNarrative').textContent = 'Could not reach the projection service.'; }
  }, 150);
}
['twinSavings','twinYears','twinReturn'].forEach(id=>document.getElementById(id).addEventListener('input', renderTwin));

/* ---------------- Loan document analyzer (backend-driven) ---------------- */
const dropzone = document.getElementById('dropzone'); const fileInput = document.getElementById('fileInput');
dropzone.addEventListener('click', ()=>fileInput.click());
['dragover','dragenter'].forEach(evt=>dropzone.addEventListener(evt, e=>{e.preventDefault(); dropzone.classList.add('drag');}));
['dragleave','drop'].forEach(evt=>dropzone.addEventListener(evt, e=>{e.preventDefault(); dropzone.classList.remove('drag');}));
dropzone.addEventListener('drop', e=>{ if(e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });
fileInput.addEventListener('change', e=>{ if(e.target.files[0]) handleFile(e.target.files[0]); });
function handleFile(file){
  document.getElementById('fileChipWrap').innerHTML = '<div class="file-chip">📄 '+file.name+' · '+(file.size/1024).toFixed(0)+' KB</div>';
  runAnalysis(file);
}
async function runAnalysis(file){
  const flagList = document.getElementById('flagList'); flagList.style.display='flex';
  flagList.innerHTML = '<li><span class="t">…</span>Scanning clauses against known predatory-lending patterns…</li>';
  try{
    const { flags, integrityScore, verdict } = await api('/loan/analyze', { method:'POST', body:{ filename:file.name, sizeKb: Math.round(file.size/1024) } });
    flagList.innerHTML = flags.map(f=>`<li><span class="t">${f.t}</span>${f.d}</li>`).join('');
    animateSeal(integrityScore, verdict, 'var(--clay)', '#fdece8');
    appendMsg('agent', `I finished reviewing the document — ${flags.length} clauses are worth negotiating. Integrity score: ${integrityScore}/100.`, agentNames.loan);
  }catch(err){
    flagList.innerHTML = '<li><span class="t">!</span>Could not analyze the document: '+err.message+'</li>';
  }
}
function animateSeal(score, verdictText, color, bg){
  const arc = document.getElementById('sealArc'); const circumference = 326.7;
  const offset = circumference - (circumference*score/100);
  arc.style.stroke = color; arc.style.transition = 'stroke-dashoffset 1s ease';
  requestAnimationFrame(()=>{ arc.style.strokeDashoffset = offset; });
  document.getElementById('sealScore').textContent = score;
  const v = document.getElementById('sealVerdict'); v.textContent = verdictText; v.style.background = bg; v.style.color = color;
}

/* ---------------- Trust center & admin panel (backend-driven) ---------------- */
async function loadTrustCenter(){
  try{
    const { sessions } = await api('/trust/sessions');
    const table = document.getElementById('sessionTable');
    table.innerHTML = '<tr><th>Device</th><th>Location</th><th>Last active</th><th></th></tr>' +
      sessions.map(s=>`<tr><td>${s.device}</td><td>${s.location}</td><td>${s.lastActive}</td><td>${s.current ? '<span class="pill" style="background:#eef3f0; color:var(--sage);">This device</span>' : '<button class="btn btn-ghost btn-sm" onclick="this.closest(\'tr\').remove()">Revoke</button>'}</td></tr>`).join('');
  }catch(err){ /* ignore until signed in */ }
}
async function loadAdminPanel(){
  try{
    const { stats } = await api('/admin/stats');
    const cards = document.querySelectorAll('#page-admin .grid4 .stat-value');
    cards[0].textContent = stats.activeUsers.toLocaleString('en-IN');
    cards[1].textContent = stats.docsAnalyzedToday;
    cards[2].textContent = stats.flagsRaised;
    cards[3].textContent = stats.avgResponseTime;
    const { users } = await api('/admin/users');
    const table = document.querySelectorAll('#page-admin table')[0];
    table.innerHTML = '<tr><th>User</th><th>Risk flags</th><th>Last active</th><th>Status</th><th></th></tr>' +
      users.map(u=>`<tr><td>${u.user}</td><td>${u.flags}</td><td>${u.lastActive}</td><td><span class="status-dot" style="background:${u.status==='Active'?'var(--sage)':'var(--clay)'};"></span>${u.status}</td><td><button class="btn btn-ghost btn-sm" onclick="this.closest('tr').style.opacity=0.4">Suspend</button></td></tr>`).join('');
  }catch(err){ /* ignore until signed in */ }
}

/* ---------------- Account: sign in / register / recover ---------------- */
function checkPasswordRules(pass){
  const rules = {
    len: pass.length >= 8,
    letter: /[a-zA-Z]/.test(pass),
    number: /[0-9]/.test(pass),
    special: /[@!#$%^&*()_\-+=\[\]{};:'",.<>/?\\|`~]/.test(pass)
  };
  return rules;
}
function renderPasswordRules(pass){
  const rules = checkPasswordRules(pass);
  document.getElementById('ruleLen').classList.toggle('ok', rules.len);
  document.getElementById('ruleLetter').classList.toggle('ok', rules.letter);
  document.getElementById('ruleNumber').classList.toggle('ok', rules.number);
  document.getElementById('ruleSpecial').classList.toggle('ok', rules.special);
  const passed = Object.values(rules).filter(Boolean).length;
  const segs = [document.getElementById('pwSeg1'), document.getElementById('pwSeg2'), document.getElementById('pwSeg3')];
  const colors = ['var(--clay)', 'var(--gold)', 'var(--sage)'];
  const level = passed<=1 ? 0 : passed<=2 ? 1 : passed<=3 ? 2 : 3;
  segs.forEach((s,i)=>{ s.style.background = i < level ? colors[Math.min(level-1,2)] : 'var(--parchment-dim)'; });
  return rules.len && rules.letter && rules.number && rules.special;
}
document.getElementById('regPass').addEventListener('input', e=>renderPasswordRules(e.target.value));

async function registerAccount(){
  const username = document.getElementById('regUser').value.trim();
  const password = document.getElementById('regPass').value;
  const question = document.getElementById('regQ').value;
  const answer = document.getElementById('regA').value;
  if(!username || !password || !answer){ showToast('Fill in username, password, and a recovery answer.'); return; }
  if(!renderPasswordRules(password)){ showToast('Password needs 8+ characters, a letter, a number, and @ or a special character.'); return; }
  try{
    const data = await api('/auth/register', { method:'POST', body:{ username, password, question, answer } });
    showToast(data.message);
    document.getElementById('regPass').value=''; document.getElementById('regA').value='';
    switchVaultTab('signin');
    document.getElementById('siUser').value = username;
  }catch(err){ showToast(err.message); }
}

let currentMaskedUser = null;
async function signIn(){
  const username = document.getElementById('siUser').value.trim();
  const password = document.getElementById('siPass').value;
  try{
    const data = await api('/auth/login', { method:'POST', body:{ username, password } });
    localStorage.setItem('fingenie_token', data.token);
    currentMaskedUser = data.maskedUsername;
    enterApp(data.maskedUsername);
    showToast('Signed in as '+data.maskedUsername);
  }catch(err){ showToast(err.message); }
}
async function logOut(){
  try{ await api('/auth/logout', { method:'POST' }); }catch(err){ /* ignore */ }
  localStorage.removeItem('fingenie_token');
  document.getElementById('appShell').style.display = 'none';
  document.getElementById('authGate').style.display = 'flex';
  document.getElementById('siPass').value = '';
  switchVaultTab('signin');
  history.replaceState(null, '', location.pathname);
}
function enterApp(maskedUsername){
  document.getElementById('authGate').style.display = 'none';
  document.getElementById('appShell').style.display = 'block';
  document.getElementById('maskedId').textContent = maskedUsername;
  const initialId = (location.hash.replace('#/','')) || 'overview';
  showPage(initialId, true);
}
const questionText = { school:'What was the name of your first school?', city:'What city were you born in?', pet:'What was the name of your first pet?' };
async function loadRecoveryQuestion(){
  const username = document.getElementById('recUser').value.trim();
  const resultBox = document.getElementById('recoverResult');
  try{
    const { question } = await api('/auth/recover/question', { method:'POST', body:{ username } });
    document.getElementById('recQLabel').textContent = question;
    document.getElementById('recQField').style.display='block'; document.getElementById('recStep2Btn').style.display='inline-flex'; resultBox.style.display='none';
  }catch(err){
    resultBox.style.display='block'; resultBox.textContent = err.message;
    document.getElementById('recQField').style.display='none'; document.getElementById('recStep2Btn').style.display='none';
  }
}
async function verifyRecovery(){
  const username = document.getElementById('recUser').value.trim();
  const answer = document.getElementById('recA').value;
  const resultBox = document.getElementById('recoverResult'); resultBox.style.display='block';
  try{
    const data = await api('/auth/recover/verify', { method:'POST', body:{ username, answer } });
    resultBox.textContent = data.message;
  }catch(err){ resultBox.textContent = err.message; }
}

function switchVaultTab(tab){
  document.querySelectorAll('.vault-tab').forEach(t=>t.classList.toggle('active', t.dataset.tab===tab));
  document.getElementById('signinPane').style.display = tab==='signin' ? 'block' : 'none';
  document.getElementById('registerPane').style.display = tab==='register' ? 'block' : 'none';
  document.getElementById('recoverPane').style.display = tab==='recover' ? 'block' : 'none';
}

/* Always start at the login page on load/refresh — no auto sign-in, even if a token exists */
(function initSession(){
  localStorage.removeItem('fingenie_token');
  history.replaceState(null, '', location.pathname);
})();

/* Kick off the initial twin render with default slider values */
renderTwin();

/* ---------------- Floating voice assistant — reachable from every page ---------------- */
const voiceFab = document.getElementById('voiceFab');
const voiceFabLabel = document.getElementById('voiceFabLabel');
voiceFab.addEventListener('mouseenter', ()=>voiceFabLabel.classList.add('show'));
voiceFab.addEventListener('mouseleave', ()=>voiceFabLabel.classList.remove('show'));
voiceFab.addEventListener('click', ()=>{
  showPage('console');
  setTimeout(()=>{ document.getElementById('micBtn').click(); }, 350);
});
