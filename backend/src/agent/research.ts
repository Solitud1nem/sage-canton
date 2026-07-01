// The research agent (worker): searcher -> synthesizer producing an answer + citations.
// With an API key it does REAL web research (Anthropic's server-side web_search tool), so the
// citations are pages it actually retrieved; offline it uses a deterministic stub.
import { complete, researchWithSearch } from './llm.js';

export interface ResearchResult {
  answer: string;
  citations: string[];
  live: boolean; // true if produced by a real LLM
}

// Live path: instruct the agent to search and ground every claim in retrieved sources.
// The search-first directive matters on Opus 4.8, which otherwise answers well-known
// questions from memory (0 citations → the fact-checker fails it, correctly).
const SYSTEM_SEARCH =
  'You are a meticulous research agent. Your job is grounded research, not recall: you MUST run ' +
  'at least one web search before answering EVERY question, even ones you think you already know, ' +
  'and ground every claim ONLY in the specific pages you actually retrieved. Then produce a ' +
  'concise, factual answer and cite the pages you used. Never answer from memory without searching.';

// Offline path: deterministic JSON stub (no network).
const SYSTEM_STUB =
  'You are a meticulous research agent. Respond as strict JSON: ' +
  '{"answer": string, "citations": string[]} where each citation is a full https URL that resolves.';

export async function research(brief: string): Promise<ResearchResult> {
  if (process.env.ANTHROPIC_API_KEY) {
    const r = await researchWithSearch(SYSTEM_SEARCH, brief);
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
