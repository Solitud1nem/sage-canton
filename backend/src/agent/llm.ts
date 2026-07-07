// Minimal LLM client for the research agent, with a provider switch:
//   - OpenAI (Responses API + built-in web_search)   — default when its key is present (cheap)
//   - Anthropic (Messages API + server-side web_search)
//   - deterministic offline stub when no key is set, so the pipeline (and the e2e demo)
//     runs without external credentials.
// LLM_PROVIDER=openai|anthropic forces a provider (given its key exists); otherwise the
// first available key wins, OpenAI first — it is an order of magnitude cheaper per run.

export type Provider = 'openai' | 'anthropic' | 'off';

export function provider(): Provider {
  const forced = process.env.LLM_PROVIDER;
  if (forced === 'openai' && process.env.OPENAI_API_KEY) return 'openai';
  if (forced === 'anthropic' && process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  return 'off';
}

// LLM_MODEL / RESEARCH_MODEL override the model FOR THE ACTIVE PROVIDER.
// Anthropic research is pinned to models that support web_search_20260209 (dynamic
// filtering): Opus 4.8/4.7/4.6 or Sonnet 5/4.6 — Haiku does not qualify. Planning has no
// such constraint, so it rides the cheap tier on both providers.
const model = (): string => process.env.LLM_MODEL ?? (provider() === 'openai' ? 'gpt-5-mini' : 'claude-haiku-4-5');
const researchModel = (): string => process.env.RESEARCH_MODEL ?? (provider() === 'openai' ? 'gpt-5-mini' : 'claude-sonnet-5');

export interface LlmResult { text: string; live: boolean; }

export async function complete(system: string, prompt: string): Promise<LlmResult> {
  const prov = provider();
  if (prov === 'off') return { text: fallback(prompt), live: false };
  if (prov === 'openai') {
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      // gpt-5* are reasoning models: keep effort low for plain synthesis and leave output
      // headroom, since max_output_tokens also feeds the reasoning trace.
      body: JSON.stringify({ model: model(), instructions: system, input: prompt, reasoning: { effort: 'low' }, max_output_tokens: 2000 }),
    });
    if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return { text: outputText(await res.json()), live: true };
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY!, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: model(), max_tokens: 1024, system, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { content: { text: string }[] };
  return { text: json.content.map((c) => c.text).join(''), live: true };
}

// Concatenate the output_text parts of an OpenAI Responses payload.
function outputText(json: any): string {
  const out: string[] = [];
  for (const item of json.output ?? []) {
    if (item.type !== 'message') continue;
    for (const c of item.content ?? []) if (c.type === 'output_text' && c.text) out.push(c.text);
  }
  return out.join(' ');
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

// Real research via the provider's built-in web search: the model actually searches, and we
// harvest the URLs it retrieved/cited — real, resolvable sources the strict fact-checker
// then verifies honestly. No offline stub here; callers use `complete`'s fallback when no key.
export interface SearchResult { answer: string; citations: string[]; live: boolean; }

// Per-agent search configuration — how a given research agent actually searches differently.
export interface SearchOpts { maxUses?: number; allowedDomains?: string[]; blockedDomains?: string[]; }

export async function researchWithSearch(system: string, prompt: string, opts: SearchOpts = {}): Promise<SearchResult> {
  // Cost knobs (for cheap platform testing): RESEARCH_MAX_USES caps search rounds, RESEARCH_EFFORT
  // sets thinking depth. Offline mode (no key) spends nothing at all — see research.ts.
  const capUses = Number(process.env.RESEARCH_MAX_USES);
  const maxUses = capUses > 0 ? Math.min(capUses, opts.maxUses ?? 4) : (opts.maxUses ?? 4);
  const effort = process.env.RESEARCH_EFFORT || 'medium';
  return provider() === 'openai'
    ? researchOpenai(system, prompt, opts, maxUses, effort)
    : researchAnthropic(system, prompt, opts, maxUses, effort);
}

async function researchOpenai(system: string, prompt: string, opts: SearchOpts, maxUses: number, effort: string): Promise<SearchResult> {
  // OpenAI's web_search filters support allowed domains but not blocked ones — the docs
  // specialist's exclusions are enforced in the instructions AND by dropping any citation
  // that slips through (below), so the agent differentiation stays real.
  const tool: Record<string, unknown> = { type: 'web_search' };
  if (opts.allowedDomains?.length) tool['filters'] = { allowed_domains: opts.allowedDomains };
  const blocked = opts.blockedDomains ?? [];
  const instructions = blocked.length
    ? `${system} Never use, rely on, or cite these domains: ${blocked.join(', ')}.`
    : system;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 220_000);
  let json: any;
  try {
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: researchModel(), instructions, input: prompt,
        tools: [tool], max_tool_calls: maxUses,
        reasoning: { effort }, max_output_tokens: 4000,
      }),
    });
    if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 300)}`);
    json = await res.json();
  } finally {
    clearTimeout(timer);
  }
  const answer = outputText(json).replace(/\s+/g, ' ').trim();
  const cited = new Set<string>();
  for (const item of json.output ?? []) {
    if (item.type !== 'message') continue;
    for (const c of item.content ?? []) {
      for (const a of c.annotations ?? []) if (a.type === 'url_citation' && a.url) cited.add(a.url);
    }
  }
  const isBlocked = (u: string) => blocked.some((d) => { try { return new URL(u).hostname.endsWith(d); } catch { return true; } });
  const citations = [...cited].filter((u) => !isBlocked(u)).slice(0, 8);
  return { answer: answer || '(no answer produced)', citations, live: true };
}

async function researchAnthropic(system: string, prompt: string, opts: SearchOpts, maxUses: number, effort: string): Promise<SearchResult> {
  const key = process.env.ANTHROPIC_API_KEY!;
  const messages: { role: string; content: unknown }[] = [{ role: 'user', content: prompt }];
  const blocks: any[] = [];
  // web_search_20260209 (dynamic filtering) needs Opus 4.8/4.7/4.6 or Sonnet 5/4.6.
  const tool: Record<string, unknown> = { type: 'web_search_20260209', name: 'web_search', max_uses: maxUses };
  if (opts.allowedDomains?.length) tool['allowed_domains'] = opts.allowedDomains;
  if (opts.blockedDomains?.length) tool['blocked_domains'] = opts.blockedDomains;
  const tools = [tool];
  for (let i = 0; i < 4; i++) {
    // Bound each turn so a long server-side search loop can't hang past undici's headers timeout.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 220_000);
    let json: { content: any[]; stop_reason: string };
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: ctrl.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: researchModel(), max_tokens: 1500, system, messages, tools, output_config: { effort } }),
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

export const llmMode = (): string => {
  const prov = provider();
  return prov === 'off' ? 'offline-fallback' : `live-${prov} (${researchModel()})`;
};
