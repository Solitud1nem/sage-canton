// Minimal REST API over the escrow service — the seam the M5 frontend / agents talk to.
// Plain node:http to keep dependencies to zero.
import http from 'node:http';
import { config } from './config.js';
import { LedgerClient } from './ledger.js';
import { RegistryClient } from './registry.js';
import { EscrowService } from './escrow.js';
import { Automation } from './automation.js';
import { tap, walletParty } from './wallet.js';
import type { InstrumentId } from './types.js';

const ledger = new LedgerClient();
const registry = new RegistryClient();
const svc = new EscrowService(config.packageId, ledger, registry);
let dso = '';

type Handler = (params: Record<string, string>, body: any, url: URL) => Promise<unknown>;
const routes: { method: string; re: RegExp; keys: string[]; fn: Handler }[] = [];
function route(method: string, path: string, fn: Handler): void {
  const keys: string[] = [];
  const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, fn });
}
const amulet = (i?: InstrumentId): InstrumentId => i ?? { admin: dso, id: 'Amulet' };

route('GET', '/health', async () => ({ ok: true, packageId: config.packageId, dso }));
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
route('POST', '/admin/tap', async (_p, b) => { await tap(String(b.amount ?? '1000.0')); return { tapped: b.amount ?? '1000.0', party: await walletParty() }; });

class HttpError extends Error { constructor(public code: number, msg: string) { super(msg); } }

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${config.port}`);
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    const send = (code: number, obj: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const m = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
    if (!m) return send(404, { error: 'not found' });
    const match = url.pathname.match(m.re)!;
    const params = Object.fromEntries(m.keys.map((k, i) => [k, decodeURIComponent(match[i + 1]!)]));
    try {
      const body = raw ? JSON.parse(raw) : {};
      send(200, await m.fn(params, body, url));
    } catch (e) {
      const code = e instanceof HttpError ? e.code : 500;
      send(code, { error: (e as Error).message });
    }
  });
});

async function main(): Promise<void> {
  dso = await registry.adminParty().catch(() => '');
  server.listen(config.port, () => console.log(`sage-canton backend on :${config.port} | pkg ${config.packageId.slice(0, 12)} | dso ${dso.slice(0, 16) || '(registry offline)'}`));
  if (process.env.AUTOMATION_PROVIDER) {
    new Automation(svc, { provider: process.env.AUTOMATION_PROVIDER, autoSettle: process.env.AUTO_SETTLE === '1', log: (m) => console.log('[auto]', m) }).start();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
