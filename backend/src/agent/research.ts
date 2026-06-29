// The research agent (worker): searcher -> synthesizer producing an answer + citations.
import { complete } from './llm.js';

export interface ResearchResult {
  answer: string;
  citations: string[];
  live: boolean; // true if produced by a real LLM
}

const SYSTEM =
  'You are a meticulous research agent. Given a question, produce a concise factual answer ' +
  'grounded ONLY in real, resolvable public web sources. Respond as strict JSON: ' +
  '{"answer": string, "citations": string[]} where each citation is a full https URL that resolves.';

export async function research(brief: string): Promise<ResearchResult> {
  const { text, live } = await complete(SYSTEM, brief);
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
