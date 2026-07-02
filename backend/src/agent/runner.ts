// Flagship orchestration: an AI research agent fulfils a TaskEscrow, a paid fact-checker
// (the arbiter) verifies it, and settlement is conditional —
//   citations resolve  -> SettlePayment (worker paid in real Canton Coin)
//   citations fail      -> requester disputes, arbiter resolves refund (worker paid nothing).
//
// Funding happens only on the success path, so a failed check never locks the requester's
// funds (nothing to claw back). On-ledger we store only a hash of the result; the content
// stays off-ledger (privacy) in this store.
import { createHash } from 'node:crypto';
import type { EscrowContract } from '../types.js';
import { EscrowService } from '../escrow.js';
import { research, type ResearchResult, type RoleKey } from './research.js';
import { factCheck, type Verdict } from './factcheck.js';
import { decompose, type Decomposition } from './orchestrator.js';
import type { Party } from '../types.js';

export interface TaskReport {
  taskRef: string;
  brief: string;
  title?: string;          // sub-task label when part of a decomposition
  contractId?: string;     // the (child) escrow this report settled
  result: ResearchResult;
  resultHash: string;
  verdict: Verdict;
  outcome: 'paid' | 'refunded';
  status: string;
  log: string[];
}

export interface DecompositionReport {
  taskRef: string;                 // parent task ref
  decomposition: Decomposition;    // the sub-task plan (titles + reward split)
  subtasks: TaskReport[];          // one per child escrow, in order
  paidTotal: string;               // sum of rewards actually paid to the worker
  status: string;                  // parent escrow rollup status
}

// A sub-task the requester has reviewed (and possibly edited: brief, reward, assigned worker)
// before approving execution. `worker` is optional — falls back to the parent's worker.
export interface PlanItem { title: string; brief: string; reward: string; worker?: string; }

const hash = (s: string): string => createHash('sha256').update(s).digest('hex');

export class AgentRunner {
  // off-ledger content store (brief + produced result), keyed by taskRef
  readonly store = new Map<string, { brief: string; result?: ResearchResult }>();
  // which specialised role each agent party plays (drives how it researches)
  private readonly roles = new Map<Party, RoleKey>();

  constructor(private svc: EscrowService) {}

  registerBrief(taskRef: string, brief: string): void {
    this.store.set(taskRef, { brief });
  }

  /** Map an agent party to its specialisation, so its sub-tasks research the way it should. */
  registerAgent(party: Party, role: RoleKey): void {
    this.roles.set(party, role);
  }

  /** Run the full agent + fact-check + conditional settlement for a Created escrow. */
  async run(escrow: EscrowContract, brief?: string): Promise<TaskReport> {
    const t = escrow.payload;
    const log: string[] = [];
    const theBrief = brief ?? this.store.get(t.taskRef)?.brief ?? t.taskRef;
    this.registerBrief(t.taskRef, theBrief);

    // worker accepts and does the work
    let esc = await this.svc.accept(escrow.contractId, t.worker);
    const role = this.roles.get(t.worker) ?? 'web';
    log.push(`agent accepted ${t.taskRef} [role: ${role}]`);
    const result = await research(theBrief, role);
    this.store.get(t.taskRef)!.result = result;
    const resultHash = hash(JSON.stringify(result));
    log.push(`agent produced ${result.citations.length} citation(s) [${result.live ? 'live LLM' : 'offline'}]`);
    esc = await this.svc.complete(esc.contractId, t.worker, resultHash);
    log.push('agent completed (result hash on-ledger; content off-ledger)');

    // the paid fact-checker (arbiter) verifies the citations resolve
    const verdict = await factCheck(result);
    log.push(`fact-check: ${verdict.summary}`);

    if (verdict.pass) {
      esc = await this.svc.settle(esc);
      log.push(`settled — worker paid ${t.amount} ${t.instrumentId.id}`);
      return { taskRef: t.taskRef, brief: theBrief, contractId: esc.contractId, result, resultHash, verdict, outcome: 'paid', status: esc.payload.status, log };
    }
    // failure: requester disputes, arbiter resolves against the worker -> refunded, no payout
    esc = await this.svc.dispute(esc.contractId, t.requester);
    esc = await this.svc.resolve(esc.contractId, t.arbiter, false);
    log.push('fact-check failed -> disputed -> arbiter refunded the requester; worker paid nothing');
    return { taskRef: t.taskRef, brief: theBrief, contractId: esc.contractId, result, resultHash, verdict, outcome: 'refunded', status: esc.payload.status, log };
  }

  /**
   * PLAN (no side effects): propose a decomposition of the parent brief into sub-tasks with a
   * reward split. Returned to the requester to review, edit, and price BEFORE any escrow is
   * created — so they see exactly what they're paying for and can reassign/adjust it.
   */
  async plan(parent: EscrowContract, brief?: string): Promise<Decomposition> {
    const t = parent.payload;
    const theBrief = brief ?? this.store.get(t.taskRef)?.brief ?? t.taskRef;
    if (brief) this.registerBrief(t.taskRef, brief);
    return decompose(theBrief, Number(t.amount));
  }

  /**
   * EXECUTE an approved (possibly edited) plan: for each sub-task spin up an independent CHILD
   * TaskEscrow (linked on-ledger via `parentRef`) owned by its ASSIGNED worker, run the full
   * agent + fact-check + conditional-settlement pipeline, then roll the parent up (status-only).
   * Each child is privately scoped and settles on its own — sound sub-tasks pay, fabricated/
   * errored ones refund (partial settlement). Resilient: one sub-task failing never aborts the batch.
   */
  async executePlan(parent: EscrowContract, items: PlanItem[]): Promise<DecompositionReport> {
    const t = parent.payload;
    const subtasks: TaskReport[] = [];
    for (const [i, sub] of items.entries()) {
      const childRef = `${t.taskRef}/sub-${i + 1}`;
      const worker = sub.worker || t.worker;
      try {
        const child = await this.svc.createTask({
          provider: t.provider, requester: t.requester, worker, arbiter: t.arbiter,
          taskRef: childRef, amount: sub.reward, instrumentId: t.instrumentId, parentRef: t.taskRef,
        });
        const rep = await this.run(child, sub.brief);
        subtasks.push({ ...rep, title: sub.title });
      } catch (e) {
        subtasks.push({
          taskRef: childRef, brief: sub.brief, title: sub.title,
          result: { answer: `sub-task errored: ${(e as Error).message}`, citations: [], live: false },
          resultHash: '', verdict: { pass: false, checks: [], summary: 'errored' },
          outcome: 'refunded', status: 'Errored', log: [`error: ${(e as Error).message}`],
        });
      }
    }

    // roll the parent up (status-only — the money moved in the children): accept -> complete -> approve
    let p = await this.svc.accept(parent.contractId, t.worker);
    const rollupHash = hash(JSON.stringify(subtasks.map((s) => s.resultHash)));
    p = await this.svc.complete(p.contractId, t.worker, rollupHash);
    p = await this.svc.approve(p.contractId, t.requester);

    const decomposition: Decomposition = { subtasks: items.map((s) => ({ title: s.title, brief: s.brief, reward: s.reward })), live: true };
    const paidTotal = subtasks.reduce(
      (sum, s, i) => (s.outcome === 'paid' ? sum + Number(items[i]!.reward) : sum), 0);
    return { taskRef: t.taskRef, decomposition, subtasks, paidTotal: paidTotal.toFixed(4), status: p.payload.status };
  }

  /** Plan + execute with the orchestrator's default assignment (all sub-tasks to the parent's
   *  worker). The interactive path is plan() → requester edits → executePlan(). */
  async runDecomposed(parent: EscrowContract, brief?: string): Promise<DecompositionReport> {
    const dec = await this.plan(parent, brief);
    return this.executePlan(parent, dec.subtasks.map((s) => ({ ...s, worker: parent.payload.worker })));
  }
}
