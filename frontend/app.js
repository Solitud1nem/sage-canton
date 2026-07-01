// Sage on Canton — demo UI over the backend REST API.
const API = location.origin; // backend serves this page, so same origin
const $ = (id) => document.getElementById(id);
const short = (p) => (p ? p.split('::')[0] + '::' + p.split('::')[1]?.slice(0, 6) + '…' : '');
// The MVP provisions a pool of interchangeable research agents (a real Sage would pull named,
// capability-tagged agents from the AgentRegistry). Name them plainly rather than by symbol.
const agentName = (i) => `Agent ${i + 1}`;

let session = null;            // { requester, provider, worker, workers[], arbiter, outsider }
let perspective = 'requester';
let pollTimer = null;
let lastTasks = [];            // last task list rendered (so editor actions can re-render)
let editingPlan = null;        // parent taskRef whose decomposition plan is being edited
const briefs = {};             // taskRef -> research brief (off-ledger, UI-side)
const reports = {};            // taskRef -> last agent TaskReport
const decomps = {};            // parent taskRef -> last DecompositionReport
const plans = {};              // parent taskRef -> editable plan { live, items:[{title,brief,reward,worker}] }
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task-' + Math.random().toString(36).slice(2, 7);
const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const agents = () => session?.workers?.length ? session.workers : [session?.worker].filter(Boolean);
const agentLabel = (p) => { const i = agents().indexOf(p); return i >= 0 ? agentName(i) : short(p); };

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
  setTimeout(() => (t.className = 'toast'), 4200);
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

function renderParties() {
  $('parties').classList.remove('hidden');
  const pill = (role, pid) => `<div class="pill"><div class="role">${role}</div><div class="pid">${short(pid)}</div></div>`;
  const base = ['requester', 'provider', 'arbiter', 'outsider'].map((r) => pill(r, session[r]));
  const wk = agents().map((w, i) => pill(agentName(i), w));
  $('parties').innerHTML = [...base, ...wk].join('');
  $('perspective').innerHTML = ['requester', 'worker', 'provider', 'outsider'].map((r) =>
    `<button class="tiny ${r === perspective ? 'active' : ''}" data-p="${r}">${r === 'worker' ? 'agents' : r}</button>`).join('');
  $('perspective').querySelectorAll('button').forEach((b) =>
    b.onclick = () => { perspective = b.dataset.p; renderParties(); refresh(); });
}

async function refresh() {
  if (!session || editingPlan) return; // don't clobber an in-progress plan edit
  try {
    const party = perspective === 'worker' ? session.worker : session[perspective];
    const [tasks, ...bals] = await Promise.all([
      api('GET', `/tasks?party=${encodeURIComponent(party)}`),
      ...agents().map((w) => api('GET', `/balance?party=${encodeURIComponent(w)}`)),
    ]);
    renderTasks(tasks);
    $('workerBal').textContent = `agents hold ${bals.reduce((s, b) => s + (b.amulet || 0), 0)} CC`;
  } catch (e) {
    toast(e.message, true);
  }
}

function actionsFor(t) {
  const s = t.payload.status;
  const overdue = Date.parse(t.payload.deadline) <= Date.now();
  const acts = [];
  // The requester (paying customer) reviews & edits the decomposition plan before paying.
  if (perspective === 'requester' && s === 'Created' && !t.payload.parentRef) {
    acts.push(['🧩 Plan & delegate', () => runPlan(t), true]);
  }
  if (perspective === 'worker') {
    if (s === 'Created') acts.push(['🤖 Run agent', () => runAgent(t), true]);
    if (s === 'Created') acts.push(['Accept', () => act(t, 'accept', { worker: t.payload.worker })]);
    if (s === 'Accepted') acts.push(['Complete', () => act(t, 'complete', { worker: t.payload.worker, completionRef: 'result-' + t.payload.taskRef })]);
    if (s === 'Completed') acts.push(['💸 Settle (pay agent)', () => act(t, 'settle', { provider: session.provider }), true]);
  }
  if (perspective === 'requester' && s === 'Completed') acts.push(['Approve', () => act(t, 'approve', { requester: session.requester })]);
  if (perspective === 'provider' && (s === 'Created' || s === 'Accepted') && overdue) acts.push(['Expire', () => act(t, 'expire', { provider: session.provider })]);
  return acts;
}

function renderTasks(tasks) {
  lastTasks = tasks;
  $('taskCount').textContent = tasks.length;
  const box = $('tasks');
  if (!tasks.length) {
    box.innerHTML = perspective === 'outsider'
      ? `<div class="empty privacy">🔒 As a non-stakeholder, this party sees <b>0</b> escrows — the terms, amount and counterparties are private to the stakeholders.</div>`
      : `<div class="empty">No tasks yet from this perspective.</div>`;
    return;
  }
  const kids = {};
  tasks.forEach((t) => { if (t.payload.parentRef) (kids[t.payload.parentRef] ||= []).push(t); });
  const tops = tasks.filter((t) => !t.payload.parentRef);

  box.innerHTML = tops.map((t) => {
    const p = t.payload;
    const editing = editingPlan === p.taskRef;
    const acts = editing ? [] : actionsFor(t);
    return `<div class="task">
      <div class="top">
        <div><span class="ref">${esc(p.taskRef)}</span> · ${p.amount} CC</div>
        <span class="badge ${p.status}">${p.status}</span>
      </div>
      <div class="meta">requester ${short(p.requester)} → ${agentLabel(p.worker)}</div>
      ${acts.length ? `<div class="actions">${acts.map((a, i) =>
        `<button class="tiny ${a[2] ? 'primary' : ''}" data-cid="${t.contractId}" data-i="${i}">${a[0]}</button>`).join('')}</div>` : ''}
      ${editing ? planEditorHtml(t) : reportHtml(reports[p.taskRef]) + decompHtml(decomps[p.taskRef], kids[p.taskRef])}
    </div>`;
  }).join('') || `<div class="empty">No tasks from this perspective.</div>`;

  box.querySelectorAll('.actions button').forEach((b) => {
    const t = tops.find((x) => x.contractId === b.dataset.cid);
    if (t) b.onclick = actionsFor(t)[Number(b.dataset.i)][1];
  });
  if (editingPlan) { const t = tops.find((x) => x.payload.taskRef === editingPlan); if (t) bindPlanEditor(t); }
}

async function act(t, verb, body) {
  try {
    toast(`${verb}…`);
    await api('POST', `/tasks/${encodeURIComponent(t.contractId)}/${verb}`, body);
    toast(verb === 'settle' ? '✅ settled — agent paid in real Canton Coin' : `✅ ${verb}`);
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
    await api('POST', '/tasks', { provider: session.provider, requester: session.requester, worker: session.worker, arbiter: session.arbiter, taskRef, amount });
    $('brief').value = '';
    toast('Task funded & created — switch to the requester view to plan it');
    await refresh();
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
}

// Single-task flagship: AI agent researches the brief, the paid fact-checker verifies.
async function runAgent(t) {
  try {
    toast('🤖 agent researching + fact-checking…');
    const rep = await api('POST', `/agent/run/${encodeURIComponent(t.contractId)}`, { provider: session.provider, brief: briefs[t.payload.taskRef] });
    reports[t.payload.taskRef] = rep;
    toast(rep.outcome === 'paid' ? `✅ fact-check passed — agent paid (${rep.verdict.summary})` : `⛔ ${rep.verdict.summary} → disputed, no payout`, rep.outcome !== 'paid');
    await refresh();
  } catch (e) {
    toast(e.message, true);
  }
}

// --- Dynamic decomposition: PLAN → requester edits → APPROVE & run ----------------------

// 1. Ask the orchestrator for a proposed plan and open it for editing (no escrows yet).
async function runPlan(t) {
  try {
    toast('🧩 planning the decomposition…');
    const dec = await api('POST', `/agent/plan/${encodeURIComponent(t.contractId)}`, { provider: session.provider, brief: briefs[t.payload.taskRef] });
    plans[t.payload.taskRef] = { live: dec.live, items: dec.subtasks.map((s) => ({ title: s.title, brief: s.brief, reward: String(s.reward), worker: session.worker })) };
    editingPlan = t.payload.taskRef;
    renderTasks(lastTasks);
  } catch (e) {
    toast(e.message, true);
  }
}

function workerOptions(sel) {
  return agents().map((w, i) => `<option value="${w}" ${w === sel ? 'selected' : ''}>${agentName(i)}</option>`).join('');
}

// Editable plan the requester reviews before paying: per sub-task title, brief, assigned agent, reward.
function planEditorHtml(t) {
  const plan = plans[t.payload.taskRef];
  if (!plan) return '';
  const budget = Number(t.payload.amount);
  const total = plan.items.reduce((s, it) => s + (Number(it.reward) || 0), 0);
  const over = total > budget + 1e-9;
  const rows = plan.items.map((it, i) => `
    <div class="pi-row" data-i="${i}">
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
  return `<div class="plan-editor">
    <div class="rlabel">🧩 Proposed plan — this is what you'll pay for. Edit the briefs, reassign agents, adjust rewards, add or remove sub-tasks, then approve. ${plan.live ? '🧠 planned by Claude' : '📦 offline plan'}</div>
    ${rows}
    <div class="pi-foot">
      <button class="pi-add tiny">➕ add sub-task</button>
      <span class="pi-total ${over ? 'over' : ''}">total ${total.toFixed(2)} / ${budget.toFixed(0)} CC${over ? ' — over budget' : ''}</span>
      <span class="pi-run-group">
        <button class="pi-cancel tiny">Cancel</button>
        <button class="pi-run tiny primary">✅ Approve &amp; delegate (${total.toFixed(2)} CC)</button>
      </span>
    </div>
  </div>`;
}

function bindPlanEditor(t) {
  const ref = t.payload.taskRef;
  const budget = Number(t.payload.amount);
  const root = $('tasks').querySelector('.plan-editor');
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
    root.querySelector('.pi-run').textContent = `✅ Approve & delegate (${total.toFixed(2)} CC)`;
  };
  // Live-edit without re-rendering (keeps focus). Reward edits also refresh the running total.
  root.querySelectorAll('input,textarea,select').forEach((el) =>
    el.addEventListener('input', () => { if (el.classList.contains('pi-reward')) updateTotal(); }));
  root.querySelectorAll('.pi-del').forEach((b, i) => b.onclick = () => { sync(); plans[ref].items.splice(i, 1); renderTasks(lastTasks); });
  root.querySelector('.pi-add').onclick = () => { sync(); plans[ref].items.push({ title: 'New sub-task', brief: '', reward: '0', worker: session.worker }); renderTasks(lastTasks); };
  root.querySelector('.pi-cancel').onclick = () => { editingPlan = null; delete plans[ref]; renderTasks(lastTasks); refresh(); };
  root.querySelector('.pi-run').onclick = () => { sync(); executePlan(t); };
}

// 2. Approve the (edited) plan → backend creates a child escrow per sub-task with its assigned
//    agent, runs the full agent + fact-check + conditional settlement, and rolls the parent up.
async function executePlan(t) {
  const ref = t.payload.taskRef;
  const items = plans[ref].items;
  if (!items.length) { toast('add at least one sub-task', true); return; }
  editingPlan = null;
  renderTasks(lastTasks);
  try {
    toast(`🧩 delegating ${items.length} sub-task(s) — real research + settlement, this can take a few minutes…`);
    const rep = await api('POST', `/agent/execute/${encodeURIComponent(t.contractId)}`, { provider: session.provider, subtasks: items });
    decomps[ref] = rep; delete plans[ref];
    const paid = rep.subtasks.filter((s) => s.outcome === 'paid').length;
    toast(`🧩 ${rep.subtasks.length} sub-tasks done · ${paid} paid · ${rep.paidTotal} CC to agents`, paid === 0);
    await refresh();
  } catch (e) {
    toast(e.message, true);
    editingPlan = ref; renderTasks(lastTasks); // restore the editor so nothing is lost
  }
}

// --- Result rendering -------------------------------------------------------------------

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
      <span class="rout ${rep.outcome}">${rep.outcome === 'paid' ? '✅ agent paid' : '⛔ no payout'}</span>
      <span class="rsrc">${r.live ? '🧠 live research' : '📦 offline stub'}</span>
    </div>
    <div class="ranswer">${esc(r.answer || '(no answer)')}</div>
    ${cites ? `<div class="rlabel">Citations · paid fact-check</div><ul class="rcites">${cites}</ul>` : ''}
    ${log ? `<details class="rlog"><summary>pipeline log (${rep.log.length} steps)</summary><ol>${log}</ol></details>` : ''}
  </div>`;
}

function decompHtml(rep, kids) {
  if (rep) {
    const paid = rep.subtasks.filter((s) => s.outcome === 'paid').length;
    const subs = rep.subtasks.map((s, i) => {
      const plan = rep.decomposition.subtasks[i] || {};
      return `<div class="subtask">
        <div class="sthead"><span class="stnum">${i + 1}</span><b>${esc(s.title || s.taskRef)}</b><span class="streward">${esc(plan.reward || '')} CC</span></div>
        ${reportHtml(s)}
      </div>`;
    }).join('');
    return `<div class="decomp">
      <div class="rlabel">🧩 delegated · ${rep.subtasks.length} on-ledger sub-escrows · ${paid} paid · ${esc(rep.paidTotal)} CC to agents</div>
      ${subs}
    </div>`;
  }
  if (kids && kids.length) {
    return `<div class="decomp"><div class="rlabel">🧩 ${kids.length} on-ledger sub-escrow(s)</div>
      ${kids.map((k) => `<div class="subchip"><span class="ref">${esc(k.payload.taskRef)}</span><span class="badge ${k.payload.status}">${k.payload.status}</span></div>`).join('')}</div>`;
  }
  return '';
}

$('provisionBtn').onclick = provision;
$('createBtn').onclick = createTask;
health();
