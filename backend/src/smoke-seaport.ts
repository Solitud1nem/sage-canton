// Seaport DevNet smoke test — DO THIS FIRST (runbook §6).
// Exchanges an OIDC client_credentials token, then hits GET /v2/state/ledger-end.
// Run: npm run smoke:seaport   (fill backend/.env from the Seaport access PDF first)
import { config } from './config.js';
import { getSeaportToken } from './auth.js';

if (config.auth.mode !== 'oidc') {
  console.error(`LEDGER_TARGET is '${config.target}', not seaport-devnet. Set LEDGER_TARGET=seaport-devnet in backend/.env.`);
  process.exit(2);
}

const token = await getSeaportToken(config.auth);
console.log(`✓ OIDC token acquired (${token.length} chars, exp ~8h)`);

const url = `${config.ledgerApi}/v2/state/ledger-end`;
const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
const text = await res.text();
console.log(`GET ${url}\n${res.status} ${text}`);

if (res.status !== 200) {
  console.error('✗ ledger-end did not return 200 — check the URL / audience / party rights.');
  process.exit(1);
}
console.log('✓ Seaport DevNet reachable — connectivity smoke passed.');
