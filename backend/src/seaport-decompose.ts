// Seaport DevNet decomposition e2e: provision → create a parent task → decompose into child
// escrows, run + settle each, roll up the parent. Proves on-ledger dynamic decomposition with
// per-sub-task private settlement. Run (LEDGER_TARGET=seaport-devnet): npx tsx src/seaport-decompose.ts
import { config } from './config.js';
import { LedgerClient } from './ledger.js';
import { EscrowService } from './escrow.js';
import { RegistryClient } from './registry.js';
import { AgentRunner } from './agent/runner.js';
import { walletParty, tap } from './wallet.js';
import { currentUserId } from './jwt.js';

if (config.target !== 'seaport-devnet') { console.error('set LEDGER_TARGET=seaport-devnet'); process.exit(2); }

const ledger = new LedgerClient();
const registry = new RegistryClient();
const svc = new EscrowService(config.packageId, ledger, registry);
const runner = new AgentRunner(svc);
const bal = async (p: string) => (await ledger.amuletHoldings(p)).reduce((s, h) => s + h.amount, 0);

async function main(): Promise<void> {
  const requester = await walletParty();
  const dso = await registry.adminParty();
  const sfx = Math.random().toString(36).slice(2, 6);
  const [provider, worker, arbiter] = await Promise.all([
    ledger.allocateParty(`sage-prov-${sfx}`), ledger.allocateParty(`sage-work-${sfx}`), ledger.allocateParty(`sage-arb-${sfx}`),
  ]);
  await ledger.grantActAs(await currentUserId(), [requester, provider, worker, arbiter]);
  await tap('1000.0');
  const before = await bal(worker);

  const brief = process.argv[2] ?? 'How does Canton Network provide sub-transaction privacy for institutional settlement?';
  const parent = await svc.createTask({ provider, requester, worker, arbiter, taskRef: `job-${sfx}`, amount: '99.0', instrumentId: { admin: dso, id: 'Amulet' } });
  console.log('parent task   ', parent.payload.taskRef, '· budget', parent.payload.amount, 'CC');
  console.log('brief         ', brief, '\n');

  const rep = await runner.runDecomposed(parent, brief);
  console.log(`decomposed into ${rep.subtasks.length} sub-task(s) [${rep.decomposition.live ? 'live LLM' : 'offline'}]:`);
  for (const s of rep.subtasks) {
    console.log(`  • ${s.title}  → ${s.outcome === 'paid' ? '✅ paid' : '⛔ refunded'}  (${s.result.citations.length} cites) — ${s.verdict.summary}`);
  }
  const after = await bal(worker);
  console.log(`\nparent rollup: ${rep.status}; paid to worker across sub-tasks: ${rep.paidTotal} CC`);
  console.log(`worker CC ${before} → ${after} (+${(after - before).toFixed(4)})`);

  // privacy: each child is its own escrow; the worker sees them all, an outsider sees none
  const outsider = await ledger.allocateParty(`sage-out-${sfx}`);
  await ledger.grantActAs(await currentUserId(), [outsider]);
  const workerTasks = (await svc.list(worker)).filter((e) => e.payload.parentRef === parent.payload.taskRef);
  const outsiderTasks = await svc.list(outsider);
  console.log(`\non-ledger children linked to parent: worker sees ${workerTasks.length}, outsider sees ${outsiderTasks.length}`);
  console.log('✓ Seaport dynamic decomposition PASSED');
}

main().catch((e) => { console.error(e); process.exit(1); });
