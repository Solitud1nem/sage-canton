// Seaport DevNet lifecycle end-to-end (runbook §C, resolves Q3 DAR-vetting + Q1 party model).
//   1. upload the clean prod DAR (we are ParticipantAdmin on the shared validator);
//   2. allocate provider/requester/worker/arbiter + an outsider, grant the m2m user CanActAs;
//   3. drive create -> accept -> complete -> approve (status-only, NO settlement — that's Q2);
//   4. prove single-participant privacy: worker sees 1, outsider sees 0.
// Run (LEDGER_TARGET=seaport-devnet in backend/.env): npx tsx src/seaport-e2e.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from './config.js';
import { LedgerClient } from './ledger.js';
import { EscrowService } from './escrow.js';
import { currentUserId } from './jwt.js';

if (config.target !== 'seaport-devnet') { console.error('set LEDGER_TARGET=seaport-devnet in backend/.env'); process.exit(2); }

const here = dirname(fileURLToPath(import.meta.url));
const darPath = join(here, '..', '..', '.daml', 'dist', 'sage-canton-0.2.0.dar');

const ledger = new LedgerClient();
// EscrowService uses a RegistryClient only in settlement paths; the lifecycle choices we
// drive here never touch it, so the default (unused on Seaport) is fine.
const svc = new EscrowService(config.packageId, ledger);

async function main(): Promise<void> {
  console.log('target        ', config.target, config.ledgerApi);

  // 1. upload the prod DAR (idempotent: KNOWN_PACKAGE_VERSION is tolerated)
  const dar = readFileSync(darPath);
  await ledger.uploadDar(dar);
  console.log('DAR uploaded  ', `sage-canton-0.2.0 (${(dar.length / 1024).toFixed(0)} KiB), pkg ${config.packageId.slice(0, 16)}…`);

  // 2. allocate parties + grant the m2m user CanActAs for them
  const sfx = Math.random().toString(36).slice(2, 8);
  const [provider, requester, worker, arbiter, outsider] = await Promise.all([
    ledger.allocateParty(`sage-prov-${sfx}`), ledger.allocateParty(`sage-req-${sfx}`),
    ledger.allocateParty(`sage-work-${sfx}`), ledger.allocateParty(`sage-arb-${sfx}`),
    ledger.allocateParty(`sage-out-${sfx}`),
  ]);
  const user = await currentUserId();
  await ledger.grantActAs(user, [provider, requester, worker, arbiter, outsider]);
  console.log('parties ready ', { provider: provider.slice(0, 18), requester: requester.slice(0, 18), worker: worker.slice(0, 18) });

  // 3. lifecycle (status-only; instrumentId is inert data here — admin=provider placeholder)
  let esc = await svc.createTask({ provider, requester, worker, arbiter, taskRef: `seaport-${sfx}`, amount: '100.0', instrumentId: { admin: provider, id: 'Amulet' } });
  console.log('created       ', esc.contractId.slice(0, 20), esc.payload.status);
  esc = await svc.accept(esc.contractId, worker);
  console.log('accepted      ', esc.payload.status);
  esc = await svc.complete(esc.contractId, worker, `artifact-${sfx}`);
  console.log('completed     ', esc.payload.status);
  esc = await svc.approve(esc.contractId, requester);
  console.log('approved      ', esc.payload.status);

  // 4. privacy: stakeholder worker sees the escrow, an outsider party sees nothing
  const workerSees = (await svc.list(worker)).length;
  const outsiderSees = (await svc.list(outsider)).length;
  console.log(`\n*** lifecycle -> ${esc.payload.status}; privacy: worker sees ${workerSees}, outsider sees ${outsiderSees} ***`);
  if (esc.payload.status !== 'Paid') throw new Error(`expected Paid, got ${esc.payload.status}`);
  if (outsiderSees !== 0) throw new Error(`privacy leak: outsider sees ${outsiderSees}`);
  console.log('✓ Seaport lifecycle + single-node privacy PASSED');
}

main().catch((e) => { console.error(e); process.exit(1); });
