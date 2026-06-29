// The paid fact-checker (maps to the TaskEscrow arbiter): a result passes only if every
// cited source actually resolves over HTTP. Unresolvable / fabricated citations => fail,
// which drives the dispute / no-payout path.
import type { ResearchResult } from './research.js';

export interface CitationCheck { url: string; ok: boolean; status?: number; error?: string; }
export interface Verdict { pass: boolean; checks: CitationCheck[]; summary: string; }

async function resolves(url: string, timeoutMs = 6000): Promise<CitationCheck> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ctrl.signal });
    if (res.status === 405 || res.status === 403) res = await fetch(url, { method: 'GET', redirect: 'follow', signal: ctrl.signal });
    return { url, ok: res.status < 400, status: res.status };
  } catch (e) {
    return { url, ok: false, error: (e as Error).name };
  } finally {
    clearTimeout(t);
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
