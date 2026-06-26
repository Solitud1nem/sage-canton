# AGENTS.md — sage-canton code standard

## Language & paradigm

- **Daml** for on-ledger logic. Contracts are immutable: model state transitions as
  consuming choices that archive the old contract and `create` the next state.
- **TypeScript** (Node 18+) for the backend and frontend, using `dpm codegen-js`
  bindings against the **JSON Ledger API**. Frontends never talk to the Ledger API
  directly — they call the backend.

## Daml conventions

- Every template declares `signatory` and (where shared) `observer` explicitly.
  Privacy is opt-in: never add an observer who does not genuinely need visibility.
  A broad `observer [allAgents]`-style list is a bug.
- Authorization lives in `controller` per choice — do not re-implement `msg.sender`
  checks. Guard preconditions with `assertMsg "<reason>" <cond>`.
- Keep sensitive task terms OFF-ledger; store a hash/reference on-ledger (`taskRef`).
- Keep the Active Contract Set small: read completed/terminal escrows from **PQS
  history**, do not keep them as active contracts indefinitely.
- Watch **divulgence**: fetching another party's holding/contract inside a choice
  reveals it to that transaction's parties. Be deliberate.

## Settlement

- Settle in **USDCx via CIP-0056** — do NOT re-implement token transfers. Prefer the
  **Allocation / DvP** primitive (executor-controlled locked holdings) for the escrow
  vault. The sage-canton `provider` party is the allocation `executor`.

## Backend conventions

- Make ledger-advancing commands **idempotent**: consume the triggering contract
  and/or use command deduplication (stable command IDs).
- Automation = retriable, **PQS-polled, state-triggered** tasks (auto-Expire overdue,
  auto-settle approved). Retry the whole task block (re-query PQS) on retryable errors.
- Never commit secrets (party tokens, JWTs, keys). `.env` is git-ignored.

## Commits

- **Conventional Commits**: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`.
- One logical change per commit; reference the ADR or milestone where relevant.

## Prohibitions

- No mutating-state mental models ("update the contract in place") — archive + create.
- No global-state lookups ("query all tasks across the network") — party-scoped only.
- No floats for money in settlement paths — use the token standard's `Decimal`/minor
  units as defined by the registry.
- No skeleton choice left without a precondition guard once logic is real.
