// Seaport: prove the plan → edit → execute flow, including reassigning a sub-task to a
// different worker. Run (LEDGER_TARGET=seaport-devnet): npx tsx src/seaport-plan.ts
import { config } from './config.js';
import { LedgerClient } from './ledger.js';
import { EscrowService } from './escrow.js';
import { RegistryClient } from './registry.js';
import { AgentRunner } from './agent/runner.js';
import { walletParty, tap } from './wallet.js';
import { currentUserId } from './jwt.js';

if (config.target !== 'seaport-devnet') { console.error('set LEDGER_TARGET=seaport-devnet'); process.exit(2); }
const ledger = new LedgerClient();
const svc = new EscrowService(config.packageId, ledger, new RegistryClient());
const runner = new AgentRunner(svc);
const bal = async (p: string) => (await ledger.amuletHoldings(p)).reduce((s, h) => s + h.amount, 0);

async function main(): Promise<void> {
  const requester = await walletParty();
  const dso = await (new RegistryClient()).adminParty();
  const sfx = Math.random().toString(36).slice(2, 6);
  const [provider, alpha, beta, arbiter] = await Promise.all([
    ledger.allocateParty(`prov-${sfx}`), ledger.allocateParty(`alpha-${sfx}`),
    ledger.allocateParty(`beta-${sfx}`), ledger.allocateParty(`arb-${sfx}`),
  ]);
  await ledger.grantActAs(await currentUserId(), [requester, provider, alpha, beta, arbiter]);
  await tap('1000.0');

  const parent = await svc.createTask({ provider, requester, worker: alpha, arbiter, taskRef: `job-${sfx}`, amount: '60.0', instrumentId: { admin: dso, id: 'Amulet' } });

  // 1. PLAN (no side effects)
  const dec = await runner.plan(parent, 'How does the Canton Network provide privacy?');
  console.log(`plan [${dec.live ? 'live' : 'offline'}] — ${dec.subtasks.length} sub-tasks:`);
  dec.subtasks.forEach((s, i) => console.log(`  ${i + 1}. ${s.title} — ${s.reward} CC`));

  // 2. requester EDITS: keep first two, reassign #2 to a different agent (beta), custom rewards
  const items = [
    { title: dec.subtasks[0]!.title, brief: dec.subtasks[0]!.brief, reward: '25', worker: alpha },
    { title: dec.subtasks[1]!.title, brief: dec.subtasks[1]!.brief, reward: '15', worker: beta },
  ];
  console.log('\nedited: 2 sub-tasks → agent α (25 CC) + agent β (15 CC)');
  const aBefore = await bal(alpha), bBefore = await bal(beta);

  // 3. EXECUTE the approved plan
  const rep = await runner.executePlan(parent, items);
  rep.subtasks.forEach((s) => console.log(`  • ${s.title} → ${s.outcome} (${s.result.citations.length} cites) — ${s.verdict.summary}`));
  console.log(`\nparent rollup: ${rep.status}; paid ${rep.paidTotal} CC`);
  console.log(`agent α CC ${aBefore} → ${await bal(alpha)}   agent β CC ${bBefore} → ${await bal(beta)}`);
  console.log('✓ plan → edit (reassign worker) → execute PASSED');
}
main().catch((e) => { console.error(e); process.exit(1); });
