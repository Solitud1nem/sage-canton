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

## M3 — CIP-0056 settlement (Amulet for dev, USDCx for prod)
Design decided in **ADR-0017** (2026-06-29): settle via the CIP-0056 Allocation/DvP
primitive, coding against the `splice-api-token-*-v1` **interfaces only** (never a concrete
token DAR). Instrument is config: **Amulet (Canton Coin)** on LocalNet, **USDCx** on
TestNet/MainNet via a one-line config switch.
- Research done (2026-06-29): USDCx is **not** on LocalNet/DevNet → dev on Amulet
  (`instrumentId = "Amulet"`). USDCx admin-party + registry URLs (MainNet/TestNet) + fee
  model (read from factory response, not fixed) captured in
  `docs/setup/toolchain-and-references.md` §3.
- [ ] Add `InstrumentId` field + allocation-cid ref to `TaskEscrow`; wire
  `Approve`/`Resolve`/`Refund`/`Expire` to Allocation/DvP (`AllocationFactory_Allocate` at
  funding, `Allocation_ExecuteTransfer` / `_Withdraw` / `_Cancel`).
- [ ] Pull exact `splice-api-token-allocation-instruction-v1` factory choice signatures.
- [ ] Unit-test with `splice-token-standard-test` mock registry; integration-test on
  LocalNet with real Amulet.
- [ ] Demonstrate an atomic task-output-for-payment settlement.
- ⚠️ Version-alignment risk: our project is pinned to SDK **3.5.1**; cn-quickstart LocalNet
  runs **3.4.11** with splice token DARs at **1.0.0**. Verify our DAR uploads to the 3.4.x
  participant and that `data-dependencies` on the 1.0.0 DARs compile from a 3.5.1 project;
  if not, align our `daml.yaml` to the LocalNet runtime for the settlement package.
- Reference impl to copy: `cn-quickstart/quickstart/daml/licensing/.../License.daml`
  (`Allocation_ExecuteTransfer` pay-leg + `AllocationRequest` interface) — see
  `docs/setup/toolchain-and-references.md` §3.

## M4 — Backend + JSON Ledger API
- TS backend (`dpm codegen-js` bindings) over the JSON Ledger API; PQS for reads.
- Idempotent, PQS-polled automation: auto-Expire overdue tasks, auto-settle approved.
- External-party signing (`prepare`/`execute`) for self-custodial agents.

## M5 — Frontend + agent orchestration
- Reuse the Sage product shell (re-pointed to the backend, not viem).
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
