// Minimal LLM client for the research agent. Uses the Anthropic Messages API when
// ANTHROPIC_API_KEY is set; otherwise falls back to a deterministic stub so the pipeline
// (and the e2e demo) runs without external credentials.
const MODEL = process.env.LLM_MODEL ?? 'claude-opus-4-8';
// The research agent uses web search, which is much faster on Sonnet 5 than Opus 4.8 while
// still supporting the web_search_20260209 (dynamic-filtering) tool. Overridable via env.
const RESEARCH_MODEL = process.env.RESEARCH_MODEL ?? 'claude-sonnet-5';

export interface LlmResult { text: string; live: boolean; }

export async function complete(system: string, prompt: string): Promise<LlmResult> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { text: fallback(prompt), live: false };
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 1024, system, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { content: { text: string }[] };
  return { text: json.content.map((c) => c.text).join(''), live: true };
}

// Deterministic offline stand-in. Returns plausible research JSON; for briefs flagged
// "[UNVERIFIABLE]" it emits a fabricated citation so the fact-checker (which resolves URLs)
// fails it — exercising the dispute / no-payout path.
function fallback(prompt: string): string {
  const unverifiable = /unverifiable|fabricat|hallucinat/i.test(prompt);
  const citations = unverifiable
    ? ['https://nonexistent-source.invalid/whitepaper']
    : ['https://www.canton.network/', 'https://docs.daml.com/'];
  return JSON.stringify({
    answer: `Synthesised findings for: ${prompt.slice(0, 140)}. ${unverifiable ? 'Key claims rest on an internal source.' : 'Claims are grounded in public Canton/Daml documentation.'}`,
    citations,
  });
}

// Real research via Anthropic's server-side web_search tool: Claude actually searches the web,
// and we harvest the URLs it retrieved/cited — real, resolvable sources the strict fact-checker
// then verifies honestly. No offline stub here; callers use `complete`'s fallback when no key.
export interface SearchResult { answer: string; citations: string[]; live: boolean; }

export async function researchWithSearch(system: string, prompt: string, maxUses = 4): Promise<SearchResult> {
  const key = process.env.ANTHROPIC_API_KEY!;
  const messages: { role: string; content: unknown }[] = [{ role: 'user', content: prompt }];
  const blocks: any[] = [];
  // web_search_20260209 (dynamic filtering) needs Opus 4.8/4.7/4.6 or Sonnet 5/4.6.
  const tools = [{ type: 'web_search_20260209', name: 'web_search', max_uses: maxUses }];
  for (let i = 0; i < 4; i++) {
    // Bound each turn so a long server-side search loop can't hang past undici's headers timeout.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 220_000);
    let json: { content: any[]; stop_reason: string };
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: ctrl.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: RESEARCH_MODEL, max_tokens: 1500, system, messages, tools, output_config: { effort: 'medium' } }),
      });
      if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
      json = (await res.json()) as { content: any[]; stop_reason: string };
    } finally {
      clearTimeout(timer);
    }
    blocks.push(...json.content);
    if (json.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: json.content }); // resume the server-tool loop
  }

  const texts = blocks.filter((b) => b.type === 'text');
  const answer = texts.map((b) => b.text).join(' ').replace(/\s+/g, ' ').trim();
  // Prefer the URLs Claude actually cited in its answer; else the pages the search returned.
  const cited = new Set<string>();
  for (const t of texts) for (const c of t.citations ?? []) if (c?.url) cited.add(c.url);
  const found = new Set<string>();
  for (const b of blocks) {
    if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
      for (const r of b.content) if (r?.url) found.add(r.url);
    }
  }
  const citations = [...(cited.size ? cited : found)].slice(0, 8);
  return { answer: answer || '(no answer produced)', citations, live: true };
}

export const llmMode = (): string => (process.env.ANTHROPIC_API_KEY ? `live (${MODEL})` : 'offline-fallback');
