// Domain types mirroring the Daml model + the v2 JSON Ledger API wire shapes we use.
// Hand-written (verified against the live node) rather than codegen-js, because the
// codegen `@daml/types` decoders target the deprecated v1 JSON API, not v2.

export type Party = string;
export type ContractId = string;

export type TaskStatus =
  | 'Created' | 'Accepted' | 'Completed'
  | 'Paid' | 'Disputed' | 'Refunded' | 'Expired';

export interface InstrumentId {
  admin: Party;
  id: string; // "Amulet" on LocalNet; USDCx instrument id on Test/MainNet
}

// TaskEscrow template payload (matches daml/TaskEscrow.daml).
export interface TaskEscrow {
  provider: Party;
  requester: Party;
  worker: Party;
  arbiter: Party;
  taskRef: string;
  amount: string;          // Decimal as string
  instrumentId: InstrumentId;
  status: TaskStatus;
  createdAt: string;       // RFC3339
  deadline: string;        // RFC3339
  resultRef: string | null;
}

// A TaskEscrow as seen on-ledger (payload + its contract id).
export interface EscrowContract {
  contractId: ContractId;
  payload: TaskEscrow;
}

// CIP-0056 metadata wrappers.
export interface Metadata { values: Record<string, string>; }
export interface ChoiceContext { values: Record<string, unknown>; }
export interface ExtraArgs { context: ChoiceContext; meta: Metadata; }
export const emptyMeta = (): Metadata => ({ values: {} });

// v2 JSON Ledger API — a contract disclosed for use in a command.
export interface DisclosedContract {
  templateId: string;
  contractId: ContractId;
  createdEventBlob: string;
  synchronizerId: string;
}
