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

Settlement is **wired and working** via the CIP-0056 Allocation (DvP) primitive: `TaskEscrow`
implements the `AllocationRequest` interface, and `SettlePayment` exercises
`Allocation_ExecuteTransfer` so funds move atomically with the status flip to Paid;
`SettleRefund` withdraws on reclaim. Disputes settle for real too: `SettleResolveRefund`
returns the locked funds to the requester (arbiter-controlled withdraw), and
`SettleResolvePayWorker` pays the worker (jointly authorized by arbiter + worker, since the
transfer needs the receiver's authority). We code against the `splice-api-token-*-v1`
**interfaces only**, so the instrument is configuration — **Amulet (Canton Coin)** on
LocalNet, **USDCx** on Test/MainNet (a one-line switch; see
[ADR-0017](docs/adr/0017-settlement-via-cip0056-token-standard.md)). Proven both in Daml
Script (mock registry) and **end-to-end on a live cn-quickstart node** (the worker's real
Canton Coin balance increases on settlement; a disputed task returns the locked funds).

## Repo layout

```
sage-canton/
├── daml/                  # PRODUCTION Daml package (the DAR we upload)
│   ├── TaskEscrow.daml     # escrow state machine + CIP-0056 settlement
│   ├── AgentRegistry.daml  # agent identity / capability registry
│   └── vendor/             # pinned splice-api-token-*-v1 / amulet DARs (build standalone)
├── daml-tests/            # Daml Script TEST package (never uploaded; data-depends on daml/)
│   └── Tests/              # lifecycle + real-token settlement tests (mock Amulet registry)
├── multi-package.yaml     # builds both packages; keeps daml-script/amulet OUT of the prod DAR
├── backend/               # TypeScript: v2 JSON Ledger API + Amulet registry + REST + agent
│   └── src/agent/          # AI research agent (worker) + paid fact-checker (arbiter)
├── frontend/              # zero-build demo UI (served by the backend)
├── scripts/               # live_settlement_demo.py — settle on a live node over HTTP
├── docs/
│   ├── adr/                # architecture decision records (0016 = this fork)
│   ├── architecture/       # overview + settlement design
│   └── setup/              # verified toolchain + LocalNet/live-settlement runbook
└── daml.yaml              # production Daml project file (pin SDK to target network)
```

## Quick start

```bash
# 1. Daml model + tests (incl. real-token settlement on a mock Amulet registry)
#    multi-package: the production DAR (daml/) and the Script tests (daml-tests/) are
#    separate, so the uploaded DAR carries only the CIP-0056 interfaces (no test bloat).
dpm install && dpm build --all && dpm test --package-root daml-tests   # 14 scripts green

# 2. Live end-to-end on a real node (multi-validator + Canton Coin + wallet)
#    bring up cn-quickstart LocalNet, then settle a TaskEscrow over HTTP:
python3 scripts/live_settlement_demo.py setup && python3 scripts/live_settlement_demo.py run
#    -> worker's real Amulet balance: 0 -> 100

# 3. Backend + demo UI (talks to the live node)
cd backend && npm install
npm run agent-demo        # flagship: AI agent + fact-checker, a paid run + a disputed run
PORT=8088 npm run dev     # REST API + demo UI at http://localhost:8088
```

See [docs/setup/toolchain-and-references.md](docs/setup/toolchain-and-references.md) for the
verified LocalNet bring-up + the live-settlement runbook.

## What works today

A complete vertical slice, proven on a live Canton node:

- **Daml model** — `TaskEscrow` lifecycle + CIP-0056 settlement; 14 Daml-Script tests green.
- **Real settlement** — worker paid in actual Canton Coin via the Allocation/DvP flow,
  on a live cn-quickstart node (USDCx is a config switch — [ADR-0017](docs/adr/0017-settlement-via-cip0056-token-standard.md)).
- **Privacy, demonstrated** — a non-stakeholder party sees **0** escrows on the live ledger
  (visible in the UI's perspective switcher).
- **Cross-participant privacy** — the headline differentiator, proven across TWO participants:
  requester/provider on App User, worker on App Provider (same synchronizer). The escrow
  replicates only to its stakeholders' participants; outsiders on either see **0**, and the
  worker drives its choices from its own participant (no shared custody).
  `scripts/cross_participant_demo.py`; design in [ADR-0018](docs/adr/0018-cross-participant-privacy-and-external-signing.md).
- **External-party signing (self-custody)** — the worker runs as an external party whose
  Ed25519 key is generated client-side; it authorizes its `Accept` via interactive submission
  (`prepare` → sign the tx hash → `execute`). A valid signature commits; a wrong-key signature
  is rejected even though the participant could otherwise relay for it — the key, not the
  operator, is the authority. `scripts/external_signing_demo.py`.
- **Both combined** — the full institutional story: an external self-custodied worker hosted on
  App Provider authorizes its action, by signature, on an escrow shared cross-participant with
  the requester/provider on App User. `scripts/cross_participant_external_demo.py`.
- **TypeScript backend** — typed v2 JSON Ledger API + Amulet registry clients, REST API,
  idempotent automation (auto-expire / auto-settle).
- **Live on Seaport DevNet** — the whole slice (lifecycle, single-node privacy, **real Canton
  Coin settlement**) runs on the hosted 5n-sandbox shared validator, reachable by judges. OIDC
  m2m auth; the DAR vets on the public node. See `docs/setup/seaport-devnet-integration.md`.
- **Demo UI** — fund → create → plan/delegate → settle, with agents' balances rising and a
  perspective switcher for privacy.
- **Flagship agent pipeline** — the worker is an AI **research agent** that does **real web
  research** (Anthropic's server-side `web_search`, so citations are pages it actually
  retrieved); the arbiter is a **paid fact-checker** that resolves every citation and honestly
  distinguishes a real-but-blocked source (403/429) from a fabricated one (404/DNS-fail).
  Fabricated/unverifiable sources → dispute → no payout. Offline deterministic fallback without a key.
- **Dynamic decomposition (human-in-the-loop)** — the Sage killer feature: an orchestrator
  proposes a plan (sub-tasks + reward split), the **requester reviews and edits it** (rewrite
  briefs, reassign agents, adjust rewards, add/remove) before approving. Each sub-task becomes
  its own on-ledger child `TaskEscrow` (linked via `parentRef`), privately scoped and settled on
  its own → partial settlement (sound sub-tasks pay, fabricated refund).
- **Specialised agents (on-ledger AgentRegistry)** — a roster of named, capability-tagged agents
  (Web Researcher / Standards & Docs Specialist / Data Analyst) registered as on-ledger
  `AgentProfile`s. Roles research **genuinely differently** (search scope/focus), not just by label.

The Daml model, real settlement, backend, demo UI, the agent pipeline and dynamic decomposition
are all working end-to-end on the live Seaport DevNet node; remaining polish is presentation.

## Engineering reference

A distilled Canton engineering reference (privacy model, Daml, CIP-0056 token standard,
JSON Ledger API, dpm toolchain) lives in the knowledge base as `platform-canton-network`.
