// Seaport DevNet REAL settlement e2e (runbook §7 / Q2 — the public-node money-moment).
// Faucet real Canton Coin into the wallet party, run a TaskEscrow to Completed, fund the
// CIP-0056 allocation via the validator scan-proxy registry, and settle — the worker's real
// CC balance rises on a PUBLIC node. Run (LEDGER_TARGET=seaport-devnet): npx tsx src/seaport-settle.ts
import { config } from './config.js';
import { LedgerClient } from './ledger.js';
import { EscrowService } from './escrow.js';
import { RegistryClient } from './registry.js';
import { walletParty, tap } from './wallet.js';
import { currentUserId } from './jwt.js';

if (config.target !== 'seaport-devnet') { console.error('set LEDGER_TARGET=seaport-devnet in backend/.env'); process.exit(2); }

const ledger = new LedgerClient();
const registry = new RegistryClient();
const svc = new EscrowService(config.packageId, ledger, registry);
const bal = async (p: string) => (await ledger.amuletHoldings(p)).reduce((s, h) => s + h.amount, 0);

async function main(): Promise<void> {
  const requester = await walletParty();            // 5nsandbox-devnet-2 (wallet party, tappable)
  const dso = await registry.adminParty();           // DSO — the Amulet instrument admin
  const sfx = Math.random().toString(36).slice(2, 8);
  const [provider, worker, arbiter] = await Promise.all([
    ledger.allocateParty(`sage-prov-${sfx}`), ledger.allocateParty(`sage-work-${sfx}`), ledger.allocateParty(`sage-arb-${sfx}`),
  ]);
  const user = await currentUserId();
  await ledger.grantActAs(user, [requester, provider, worker, arbiter]);
  console.log('registry DSO  ', dso.slice(0, 24) + '…');
  console.log('requester     ', requester.slice(0, 24) + '…  (wallet)');
  console.log('worker        ', worker.slice(0, 24) + '…');

  await tap('200.0');
  const workerBefore = await bal(worker);
  console.log('tapped 200 CC → requester; worker balance before:', workerBefore);

  let esc = await svc.createTask({ provider, requester, worker, arbiter, taskRef: `settle-${sfx}`, amount: '100.0', instrumentId: { admin: dso, id: 'Amulet' } });
  console.log('created       ', esc.payload.status);
  esc = await svc.accept(esc.contractId, worker);
  esc = await svc.complete(esc.contractId, worker, `artifact-${sfx}`);
  console.log('completed     ', esc.payload.status);

  esc = await svc.settle(esc);   // fund allocation via registry → SettlePayment (worker claims)
  const workerAfter = await bal(worker);
  console.log('settled       ', esc.payload.status);
  console.log(`\n*** REAL settlement on Seaport DevNet: worker CC ${workerBefore} → ${workerAfter} (+${(workerAfter - workerBefore).toFixed(4)}); escrow → ${esc.payload.status} ***`);
  if (esc.payload.status !== 'Paid') throw new Error(`expected Paid, got ${esc.payload.status}`);
  if (workerAfter <= workerBefore) throw new Error('worker balance did not increase');
  console.log('✓ Seaport REAL Canton Coin settlement PASSED (money moved on a public node)');
}

main().catch((e) => { console.error(e); process.exit(1); });
