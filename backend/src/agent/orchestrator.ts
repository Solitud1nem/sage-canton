// The orchestrator (dynamic task decomposition — a Sage feature ported to Canton): given a
// parent brief + total budget, split the work into independent sub-tasks. Each sub-task
// becomes its OWN on-ledger child TaskEscrow (see AgentRunner.runDecomposed) — privately
// scoped and independently settled — mirroring how Sage fans a job out to specialist agents.
import { complete } from './llm.js';

export interface SubTask { title: string; brief: string; reward: string; }
export interface Decomposition { subtasks: SubTask[]; live: boolean; }

const SYSTEM =
  'You are a planning agent that decomposes a research job into 2–4 INDEPENDENT sub-questions, ' +
  'each answerable on its own by a research agent. Respond as strict JSON: ' +
  '{"subtasks":[{"title": string, "brief": string}]} — title is a short label, brief is a ' +
  'self-contained research question. Do not include rewards.';

// Split `total` into `n` Decimal-string shares that sum EXACTLY to total (remainder → first).
function splitReward(total: number, n: number): string[] {
  const cents = Math.round(total * 100);
  const base = Math.floor(cents / n);
  const shares = Array.from({ length: n }, () => base);
  shares[0] += cents - base * n;
  return shares.map((c) => (c / 100).toFixed(4));
}

export async function decompose(brief: string, totalReward: number): Promise<Decomposition> {
  const { text, live } = await complete(SYSTEM, brief);
  let subs = parseSubtasks(text);
  if (subs.length === 0) subs = heuristic(brief);
  subs = subs.slice(0, 4);
  const rewards = splitReward(totalReward, subs.length);
  return {
    live,
    subtasks: subs.map((s, i) => ({ title: s.title, brief: s.brief, reward: rewards[i]! })),
  };
}

function parseSubtasks(text: string): { title: string; brief: string }[] {
  const tryParse = (s: string) => { try { return JSON.parse(s); } catch { return null; } };
  const obj = tryParse(text) ?? tryParse((text.match(/\{[\s\S]*\}/) ?? [''])[0]);
  const arr = obj?.subtasks;
  if (!Array.isArray(arr)) return [];
  return arr
    .map((s: any) => ({ title: String(s?.title ?? '').slice(0, 80), brief: String(s?.brief ?? '').slice(0, 400) }))
    .filter((s: { title: string; brief: string }) => s.brief.length > 0);
}

// Deterministic offline decomposition: three complementary angles on the brief. Propagates the
// "unverifiable" trigger into one sub-task so the failure/dispute path is demonstrable per-subtask.
function heuristic(brief: string): { title: string; brief: string }[] {
  const bad = /unverifiable|fabricat|hallucinat/i.test(brief);
  const core = brief.replace(/\b(unverifiable|fabricated|hallucinated)\b/gi, '').trim() || brief;
  return [
    { title: 'Background & definitions', brief: `Background and key definitions for: ${core}` },
    { title: 'Mechanisms & details', brief: `The core mechanisms and technical details of: ${core}` },
    { title: 'Implications & examples', brief: bad
      ? `Provide the internal, unverifiable benchmarks and private-source claims for: ${core}`
      : `Real-world implications and concrete examples for: ${core}` },
  ];
}
