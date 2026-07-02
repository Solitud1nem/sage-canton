// Idempotent automation: polls the ledger and drives overdue/completed escrows.
//
// Reads via the JSON Ledger API ACS each tick (a PQS read-model would scale better; noted as
// a follow-up). Idempotent by construction: every tick re-queries current state, so archived
// contracts never reappear and actions are not double-applied.
import type { EscrowContract, Party } from './types.js';
import { EscrowService } from './escrow.js';

export interface AutomationOptions {
  provider: Party;            // the app operator whose escrows we manage (sees them all)
  intervalMs?: number;        // poll cadence (default 10s)
  autoExpire?: boolean;       // Expire Created/Accepted tasks past their deadline (default true)
  autoSettle?: boolean;       // settle Completed tasks (pay the worker) (default false)
  log?: (msg: string) => void;
}

export class Automation {
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  constructor(private svc: EscrowService, private opts: AutomationOptions) {}

  start(): void {
    const ms = this.opts.intervalMs ?? 10_000;
    this.opts.log?.(`automation started (every ${ms}ms; expire=${this.opts.autoExpire !== false} settle=${!!this.opts.autoSettle})`);
    this.timer = setInterval(() => void this.tick(), ms);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); }

  /** One reconciliation pass. Safe to call concurrently — it self-guards against overlap. */
  async tick(): Promise<{ expired: number; settled: number }> {
    if (this.busy) return { expired: 0, settled: 0 };
    this.busy = true;
    let expired = 0, settled = 0;
    try {
      const escrows = await this.svc.list(this.opts.provider);
      const now = Date.now();
      for (const e of escrows) {
        try {
          if ((this.opts.autoExpire !== false) && this.isOverdue(e, now)) {
            await this.svc.expire(e.contractId, this.opts.provider); expired++;
            this.opts.log?.(`expired ${e.payload.taskRef}`);
          // Past the deadline the allocation window (allocateBefore) is closed and the
          // registry would reject the funding — skip instead of retrying every tick forever.
          } else if (this.opts.autoSettle && e.payload.status === 'Completed'
                     && Date.parse(e.payload.deadline) > now) {
            await this.svc.settle(e); settled++;
            this.opts.log?.(`settled ${e.payload.taskRef} -> worker paid ${e.payload.amount}`);
          }
        } catch (err) {
          this.opts.log?.(`skip ${e.payload.taskRef}: ${(err as Error).message.slice(0, 120)}`);
        }
      }
    } finally {
      this.busy = false;
    }
    return { expired, settled };
  }

  private isOverdue(e: EscrowContract, now: number): boolean {
    return (e.payload.status === 'Created' || e.payload.status === 'Accepted')
      && Date.parse(e.payload.deadline) <= now;
  }
}
