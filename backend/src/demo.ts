// End-to-end smoke test of the backend against a live LocalNet: provisions parties, taps
// Amulet, and drives a TaskEscrow create -> accept -> complete -> settle, proving the worker
// is paid in real Canton Coin. Run: npm run demo  (LocalNet must be up; DAR uploaded).
import { config } from './config.js';
import { LedgerClient } from './ledger.js';
import { EscrowService } from './escrow.js';
import { walletParty, tap } from './wallet.js';
import { RegistryClient } from './registry.js';

async function main(): Promise<void> {
  const ledger = new LedgerClient();
  const registry = new RegistryClient();
  const svc = new EscrowService(config.packageId, ledger, registry);

  const requester = await walletParty();
  const sfx = Math.random().toString(36).slice(2, 8);
  const [provider, worker, arbiter] = await Promise.all([
    ledger.allocateParty(`provider-${sfx}`), ledger.allocateParty(`worker-${sfx}`), ledger.allocateParty(`arbiter-${sfx}`),
  ]);
  await ledger.grantActAs(config.adminUser, [requester, provider, worker, arbiter]);
  const dso = await registry.adminParty();
  console.log('parties ready | dso', dso.slice(0, 16));

  await tap('1000.0');
  const before = (await ledger.amuletHoldings(worker)).reduce((s, h) => s + h.amount, 0);

  let esc = await svc.createTask({ provider, requester, worker, arbiter, taskRef: `be-${sfx}`, amount: '100.0', instrumentId: { admin: dso, id: 'Amulet' } });
  console.log('created   ', esc.contractId.slice(0, 20), esc.payload.status);
  esc = await svc.accept(esc.contractId, worker);
  esc = await svc.complete(esc.contractId, worker, 'artifact-be-1');
  console.log('completed ', esc.contractId.slice(0, 20), esc.payload.status);

  esc = await svc.settle(esc);
  const after = (await ledger.amuletHoldings(worker)).reduce((s, h) => s + h.amount, 0);
  console.log('settled   ', esc.contractId.slice(0, 20), esc.payload.status);
  console.log(`\n*** worker Amulet ${before} -> ${after} (+${(after - before).toFixed(4)}); escrow -> ${esc.payload.status} ***`);
}

main().catch((e) => { console.error(e); process.exit(1); });
