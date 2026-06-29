// Sage on Canton — demo UI over the backend REST API.
const API = location.origin; // backend serves this page, so same origin
const $ = (id) => document.getElementById(id);
const short = (p) => (p ? p.split('::')[0] + '::' + p.split('::')[1]?.slice(0, 6) + '…' : '');

let session = null;            // { requester, provider, worker, arbiter, outsider }
let perspective = 'requester';
let pollTimer = null;
const briefs = {};             // taskRef -> research brief (off-ledger, UI-side)
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
    $('net').innerHTML = `<span class="dot"></span> LocalNet · DSO ${h.dso ? h.dso.slice(0, 14) + '…' : 'offline'}`;
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
  box.innerHTML = tasks.map((t) => {
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
    </div>`;
  }).join('');
  box.querySelectorAll('button').forEach((b) => {
    const t = tasks.find((x) => x.contractId === b.dataset.cid);
    b.onclick = actionsFor(t)[Number(b.dataset.i)][1];
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
    toast(rep.outcome === 'paid'
      ? `✅ fact-check passed — worker paid (${rep.verdict.summary})`
      : `⛔ ${rep.verdict.summary} → disputed, no payout`, rep.outcome !== 'paid');
    await refresh();
  } catch (e) {
    toast(e.message, true);
  }
}

const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

$('provisionBtn').onclick = provision;
$('createBtn').onclick = createTask;
health();
