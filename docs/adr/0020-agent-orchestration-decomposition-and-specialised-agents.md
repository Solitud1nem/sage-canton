# ADR-0020: Agent orchestration — dynamic decomposition, specialised agents, honest research

- **Status:** Accepted (all four capabilities demonstrated live on Seaport DevNet)
- **Date:** 2026-07-02
- **Deciders:** Alex
- **Context note:** Continues the Canton-native ADR trail (0016 fork, 0017 settlement, 0018
  cross-participant/self-custody). This ADR records how the sage-canton **agent layer** works
  above the escrow: how a task is decomposed and priced for the human requester, how sub-tasks
  map to on-ledger child escrows, how agents are specialised via the AgentRegistry, and how the
  research agent produces citations that the fact-checker can honestly verify.

## Context

The EVM Sage headline above the settlement layer is **agent orchestration**: a task is
dynamically decomposed into sub-tasks, delegated to specialist agents, and the requester stays
in control of the plan and the spend. The Canton MVP initially shipped a single fixed
research→fact-check pipeline, which cut three corners:

1. **No decomposition, no plan.** A task ran as one opaque agent call — the paying requester
   never saw *what* they were buying or could shape it.
2. **Interchangeable agents.** Sub-tasks (once added) all went to one generic worker; "agents"
   were labels, not capabilities.
3. **Fabricated research.** The research agent asked the LLM to emit citations *from memory*,
   producing hallucinated/dead URLs; the strict fact-checker then failed almost everything.

## Decision

**Model the agent layer as a human-in-the-loop, two-phase orchestration over the existing
`TaskEscrow`, with specialised agents registered on-ledger and research grounded in real web
search.** No new settlement mechanics — decomposition reuses `TaskEscrow` via one new field.

### 1. On-ledger dynamic decomposition (parent → child escrows)

`TaskEscrow` gains `parentRef : Optional Text` (ADR-scope Daml change, package **0.2.0**). A
parent task is decomposed into N **child `TaskEscrow`s**, each with `parentRef = parent.taskRef`
— so the fan-out is provable on-ledger and each sub-task keeps its **own private stakeholder set
and independent settlement**. The parent is a status-only rollup (no money); the children carry
the rewards. A fabricated/errored sub-task refunds while sound ones pay → **partial settlement**.

### 2. Human-in-the-loop plan (the requester controls the spend)

Split into two REST phases:
- `POST /agent/plan/:cid` — an orchestrator LLM proposes sub-tasks + a reward split. **No side
  effects.** This is the quote: the requester sees exactly what they're paying for.
- `POST /agent/execute/:cid` — takes the (possibly edited) plan and creates + runs + settles a
  child escrow per sub-task with its **assigned** agent.

The UI renders the plan as an editable table: rewrite briefs, **reassign agents**, adjust
rewards, add/remove sub-tasks, running total vs budget, then Approve. This also answers the
pricing question raised against a privacy-by-default product: privacy hides terms from
*outsiders*, never from the requester, who always sees and edits their own plan.

### 3. Specialised agents via the AgentRegistry

`AgentRegistry.AgentProfile` (previously a skeleton) is now used: `/admin/provision` registers a
roster of named, capability-tagged agents on-ledger (registryOperator = provider) —
**Web Researcher**, **Standards & Docs Specialist**, **Data Analyst**. Discovery is off-ledger
(the backend reads the profiles it operates and serves them to the UI); profiles stay private to
`(registryOperator, agent)` — no global-visibility leak. Roles are **real behavioural
differences**, not labels: each runs a different `web_search` (general / blog-and-aggregator-
blocked → primary sources / deeper + data-focused). Proven: the same question via the Web vs
Docs agent yields different sources; the Docs specialist cites **0** blocked domains.

### 4. Honest research + honest fact-check (no smoothed corners)

- **Research** uses Anthropic's server-side `web_search_20260209` tool (on Sonnet 5 for speed):
  the agent actually searches and we harvest the URLs it retrieved/cited — real, resolvable
  sources. A search-first system prompt stops the model answering from memory.
- **Fact-check** honestly distinguishes *"real source the server blocks/limits"* (401/403/405/
  429 → exists) from *"the source does not exist"* (404/410, DNS failure, connection refused →
  fail). Fabrication surfaces as a made-up domain (DNS-fail) or 404 and still fails; a real page
  that blocks bots is not punished. This is **stricter about fabrication, not looser**.

## Alternatives considered

- **Off-ledger sub-steps inside one escrow** (rejected): cheaper, but the decomposition wouldn't
  be on-ledger and each sub-task couldn't be privately scoped or settled independently — losing
  the Canton differentiator. Chose on-ledger child escrows.
- **Loosen the fact-checker to "majority resolve"** to make demos pass (rejected): that hides
  fabrication. Fixed the root cause instead — give the agent real web search and make the
  resolver accurate.
- **Prompt-only agent "specialisation"** (rejected as the sole mechanism): would be fake
  differentiation. Each role makes a materially different `web_search` request (domain scoping,
  depth) so the behaviour genuinely differs.
- **Contract-key `name → AgentProfile` lookup** (deferred): still omitted pending confirmed
  `key … maintainer …` syntax (see AgentRegistry.daml); discovery stays off-ledger for now.

## Consequences

- **Positive:** the Sage killer feature (plan → edit → delegate) is real and demonstrable; the
  requester controls spend and assignment; sub-tasks are private and settle independently
  (partial settlement); agents are genuinely specialised and registered on-ledger; research is
  grounded and the fact-check is honest — all proven live on Seaport
  (`npm run plan:seaport` / `agents:seaport` / `decompose:seaport`).
- **Negative / cost:** the `parentRef` field bumped the package to 0.2.0 (new id `56c051ce…`,
  re-vetted on Seaport). Real web-search research is slower (~40s/sub-task on Sonnet 5) and can
  hit transient API timeouts — handled by per-sub-task resilience (one failure refunds, doesn't
  abort the batch) but a retry on transient errors is a follow-up. Agent specialisation is
  currently three fixed research roles; a fuller registry (capabilities-based matching,
  agent-set discovery, self-registration) is future work.
- **Follow-ups:** (a) retry transient web-search failures to reduce `errored` sub-tasks;
  (b) capability-based default assignment (orchestrator matches sub-task → best agent);
  (c) seed sub-task rewards from registry pricing; (d) fold PQS-backed discovery so agents
  aren't provisioned per session.
