// Sage on Canton — demo UI over the backend REST API.
const API = location.origin; // backend serves this page, so same origin
const $ = (id) => document.getElementById(id);
const short = (p) => (p ? p.split('::')[0] + '::' + p.split('::')[1]?.slice(0, 6) + '…' : '');

let session = null;            // { requester, provider, worker, arbiter, outsider }
let perspective = 'requester';
let pollTimer = null;
const briefs = {};             // taskRef -> research brief (off-ledger, UI-side)
const reports = {};            // taskRef -> last agent TaskReport (answer/citations/verdict/log)
const decomps = {};            // parent taskRef -> last DecompositionReport (sub-task reports)
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task-' + Math.random().toString(36).slice(2, 7);

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `${method} ${path} ${res.status}`);
  return json;
}

function toast(msg, err = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (err ? ' err' : '');
  setTimeout(() => (t.className = 'toast'), 3200);
}

async function health() {
  try {
    const h = await api('GET', '/health');
    $('net').classList.add('ok');
    const label = h.target === 'seaport-devnet' ? 'Seaport DevNet' : (h.target || 'LocalNet');
    $('net').innerHTML = `<span class="dot"></span> ${label} · ${h.llm && h.llm.startsWith('live') ? '🧠 live LLM' : '📦 offline LLM'} · DSO ${h.dso ? h.dso.slice(0, 14) + '…' : 'offline'}`;
  } catch {
    $('net').innerHTML = `<span class="dot"></span> backend offline`;
  }
}

async function provision() {
  const btn = $('provisionBtn');
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span> provisioning…';
  try {
    session = await api('POST', '/admin/provision');
    renderParties();
    ['viewCard', 'createCard', 'tasksCard'].forEach((id) => $(id).classList.remove('hidden'));
    $('sessionHint').textContent = 'Live parties provisioned · 1000 CC tapped to the requester wallet.';
    btn.textContent = 'Re-provision';
    refresh();
    if (!pollTimer) pollTimer = setInterval(refresh, 4000);
    toast('Session ready');
  } catch (e) {
    toast(e.message, true);
    btn.textContent = 'Start session';
  } finally {
    btn.disabled = false;
  }
}

const ROLES = ['requester', 'worker', 'provider', 'arbiter', 'outsider'];
function renderParties() {
  $('parties').classList.remove('hidden');
  $('parties').innerHTML = ROLES.map((r) =>
    `<div class="pill"><div class="role">${r}</div><div class="pid">${short(session[r])}</div></div>`).join('');
  $('perspective').innerHTML = ['requester', 'worker', 'provider', 'outsider'].map((r) =>
    `<button class="tiny ${r === perspective ? 'active' : ''}" data-p="${r}">${r}</button>`).join('');
  $('perspective').querySelectorAll('button').forEach((b) =>
    b.onclick = () => { perspective = b.dataset.p; renderParties(); refresh(); });
}

async function refresh() {
  if (!session) return;
  try {
    const [tasks, bal] = await Promise.all([
      api('GET', `/tasks?party=${encodeURIComponent(session[perspective])}`),
      api('GET', `/balance?party=${encodeURIComponent(session.worker)}`),
    ]);
    renderTasks(tasks);
    $('workerBal').textContent = `worker holds ${bal.amulet} CC`;
  } catch (e) {
    toast(e.message, true);
  }
}

function actionsFor(t) {
  const s = t.payload.status;
  const overdue = Date.parse(t.payload.deadline) <= Date.now();
  const acts = [];
  if (perspective === 'worker') {
    if (s === 'Created') acts.push(['🤖 Run agent', () => runAgent(t), true]);
    if (s === 'Created' && !t.payload.parentRef) acts.push(['🧩 Decompose', () => runDecompose(t), true]);
    if (s === 'Created') acts.push(['Accept', () => act(t, 'accept', { worker: session.worker })]);
    if (s === 'Accepted') acts.push(['Complete', () => act(t, 'complete', { worker: session.worker, completionRef: 'result-' + t.payload.taskRef })]);
    if (s === 'Completed') acts.push(['💸 Settle (pay me)', () => act(t, 'settle', { provider: session.provider }), true]);
  }
  if (perspective === 'requester' && s === 'Completed') acts.push(['Approve', () => act(t, 'approve', { requester: session.requester })]);
  if (perspective === 'provider' && (s === 'Created' || s === 'Accepted') && overdue) acts.push(['Expire', () => act(t, 'expire', { provider: session.provider })]);
  return acts;
}

function renderTasks(tasks) {
  $('taskCount').textContent = tasks.length;
  const box = $('tasks');
  if (!tasks.length) {
    box.innerHTML = perspective === 'outsider'
      ? `<div class="empty privacy">🔒 As a non-stakeholder, this party sees <b>0</b> escrows — the terms, amount and counterparties are private to the stakeholders.</div>`
      : `<div class="empty">No tasks yet from this perspective.</div>`;
    return;
  }
  // Nest decomposition children under their parent; only top-level tasks get their own card.
  const kids = {};
  tasks.forEach((t) => { if (t.payload.parentRef) (kids[t.payload.parentRef] ||= []).push(t); });
  const tops = tasks.filter((t) => !t.payload.parentRef);

  box.innerHTML = tops.map((t) => {
    const p = t.payload;
    const acts = actionsFor(t);
    return `<div class="task">
      <div class="top">
        <div><span class="ref">${esc(p.taskRef)}</span> · ${p.amount} CC</div>
        <span class="badge ${p.status}">${p.status}</span>
      </div>
      <div class="meta">requester ${short(p.requester)} → worker ${short(p.worker)}</div>
      ${acts.length ? `<div class="actions">${acts.map((a, i) =>
        `<button class="tiny ${a[2] ? 'primary' : ''}" data-cid="${t.contractId}" data-i="${i}">${a[0]}</button>`).join('')}</div>` : ''}
      ${reportHtml(reports[p.taskRef])}
      ${decompHtml(decomps[p.taskRef], kids[p.taskRef])}
    </div>`;
  }).join('') || `<div class="empty">No tasks yet from this perspective.</div>`;
  box.querySelectorAll('button').forEach((b) => {
    const t = tops.find((x) => x.contractId === b.dataset.cid);
    if (t) b.onclick = actionsFor(t)[Number(b.dataset.i)][1];
  });
}

async function act(t, verb, body) {
  try {
    toast(`${verb}…`);
    await api('POST', `/tasks/${encodeURIComponent(t.contractId)}/${verb}`, body);
    toast(verb === 'settle' ? '✅ settled — worker paid in real Canton Coin' : `✅ ${verb}`);
    await refresh();
  } catch (e) {
    toast(e.message, true);
  }
}

async function createTask() {
  const brief = $('brief').value.trim() || 'Summarise Canton Network privacy for settlement';
  const taskRef = slug(brief);
  briefs[taskRef] = brief;
  const amount = $('amount').value || '100';
  const btn = $('createBtn'); btn.disabled = true;
  try {
    await api('POST', '/tasks', { ...session, taskRef, amount });
    $('brief').value = '';
    toast('Task funded & created');
    await refresh();
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
}

// One-click flagship: AI agent researches the brief, the paid fact-checker verifies, and
// settlement is conditional. Drives the backend /agent/run pipeline.
async function runAgent(t) {
  try {
    toast('🤖 agent researching + fact-checking…');
    const rep = await api('POST', `/agent/run/${encodeURIComponent(t.contractId)}`, {
      provider: session.provider,
      brief: briefs[t.payload.taskRef],
    });
    reports[t.payload.taskRef] = rep;
    toast(rep.outcome === 'paid'
      ? `✅ fact-check passed — worker paid (${rep.verdict.summary})`
      : `⛔ ${rep.verdict.summary} → disputed, no payout`, rep.outcome !== 'paid');
    await refresh();
  } catch (e) {
    toast(e.message, true);
  }
}

// Dynamic decomposition: split the parent into child escrows, run + settle each, roll up.
async function runDecompose(t) {
  try {
    toast('🧩 decomposing → running sub-tasks (real settlement each, ~30–60s)…');
    const rep = await api('POST', `/agent/decompose/${encodeURIComponent(t.contractId)}`, {
      provider: session.provider,
      brief: briefs[t.payload.taskRef],
    });
    decomps[t.payload.taskRef] = rep;
    const paid = rep.subtasks.filter((s) => s.outcome === 'paid').length;
    toast(`🧩 ${rep.subtasks.length} sub-tasks · ${paid} paid · ${rep.paidTotal} CC to worker`, paid === 0);
    await refresh();
  } catch (e) {
    toast(e.message, true);
  }
}

// Render the agent's result under its task: answer, per-citation fact-check, pipeline log.
function reportHtml(rep) {
  if (!rep) return '';
  const r = rep.result || {};
  const checks = (rep.verdict && rep.verdict.checks) || [];
  const cites = (r.citations || []).map((u) => {
    const c = checks.find((x) => x.url === u) || {};
    const st = c.status ? ` ${c.status}` : (c.error ? ` ${c.error}` : '');
    return `<li class="${c.ok ? 'ok' : 'bad'}"><span class="ck">${c.ok ? '✓' : '✗'}</span><a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a><span class="st">${esc(st)}</span></li>`;
  }).join('');
  const log = (rep.log || []).map((l) => `<li>${esc(l)}</li>`).join('');
  return `<div class="report ${rep.outcome}">
    <div class="rhead">
      <span class="rout ${rep.outcome}">${rep.outcome === 'paid' ? '✅ worker paid' : '⛔ no payout (disputed)'}</span>
      <span class="rsrc">${r.live ? '🧠 live Claude' : '📦 offline stub'}</span>
    </div>
    <div class="ranswer">${esc(r.answer || '(no answer)')}</div>
    ${cites ? `<div class="rlabel">Citations · paid fact-check</div><ul class="rcites">${cites}</ul>` : ''}
    ${log ? `<details class="rlog"><summary>pipeline log (${rep.log.length} steps)</summary><ol>${log}</ol></details>` : ''}
  </div>`;
}

// Render a decomposition: the sub-task plan + each child escrow's own report. Falls back to
// bare status chips for on-ledger children with no in-memory report (e.g. after a reload).
function decompHtml(rep, kids) {
  if (rep) {
    const paid = rep.subtasks.filter((s) => s.outcome === 'paid').length;
    const subs = rep.subtasks.map((s, i) => {
      const reward = (rep.decomposition.subtasks[i] || {}).reward || '';
      return `<div class="subtask">
        <div class="sthead"><span class="stnum">${i + 1}</span><b>${esc(s.title || s.taskRef)}</b><span class="streward">${esc(reward)} CC</span></div>
        ${reportHtml(s)}
      </div>`;
    }).join('');
    return `<div class="decomp">
      <div class="rlabel">🧩 dynamic decomposition · ${rep.subtasks.length} on-ledger sub-escrows · ${paid} paid · ${esc(rep.paidTotal)} CC to worker</div>
      ${subs}
    </div>`;
  }
  if (kids && kids.length) {
    return `<div class="decomp"><div class="rlabel">🧩 ${kids.length} on-ledger sub-escrow(s)</div>
      ${kids.map((k) => `<div class="subchip"><span class="ref">${esc(k.payload.taskRef)}</span><span class="badge ${k.payload.status}">${k.payload.status}</span></div>`).join('')}</div>`;
  }
  return '';
}

const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

$('provisionBtn').onclick = provision;
$('createBtn').onclick = createTask;
health();
