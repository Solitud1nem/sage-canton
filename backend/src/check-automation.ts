// Validates the automation poller: create an already-overdue task, run one tick, expect Expire.
import { config } from './config.js';
import { LedgerClient } from './ledger.js';
import { RegistryClient } from './registry.js';
import { EscrowService } from './escrow.js';
import { Automation } from './automation.js';
import { walletParty } from './wallet.js';

const ledger = new LedgerClient();
const svc = new EscrowService(config.packageId, ledger, new RegistryClient());
const sfx = Math.random().toString(36).slice(2, 7);
const requester = await walletParty();
const [provider, worker, arbiter] = await Promise.all([
  ledger.allocateParty(`aprov-${sfx}`), ledger.allocateParty(`awork-${sfx}`), ledger.allocateParty(`aarb-${sfx}`),
]);
await ledger.grantActAs(config.adminUser, [requester, provider, worker, arbiter]);

// deadline 60s in the PAST -> immediately overdue
const esc = await svc.createTask({ provider, requester, worker, arbiter, taskRef: `auto-${sfx}`, amount: '5.0', instrumentId: { admin: 'x', id: 'Amulet' }, deadlineSeconds: -60 });
console.log('created overdue task', esc.contractId.slice(0, 18), esc.payload.status);

const auto = new Automation(svc, { provider, autoExpire: true, log: (m) => console.log('[auto]', m) });
const r = await auto.tick();
console.log('tick result:', JSON.stringify(r));
const after = await svc.list(provider);
const mine = after.find((e) => e.payload.taskRef === `auto-${sfx}`);
console.log('task status after tick:', mine?.payload.status);
console.log(mine?.payload.status === 'Expired' && r.expired === 1 ? 'AUTOMATION_OK' : 'AUTOMATION_FAIL');
