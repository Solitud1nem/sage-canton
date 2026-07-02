// The paid fact-checker (maps to the TaskEscrow arbiter): a result passes only if every
// cited source actually resolves over HTTP. Unresolvable / fabricated citations => fail,
// which drives the dispute / no-payout path.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
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
// EPRIVATE / EPROTO / EREDIRECT come from our own SSRF guard below and are equally final.
const DEFINITIVE = new Set(['ENOTFOUND', 'ECONNREFUSED', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_INVALID_URL', 'EPRIVATE', 'EPROTO', 'EREDIRECT']);

const errCode = (e: unknown): string | undefined =>
  (e as { code?: string })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;
const fail = (msg: string, code: string): Error => Object.assign(new Error(msg), { code });

// SSRF guard: citations come from LLM output (ultimately from a client-supplied brief), and
// we fetch them server-side — so only allow http(s) to hosts that resolve to PUBLIC addresses.
// Without this, a crafted citation lets the fact-checker probe localhost / cloud metadata /
// the internal network and leak reachability via status codes.
function isPrivateAddr(addr: string): boolean {
  if (addr.includes(':')) { // IPv6
    const a = addr.toLowerCase();
    if (a.startsWith('::ffff:')) return isPrivateAddr(a.slice(7)); // v4-mapped
    return a === '::' || a === '::1' || a.startsWith('fc') || a.startsWith('fd') || a.startsWith('fe80');
  }
  const o = addr.split('.').map(Number);
  return o[0] === 0 || o[0] === 10 || o[0] === 127
    || (o[0] === 100 && o[1]! >= 64 && o[1]! <= 127)   // CGNAT
    || (o[0] === 169 && o[1] === 254)                   // link-local / cloud metadata
    || (o[0] === 172 && o[1]! >= 16 && o[1]! <= 31)
    || (o[0] === 192 && o[1] === 168);
}

async function assertPublicUrl(url: string): Promise<void> {
  const u = new URL(url); // throws ERR_INVALID_URL
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw fail(`unsupported protocol ${u.protocol}`, 'EPROTO');
  const host = u.hostname.replace(/^\[|\]$/g, ''); // bare IPv6 literals come bracketed
  const addr = isIP(host) ? host : (await lookup(host)).address; // ENOTFOUND for fabricated domains
  if (isPrivateAddr(addr)) throw fail(`${host} resolves to a private address`, 'EPRIVATE');
}

// Follow redirects MANUALLY so every hop is SSRF-checked too (a public page could otherwise
// bounce the checker to an internal address).
async function fetchStatus(url: string, method: string, timeoutMs: number): Promise<number> {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    await assertPublicUrl(current);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(current, { method, redirect: 'manual', signal: ctrl.signal, headers: BROWSER_HEADERS });
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) { current = new URL(loc, current).href; continue; }
      return res.status;
    } finally {
      clearTimeout(t);
    }
  }
  throw fail('too many redirects', 'EREDIRECT');
}

async function resolves(url: string): Promise<CitationCheck> {
  try {
    let status: number;
    try {
      status = await fetchStatus(url, 'HEAD', 9000);
    } catch (e) {
      const code = errCode(e);
      if (code && DEFINITIVE.has(code)) return { url, ok: false, error: code }; // fabricated / dead / off-limits
      status = await fetchStatus(url, 'GET', 13000); // slow or HEAD-hostile → one longer GET
    }
    // HEAD often 405/403/501 on servers that serve the page fine to GET.
    if (status === 405 || status === 403 || status === 501) status = await fetchStatus(url, 'GET', 13000);
    const ok = status < 400 || EXISTS_DESPITE_BLOCK.has(status);
    return { url, ok, status };
  } catch (e) {
    return { url, ok: false, error: errCode(e) ?? (e as Error).name };
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
