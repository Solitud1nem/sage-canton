// Seaport: prove the on-ledger AgentRegistry + that agent roles research DIFFERENTLY.
// Run (LEDGER_TARGET=seaport-devnet): npx tsx src/seaport-agents.ts
import { config } from './config.js';
import { LedgerClient } from './ledger.js';
import { currentUserId } from './jwt.js';
import { AgentRegistryService, AGENT_ROLES } from './agents.js';
import { research } from './agent/research.js';

if (config.target !== 'seaport-devnet') { console.error('set LEDGER_TARGET=seaport-devnet'); process.exit(2); }
const ledger = new LedgerClient();
const reg = new AgentRegistryService(config.packageId, ledger);
const BLOCKED = ['medium.com', 'reddit.com', 'quora.com', 'substack.com', 'linkedin.com'];

async function main(): Promise<void> {
  const sfx = Math.random().toString(36).slice(2, 6);
  const [provider, w1, w2, w3] = await Promise.all([
    ledger.allocateParty(`prov-${sfx}`), ledger.allocateParty(`agent-1-${sfx}`),
    ledger.allocateParty(`agent-2-${sfx}`), ledger.allocateParty(`agent-3-${sfx}`),
  ]);
  await ledger.grantActAs(await currentUserId(), [provider, w1, w2, w3]);

  // 1. register on-ledger + read back from the registry
  const roster = [{ party: w1, role: AGENT_ROLES[0]! }, { party: w2, role: AGENT_ROLES[1]! }, { party: w3, role: AGENT_ROLES[2]! }];
  await reg.register(provider, roster);
  const listed = await reg.list(provider);
  console.log('=== on-ledger AgentRegistry ===');
  listed.forEach((a) => console.log(`  ${a.name} [${a.role}] · caps=${a.capabilities.join(',')} · ${a.pricing} CC`));
  if (listed.length !== 3) throw new Error(`expected 3 registered agents, got ${listed.length}`);

  // 2. same question, two roles → genuinely different sources
  const q = 'How does the Canton Network provide privacy for institutions?';
  const web = await research(q, 'web');
  const docs = await research(q, 'docs');
  console.log('\n=== Web Researcher citations ===');
  web.citations.forEach((u) => console.log('  ', u));
  console.log('=== Standards & Docs Specialist citations ===');
  docs.citations.forEach((u) => console.log('  ', u));
  const leak = docs.citations.filter((u) => BLOCKED.some((d) => u.includes(d)));
  console.log(`\ndocs specialist blocked-domain hits: ${leak.length} (expected 0)`);
  if (leak.length) throw new Error(`docs specialist cited blocked domains: ${leak.join(', ')}`);
  console.log('✓ on-ledger registry + role-differentiated research PASSED');
}
main().catch((e) => { console.error(e); process.exit(1); });
