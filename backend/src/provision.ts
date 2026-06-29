// Dev helper: provision a fresh set of demo parties (requester=wallet party) + tap Amulet.
// Prints {requester,provider,worker,arbiter} as JSON. Run: npx tsx src/provision.ts
import { LedgerClient } from './ledger.js';
import { walletParty, tap } from './wallet.js';
import { config } from './config.js';

const ledger = new LedgerClient();
const sfx = Math.random().toString(36).slice(2, 7);
const requester = await walletParty();
const [provider, worker, arbiter] = await Promise.all([
  ledger.allocateParty(`prov-${sfx}`), ledger.allocateParty(`work-${sfx}`), ledger.allocateParty(`arb-${sfx}`),
]);
await ledger.grantActAs(config.adminUser, [requester, provider, worker, arbiter]);
await tap('1000.0');
console.log(JSON.stringify({ requester, provider, worker, arbiter }));
