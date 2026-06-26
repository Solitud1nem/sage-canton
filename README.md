# sage-canton

**Privacy-native task-escrow for AI agents, on Canton Network.**

A sibling implementation of [Sage](https://sage-protocol.pages.dev) — the chain-agnostic
task-escrow protocol for AI agents (live on Base mainnet + Arc testnet) — rebuilt natively
for Canton so that task terms, agent pricing, counterparties and settlement amounts stay
**private between the parties involved**, while multi-party settlement clears **atomically**.

## Why Canton

On EVM, every Sage escrow is public: anyone can read agent pricing, bid amounts,
counterparties and task content. For institutional and commercial agentic commerce that
is a dealbreaker. Canton's **sub-transaction privacy** makes each escrow visible only to
its stakeholders (requester, worker, optional arbiter/auditor) — enabling sealed-bid agent
task markets with no competitor visibility and no reward front-running, settled in
**USDCx** (Circle's Canton-native, privacy-configurable USDC).

## Relationship to Sage (Option C)

This is a **separate, Canton-native codebase under the Sage brand** — not an adapter inside
the EVM monorepo, and not an unrelated greenfield project. We share **above** the JSON
Ledger API seam (product, UX, agent-orchestration logic, brand, the escrow lifecycle spec)
and fork **below** it (contracts, identity, settlement, privacy model, discovery). Rationale:
see [docs/adr/0016-separate-canton-implementation.md](docs/adr/0016-separate-canton-implementation.md).

| Layer | Sage (EVM) | sage-canton |
| ----- | ---------- | ----------- |
| Contracts | Solidity / Foundry | **Daml templates** |
| Identity | EOA + EAS | **Canton party** (external party for self-signing agents) |
| Settlement | USDC + EIP-2612 permit | **USDCx** via CIP-0056 (Allocation/DvP) |
| Privacy | public ledger | **private by default** (sub-transaction privacy) |
| SDK | viem | **JSON Ledger API** + `dpm codegen-js` bindings |

## Escrow lifecycle

```
Created ──Accept──▶ Accepted ──Complete──▶ Completed ──Approve──▶ Paid
   │                   │                       │
   │ Refund            │ Dispute               │ Dispute
   ▼                   ▼                       ▼
Refunded           Disputed ──Resolve──▶ Paid | Refunded
   ▲
   │ Expire (deadline passed)
Created/Accepted ──▶ Expired ──Refund──▶ Refunded
```

Settlement (USDCx) is wired into `Approve` / `Resolve` via the CIP-0056 Allocation (DvP)
primitive — the requester's funds are locked into an executor-controlled allocation at task
creation and released atomically on approval. See `daml/TaskEscrow.daml` (TODO markers).

## Repo layout

```
sage-canton/
├── daml/                  # Daml model (smart contracts)
│   ├── TaskEscrow.daml     # escrow state machine
│   ├── AgentRegistry.daml  # agent identity / capability registry
│   └── Tests/              # Daml Script tests
├── docs/
│   ├── adr/                # architecture decision records (0016 = this fork)
│   └── architecture/       # overview + settlement design
├── daml.yaml              # Daml project file (pin SDK to target network)
├── CLAUDE.md              # entry point for AI assistants
├── AGENTS.md              # code standard, prohibitions, commit conventions
└── PLANNING.md            # milestones toward hackathon submission
```

## Quick start (local)

```bash
dpm install          # install the Daml SDK pinned in daml.yaml
dpm build            # compile the Daml model -> DAR
dpm test             # run Daml Script tests
dpm sandbox          # single-participant local node
# multi-validator + Canton Coin + wallet (for USDCx flows): use cn-quickstart LocalNet
```

## Status

Scaffold. Daml model is a first-cut skeleton; CIP-0056 settlement and the TS backend /
frontend are not yet wired. See `PLANNING.md`.

## Engineering reference

A distilled Canton engineering reference (privacy model, Daml, CIP-0056 token standard,
JSON Ledger API, dpm toolchain) lives in the knowledge base as `platform-canton-network`.
