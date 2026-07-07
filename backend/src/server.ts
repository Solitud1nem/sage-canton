// REST API over the escrow service + static hosting for the demo UI.
// Plain node:http to keep dependencies to zero. Serves the frontend at / so the UI shares
// the backend origin (no CORS needed); CORS headers are added anyway for separate hosting.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';
import { config } from './config.js';
import { LedgerClient, LedgerError } from './ledger.js';
import { RegistryClient } from './registry.js';
import { EscrowService } from './escrow.js';
import { Automation } from './automation.js';
import { tap, walletParty } from './wallet.js';
import { currentUserId } from './jwt.js';
import { AgentRunner } from './agent/runner.js';
import { AgentRegistryService, AGENT_ROLES } from './agents.js';
import { llmMode } from './agent/llm.js';
import type { InstrumentId, Party } from './types.js';

const ledger = new LedgerClient();
const registry = new RegistryClient();
const svc = new EscrowService(config.packageId, ledger, registry);
const runner = new AgentRunner(svc);
const agentReg = new AgentRegistryService(config.packageId, ledger);
const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'frontend');
let dso = '';

type Handler = (params: Record<string, string>, body: any, url: URL) => Promise<unknown>;
const routes: { method: string; re: RegExp; keys: string[]; fn: Handler }[] = [];
function route(method: string, path: string, fn: Handler): void {
  const keys: string[] = [];
  const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, fn });
}
const amulet = (i?: InstrumentId): InstrumentId => i ?? { admin: dso, id: 'Amulet' };
const balance = async (party: Party): Promise<number> => (await ledger.amuletHoldings(party)).reduce((s, h) => s + h.amount, 0);

route('GET', '/health', async () => ({ ok: true, target: config.target, packageId: config.packageId, dso, llm: llmMode() }));
route('GET', '/balance', async (_p, _b, url) => ({ amulet: await balance(url.searchParams.get('party') ?? '') }));
route('GET', '/tasks', async (_p, _b, url) => {
  const party = url.searchParams.get('party');
  if (!party) throw new HttpError(400, 'party query param required');
  return svc.list(party);
});
route('POST', '/tasks', async (_p, b) =>
  svc.createTask({ provider: b.provider, requester: b.requester, worker: b.worker, arbiter: b.arbiter,
    taskRef: b.taskRef, amount: String(b.amount), instrumentId: amulet(b.instrumentId), deadlineSeconds: b.deadlineSeconds }));
route('POST', '/tasks/:cid/accept', async (p, b) => svc.accept(p.cid!, b.worker));
route('POST', '/tasks/:cid/complete', async (p, b) => svc.complete(p.cid!, b.worker, b.completionRef ?? ''));
route('POST', '/tasks/:cid/approve', async (p, b) => svc.approve(p.cid!, b.requester));
route('POST', '/tasks/:cid/expire', async (p, b) => svc.expire(p.cid!, b.provider));
route('POST', '/tasks/:cid/dispute', async (p, b) => svc.dispute(p.cid!, b.raisedBy));
// Status-only resolve — right for a dispute raised before settlement (nothing locked yet);
// the value-moving siblings are /settle-resolve-refund and /settle-resolve-pay.
route('POST', '/tasks/:cid/resolve', async (p, b) => svc.resolve(p.cid!, b.arbiter, !!b.payWorker));
route('POST', '/tasks/:cid/settle', async (p, b) => {
  const esc = await svc.get(b.provider, p.cid!);
  if (!esc) throw new HttpError(404, 'escrow not found / not visible to provider');
  // Guard here, not just on-ledger: SettlePayment is also exercisable from Paid (to rescue a
  // status-only Approve), and this backend can act as the requester — so without this check a
  // repeated call would fund + execute a SECOND allocation (double payment).
  if (esc.payload.status !== 'Completed') throw new HttpError(409, `escrow is ${esc.payload.status}, settle requires Completed`);
  return svc.settle(esc);
});
// Value-moving dispute resolution (escrow must already be Disputed): the arbiter returns
// the locked funds to the requester for real (worker paid nothing).
route('POST', '/tasks/:cid/settle-resolve-refund', async (p, b) => {
  const esc = await svc.get(b.provider, p.cid!);
  if (!esc) throw new HttpError(404, 'escrow not found / not visible to provider');
  if (esc.payload.status !== 'Disputed') throw new HttpError(409, `escrow is ${esc.payload.status}, resolve requires Disputed`);
  return svc.settleResolveRefund(esc);
});
// Value-moving dispute resolution: the arbiter rules for the worker, who is paid for real.
route('POST', '/tasks/:cid/settle-resolve-pay', async (p, b) => {
  const esc = await svc.get(b.provider, p.cid!);
  if (!esc) throw new HttpError(404, 'escrow not found / not visible to provider');
  if (esc.payload.status !== 'Disputed') throw new HttpError(409, `escrow is ${esc.payload.status}, resolve requires Disputed`);
  return svc.settleResolvePayWorker(esc);
});
route('POST', '/admin/tap', async (_p, b) => { await tap(String(b.amount ?? '1000.0')); return { tapped: b.amount ?? '1000.0', party: await walletParty() }; });
// Flagship: run the AI research agent + paid fact-checker on a Created task -> conditional
// settlement (citations resolve = worker paid; fabricated = disputed, no payout).
route('POST', '/agent/run/:cid', async (p, b) => {
  const esc = await svc.get(b.provider, p.cid!);
  if (!esc) throw new HttpError(404, 'escrow not found / not visible to provider');
  return runner.run(esc, b.brief);
});
// Dynamic decomposition — PLAN: propose sub-tasks + reward split for the requester to review
// and edit before paying. No escrows created, no side effects.
route('POST', '/agent/plan/:cid', async (p, b) => {
  const esc = await svc.get(b.provider, p.cid!);
  if (!esc) throw new HttpError(404, 'escrow not found / not visible to provider');
  return runner.plan(esc, b.brief);
});
// Dynamic decomposition — EXECUTE an approved (possibly edited) plan: create + run + settle a
// child escrow per sub-task with its assigned worker, then roll the parent up.
route('POST', '/agent/execute/:cid', async (p, b) => {
  const esc = await svc.get(b.provider, p.cid!);
  if (!esc) throw new HttpError(404, 'escrow not found / not visible to provider');
  if (!Array.isArray(b.subtasks) || b.subtasks.length === 0) throw new HttpError(400, 'subtasks[] required');
  // Enforce the budget server-side (the UI shows a running total, but must not be trusted).
  const rewards = b.subtasks.map((s: { reward?: unknown }) => Number(s?.reward));
  if (rewards.some((r: number) => !Number.isFinite(r) || r < 0)) throw new HttpError(400, 'each subtask needs a finite non-negative reward');
  const total = rewards.reduce((s: number, r: number) => s + r, 0);
  if (total > Number(esc.payload.amount) + 1e-9) throw new HttpError(400, `plan total ${total} CC exceeds the parent budget ${esc.payload.amount} CC`);
  return runner.executePlan(esc, b.subtasks);
});
// Demo provisioning: requester = the wallet party; allocate the other roles + an outsider
// (no stake) and grant the backend CanActAs so it can drive every perspective.
route('POST', '/admin/provision', async () => {
  const sfx = Math.random().toString(36).slice(2, 7);
  const requester = await walletParty();
  // A small pool of worker agents so a decomposition plan can assign sub-tasks to different ones.
  // The `sage-` hint prefix marks these parties as OURS on the shared validator, so the
  // rights-cap self-heal below can safely target stale sessions and nothing else.
  const [provider, workerA, workerB, workerC, arbiter, outsider] = await Promise.all([
    ledger.allocateParty(`sage-provider-${sfx}`), ledger.allocateParty(`sage-agent-1-${sfx}`),
    ledger.allocateParty(`sage-agent-2-${sfx}`), ledger.allocateParty(`sage-agent-3-${sfx}`),
    ledger.allocateParty(`sage-arbiter-${sfx}`), ledger.allocateParty(`sage-outsider-${sfx}`),
  ]);
  const workers = [workerA, workerB, workerC];
  // No grant for the outsider: it only ever READS (privacy perspective), and the API user
  // holds CanReadAsAnyParty — every CanActAs slot counts against the participant's
  // 1000-rights-per-user cap, which is shared by every team on the Seaport validator.
  const user = await currentUserId();
  const granted = [requester, provider, ...workers, arbiter];
  try {
    await ledger.grantActAs(user, granted);
  } catch (e) {
    if (!(e instanceof LedgerError) || (e.detail as { code?: string })?.code !== 'TOO_MANY_USER_RIGHTS') throw e;
    // The shared user hit the participant's rights cap. Revoke OUR stale demo-session
    // rights (sage-prefixed hints only — never another team's parties) and retry once.
    const keep = new Set(granted);
    const stale = (await ledger.listActAs(user)).filter(
      (p) => /^sage-[a-z0-9-]+-[a-z0-9]{3,6}::/.test(p) && !keep.has(p),
    );
    if (stale.length === 0) throw e;
    console.warn(`provision: rights cap hit — revoking ${stale.length} stale sage-* CanActAs and retrying`);
    await ledger.revokeActAs(user, stale);
    await ledger.grantActAs(user, granted);
  }
  // Register each agent on-ledger (AgentRegistry) with a real specialisation, and tell the
  // runner which party plays which role so its sub-tasks research accordingly.
  const roster = AGENT_ROLES.map((role, i) => ({ party: workers[i]!, role }));
  await agentReg.register(provider, roster);
  roster.forEach((r) => runner.registerAgent(r.party, r.role.key));
  await tap('1000.0');
  const agents = await agentReg.list(provider); // read back from the on-ledger registry
  return { requester, provider, worker: workerA, workers, arbiter, outsider, agents };
});
// Read the agent registry (on-ledger AgentProfiles this operator published).
route('GET', '/agents', async (_p, _b, url) => {
  const operator = url.searchParams.get('operator');
  if (!operator) throw new HttpError(400, 'operator query param required');
  return agentReg.list(operator);
});

class HttpError extends Error { constructor(public code: number, msg: string) { super(msg); } }

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
async function serveStatic(pathname: string, res: http.ServerResponse): Promise<void> {
  const rel = pathname === '/' ? 'index.html' : normalize(pathname).replace(/^(\.\.[/\\])+/, '').replace(/^\//, '');
  try {
    const data = await readFile(join(FRONTEND, rel));
    res.writeHead(200, { 'Content-Type': MIME[extname(rel)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found');
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${config.port}`);
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    const m = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
    if (!m) { if (req.method === 'GET') return serveStatic(url.pathname, res); res.writeHead(404, cors); return res.end('{"error":"not found"}'); }
    const send = (code: number, obj: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json', ...cors }); res.end(JSON.stringify(obj)); };
    // Optional shared-token gate for a publicly reachable deployment: every mutating route
    // needs `Authorization: Bearer $API_TOKEN` (the UI forwards it from ?token=…). This
    // backend holds CanActAs for all demo parties, so an open POST surface is god-mode.
    // Loopback connections are exempt — local dev talks straight to localhost, while on a
    // public host (Fly, tunnel) requests arrive via the proxy's non-loopback address.
    const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');
    if (config.apiToken && !loopback && req.method !== 'GET' && req.headers.authorization !== `Bearer ${config.apiToken}`) {
      return send(401, { error: 'missing or wrong API token (open the UI with ?token=…)' });
    }
    const match = url.pathname.match(m.re)!;
    const params = Object.fromEntries(m.keys.map((k, i) => [k, decodeURIComponent(match[i + 1]!)]));
    let body: unknown = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { return send(400, { error: 'invalid JSON body' }); }
    try {
      send(200, await m.fn(params, body, url));
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(`[api] ${req.method} ${url.pathname}:`, (e as Error).message);
      send(e instanceof HttpError ? e.code : 500, { error: (e as Error).message });
    }
  });
});

async function main(): Promise<void> {
  dso = await registry.adminParty().catch(() => '');
  server.listen(config.port, () => console.log(`sage-canton backend+UI on http://localhost:${config.port} | pkg ${config.packageId.slice(0, 12)} | dso ${dso.slice(0, 16) || '(registry offline)'}`));
  if (process.env.AUTOMATION_PROVIDER) {
    new Automation(svc, { provider: process.env.AUTOMATION_PROVIDER, autoSettle: process.env.AUTO_SETTLE === '1', log: (msg) => console.log('[auto]', msg) }).start();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
