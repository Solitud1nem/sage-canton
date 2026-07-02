// Sage on Canton — demo UI over the backend REST API.
// The ledger is rendered as a chat-like activity feed: You fund a task, the Agent
// delivers, the Fact-checker verifies, Settlement moves real Canton Coin. A new task
// is composed at the bottom like a message.
const API = location.origin; // backend serves this page, so same origin
// Optional API token for a publicly hosted backend (API_TOKEN env): open the UI once with
// ?token=… — it is stored locally, stripped from the URL, and sent on every mutating call.
const TOKEN = (() => {
  const q = new URLSearchParams(location.search).get('token');
  if (q) { localStorage.setItem('sage_token', q); history.replaceState(null, '', location.pathname); }
  return q || localStorage.getItem('sage_token') || '';
})();
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task-' + Math.random().toString(36).slice(2, 7);
const hhmm = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
const cc = (n) => `<span class="cc">${esc(String(n).replace(/\.0+$/, ''))} CC</span>`;

let session = JSON.parse(localStorage.getItem('sage_session_v1') || 'null');
let perspective = 'my';          // 'my' | 'agents' | 'outsider'
let pollTimer = null;
let lastTasks = [];
let editingPlan = null;          // taskRef whose decomposition plan is being edited
let refreshFailed = false;
const briefs = {};               // taskRef -> research brief (off-ledger, UI-side)
const reports = {};              // taskRef -> last agent TaskReport
const decomps = {};              // parent taskRef -> last DecompositionReport
const plans = {};                // parent taskRef -> editable plan { live, items[] }
let ACTIONS = [];                // per-render click handlers for [data-i] buttons

const agentBy = (p) => (session?.agents || []).find((a) => a.party === p);
const agentName = (p) => agentBy(p)?.name || 'Agent';
const agents = () => (session?.agents?.length ? session.agents.map((a) => a.party) : (session?.workers || [session?.worker].filter(Boolean)));

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `${method} ${path} ${res.status}`);
  return json;
}

let toastTimer;
function toast(msg, err = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toastTimer);
  // errors stick around and are click-to-copy (ledger errors are long and worth pasting)
  toastTimer = setTimeout(() => (t.className = 'toast'), err ? 20000 : 4200);
}
$('toast').onclick = async () => {
  const t = $('toast');
  try { await navigator.clipboard.writeText(t.textContent); toast('copied to clipboard'); }
  catch { t.className = 'toast'; }
};

async function health() {
  try {
    const h = await api('GET', '/health');
    $('net').classList.add('ok');
    const label = h.target === 'seaport-devnet' ? 'Seaport DevNet' : 'LocalNet';
    $('net').innerHTML = `<span class="dot"></span> ${label} · ${h.llm && h.llm.startsWith('live') ? '🧠 live LLM' : '📦 offline LLM'}`;
  } catch {
    $('net').innerHTML = `<span class="dot"></span> backend offline`;
  }
}

// ── session ────────────────────────────────────────────────────────────────
async function provision(btn) {
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spin"></span> allocating parties on the live node…'; }
  try {
    session = await api('POST', '/admin/provision');
    localStorage.setItem('sage_session_v1', JSON.stringify(session));
    perspective = 'my';
    renderChrome();
    toast('Session ready — 1000 CC tapped to your wallet');
    await refresh();
    startPolling();
  } catch (e) {
    toast(e.message, true);
    if (btn) { btn.disabled = false; btn.textContent = 'Start the demo'; }
  }
}

function startPolling() { if (!pollTimer) pollTimer = setInterval(refresh, 4000); }

// ── chrome (tabs / composer / header) ──────────────────────────────────────
function renderChrome() {
  const seg = $('perspective');
  if (!session) { seg.innerHTML = ''; $('composer').classList.add('hidden'); $('newSessionBtn').classList.add('hidden'); return; }
  const tabs = [['my', 'my view'], ['agents', "agents' view"], ['outsider', 'outsider 🔒']];
  seg.innerHTML = tabs.map(([k, l]) => `<button class="${k === perspective ? 'active' : ''}" data-p="${k}">${l}</button>`).join('');
  seg.querySelectorAll('button').forEach((b) => (b.onclick = () => { perspective = b.dataset.p; renderChrome(); refresh(); }));
  $('composer').classList.toggle('hidden', perspective !== 'my');
  $('newSessionBtn').classList.remove('hidden');
}

// ── feed rendering ─────────────────────────────────────────────────────────
function heroStart() {
  return `<div class="hero">
    <div class="big">🌿</div>
    <h2>Give an AI agent a paid task</h2>
    <p>The agent researches it, an independent fact-checker verifies every citation —<br/>and only verified work gets paid, in real Canton Coin, privately.</p>
    <button class="primary" id="startBtn" style="font-size:16px;padding:12px 28px">Start the demo</button>
    <div class="trust"><span>🔒 <b>Private</b> — each escrow visible only to its parties</span><span>⚖️ <b>Verified</b> — fabricated sources are never paid</span><span>💸 <b>Real money</b> — settled on-ledger</span></div>
  </div>`;
}

function heroOutsider(count) {
  return `<div class="hero lock">
    <div class="big">🔒</div>
    <h2>This party sees ${count} escrows</h2>
    <p>Same ledger, same moment — but an outsider is not a stakeholder of any task,<br/>so Canton shows it <b>nothing</b>: no tasks, no prices, no counterparties.<br/>That is sub-transaction privacy, live.</p>
  </div>`;
}

const evt = (cls, icon, name, ref, when, msg, extra = '') => `
  <div class="evt ${cls}">
    <div class="who">${icon}</div>
    <div class="body">
      <div class="line1"><span class="name">${esc(name)}</span><span class="eref">${esc(ref)}</span><span class="when">${when}</span></div>
      <div class="msg">${msg}</div>${extra}
    </div>
  </div>`;

const chip = (label, primary, fn) => { ACTIONS.push(fn); return `<button class="tiny ${primary ? 'primary' : ''}" data-i="${ACTIONS.length - 1}">${label}</button>`; };
const chips = (arr) => (arr.length ? `<div class="chips">${arr.join('')}</div>` : '');

function citesCard(checks) {
  if (!checks?.length) return '';
  const rows = checks.map((c) => `<div class="cite ${c.ok ? 'ok' : 'bad'}"><span class="ck">${c.ok ? '✓' : '✗'}</span><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.url)}</a><span class="code">${esc(String(c.status ?? c.error ?? ''))}</span></div>`).join('');
  return `<div class="card">${rows}</div>`;
}

function answerSub(rep) {
  const a = rep?.result?.answer || '';
  if (!a) return '';
  const head = a.length > 180 ? a.slice(0, 180) + '…' : a;
  const full = a.length > 180 ? `<details class="more"><summary>full answer</summary><div class="answer">${esc(a)}</div></details>` : '';
  return `<div class="sub">“${esc(head)}”</div>${full}`;
}

function logDetails(rep) {
  if (!rep?.log?.length) return '';
  return `<details class="plog"><summary>how it settled · ${rep.log.length} steps on-ledger</summary><ol>${rep.log.map((l) => `<li>${esc(l)}</li>`).join('')}</ol></details>`;
}

// Events for one top-level task (+ its decomposition children).
function taskEvents(t, kids) {
  const p = t.payload;
  const ref = p.taskRef;
  const rep = reports[ref];
  const brief = briefs[ref] || ref;
  const when = hhmm(p.createdAt);
  const my = perspective === 'my';
  const out = [];

  out.push(evt('me', '🧑', 'You', ref, when,
    `Funded a task for ${cc(p.amount)}: “${esc(brief)}”`,
    p.status === 'Created' && !editingPlanIs(ref) ? chips(my ? [
      chip('🤖 Run agent', true, () => runAgent(t)),
      chip('🧩 Plan & delegate', false, () => runPlan(t)),
      ...(overdue(p) ? [chip('⌛ Expire', false, () => act(t, 'expire', { provider: session.provider }))] : []),
    ] : perspective === 'agents' ? [chip('Accept', true, () => act(t, 'accept', { worker: p.worker }))] : []) : ''));

  // decomposition: plan being edited / executed / children on-ledger
  if (editingPlanIs(ref)) {
    out.push(evt('orch', '🧩', 'Orchestrator', ref, '', `Proposed a plan — <b>this is what you'll pay for</b>. Edit briefs, reassign agents, adjust rewards, then approve. ${plans[ref].live ? '🧠 planned by Claude' : '📦 offline plan'}`, planEditorHtml(t)));
    return out;
  }
  const dec = decomps[ref];
  if (dec) {
    const paid = dec.subtasks.filter((s) => s.outcome === 'paid').length;
    const rows = dec.subtasks.map((s, i) => {
      const ok = s.outcome === 'paid';
      const reward = dec.decomposition.subtasks[i]?.reward || '';
      return `<div class="subrow ${ok ? 'ok' : 'bad'}"><span class="ck">${ok ? '✓' : '✗'}</span><b>${esc(s.title || s.taskRef)}</b><span class="who2">${esc(s.verdict?.summary || '')}</span><span class="cc">${ok ? esc(reward) + ' CC' : 'not paid'}</span></div>`;
    }).join('');
    out.push(evt('orch', '🧩', 'Orchestrator', ref, '',
      `Split across <b>${dec.subtasks.length}</b> specialists — <b>${paid} paid</b> · ${cc(dec.paidTotal)} to agents. Each sub-task was its own private escrow, settled on its own.`,
      `<div class="card">${rows}</div>`));
    return out;
  }
  if (kids?.length) {
    const paid = kids.filter((k) => k.payload.status === 'Paid').length;
    const rows = kids.map((k) => {
      const ok = k.payload.status === 'Paid';
      return `<div class="subrow ${ok ? 'ok' : 'bad'}"><span class="ck">${ok ? '✓' : '✗'}</span><b>${esc(k.payload.taskRef.split('/').pop())}</b><span class="who2">${esc(agentName(k.payload.worker))} · ${esc(k.payload.status)}</span><span class="cc">${ok ? esc(k.payload.amount.replace(/\.0+$/, '')) + ' CC' : 'not paid'}</span></div>`;
    }).join('');
    out.push(evt('orch', '🧩', 'Orchestrator', ref, '', `Split across <b>${kids.length}</b> specialists — ${paid} paid.`, `<div class="card">${rows}</div>`));
    return out;
  }

  const name = agentName(p.worker);
  if (p.status === 'Accepted') {
    out.push(evt('agent', '🤖', name, ref, '', 'Accepted the task — researching…',
      perspective === 'agents' ? chips([chip('Deliver result', true, () => act(t, 'complete', { worker: p.worker, completionRef: 'result-' + ref }))]) : ''));
  }
  if (p.status === 'Completed') {
    const n = rep?.result?.citations?.length;
    out.push(evt('agent', '🤖', name, ref, '', `Delivered the research${n ? ` — <b>${n}</b> sources cited` : ''}. Awaiting settlement.`, answerSub(rep) +
      chips(my ? [chip(`💸 Pay the agent · ${p.amount.replace(/\.0+$/, '')} CC`, true, () => act(t, 'settle', { provider: session.provider })),
                  chip('Dispute', false, () => act(t, 'dispute', { raisedBy: session.requester }))]
        : perspective === 'agents' ? [chip('💸 Claim payment', true, () => act(t, 'settle', { provider: session.provider }))] : [])));
    if (rep?.verdict) out.push(evt('checker', '⚖️', 'Fact-checker', ref, '', `<b>${rep.verdict.checks.filter((c) => c.ok).length} of ${rep.verdict.checks.length}</b> citations resolve.`, citesCard(rep.verdict.checks)));
  }
  if (p.status === 'Paid') {
    out.push(evt('agent', '🤖', name, ref, '', `Delivered the research${rep ? ` — <b>${rep.result.citations.length}</b> sources cited` : ''}.`, answerSub(rep)));
    if (rep?.verdict) out.push(evt('checker', '⚖️', 'Fact-checker', ref, '', `All <b>${rep.verdict.checks.length} of ${rep.verdict.checks.length}</b> citations resolve — work verified.`, citesCard(rep.verdict.checks)));
    out.push(evt('money', '💸', 'Settlement', ref, '', `Agent paid ${cc(p.amount)} — real Canton Coin, moved atomically with the escrow closing.`, logDetails(rep)));
  }
  if (p.status === 'Disputed') {
    out.push(evt('checker', '⚖️', 'Fact-checker', ref, '', `The result is <span class="neg">contested</span> — under arbiter review.`,
      (rep?.verdict ? citesCard(rep.verdict.checks) : '') +
      chips(my ? [chip('↩ Refund me', true, () => act(t, 'resolve', { arbiter: session.arbiter, payWorker: false })),
                  chip('Pay the agent anyway', false, () => act(t, 'settle-resolve-pay', { provider: session.provider }))] : [])));
  }
  if (p.status === 'Refunded') {
    const bad = rep?.verdict?.checks?.filter((c) => !c.ok);
    out.push(evt('checker', '⚖️', 'Fact-checker', ref, '',
      bad?.length ? `Citation does <span class="neg">not resolve</span> — fabricated source. Task disputed, funds returned. <b>The agent got nothing.</b>`
                  : `Task refunded — <b>the agent got nothing.</b>`,
      citesCard(bad) + logDetails(rep)));
  }
  if (p.status === 'Expired') {
    out.push(evt('gray', '⌛', 'Deadline', ref, '', 'The deadline passed before completion — task expired, nothing was paid.'));
  }
  return out;
}

const editingPlanIs = (ref) => editingPlan === ref && plans[ref];
const overdue = (p) => Date.parse(p.deadline) <= Date.now();

function renderFeed(tasks) {
  lastTasks = tasks;
  const feed = $('feed');
  const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120;
  ACTIONS = [];

  if (!session) { feed.innerHTML = heroStart(); const b = $('startBtn'); if (b) b.onclick = () => provision(b); return; }
  if (perspective === 'outsider') { feed.innerHTML = heroOutsider(tasks.length); return; }

  const kids = {};
  tasks.forEach((t) => { if (t.payload.parentRef) (kids[t.payload.parentRef] ||= []).push(t); });
  const tops = tasks.filter((t) => !t.payload.parentRef)
    .sort((a, b) => Date.parse(a.payload.createdAt) - Date.parse(b.payload.createdAt));

  let html = `<div class="daysep">demo session · everything below is on the live ledger</div>`;
  if (!tops.length) {
    html += `<div class="hero"><div class="big">👇</div><h2>No tasks yet</h2><p>Give the agents their first task below.</p></div>`;
  } else {
    // The ACTIVE work zone: the task whose plan is being edited, else the newest one.
    // Everything older is dimmed and its buttons lose the primary green, so the eye
    // lands on exactly one place.
    const nowIdx = editingPlan ? tops.findIndex((x) => x.payload.taskRef === editingPlan) : tops.length - 1;
    html += tops.map((t, i) => {
      const inner = taskEvents(t, kids[t.payload.taskRef]).join('');
      return i === nowIdx
        ? `${tops.length > 1 ? '<div class="daysep cur">⚡ current task</div>' : ''}<div class="tgroup now">${inner}</div>`
        : `<div class="tgroup old">${inner}</div>`;
    }).join('');
    html += `<div class="privacy">🔒 An outsider looking at the same ledger sees <b>none</b> of this — no tasks, no prices, no counterparties. Switch to “outsider” above to see their view.</div>`;
  }
  feed.innerHTML = html;

  feed.querySelectorAll('button[data-i]').forEach((b) => {
    const fn = ACTIONS[Number(b.dataset.i)];
    if (fn) b.onclick = async () => { b.disabled = true; try { await fn(); } finally { b.disabled = false; } };
  });
  if (editingPlan) { const t = tops.find((x) => x.payload.taskRef === editingPlan); if (t) bindPlanEditor(t); }
  if (nearBottom) feed.scrollTop = feed.scrollHeight;
}

// ── data refresh ───────────────────────────────────────────────────────────
async function refresh() {
  if (!session) { renderFeed([]); return; }
  if (editingPlan) return; // don't clobber an in-progress plan edit
  try {
    const party = perspective === 'agents' ? session.worker : perspective === 'outsider' ? session.outsider : session.requester;
    const [all, ...bals] = await Promise.all([
      api('GET', `/tasks?party=${encodeURIComponent(party)}`),
      ...agents().map((w) => api('GET', `/balance?party=${encodeURIComponent(w)}`)),
    ]);
    // The requester is the validator's wallet party and persists across sessions; scope the
    // feed to THIS session (its provider party is freshly allocated each provision).
    const tasks = all.filter((t) => t.payload.provider === session.provider);
    renderFeed(tasks);
    const earned = bals.reduce((s, b) => s + (b.amulet || 0), 0);
    $('earned').innerHTML = `agents earned <b>${earned} CC</b>`;
    refreshFailed = false;
  } catch (e) {
    if (!refreshFailed) toast(e.message, true);
    refreshFailed = true;
  }
}

// ── actions ────────────────────────────────────────────────────────────────
async function act(t, verb, body) {
  try {
    toast(`${verb}…`);
    await api('POST', `/tasks/${encodeURIComponent(t.contractId)}/${verb}`, body);
    toast(verb === 'settle' ? '✅ settled — agent paid in real Canton Coin' : `✅ ${verb}`);
    await refresh();
  } catch (e) { toast(e.message, true); }
}

async function runAgent(t) {
  try {
    toast('🤖 agent researching + fact-checking…');
    const rep = await api('POST', `/agent/run/${encodeURIComponent(t.contractId)}`, { provider: session.provider, brief: briefs[t.payload.taskRef] });
    reports[t.payload.taskRef] = rep;
    toast(rep.outcome === 'paid' ? `✅ verified — agent paid (${rep.verdict.summary})` : `⛔ ${rep.verdict.summary} → no payout`, rep.outcome !== 'paid');
    await refresh();
  } catch (e) { toast(e.message, true); }
}

async function createTask(brief, amount) {
  const taskRef = slug(brief);
  briefs[taskRef] = brief;
  const created = await api('POST', '/tasks', { provider: session.provider, requester: session.requester, worker: session.worker, arbiter: session.arbiter, taskRef, amount });
  await refresh();
  return created;
}

// ── decomposition: plan → edit → approve ───────────────────────────────────
async function runPlan(t) {
  try {
    toast('🧩 planning the decomposition…');
    const dec = await api('POST', `/agent/plan/${encodeURIComponent(t.contractId)}`, { provider: session.provider, brief: briefs[t.payload.taskRef] });
    plans[t.payload.taskRef] = { live: dec.live, items: dec.subtasks.map((s) => ({ title: s.title, brief: s.brief, reward: String(s.reward), worker: session.worker })) };
    editingPlan = t.payload.taskRef;
    renderFeed(lastTasks);
  } catch (e) { toast(e.message, true); }
}

function workerOptions(sel) {
  return (session.agents || []).map((a) => `<option value="${esc(a.party)}" ${a.party === sel ? 'selected' : ''}>${esc(a.name)} · ${esc(a.pricing)} CC</option>`).join('');
}

function planEditorHtml(t) {
  const plan = plans[t.payload.taskRef];
  const budget = Number(t.payload.amount);
  const total = plan.items.reduce((s, it) => s + (Number(it.reward) || 0), 0);
  const over = total > budget + 1e-9;
  const rows = plan.items.map((it) => `
    <div class="pi-row">
      <div class="pi-main">
        <input class="pi-title" value="${esc(it.title)}" placeholder="sub-task title" />
        <textarea class="pi-brief" rows="2" placeholder="what should this agent research?">${esc(it.brief)}</textarea>
      </div>
      <div class="pi-side">
        <label>agent<select class="pi-worker">${workerOptions(it.worker)}</select></label>
        <label>CC<input class="pi-reward" type="number" min="0" step="1" value="${esc(it.reward)}" /></label>
        <button class="pi-del tiny" title="remove sub-task">✕</button>
      </div>
    </div>`).join('');
  return `<div class="card plan-editor">
    ${rows}
    <div class="pi-foot">
      <button class="pi-add tiny">➕ add sub-task</button>
      <span class="pi-total ${over ? 'over' : ''}">total ${total.toFixed(2)} / ${budget.toFixed(0)} CC${over ? ' — over budget' : ''}</span>
      <span class="pi-run-group">
        <button class="pi-cancel tiny">Cancel</button>
        <button class="pi-run tiny primary" ${over ? 'disabled' : ''}>✅ Approve &amp; delegate (${total.toFixed(2)} CC)</button>
      </span>
    </div>
  </div>`;
}

function bindPlanEditor(t) {
  const ref = t.payload.taskRef;
  const budget = Number(t.payload.amount);
  const root = $('feed').querySelector('.plan-editor');
  if (!root) return;
  const sync = () => {
    plans[ref].items = [...root.querySelectorAll('.pi-row')].map((row) => ({
      title: row.querySelector('.pi-title').value,
      brief: row.querySelector('.pi-brief').value,
      worker: row.querySelector('.pi-worker').value,
      reward: row.querySelector('.pi-reward').value || '0',
    }));
  };
  const updateTotal = () => {
    const total = [...root.querySelectorAll('.pi-reward')].reduce((s, el) => s + (Number(el.value) || 0), 0);
    const over = total > budget + 1e-9;
    const span = root.querySelector('.pi-total');
    span.textContent = `total ${total.toFixed(2)} / ${budget.toFixed(0)} CC${over ? ' — over budget' : ''}`;
    span.classList.toggle('over', over);
    const run = root.querySelector('.pi-run');
    run.textContent = `✅ Approve & delegate (${total.toFixed(2)} CC)`;
    run.disabled = over;
  };
  root.querySelectorAll('input,textarea,select').forEach((el) =>
    el.addEventListener('input', () => { if (el.classList.contains('pi-reward')) updateTotal(); }));
  root.querySelectorAll('.pi-worker').forEach((sel) => sel.addEventListener('change', () => {
    const a = agentBy(sel.value);
    if (a) sel.closest('.pi-row').querySelector('.pi-reward').value = a.pricing;
    updateTotal();
  }));
  root.querySelectorAll('.pi-del').forEach((b, i) => (b.onclick = () => { sync(); plans[ref].items.splice(i, 1); renderFeed(lastTasks); }));
  root.querySelector('.pi-add').onclick = () => { sync(); plans[ref].items.push({ title: 'New sub-task', brief: '', reward: '0', worker: session.worker }); renderFeed(lastTasks); };
  root.querySelector('.pi-cancel').onclick = () => { editingPlan = null; delete plans[ref]; renderFeed(lastTasks); refresh(); };
  root.querySelector('.pi-run').onclick = () => { sync(); executePlan(t); };
}

async function executePlan(t) {
  const ref = t.payload.taskRef;
  const items = plans[ref].items;
  if (!items.length) { toast('add at least one sub-task', true); return; }
  editingPlan = null;
  renderFeed(lastTasks);
  try {
    toast(`🧩 delegating ${items.length} sub-task(s) — research + verification + settlement…`);
    const rep = await api('POST', `/agent/execute/${encodeURIComponent(t.contractId)}`, { provider: session.provider, subtasks: items });
    decomps[ref] = rep; delete plans[ref];
    const paid = rep.subtasks.filter((s) => s.outcome === 'paid').length;
    toast(`🧩 ${rep.subtasks.length} sub-tasks done · ${paid} paid · ${rep.paidTotal} CC to agents`, paid === 0);
    await refresh();
  } catch (e) {
    toast(e.message, true);
    editingPlan = ref; renderFeed(lastTasks); // restore the editor so nothing is lost
  }
}

// ── composer ───────────────────────────────────────────────────────────────
$('createBtn').onclick = async () => {
  const brief = $('brief').value.trim() || 'Summarise Canton Network privacy for settlement';
  const btn = $('createBtn'); btn.disabled = true;
  try {
    await createTask(brief, $('amount').value || '100');
    $('brief').value = '';
    toast('Task funded — now run the agent on it ☝️');
  } catch (e) { toast(e.message, true); } finally { btn.disabled = false; }
};
$('splitBtn').onclick = async () => {
  const brief = $('brief').value.trim() || 'Summarise Canton Network privacy for settlement';
  const btn = $('splitBtn'); btn.disabled = true;
  try {
    const created = await createTask(brief, $('amount').value || '100');
    $('brief').value = '';
    await runPlan(created);
  } catch (e) { toast(e.message, true); } finally { btn.disabled = false; }
};
$('brief').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('createBtn').click(); });
$('newSessionBtn').onclick = () => provision();

// ── boot ───────────────────────────────────────────────────────────────────
health();
renderChrome();
renderFeed([]);
if (session) { refresh(); startPolling(); }
