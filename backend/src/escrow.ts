// Core escrow orchestration: TaskEscrow lifecycle + CIP-0056 settlement over the ledger.
import { ALLOCATION_INSTRUCTION_PKG, config } from './config.js';
import { LedgerClient, createdBySuffix, type Command, type CreatedEvent } from './ledger.js';
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
}

export class EscrowService {
  private readonly te: string;       // package-id qualified — for create/exercise commands
  private readonly teQuery: string;  // package-name qualified — for ACS/query template filters
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
      status: 'Created', createdAt, deadline, resultRef: null,
    };
    const tx = await this.ledger.submit([{ CreateCommand: { templateId: this.te, createArguments: args as unknown as Record<string, unknown> } }], [p.provider, p.requester]);
    return this.created(tx.events && createdBySuffix(tx, TE_SUFFIX)!);
  }

  async accept(cid: ContractId, worker: Party): Promise<EscrowContract> {
    const tx = await this.ledger.submit([this.exercise(cid, 'Accept')], [worker]);
    return this.created(createdBySuffix(tx, TE_SUFFIX)!);
  }
  async complete(cid: ContractId, worker: Party, completionRef: string): Promise<EscrowContract> {
    const tx = await this.ledger.submit([this.exercise(cid, 'Complete', { completionRef })], [worker]);
    return this.created(createdBySuffix(tx, TE_SUFFIX)!);
  }
  async approve(cid: ContractId, requester: Party): Promise<EscrowContract> {
    const tx = await this.ledger.submit([this.exercise(cid, 'Approve')], [requester]);
    return this.created(createdBySuffix(tx, TE_SUFFIX)!);
  }
  async expire(cid: ContractId, provider: Party): Promise<EscrowContract> {
    const tx = await this.ledger.submit([this.exercise(cid, 'Expire')], [provider]);
    return this.created(createdBySuffix(tx, TE_SUFFIX)!);
  }
  async dispute(cid: ContractId, raisedBy: Party): Promise<EscrowContract> {
    const tx = await this.ledger.submit([this.exercise(cid, 'Dispute', { raisedBy })], [raisedBy]);
    return this.created(createdBySuffix(tx, TE_SUFFIX)!);
  }
  /** Arbiter resolves a dispute: pay the worker or refund the requester (status only). */
  async resolve(cid: ContractId, arbiter: Party, payWorker: boolean): Promise<EscrowContract> {
    const tx = await this.ledger.submit([this.exercise(cid, 'Resolve', { payWorker })], [arbiter]);
    return this.created(createdBySuffix(tx, TE_SUFFIX)!);
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
    const allocEv = await this.fundAllocation(escrow.payload);
    return this.settleAllocation(escrow.contractId, 'SettlePayment', allocEv, 'execute-transfer', [escrow.payload.worker]);
  }

  /**
   * Value-moving dispute resolution — the arbiter rules for the REQUESTER and the locked
   * funds actually return (SettleResolveRefund -> Allocation_Withdraw). The escrow must
   * already be Disputed. Worker is paid nothing; escrow -> Refunded. The arbiter isn't an
   * allocation stakeholder, so we disclose the funded allocation to it (via the backend's
   * blob) at withdraw time.
   */
  async settleResolveRefund(escrow: EscrowContract): Promise<EscrowContract> {
    const allocEv = await this.fundAllocation(escrow.payload);
    return this.settleAllocation(escrow.contractId, 'SettleResolveRefund', allocEv, 'withdraw', [escrow.payload.arbiter]);
  }

  /**
   * Value-moving dispute resolution — the arbiter rules for the WORKER, who is paid for real
   * (SettleResolvePayWorker -> Allocation_ExecuteTransfer). The escrow must already be
   * Disputed. Jointly authorized by [arbiter, worker]: the arbiter rules, the worker claims.
   */
  async settleResolvePayWorker(escrow: EscrowContract): Promise<EscrowContract> {
    const allocEv = await this.fundAllocation(escrow.payload);
    return this.settleAllocation(escrow.contractId, 'SettleResolvePayWorker', allocEv, 'execute-transfer', [escrow.payload.arbiter, escrow.payload.worker]);
  }

  /** Fund the escrow's payment leg: the requester locks `amount` of the instrument into a
   *  CIP-0056 Allocation via the registry factory. Returns the created allocation event. */
  private async fundAllocation(t: TaskEscrow): Promise<CreatedEvent> {
    const settleBefore = plusSeconds(t.deadline, 86_400);
    const settlement = {
      executor: t.provider,
      settlementRef: { id: t.taskRef, cid: null },
      requestedAt: t.createdAt, allocateBefore: t.deadline, settleBefore,
      meta: emptyMeta(),
    };
    const leg = { sender: t.requester, receiver: t.worker, amount: t.amount, instrumentId: t.instrumentId, meta: emptyMeta() };
    const inputs = (await this.ledger.amuletHoldings(t.requester)).map((h) => h.contractId);
    const args: Record<string, unknown> = {
      expectedAdmin: t.instrumentId.admin,
      allocation: { settlement, transferLegId: 'taskPayment', transferLeg: leg },
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
    const disclosed = [...tc.disclosed, { templateId: allocEv.templateId, contractId: allocEv.contractId, createdEventBlob: allocEv.createdEventBlob!, synchronizerId: tc.disclosed[0]!.synchronizerId }];
    const tx = await this.ledger.submit(
      [this.exercise(escrowCid, choice, { allocationCid: allocEv.contractId, extraArgs: { context: tc.context, meta: emptyMeta() } })],
      actAs, disclosed,
    );
    return this.created(createdBySuffix(tx, TE_SUFFIX)!);
  }

  private created(ce: { contractId: ContractId; createArgument?: Record<string, unknown> }): EscrowContract {
    return { contractId: ce.contractId, payload: ce.createArgument as unknown as TaskEscrow };
  }
}
