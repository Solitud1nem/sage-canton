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

## M2 — Local end-to-end on LocalNet
- Stand up cn-quickstart **LocalNet** (validators + Canton Coin + wallet).
- Allocate provider/requester/worker/arbiter parties; run the happy path on a real node.
- Verify privacy: confirm a non-stakeholder party cannot see an escrow.

## M3 — USDCx settlement (CIP-0056)
- Pull exact `splice-api-token-*-v1` interface signatures; confirm USDCx registry
  admin party + URL + fee model.
- Wire `Approve`/`Resolve`/`Refund`/`Expire` to Allocation/DvP
  (`AllocationFactory_Allocate` at funding, `Allocation_ExecuteTransfer` / `_Withdraw` /
  `_Cancel`).
- Demonstrate an atomic task-output-for-payment settlement.

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
