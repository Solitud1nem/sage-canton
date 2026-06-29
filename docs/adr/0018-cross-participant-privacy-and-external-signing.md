# ADR-0018: Cross-participant privacy and external-party signing

- **Status:** Accepted (cross-participant privacy demonstrated; external signing scoped)
- **Date:** 2026-06-29
- **Deciders:** Alex
- **Context note:** Continues the Canton-native ADR trail (0016 fork rationale, 0017
  settlement). This ADR records how `TaskEscrow`'s privacy model maps onto a *multi-participant*
  deployment — the headline differentiator over EVM Sage — and fixes external-party signing
  as the path to agent self-custody. Demonstrated end-to-end on cn-quickstart LocalNet
  (App User + App Provider participants) via `scripts/cross_participant_demo.py` on 2026-06-29.

## Context

Through M5 every party (requester, provider, worker, arbiter, outsider) was hosted on ONE
participant (App User), with the backend holding `CanActAs` for all of them. That proves the
lifecycle, the auth model, and *party-scoped* privacy — but not the institutional story: in
production the worker (an autonomous agent) and the requester belong to **different
organisations on different participants**, and no one organisation should be able to act for
another or see escrows it isn't party to.

Two distinct capabilities are involved, and they are independent:

1. **Cross-participant hosting + privacy.** Stakeholders hosted on different participants of
   the same synchronizer; Canton replicates each contract only to the participants hosting
   its stakeholders, scoped per party (sub-transaction privacy). This needs NO external
   signing — each participant authorizes for the parties it hosts locally.
2. **External-party signing (self-custody).** A party whose signing key lives OFF the
   participant; transactions are `prepare`d by a participant, the hash is signed by the
   external key, and `execute`d with that signature. This lets an agent self-custody instead
   of trusting a participant operator to hold `CanActAs`.

## Decision

**Map `TaskEscrow`'s existing observer model directly onto participants, and adopt the v2
JSON Ledger API interactive submission (`prepare`/`execute`) as the mechanism for external
self-custody.** No contract changes are required for either: the template's
`signatory provider, requester` / `observer worker, arbiter` already expresses who each
participant must host and what it may authorize.

1. **Cross-participant topology (demonstrated).** Requester + provider on App User (the
   signatories, so creation is authorized there); worker on App Provider (an observer, so its
   participant receives the contract over the synchronizer). The worker's controller choices
   (`Accept`, `Complete`) are submitted from App Provider — its home participant authorizes
   for it; App User never holds `CanActAs` for the worker. Verified:
   - create on App User → `requester @ App User` sees 1, `outsider @ App User` sees **0**;
   - `worker @ App Provider` sees **1** (cross-participant), `outsider @ App Provider` sees **0**;
   - `worker` exercises `Accept` from App Provider → App User's provider sees `Accepted`
     (the sub-transaction propagated back, terms still private to non-stakeholders).
   Prerequisite (learned the hard way): the package must be **vetted on BOTH participants**
   and they must share a synchronizer, otherwise submission fails `NO_SYNCHRONIZER_FOR_SUBMISSION`.

2. **External signing (scoped, next).** Onboard the worker as an *external party* (key pair
   generated client-side; the public key published to the participant's topology), then drive
   its choices via `/v2/interactive-submission/prepare` → sign the returned transaction hash
   with the private key → `/v2/interactive-submission/execute`. The endpoints are present on
   the LocalNet JSON API (confirmed). The backend's current `CanActAs`-based `EscrowService`
   becomes the "custodial" path; an external-signing path is added alongside for agents that
   self-custody.

## Alternatives considered

- **Keep everyone on one participant; call it "private".** Rejected: party-scoped privacy on
  a single participant doesn't demonstrate the cross-organisation story institutions need,
  and leaves the participant operator able to act for every party.
- **External signing first, before cross-participant hosting.** Rejected as sequencing:
  cross-participant privacy is the visible differentiator and needs no key management, so it
  lands first; external signing is layered on without contract changes.
- **A fresh package name to dodge dev-node vetting lineage.** Used only as a LocalNet
  workaround: the demo node already had tainted `sage-canton` 0.1.x lineages on each
  participant (smart-upgrade rejects the clean successor), so the demo builds the identical
  contract under `sage-canton-xc` to vet cleanly on both. On a fresh participant the
  production package vets directly; this is not a design change.

## Consequences

- **Positive:** the privacy claim is now demonstrated across organisational boundaries, not
  just asserted; the contract needed zero changes (the observer model already encoded it);
  external signing has a concrete, API-backed plan for agent self-custody; the custodial and
  self-custody paths can coexist in the backend.
- **Negative / cost:** operationally the package must be vetted on every participant hosting a
  stakeholder, and the admin-party/topology plumbing grows; external signing adds client-side
  key management, external-party onboarding, and the two-step prepare/execute flow (more
  round-trips, hash-verification responsibility on the signer).
- **Follow-ups:** (a) external-party onboarding + a `prepare`/sign/`execute` path in the
  backend for the worker agent; (b) settle the cross-participant escrow in real Amulet (the
  allocation's registry parties span participants — verify disclosure routing); (c) a fresh
  LocalNet (or per-participant clean vetting) so the production `sage-canton` package, not the
  `sage-canton-xc` stand-in, runs the cross-participant path.
