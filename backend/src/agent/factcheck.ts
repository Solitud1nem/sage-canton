// The paid fact-checker (maps to the TaskEscrow arbiter): a result passes only if every
// cited source actually resolves over HTTP. Unresolvable / fabricated citations => fail,
// which drives the dispute / no-payout path.
import type { ResearchResult } from './research.js';

export interface CitationCheck { url: string; ok: boolean; status?: number; error?: string; }
export interface Verdict { pass: boolean; checks: CitationCheck[]; summary: string; }

// A citation "exists" if a live server recognizes the resource. We honestly distinguish
// "the page is real but the server blocks/limits our automated request" (401/403/405/429 —
// common on Britannica, Reuters, gov sites) from "the source does not exist" (404/410, DNS
// failure, or connection timeout). Fabricated citations — the thing we must catch — surface
// as a DNS failure (made-up domain) or 404, so they still fail. A browser-like User-Agent
// cuts down false bot-blocks. This is stricter about fabrication, not looser.
const EXISTS_DESPITE_BLOCK = new Set([401, 403, 405, 429]);
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

// DNS-level / connection-refused failures are definitive: the source does not exist / is
// unreachable → fail immediately (this is how fabricated domains surface). A timeout is only
// "too slow", so we give a real-but-slow page a second, longer chance via GET before judging.
const DEFINITIVE = new Set(['ENOTFOUND', 'ECONNREFUSED', 'ERR_TLS_CERT_ALTNAME_INVALID']);

async function fetchStatus(url: string, method: string, timeoutMs: number): Promise<number> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, redirect: 'follow', signal: ctrl.signal, headers: BROWSER_HEADERS });
    return res.status;
  } finally {
    clearTimeout(t);
  }
}

async function resolves(url: string): Promise<CitationCheck> {
  try {
    let status: number;
    try {
      status = await fetchStatus(url, 'HEAD', 9000);
    } catch (e) {
      const code = (e as { cause?: { code?: string } })?.cause?.code;
      if (code && DEFINITIVE.has(code)) return { url, ok: false, error: code }; // fabricated / dead
      status = await fetchStatus(url, 'GET', 13000); // slow or HEAD-hostile → one longer GET
    }
    // HEAD often 405/403/501 on servers that serve the page fine to GET.
    if (status === 405 || status === 403 || status === 501) status = await fetchStatus(url, 'GET', 13000);
    const ok = status < 400 || EXISTS_DESPITE_BLOCK.has(status);
    return { url, ok, status };
  } catch (e) {
    return { url, ok: false, error: (e as { cause?: { code?: string } })?.cause?.code ?? (e as Error).name };
  }
}

export async function factCheck(result: ResearchResult): Promise<Verdict> {
  if (result.citations.length === 0) {
    return { pass: false, checks: [], summary: 'no citations provided' };
  }
  const checks = await Promise.all(result.citations.map((u) => resolves(u)));
  const bad = checks.filter((c) => !c.ok);
  return {
    pass: bad.length === 0,
    checks,
    summary: bad.length === 0
      ? `all ${checks.length} citation(s) resolve`
      : `${bad.length}/${checks.length} citation(s) failed to resolve: ${bad.map((b) => b.url).join(', ')}`,
  };
}
