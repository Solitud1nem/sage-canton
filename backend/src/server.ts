// REST API over the escrow service + static hosting for the demo UI.
// Plain node:http to keep dependencies to zero. Serves the frontend at / so the UI shares
// the backend origin (no CORS needed); CORS headers are added anyway for separate hosting.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';
import { config } from './config.js';
import { LedgerClient } from './ledger.js';
import { RegistryClient } from './registry.js';
import { EscrowService } from './escrow.js';
import { Automation } from './automation.js';
import { tap, walletParty } from './wallet.js';
import { currentUserId } from './jwt.js';
import { AgentRunner } from './agent/runner.js';
import { llmMode } from './agent/llm.js';
import type { InstrumentId, Party } from './types.js';

const ledger = new LedgerClient();
const registry = new RegistryClient();
const svc = new EscrowService(config.packageId, ledger, registry);
const runner = new AgentRunner(svc);
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

route('GET', '/health', async () => ({ ok: true, packageId: config.packageId, dso, llm: llmMode() }));
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
route('POST', '/tasks/:cid/settle', async (p, b) => {
  const esc = await svc.get(b.provider, p.cid!);
  if (!esc) throw new HttpError(404, 'escrow not found / not visible to provider');
  return svc.settle(esc);
});
// Value-moving dispute resolution (escrow must already be Disputed): the arbiter returns
// the locked funds to the requester for real (worker paid nothing).
route('POST', '/tasks/:cid/settle-resolve-refund', async (p, b) => {
  const esc = await svc.get(b.provider, p.cid!);
  if (!esc) throw new HttpError(404, 'escrow not found / not visible to provider');
  return svc.settleResolveRefund(esc);
});
// Value-moving dispute resolution: the arbiter rules for the worker, who is paid for real.
route('POST', '/tasks/:cid/settle-resolve-pay', async (p, b) => {
  const esc = await svc.get(b.provider, p.cid!);
  if (!esc) throw new HttpError(404, 'escrow not found / not visible to provider');
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
// Demo provisioning: requester = the wallet party; allocate the other roles + an outsider
// (no stake) and grant the backend CanActAs so it can drive every perspective.
route('POST', '/admin/provision', async () => {
  const sfx = Math.random().toString(36).slice(2, 7);
  const requester = await walletParty();
  const [provider, worker, arbiter, outsider] = await Promise.all([
    ledger.allocateParty(`provider-${sfx}`), ledger.allocateParty(`worker-${sfx}`),
    ledger.allocateParty(`arbiter-${sfx}`), ledger.allocateParty(`outsider-${sfx}`),
  ]);
  await ledger.grantActAs(await currentUserId(), [requester, provider, worker, arbiter, outsider]);
  await tap('1000.0');
  return { requester, provider, worker, arbiter, outsider };
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
    const match = url.pathname.match(m.re)!;
    const params = Object.fromEntries(m.keys.map((k, i) => [k, decodeURIComponent(match[i + 1]!)]));
    try {
      send(200, await m.fn(params, raw ? JSON.parse(raw) : {}, url));
    } catch (e) {
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
