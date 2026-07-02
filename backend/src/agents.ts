// Agent roster + on-ledger AgentRegistry integration.
//
// Each role is a real specialisation (distinct search behaviour in agent/research.ts) with
// capabilities published on-ledger as an AgentProfile. Discovery is off-ledger (the backend
// reads the profiles it operates and serves them to the UI) — profiles are private to
// (registryOperator, agent), so there is no global-visibility leak. See AgentRegistry.daml.
import { config } from './config.js';
import { LedgerClient } from './ledger.js';
import type { Party } from './types.js';
import type { RoleKey } from './agent/research.js';

export interface AgentRole {
  key: RoleKey;
  name: string;
  capabilities: string[];
  pricing: string;   // indicative CC per task
  blurb: string;     // one-line description of how it works differently
}

export const AGENT_ROLES: AgentRole[] = [
  { key: 'web', name: 'Web Researcher', capabilities: ['web-research', 'general'], pricing: '20',
    blurb: 'Searches broadly across the open web for the best sources.' },
  { key: 'docs', name: 'Standards & Docs Specialist', capabilities: ['docs-research', 'standards'], pricing: '25',
    blurb: 'Restricts search to primary docs & standards (excludes blogs/aggregators).' },
  { key: 'analyst', name: 'Data Analyst', capabilities: ['web-research', 'data-analysis'], pricing: '30',
    blurb: 'Digs deeper for figures & benchmarks; answers quantitatively.' },
];

export interface AgentEntry { party: Party; name: string; capabilities: string[]; pricing: string; role: RoleKey; }

const SUFFIX = ':AgentRegistry:AgentProfile';

export class AgentRegistryService {
  private readonly te: string;       // package-id qualified (commands)
  private readonly teQuery: string;  // package-name qualified (ACS queries)
  constructor(packageId: string, private readonly ledger = new LedgerClient()) {
    this.te = `${packageId}:AgentRegistry:AgentProfile`;
    this.teQuery = `#${config.packageName}:AgentRegistry:AgentProfile`;
  }

  /** Publish an AgentProfile on-ledger for each agent (registryOperator = provider). */
  async register(operator: Party, agents: { party: Party; role: AgentRole }[]): Promise<void> {
    for (const a of agents) {
      await this.ledger.submit([{ CreateCommand: { templateId: this.te, createArguments: {
        registryOperator: operator, agent: a.party, name: a.role.name,
        capabilities: a.role.capabilities, endpoint: `https://sage-canton.local/agents/${a.role.key}`,
        pricing: a.role.pricing, active: true,
      } } }], [operator]);
    }
  }

  /** Read the AgentProfiles this operator registered (proves the on-ledger registry). */
  async list(operator: Party): Promise<AgentEntry[]> {
    const evs = await this.ledger.activeContracts(operator, { templateId: this.teQuery });
    const byName = new Map(AGENT_ROLES.map((r) => [r.name, r.key] as const));
    return evs.filter((e) => e.templateId.endsWith(SUFFIX)).map((e) => {
      const p = e.createArgument as any;
      return { party: p.agent as Party, name: p.name as string, capabilities: p.capabilities as string[],
        pricing: String(p.pricing), role: (byName.get(p.name) ?? 'web') as RoleKey };
    });
  }
}
