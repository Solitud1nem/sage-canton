// Seaport DevNet read-only probe: what identity/rights does the m2m token carry, and
// what parties/users already exist? Informs the party model (runbook §5 / Q1). No writes.
// Run: npx tsx src/probe-seaport.ts
import { config } from './config.js';
import { getSeaportToken } from './auth.js';

if (config.auth.mode !== 'oidc') { console.error('set LEDGER_TARGET=seaport-devnet'); process.exit(2); }
const token = await getSeaportToken(config.auth);

// decode the JWT payload (no verify — just inspection)
const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
console.log('=== JWT payload ===');
console.log(JSON.stringify(payload, null, 2));

async function get(path: string) {
  const res = await fetch(`${config.ledgerApi}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  let body: any; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

for (const path of ['/v2/users', '/v2/parties', '/v2/version']) {
  const r = await get(path);
  console.log(`\n=== GET ${path} -> ${r.status} ===`);
  console.log(JSON.stringify(r.body, null, 2).slice(0, 2000));
}
