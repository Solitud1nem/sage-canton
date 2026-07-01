// Seaport DevNet settlement recon (runbook §7 / Q2). READ-ONLY.
// 1. Is Amulet (Canton Coin) on this ledger at all, and who is the instrument admin (DSO)?
//    We hold CanReadAsAnyParty, so we can inspect existing parties' Holding-interface contracts.
// 2. Is a CIP-0056 token-standard registry (scan) HTTP endpoint reachable at a guessable URL?
// Run: LEDGER_TARGET=seaport-devnet npx tsx src/probe-settlement.ts
import { config } from './config.js';
import { getSeaportToken } from './auth.js';

if (config.auth.mode !== 'oidc') { console.error('set LEDGER_TARGET=seaport-devnet'); process.exit(2); }
const token = await getSeaportToken(config.auth);
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

// Resolve party ids the m2m user can read, from its rights (namespace suffix varies).
async function allKnownParties(): Promise<string[]> {
  const set = new Set<string>();
  const ru = await fetch(`${config.ledgerApi}/v2/users/6/rights`, { headers: H });
  const rights = ((await ru.json()) as { rights?: any[] }).rights ?? [];
  for (const r of rights) {
    const v = Object.values(r.kind)[0] as any; if (v?.value?.party) set.add(v.value.party);
  }
  return [...set];
}

const ledgerEnd = (await (await fetch(`${config.ledgerApi}/v2/state/ledger-end`, { headers: H })).json()) as { offset: number };

async function holdings(party: string) {
  // Try package-NAME interface filter first (3.5.6 prefers it), then package-id fallback.
  for (const interfaceId of ['#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding',
                             '718a0f77e505a8de22f188bd4c87fe74101274e9d4cb1bfac7d09aec7158d35b:Splice.Api.Token.HoldingV1:Holding']) {
    const body = { filter: { filtersByParty: { [party]: { cumulative: [{ identifierFilter: { InterfaceFilter: { value: { interfaceId, includeInterfaceView: true } } } }] } } }, verbose: true, activeAtOffset: ledgerEnd.offset };
    const res = await fetch(`${config.ledgerApi}/v2/state/active-contracts`, { method: 'POST', headers: H, body: JSON.stringify(body) });
    if (res.status !== 200) continue;
    const arr = await res.json();
    const views: any[] = [];
    for (const it of Array.isArray(arr) ? arr : []) {
      const ce = it?.contractEntry?.JsActiveContract?.createdEvent;
      for (const iv of ce?.interfaceViews ?? []) if (iv.viewValue) views.push(iv.viewValue);
    }
    return views;
  }
  return [];
}

console.log('=== 1. Amulet on-ledger? (Holding interface across known parties) ===');
const admins = new Set<string>();
const parties = [...new Set([...(await allKnownParties())])];
let checked = 0;
for (const p of parties) {
  const hs = await holdings(p);
  checked++;
  if (hs.length) {
    const amulet = hs.filter((v: any) => v?.instrumentId?.id === 'Amulet');
    const other = hs.filter((v: any) => v?.instrumentId?.id !== 'Amulet');
    if (amulet.length) {
      admins.add(amulet[0].instrumentId.admin);
      console.log(`  ${p.slice(0, 28)}… : ${amulet.length} Amulet holding(s), admin=${String(amulet[0].instrumentId.admin).slice(0, 40)}…`);
    }
    if (other.length) console.log(`  ${p.slice(0, 28)}… : ${other.length} non-Amulet holding(s) instrIds=${[...new Set(other.map((v:any)=>v.instrumentId?.id))].join(',')}`);
  }
  if (checked >= 60) break; // cap
}
console.log(`checked ${checked}/${parties.length} parties; distinct Amulet admins:`, [...admins].map(a=>a.slice(0,40)+'…'));

console.log('\n=== 2. Registry/scan HTTP endpoint reachable? ===');
const bases = [
  'https://scan.validator.devnet.sandbox.fivenorth.io',
  'https://scan.sv.devnet.sandbox.fivenorth.io',
  'https://scan.devnet.sandbox.fivenorth.io',
  'https://validator.devnet.sandbox.fivenorth.io',
  'https://ledger-api.validator.devnet.sandbox.fivenorth.io',
  'https://wallet.devnet.sandbox.fivenorth.io',
];
for (const base of bases) {
  for (const path of ['/registry/metadata/v1/info', '/api/scan/v0/dso']) {
    try {
      const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(6000) });
      const t = (await res.text()).slice(0, 120);
      console.log(`  ${res.status}  ${base}${path}  ${t.replace(/\s+/g,' ')}`);
    } catch (e: any) {
      console.log(`  ERR  ${base}${path}  ${e?.cause?.code ?? e?.name ?? e?.message}`);
    }
  }
}
