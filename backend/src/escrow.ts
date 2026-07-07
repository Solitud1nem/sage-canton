// Core escrow orchestration: TaskEscrow lifecycle + CIP-0056 settlement over the ledger.
import { ALLOCATION_INSTRUCTION_PKG, config } from './config.js';
import { LedgerClient, createdBySuffix, type Command, type CreatedEvent, type Transaction } from './ledger.js';
import { RegistryClient } from './registry.js';
import type { ContractId, EscrowContract, InstrumentId, Party, TaskEscrow } from './types.js';
import { emptyMeta } from './types.js';

const TE_SUFFIX = ':TaskEscrow:TaskEscrow';
const ALLOCATION_SUFFIX = ':Splice.AmuletAllocation:AmuletAllocation';
const iso = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const plusSeconds = (rfc: string, s: number): string => iso(new Date(Date.parse(rfc) + s * 1000));

export interface CreateTaskParams {
  provider: Party; requester: Party; worker: Party; arbiter: Party;
  taskRef: string; amount: string; instrumentId: InstrumentId;
  deadlineSeconds?: number; // default 1h
  parentRef?: string | null; // set for a decomposition sub-task (links it to its parent)
  arbiterFee?: string | null; // per-verdict fee for the arbiter; default ARBITER_FEE env (2 CC)
}

// The fact-checker's per-verdict fee: paid on BOTH outcomes (paid/refunded), so the
// referee has no economic reason to lean either way. '0' disables the fee leg entirely.
const defaultArbiterFee = (): string | null => {
  const fee = process.env.ARBITER_FEE ?? '2.0';
  return Number(fee) > 0 ? fee : null;
};

export class EscrowService {
  private readonly te: string;       // package-id qualified — for create/exercise commands
  private readonly teQuery: string;  // package-name qualified — for ACS/query template filters
  // Escrows with a settlement currently in flight. Funding + settling is two ledger round
  // trips; without this guard a double click (or a race with Automation.autoSettle) funds a
  // SECOND allocation that stays locked until its allocateBefore/settleBefore expires.
  private readonly inFlight = new Set<ContractId>();
  constructor(
    packageId: string,
    private readonly ledger = new LedgerClient(),
    private readonly registry = new RegistryClient(),
  ) {
    this.te = `${packageId}:TaskEscrow:TaskEscrow`;
    // The v2 active-contracts filter expects a package-NAME identifier (`#name:Mod:Ent`),
    // not a package id — and package-name matching also spans DAR upgrades.
    this.teQuery = `#${config.packageName}:TaskEscrow:TaskEscrow`;
  }

  private exercise(cid: ContractId, choice: string, arg: Record<string, unknown> = {}): Command {
    return { ExerciseCommand: { templateId: this.te, contractId: cid, choice, choiceArgument: arg } };
  }

  /** Create a funded-task escrow (Created). createdAt is set ~2 min in the past for settlement timing. */
  async createTask(p: CreateTaskParams): Promise<EscrowContract> {
    const now = Date.now();
    const createdAt = iso(new Date(now - 120_000));
    const deadline = iso(new Date(now + (p.deadlineSeconds ?? 3600) * 1000));
    const args: TaskEscrow = {
      provider: p.provider, requester: p.requester, worker: p.worker, arbiter: p.arbiter,
      taskRef: p.taskRef, amount: p.amount, instrumentId: p.instrumentId,
      status: 'Created', createdAt, deadline, resultRef: null, parentRef: p.parentRef ?? null,
      arbiterFee: p.arbiterFee !== undefined ? p.arbiterFee : defaultArbiterFee(),
    };
    const tx = await this.ledger.submit([{ CreateCommand: { templateId: this.te, createArguments: args as unknown as Record<string, unknown> } }], [p.provider, p.requester]);
    return this.created(tx);
  }

  async accept(cid: ContractId, worker: Party): Promise<EscrowContract> {
    const tx = await this.ledger.submit([this.exercise(cid, 'Accept')], [worker]);
    return this.created(tx);
  }
  async complete(cid: ContractId, worker: Party, completionRef: string): Promise<EscrowContract> {
    const tx = await this.ledger.submit([this.exercise(cid, 'Complete', { completionRef })], [worker]);
    return this.created(tx);
  }
  async approve(cid: ContractId, requester: Party): Promise<EscrowContract> {
    const tx = await this.ledger.submit([this.exercise(cid, 'Approve')], [requester]);
    return this.created(tx);
  }
  async expire(cid: ContractId, provider: Party): Promise<EscrowContract> {
    const tx = await this.ledger.submit([this.exercise(cid, 'Expire')], [provider]);
    return this.created(tx);
  }
  async dispute(cid: ContractId, raisedBy: Party): Promise<EscrowContract> {
    const tx = await this.ledger.submit([this.exercise(cid, 'Dispute', { raisedBy })], [raisedBy]);
    return this.created(tx);
  }
  /** Arbiter resolves a dispute: pay the worker or refund the requester (status only). */
  async resolve(cid: ContractId, arbiter: Party, payWorker: boolean): Promise<EscrowContract> {
    const tx = await this.ledger.submit([this.exercise(cid, 'Resolve', { payWorker })], [arbiter]);
    return this.created(tx);
  }

  /** All TaskEscrows visible to a party. */
  async list(party: Party): Promise<EscrowContract[]> {
    const evs = await this.ledger.activeContracts(party, { templateId: this.teQuery });
    return evs.filter((ce) => ce.templateId.endsWith(TE_SUFFIX)).map((ce) => ({ contractId: ce.contractId, payload: ce.createArgument as unknown as TaskEscrow }));
  }
  async get(party: Party, cid: ContractId): Promise<EscrowContract | undefined> {
    return (await this.list(party)).find((e) => e.contractId === cid);
  }

  /**
   * Settle a completed task in REAL tokens: fund the allocation via the Amulet registry,
   * then have the worker claim it (SettlePayment -> Allocation_ExecuteTransfer). Returns
   * the Paid escrow. Mirrors scripts/live_settlement_demo.py.
   */
  async settle(escrow: EscrowContract): Promise<EscrowContract> {
    return this.locked(escrow.contractId, async () => {
      const allocEv = await this.fundAllocation(escrow.payload);
      return this.settleAllocation(escrow.contractId, 'SettlePayment', allocEv, 'execute-transfer', [escrow.payload.worker]);
    });
  }

  /**
   * Value-moving dispute resolution — the arbiter rules for the REQUESTER and the locked
   * funds actually return (SettleResolveRefund -> Allocation_Withdraw). The escrow must
   * already be Disputed. Worker is paid nothing; escrow -> Refunded. The arbiter isn't an
   * allocation stakeholder, so we disclose the funded allocation to it (via the backend's
   * blob) at withdraw time.
   */
  async settleResolveRefund(escrow: EscrowContract): Promise<EscrowContract> {
    return this.locked(escrow.contractId, async () => {
      const allocEv = await this.fundAllocation(escrow.payload);
      return this.settleAllocation(escrow.contractId, 'SettleResolveRefund', allocEv, 'withdraw', [escrow.payload.arbiter]);
    });
  }

  /**
   * Value-moving dispute resolution — the arbiter rules for the WORKER, who is paid for real
   * (SettleResolvePayWorker -> Allocation_ExecuteTransfer). The escrow must already be
   * Disputed. Jointly authorized by [arbiter, worker]: the arbiter rules, the worker claims.
   */
  async settleResolvePayWorker(escrow: EscrowContract): Promise<EscrowContract> {
    return this.locked(escrow.contractId, async () => {
      const allocEv = await this.fundAllocation(escrow.payload);
      return this.settleAllocation(escrow.contractId, 'SettleResolvePayWorker', allocEv, 'execute-transfer', [escrow.payload.arbiter, escrow.payload.worker]);
    });
  }

  /**
   * Pay the arbiter's verification fee (both outcomes: the escrow must be Paid or
   * Refunded). Funds the fee leg and has the ARBITER claim it via SettleArbiterFee.
   * No-op when the escrow has no fee configured. Returns the (recreated) escrow.
   */
  async settleArbiterFee(escrow: EscrowContract): Promise<EscrowContract> {
    const t = escrow.payload;
    if (!t.arbiterFee || Number(t.arbiterFee) <= 0) return escrow;
    return this.locked(escrow.contractId, async () => {
      const allocEv = await this.fundAllocation(t, { legId: 'arbiterFee', receiver: t.arbiter, amount: t.arbiterFee! });
      return this.settleAllocation(escrow.contractId, 'SettleArbiterFee', allocEv, 'execute-transfer', [t.arbiter]);
    });
  }

  /** Serialize value-moving operations per escrow: reject a second settle while one is in flight. */
  private async locked<T>(cid: ContractId, fn: () => Promise<T>): Promise<T> {
    if (this.inFlight.has(cid)) throw new Error(`settlement already in progress for ${cid.slice(0, 16)}…`);
    this.inFlight.add(cid);
    try { return await fn(); } finally { this.inFlight.delete(cid); }
  }

  /** Fund one leg of the escrow's settlement (payment by default): the requester locks the
   *  leg amount into a CIP-0056 Allocation via the registry factory. The constructed spec
   *  must EXACTLY match the corresponding view leg (the contract asserts it on settlement).
   *  Returns the created allocation event. */
  private async fundAllocation(
    t: TaskEscrow,
    legOverride?: { legId: string; receiver: Party; amount: string },
  ): Promise<CreatedEvent> {
    const settleBefore = plusSeconds(t.deadline, 86_400);
    const settlement = {
      executor: t.provider,
      settlementRef: { id: t.taskRef, cid: null },
      requestedAt: t.createdAt, allocateBefore: t.deadline, settleBefore,
      meta: emptyMeta(),
    };
    const legSpec = legOverride ?? { legId: 'taskPayment', receiver: t.worker, amount: t.amount };
    const leg = { sender: t.requester, receiver: legSpec.receiver, amount: legSpec.amount, instrumentId: t.instrumentId, meta: emptyMeta() };
    const inputs = (await this.ledger.amuletHoldings(t.requester)).map((h) => h.contractId);
    const args: Record<string, unknown> = {
      expectedAdmin: t.instrumentId.admin,
      allocation: { settlement, transferLegId: legSpec.legId, transferLeg: leg },
      requestedAt: t.createdAt, inputHoldingCids: inputs,
      extraArgs: { context: { values: {} }, meta: emptyMeta() },
    };
    const fac = await this.registry.allocationFactory(args);
    (args['extraArgs'] as { context: unknown }).context = fac.context;
    const allocTx = await this.ledger.submit(
      [{ ExerciseCommand: { templateId: `${ALLOCATION_INSTRUCTION_PKG}:Splice.Api.Token.AllocationInstructionV1:AllocationFactory`, contractId: fac.factoryId!, choice: 'AllocationFactory_Allocate', choiceArgument: args } }],
      [t.requester], fac.disclosed,
    );
    const allocEv = createdBySuffix(allocTx, ALLOCATION_SUFFIX);
    if (!allocEv) throw new Error('allocation not created');
    return allocEv;
  }

  /** Exercise a value-moving TaskEscrow choice against a funded allocation: fetch the
   *  registry choice-context, disclose the allocation alongside it, and submit as `actAs`. */
  private async settleAllocation(
    escrowCid: ContractId, choice: string, allocEv: CreatedEvent,
    kind: 'execute-transfer' | 'withdraw', actAs: Party[],
  ): Promise<EscrowContract> {
    const tc = await this.registry.allocationChoiceContext(allocEv.contractId, kind);
    const synchronizerId = tc.disclosed[0]?.synchronizerId;
    if (!synchronizerId) throw new Error(`registry returned no disclosed contracts for ${kind} (cannot determine synchronizer id)`);
    if (!allocEv.createdEventBlob) throw new Error('allocation created event has no createdEventBlob (was includeCreatedEventBlob set?)');
    const disclosed = [...tc.disclosed, { templateId: allocEv.templateId, contractId: allocEv.contractId, createdEventBlob: allocEv.createdEventBlob, synchronizerId }];
    const tx = await this.ledger.submit(
      [this.exercise(escrowCid, choice, { allocationCid: allocEv.contractId, extraArgs: { context: tc.context, meta: emptyMeta() } })],
      actAs, disclosed,
    );
    return this.created(tx);
  }

  /** The TaskEscrow created by this transaction — with a clear error instead of a `!` crash. */
  private created(tx: Transaction): EscrowContract {
    const ce = createdBySuffix(tx, TE_SUFFIX);
    if (!ce) throw new Error('transaction produced no TaskEscrow created event (check template filters / party visibility)');
    return { contractId: ce.contractId, payload: ce.createArgument as unknown as TaskEscrow };
  }
}
