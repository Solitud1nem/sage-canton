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
import { research, type ResearchResult } from './research.js';
import { factCheck, type Verdict } from './factcheck.js';

export interface TaskReport {
  taskRef: string;
  brief: string;
  result: ResearchResult;
  resultHash: string;
  verdict: Verdict;
  outcome: 'paid' | 'refunded';
  status: string;
  log: string[];
}

const hash = (s: string): string => createHash('sha256').update(s).digest('hex');

export class AgentRunner {
  // off-ledger content store (brief + produced result), keyed by taskRef
  readonly store = new Map<string, { brief: string; result?: ResearchResult }>();

  constructor(private svc: EscrowService) {}

  registerBrief(taskRef: string, brief: string): void {
    this.store.set(taskRef, { brief });
  }

  /** Run the full agent + fact-check + conditional settlement for a Created escrow. */
  async run(escrow: EscrowContract, brief?: string): Promise<TaskReport> {
    const t = escrow.payload;
    const log: string[] = [];
    const theBrief = brief ?? this.store.get(t.taskRef)?.brief ?? t.taskRef;
    this.registerBrief(t.taskRef, theBrief);

    // worker accepts and does the work
    let esc = await this.svc.accept(escrow.contractId, t.worker);
    log.push(`agent accepted ${t.taskRef}`);
    const result = await research(theBrief);
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
      return { taskRef: t.taskRef, brief: theBrief, result, resultHash, verdict, outcome: 'paid', status: esc.payload.status, log };
    }
    // failure: requester disputes, arbiter resolves against the worker -> refunded, no payout
    esc = await this.svc.dispute(esc.contractId, t.requester);
    esc = await this.svc.resolve(esc.contractId, t.arbiter, false);
    log.push('fact-check failed -> disputed -> arbiter refunded the requester; worker paid nothing');
    return { taskRef: t.taskRef, brief: theBrief, result, resultHash, verdict, outcome: 'refunded', status: esc.payload.status, log };
  }
}
