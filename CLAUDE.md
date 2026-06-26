# CLAUDE.md — sage-canton

Entry point for AI assistants working in this repo.

## What this is

`sage-canton` is a **privacy-native task-escrow protocol for AI agents on Canton Network** —
a Canton-native sibling of the EVM **Sage** protocol. A requester funds a task, a worker
(agent) accepts and completes it, funds release on approval. The headline differentiator
over EVM Sage is **privacy**: each escrow is visible only to its stakeholders, settled in
**USDCx** (CIP-0056).

## Relationship to Sage

This repo is **Option C**: a separate Canton-native codebase under the Sage brand. Share
**above** the JSON Ledger API seam (product, UX, agent orchestration, brand, lifecycle
spec); fork **below** it (contracts, identity, settlement, privacy, discovery). Do NOT try
to reuse the EVM `@sage/adapter-*` abstraction here — Daml + parties + privacy do not fit
the viem ChainAdapter shape. See `docs/adr/0016-separate-canton-implementation.md`.

## Mental model (coming from Solidity/EVM)

| Ethereum | Canton |
| -------- | ------ |
| Smart contract | **Template** |
| Contract instance | **Contract** (immutable; archive + create, never mutate) |
| Function | **Choice** |
| EOA / address | **Party** |
| `msg.sender` check | `signatory` / `controller` (compile-time) |
| public by default | **private by default** (declare `observer` to share) |
| global RPC query | query your validator's Ledger API / PQS for YOUR parties only |
| Hardhat/Foundry | **Daml SDK + dpm** |
| ethers/viem | **JSON Ledger API** + `dpm codegen-js` |
| ERC standards | **CIPs** (CIP-0056 = token standard) |

The four shifts to internalize: no global state queries, immutable contracts, explicit
authorization, privacy by default.

## Where things live

- `daml/TaskEscrow.daml` — escrow state machine (Created → … → Paid/Refunded/Expired).
- `daml/AgentRegistry.daml` — agent identity / capability profiles.
- `daml/Tests/` — Daml Script tests (`dpm test`).
- `docs/adr/` — architecture decisions (0016 = the Sage fork rationale).
- `docs/architecture/overview.md` — settlement (CIP-0056) + app architecture.
- `docs/setup/toolchain-and-references.md` — **source-verified** dpm install, SDK version
  pinning, CIP-0056 package names, LocalNet setup, canonical doc URLs (re-vetted 2026-06-26).
- KB `platform-canton-network` — full Canton engineering reference (privacy, Daml,
  CIP-0056, JSON Ledger API, dpm). Read it before non-trivial Daml/settlement work.

## Build / test

```bash
dpm install && dpm build && dpm test
```

## Open items before deep work (see KB "open items")

- Confirm contract-key `key … maintainer …` syntax before adding registry lookups.
- Confirm current Daml Script idioms against the pinned SDK.
- Pull exact CIP-0056 interface signatures (`splice-api-token-*-v1`) for settlement.
- Confirm USDCx registry admin party + registry URL + fee model.
