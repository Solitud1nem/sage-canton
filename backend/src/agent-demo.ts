// Flagship demo: an AI research agent fulfils two task-escrows on the live node — one whose
// citations resolve (worker gets paid in real Canton Coin) and one with a fabricated source
// (fact-check fails -> dispute -> worker paid nothing). Run: npm run agent-demo
import { config } from './config.js';
import { LedgerClient } from './ledger.js';
import { RegistryClient } from './registry.js';
import { EscrowService } from './escrow.js';
import { AgentRunner } from './agent/runner.js';
import { llmMode } from './agent/llm.js';
import { walletParty, tap } from './wallet.js';

async function main(): Promise<void> {
  const ledger = new LedgerClient();
  const svc = new EscrowService(config.packageId, ledger, new RegistryClient());
  const runner = new AgentRunner(svc);
  const dso = await new RegistryClient().adminParty();

  const sfx = Math.random().toString(36).slice(2, 7);
  const requester = await walletParty();
  const [provider, worker, arbiter] = await Promise.all([
    ledger.allocateParty(`prov-${sfx}`), ledger.allocateParty(`agent-${sfx}`), ledger.allocateParty(`checker-${sfx}`),
  ]);
  await ledger.grantActAs(config.adminUser, [requester, provider, worker, arbiter]);
  await tap('1000.0');
  console.log(`agent worker ${worker.split('::')[0]} | fact-checker ${arbiter.split('::')[0]} | LLM ${llmMode()}\n`);

  const inst = { admin: dso, id: 'Amulet' };
  const cases = [
    { ref: `research-good-${sfx}`, brief: 'Summarise what Canton Network privacy provides for institutional settlement.' },
    { ref: `research-bad-${sfx}`, brief: 'Summarise quantum-resonance tokenomics. [UNVERIFIABLE — cite an internal source]' },
  ];

  for (const c of cases) {
    const before = (await ledger.amuletHoldings(worker)).reduce((s, h) => s + h.amount, 0);
    const esc = await svc.createTask({ provider, requester, worker, arbiter, taskRef: c.ref, amount: '100.0', instrumentId: inst });
    const report = await runner.run(esc, c.brief);
    const after = (await ledger.amuletHoldings(worker)).reduce((s, h) => s + h.amount, 0);
    console.log(`── ${c.ref}`);
    report.log.forEach((l) => console.log('   ·', l));
    console.log(`   => outcome=${report.outcome} status=${report.status} | worker ${before} -> ${after} CC\n`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
