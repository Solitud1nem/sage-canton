# PLANNING — sage-canton

Milestones toward the Canton Hackathon submission (public repo + deck + 3-min video +
live product). Track 3: Payments / Neobanking / Agentic Commerce.

## M0 — Scaffold ✅ (this commit)
- Repo skeleton, README, CLAUDE.md, AGENTS.md, ADR-0016, architecture overview.
- Daml model skeleton: `TaskEscrow` state machine + `AgentRegistry` + Daml Script tests.
- Canton engineering reference captured in KB (`platform-canton-network`).

## M1 — Daml model compiles & tests green ✅ (2026-06-26)
- [x] `dpm` 3.5.1 installed; `daml.yaml` pinned to **3.5.1** (TestNet/DevNet).
- [x] `dpm build` clean (DAR builds). Syntax drift fixed: `Created` ambiguity vs
      `Daml.Script.Created` (hidden on import); `submitMulti` → `submit (actAs …)`.
- [x] `dpm test` green — 8 tests: lifecycle (happy→Paid, dispute→refund, dispute→pay,
      refund-unaccepted, expire→refund) + guards (accept-twice, approve-before-complete,
      expire-early). See `daml/Tests/TestTaskEscrow.daml`.
- [ ] Contract-key syntax + `AgentRegistry` name→profile key — still open (deferred to
      when registry lookups are needed; see `CLAUDE.md` open items).
- Follow-up (non-blocking): build warns that tests share a package with templates
  (`template-interface-depends-on-daml-script`); split tests into their own package
  before any DAR upload to keep the participant package store clean.
- Toolchain/setup is recorded in `docs/setup/toolchain-and-references.md`.

## M2 — Local end-to-end on a real node ✅ (2026-06-29)
- [x] Happy path on a **real running node**: `dpm sandbox` (gRPC 6865 / JSON API 6864),
      DAR uploaded, `Tests.TestTaskEscrow:liveHappyPathWithPrivacy` → SUCCESS
      (Created→Accepted→Completed→Paid).
- [x] **Privacy verified on the live ledger**: a non-stakeholder `outsider` party sees
      0 escrows while the worker (stakeholder) sees 1 — party-scoped visibility holds.
- [x] **Full cn-quickstart LocalNet up** (multi-validator + Canton Coin + wallet):
      `make setup`/`build`/`start` green; ~15 containers healthy (canton, splice SV,
      wallets, scan, swagger). Setup recipe + ports in
      `docs/setup/toolchain-and-references.md` §4.
- [x] **Our DAR runs on LocalNet**: `sage-canton-0.1.1.dar` (built SDK 3.5.1) uploaded to
      the **3.4.11** App Provider participant and exercised end-to-end via
      `Tests.TestTaskEscrow:liveHappyPathFromInput` (gRPC 3901, JWT auth + granted
      `CanActAs` rights) → Created→Accepted→Completed→Paid, **privacy holds** (worker
      sees 1, outsider 0). Resolves the 3.5.1↔3.4.11 version-compat question (compatible).
- Scope note: all 5 parties are on ONE participant → this proves the lifecycle + the full
  auth model (tokens + party rights, the M4 backend pattern) + party-scoped privacy on the
  real node. **Cross-participant** sub-transaction privacy (requester on app-user 2901,
  worker on app-provider 3901) is the next step and needs external-party signing → M4.

## M3 — CIP-0056 settlement (Amulet for dev, USDCx for prod) ✅ (2026-06-29)
Proven both in Daml-Script (mock registry) AND on the live LocalNet node (real Amulet).
Design **ADR-0017**: settle via the CIP-0056 Allocation/DvP primitive, coding against the
`splice-api-token-*-v1` **interfaces only** (never a concrete token DAR). Instrument is
config: **Amulet (Canton Coin)** on LocalNet, **USDCx** on TestNet/MainNet via a one-line
config switch.
- [x] USDCx research (2026-06-29): not on LocalNet → dev on Amulet; admin parties + registry
  URLs + fee model captured in `docs/setup/toolchain-and-references.md` §3.
- [x] **`TaskEscrow` implements `AllocationRequest`** (executor=provider, leg
  requester→worker, `instrumentId`+`createdAt` fields) and has settlement choices
  `SettlePayment` (worker claims → `Allocation_ExecuteTransfer`) and `SettleRefund`
  (requester → `Allocation_Withdraw`). Coded against the interfaces in `daml/vendor/`.
- [x] **Real token movement proven** — `daml/Tests/TestSettlement.daml` runs the full flow
  on the `splice-token-standard-test` mock Amulet registry: tap → fund allocation
  (`AllocationFactory_Allocate`) → settle → **worker's Amulet balance actually increases**
  (`testSettlementPaysWorker`); plus a refund path (`testSettlementRefunds`). 12/12 `dpm
  test` green.
- [x] Version-alignment **resolved**: project pinned to **SDK 3.4.11** (matches LocalNet
  runtime AND the harness's daml-script — their `Script` types must unify); LF target 2.2.
- Auth note: settlement needs receiver (worker) authority, which a lone executor doesn't
  have (unlike licensing where executor=receiver). Solved by making `SettlePayment`
  worker-controlled (provider+requester authority comes from escrow signatories) and
  disclosing the Amulet allocation to the worker at claim time.
- [x] **Real Amulet settlement on the live LocalNet node** (2026-06-29): tap → create →
  accept → complete → fund allocation via the **real** Amulet registry factory → settle →
  **worker's on-ledger Amulet balance 0 → 100**, escrow Paid. Driven entirely over HTTP
  (JSON Ledger API + `splice:5012` registry). Reproducible: `python3
  scripts/live_settlement_demo.py setup && … run`. Runbook in
  `docs/setup/toolchain-and-references.md` §4.
- [ ] Wire dispute settlement (`Resolve` → execute/withdraw) — state machine handles
  Disputed today; the value-moving variant is a follow-up.
- Follow-up: split Script tests into their own package so the production DAR drops the
  amulet/token-standard-test/daml-script bloat (see `daml.yaml` note).

## M4 — Backend + JSON Ledger API 🟢 (core done, 2026-06-29)
TypeScript backend in `backend/` — typed orchestration over the **v2** JSON Ledger API +
the Amulet registry. Proven end-to-end against the live LocalNet (worker paid real Amulet
through the REST `settle` endpoint).
- [x] Typed v2 client (`src/ledger.ts`), Amulet registry client (`src/registry.ts`, via
  `node:http` because fetch drops the `Host: scan.localhost` header), wallet/tap
  (`src/wallet.ts`), and `EscrowService` (lifecycle + fund→settle) — `src/escrow.ts`.
- [x] **REST API** (`src/server.ts`, zero-dep `node:http`): create / accept / complete /
  approve / settle / expire / list + `/admin/tap`. Full lifecycle incl. real-token settle
  driven over HTTP and verified.
- [x] **Idempotent automation** (`src/automation.ts`): polls the ACS, auto-Expires overdue
  tasks (verified), optional auto-settle; self-guards against overlap; idempotent by
  re-reading current state each tick.
- Decision: speak v2 JSON API directly with hand-written types (verified) rather than
  `dpm codegen-js`, whose `@daml/types` decoders target the deprecated **v1** API. See
  `backend/README.md`.
- [ ] PQS read model instead of ACS polling (scales; poller is fine for the demo).
- [ ] **External-party signing** (`prepare`/`execute`) so agents self-custody instead of the
  backend holding `CanActAs` — also unlocks the cross-participant privacy story (M2 note).

## M5 — Frontend + agent orchestration 🟡 (demo UI done, 2026-06-29)
- [x] **Mini demo UI** built from scratch in `frontend/` (zero-build vanilla SPA, served by
  the backend at `/`). Provisions a live session, funds + creates tasks, drives the full
  lifecycle (accept → complete → 💸 settle), shows the worker's real Canton Coin balance
  rising, and a **perspective switcher** that demonstrates privacy live (the `outsider`
  party sees 0 escrows). All backend interactions verified end-to-end.
  - The EVM Sage product shell isn't available in this repo; built a focused Canton-native
    UI instead. Re-skinning to the Sage shell later is a presentation-layer swap.
- [ ] Agent orchestration: wire a real AI pipeline as the worker (create → agent does work
  → complete → settle; plus a deliberately-failed run showing funds NOT released).
- Port ONE useful-output pipeline (per Sage ADR-0020, 2026-06-10 — the old
  summarize/translate/sentiment/vision modes are deprecated). Candidates:
  - **Website pipeline** (copywriter → builder → packager; artifact = zip + README;
    QA gate) — simplest, tangible artifact. Recommended MVP anchor.
  - **Research + fact-check** (searcher → extractor → synthesizer → paid fact-checker;
    citations must resolve; failure → dispute) — flagship narrative; the paid
    fact-checker maps to the TaskEscrow `arbiter`/evaluator role and best showcases
    Canton's private multi-party + conditional settlement. Stretch / pitch flagship.
- Live demo flow: create task → agent accepts → completes → approve → private
  settlement; plus a deliberately-failed run showing funds NOT released.

## M6 — Submission polish
- Deck, 3-min video w/ demo, live deployment, README polish.
- Map the submission to judging criteria: privacy (originality), institutional relevance
  (real-world applicability), working e2e (technical execution), clear UX.

## Risks / unknowns
- Daml learning curve (new language) — mitigated by porting a fully-specified design.
- USDCx registry specifics on the hackathon network (DevNet/TestNet availability).
- LocalNet/Docker resource needs for multi-validator testing.
