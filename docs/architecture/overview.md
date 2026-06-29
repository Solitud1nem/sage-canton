# Architecture overview — sage-canton

## Goal

A privacy-native task-escrow protocol for AI agents on Canton: a requester funds a task,
a worker (agent) accepts and completes it, funds release on approval — with each escrow
visible only to its stakeholders, settled atomically in USDCx.

## Layers (fully-mediated, cn-quickstart shape)

```
React frontend ── HTTP/REST ──▶ TS backend ── JSON Ledger API ──▶ Validator (participant node)
                                    │                                   │
                                    └────── SQL ──▶ PQS (Postgres) ◀── projections
                                                                        │
                                                                  Synchronizer (Global)
```

- **Daml model** (`daml/`) — `TaskEscrow` + `AgentRegistry`, compiled to a DAR via
  `dpm build`, uploaded to participant nodes hosting the relevant parties.
- **Backend** (TypeScript, later milestone) — submits commands and reads PQS; enforces
  end-user auth (PQS itself has no access control); hosts agent orchestration.
- **Frontend** (later milestone) — talks only to the backend.

## Parties

| Party | Role | In TaskEscrow |
| ----- | ---- | ------------- |
| `provider` | sage-canton app/registry operator; settlement **executor** | signatory + controller of `Expire` |
| `requester` | funds the task | signatory + controller of `Approve`/`Dispute`/`Refund` |
| `worker` | agent performing the task | observer + controller of `Accept`/`Complete` |
| `arbiter` | dispute resolver / auditor | observer + controller of `Resolve` |

Self-signing agents should be modeled as **external parties** (sign their own commands via
the JSON Ledger API `prepare`/`execute` endpoints). Provider-automated agents can be local
parties for the MVP (the provider validator signs on their behalf — a deliberate trust
trade-off, documented).

## Privacy

Each `TaskEscrow` is decomposed into stakeholder views: only `provider`, `requester`,
`worker`, `arbiter` see it; the synchronizer sees encrypted blobs only; no other agent can
read pricing, terms, amount, or counterparties. This enables **sealed-bid agent task
markets** with no competitor visibility — the core differentiator over EVM Sage. Keep task
terms off-ledger (store a hash in `taskRef`). Watch divulgence when fetching holdings
during settlement.

## Settlement (USDCx via CIP-0056) — to be wired

USDCx is a CIP-0056 registry; we do not implement token transfers. Plan: use the
**Allocation / DvP** primitive as the escrow vault.

1. **Fund (at task creation):** requester's wallet exercises `AllocationFactory_Allocate`
   to lock the task amount of USDCx into an `Allocation` whose `executor` is `provider`.
   `allocateBefore` / `settleBefore` deadlines map to the `Expired` state.
2. **Pay (Approve / Resolve→payWorker):** `provider` (executor) exercises
   `Allocation_ExecuteTransfer` to release the locked funds to the worker — atomically.
3. **Refund (Refund / Resolve→!payWorker / Expired):** `Allocation_Withdraw` (requester
   reclaims before `allocateBefore`) or `Allocation_Cancel` (joint sender/receiver/
   executor).

Integration mechanics: query the USDCx registry's off-ledger HTTP API for `factoryId` +
`disclosedContracts` + `choiceContextData`, then submit an `ExerciseCommand` over the JSON
Ledger API (`templateId` = factory interface id, `contractId` = `factoryId`, `choice` =
`AllocationFactory_Allocate` / `Allocation_ExecuteTransfer`, `choiceArgument` carrying the
leg + `context`, plus `disclosedContracts`). Agents-as-external-parties → `prepare`+
`execute`; otherwise `submit-and-wait`. See KB `platform-canton-network` §7.

## Open items (confirm before coding settlement)

Exact CIP-0056 interface signatures, USDCx registry admin party + URL + fee model, current
Daml Script idioms, contract-key syntax. See `docs/setup/toolchain-and-references.md`.
