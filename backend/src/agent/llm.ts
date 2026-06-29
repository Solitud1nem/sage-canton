// Minimal LLM client for the research agent. Uses the Anthropic Messages API when
// ANTHROPIC_API_KEY is set; otherwise falls back to a deterministic stub so the pipeline
// (and the e2e demo) runs without external credentials.
const MODEL = process.env.LLM_MODEL ?? 'claude-opus-4-8';

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

export const llmMode = (): string => (process.env.ANTHROPIC_API_KEY ? `live (${MODEL})` : 'offline-fallback');
