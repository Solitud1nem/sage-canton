// The research agent (worker): searcher -> synthesizer producing an answer + citations.
// With an API key it does REAL web research (Anthropic's server-side web_search tool), so the
// citations are pages it actually retrieved; offline it uses a deterministic stub.
//
// Agents are specialised (registered in the AgentRegistry with capabilities): each role runs a
// GENUINELY different search — different scope and focus — not just a different label.
import { complete, researchWithSearch, type SearchOpts } from './llm.js';

export type RoleKey = 'web' | 'docs' | 'analyst';

export interface ResearchResult {
  answer: string;
  citations: string[];
  live: boolean; // true if produced by a real LLM
}

// Base directive: the agent's job is grounded research, not recall — always search, always cite.
// (Matters on modern models, which otherwise answer well-known questions from memory → 0 cites.)
const BASE = 'You are a meticulous research agent. Your job is grounded research, not recall: you MUST run ' +
  'at least one web search before answering EVERY question, and ground every claim ONLY in the specific ' +
  'pages you actually retrieved. Produce a concise, factual answer and cite the pages you used.';

// Aggregator / social / blog-farm domains the docs specialist excludes to force primary sources.
const LOW_QUALITY = ['medium.com', 'reddit.com', 'quora.com', 'pinterest.com', 'facebook.com',
  'instagram.com', 'x.com', 'twitter.com', 'linkedin.com', 'substack.com'];

// Each role is a real behavioural difference (search scope + focus), mirroring its registry capabilities.
const ROLES: Record<RoleKey, { system: string; opts: SearchOpts }> = {
  web: {
    system: `${BASE} You are a generalist: search broadly across the open web for the best sources.`,
    opts: { maxUses: 5 },
  },
  docs: {
    system: `${BASE} You are a standards & documentation specialist: prefer official documentation, ` +
      `specifications, standards bodies and primary/reference sources over blogs and aggregators.`,
    opts: { maxUses: 4, blockedDomains: LOW_QUALITY },
  },
  analyst: {
    system: `${BASE} You are a data analyst: dig for concrete figures, benchmarks, statistics and dates, ` +
      `and make the answer quantitative — lead with the numbers you found and cite the data sources.`,
    opts: { maxUses: 6 },
  },
};

const SYSTEM_STUB =
  'You are a meticulous research agent. Respond as strict JSON: ' +
  '{"answer": string, "citations": string[]} where each citation is a full https URL that resolves.';

export async function research(brief: string, role: RoleKey = 'web'): Promise<ResearchResult> {
  if (process.env.ANTHROPIC_API_KEY) {
    const cfg = ROLES[role] ?? ROLES.web;
    const r = await researchWithSearch(cfg.system, brief, cfg.opts);
    return { answer: r.answer.slice(0, 2000), citations: r.citations, live: r.live };
  }
  const { text, live } = await complete(SYSTEM_STUB, brief);
  const parsed = safeParse(text);
  return {
    answer: String(parsed.answer ?? text).slice(0, 2000),
    citations: (Array.isArray(parsed.citations) ? parsed.citations : []).map(String).slice(0, 8),
    live,
  };
}

function safeParse(text: string): { answer?: unknown; citations?: unknown } {
  try { return JSON.parse(text); } catch { /* fall through */ }
  const m = text.match(/\{[\s\S]*\}/); // tolerate prose around the JSON
  if (m) { try { return JSON.parse(m[0]); } catch { /* ignore */ } }
  return {};
}
