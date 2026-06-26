# ADR-0016: Separate Canton implementation under the Sage umbrella

- **Status:** Accepted
- **Date:** 2026-06-26
- **Deciders:** Alex
- **Context note:** ADR numbering continues the Sage trail (last EVM ADR was 0015 — Arc
  bridge interim). This is the first ADR of the Canton-native sibling and is recorded
  in `sage-canton`, not the EVM monorepo.

## Context

We are entering the Canton Hackathon (Payments / Neobanking / Agentic Commerce track).
Sage already exists as a production EVM task-escrow protocol for AI agents (live on Base
mainnet + Arc testnet). Canton's value proposition — **sub-transaction privacy** + atomic
multi-party settlement + USDCx — directly fixes EVM Sage's structural weakness: on a
transparent ledger, agent pricing, bids, counterparties and task terms are all public.

The question: how do we bring Sage's mechanics to Canton?

Key technical fact forcing the decision: Sage's `ChainAdapter` abstraction (and ADR-0001
deterministic addresses, ADR-0002 EOA+EAS identity, ADR-0004 USDC+permit, x402 transport)
is **EVM-shaped**. Canton is further from EVM than Solana is: no addresses, no account
model, identity = party IDs, contracts in **Daml**, and privacy is not a feature bolted on
but inverts the data model (discovery/indexing are per-party, not global `getLogs`).

## Decision

Build **sage-canton** as a **separate, Canton-native codebase under the Sage brand**
(Option C). Define the seam at the **JSON Ledger API**:

- **Share above the seam:** product concept, UX, agent-orchestration logic, brand, the
  escrow lifecycle spec, demo narrative, docs audience.
- **Fork below the seam:** smart contracts (Daml, not Solidity), identity (Canton party,
  not EOA+EAS), settlement (USDCx via CIP-0056, not USDC+permit), privacy model, and
  discovery (off-ledger / explicit disclosure, not a public indexer).

Do **not** force Canton through the EVM `@sage/adapter-*` interface.

## Alternatives considered

- **A — Adapter inside the Sage EVM monorepo (`@sage/adapter-canton`).** Reuses the
  existing `ChainAdapter` surface and gives a single "multi-chain incl. Canton" story.
  **Rejected:** the adapter interface is EVM-formed; Canton's party + privacy + Daml model
  forces either a leaky abstraction or a fake conformance (cf. the `adapter-arc`
  NotImplementedError scaffold). Under hackathon time pressure the abstraction fights us,
  and the Daml contracts live outside the TS monorepo regardless.
- **B — Fully separate greenfield, new brand, nothing shared.** Cleanest from an EVM-
  baggage standpoint. **Rejected:** throws away the frontend/agent/demo reuse and the
  brand-credibility narrative ("mature protocol, live on mainnet") that helps with judges,
  for more total work and less payoff.

## Consequences

- **Positive:** clean Canton-native design; privacy as a first-class property; a separate,
  reviewable public repo that satisfies the hackathon "public repo + clean code"
  requirement; the live EVM Sage codebase is not put at risk during a time-boxed hack; the
  "Sage on Canton" framing keeps brand + narrative.
- **Negative / cost:** the contract layer is a from-scratch Daml rewrite (this work is the
  same under A, B, or C — Option C simply avoids extra friction from a foreign
  abstraction). Two codebases to keep conceptually in sync at the product layer.
- **Follow-ups:** later unification, if any, happens at the **discovery/registry** layer
  (a meta-index across EVM + Canton), never at the shared-contract-code layer. Reference
  the EVM Sage lifecycle when modeling the Daml `TaskEscrow` so the product stories match.
