# ADR-0017: Settlement via the CIP-0056 token standard (Amulet for dev, USDCx for prod)

- **Status:** Accepted
- **Date:** 2026-06-29
- **Deciders:** Alex
- **Context note:** Continues the Canton-native ADR trail started by ADR-0016. This ADR
  fixes *how* `TaskEscrow` actually moves money, which ADR-0016 left as "settlement =
  USDCx via CIP-0056" without committing to a mechanism. Facts here were source-verified
  against `docs.digitalasset.com`, the GSF CIP-0056 spec, and `hyperledger-labs/splice`
  on 2026-06-29; see `docs/setup/toolchain-and-references.md` §5 for the citation table.

## Context

`TaskEscrow` (see `daml/TaskEscrow.daml`) is today a pure state machine: it tracks
`amount : Decimal` and walks Created → Accepted → Completed → Paid/Refunded/Expired, but
the value-bearing choices (`Approve`, `Resolve`, `Refund`, `Expire`) only flip `status` —
no actual asset is escrowed or released. The `amount` is a number, not money.

To settle we need to answer three coupled questions:

1. **Which asset?** The headline is USDCx (CIP-0056), but research (2026-06-29) confirmed
   **USDCx does not exist on LocalNet / cn-quickstart**, and even on TestNet/MainNet the
   instrument-admin-party → registry-URL mapping must be hand-maintained by the app (no
   on-ledger resolver yet). Building or demoing against real USDCx locally is impossible.

2. **What do we code against?** Each concrete token (USDCx via `utility-bridge-v0`,
   Canton Coin via `splice-amulet`) ships its own DAR. Coding against a concrete DAR welds
   us to one token.

3. **How does escrow+release stay atomic and private?** EVM Sage used `USDC + permit` and
   `msg.sender`. Canton has neither; the standard primitive is the CIP-0056
   **Allocation / DvP** flow exercised through registry **factory** choices.

Key facts that force the design (all source-verified — see references doc):

- CIP-0056 is a set of **interface** packages, all `-v1`:
  `splice-api-token-metadata-v1`, `-holding-v1`, `-transfer-instruction-v1`,
  `-allocation-v1`, `-allocation-instruction-v1`, `-allocation-request-v1`
  (+ `-burn-mint-v1` for issuers). Any compliant token — **Amulet (Canton Coin)** and
  **USDCx** both — implements these.
- **Amulet implements CIP-0056** and the docs explicitly bless it as the stand-in "if you
  do not have access to another token." cn-quickstart's LocalNet bundles the Amulet
  registry + Scan; the token-standard dev guide hardcodes `instrumentId = "Amulet"` and a
  `LOCALNET_REGISTRY_API_URL` for local work.
- **Fees are not fixed.** They are returned at runtime in the factory **choice-response
  metadata**; the app must read them, not assume them. (Plus Canton traffic fees in Canton
  Coin, payable by the app provider for a rebate.)
- `splice-token-standard-test` provides a Daml-Script mock registry for unit tests.

## Decision

**Settle through the CIP-0056 Allocation/DvP primitive, coding `TaskEscrow` against the
`splice-api-token-*-v1` interfaces only — never against a concrete token's DAR.** The
instrument is a *parameter*, not a baked-in dependency.

1. **Interface-only coupling.** `TaskEscrow` references `Holding`, `Allocation`,
   `AllocationFactory`, `TransferInstruction` via the `splice-api-token-*-v1` interfaces.
   It never imports `splice-amulet` or `utility-bridge-v0`.

2. **Instrument is configuration.** The escrow carries the target instrument
   (`InstrumentId { admin, id }`) as data. Dev/LocalNet → `id = "Amulet"` with the local
   registry; TestNet/MainNet → USDCx (`admin = decentralized-usdc-interchain-rep::…`,
   registry `api.utilities.digitalasset[-staging].com`). **Swapping USDCx ⇄ Canton Coin is
   a config change, zero contract changes**, as long as we stay on the interfaces.

3. **Lifecycle → allocation mapping:**
   - **Funding (at/after create):** requester's wallet calls the registry
     `AllocationFactory_Allocate` to lock `amount` of the instrument into an `Allocation`
     whose settlement is conditioned on the `TaskEscrow` outcome. The escrow references
     the resulting allocation cid.
   - **`Approve` / `Resolve(payWorker=True)` → pay worker:** exercise
     `Allocation_ExecuteTransfer` → funds move requester → worker atomically with the
     status flip to `Paid`.
   - **`Refund` / `Resolve(payWorker=False)` → return to requester:** `Allocation_Withdraw`
     (or `_Cancel`) → locked funds return; status → `Refunded`.
   - **`Expire` → reclaim after deadline:** `Allocation_Cancel`/`_Withdraw`; status →
     `Expired`/`Refunded`.
   - **Fees:** read the amount + any sender-change from the factory/choice **response
     metadata**; do not hardcode a fee.

4. **Privacy preserved.** The allocation is a CIP-0056 contract between the
   requester, the registry, and (on execution) the worker — visible only to its
   stakeholders, matching `TaskEscrow`'s own observer model. No global token ledger view.

5. **Testing.** Unit-test settlement with `splice-token-standard-test`'s mock registry in
   Daml Script; integration-test on cn-quickstart LocalNet using real Amulet.

## Alternatives considered

- **A — Code directly against Canton Coin (`splice-amulet`) now, port to USDCx later.**
  Fastest to a working LocalNet demo. **Rejected:** welds the escrow to Amulet's DAR;
  moving to USDCx becomes a contract rewrite, not a config flip. The interface-only path
  costs little more and keeps the USDCx promise of ADR-0016 cheap to honour.

- **B — Target real USDCx end-to-end.** Most on-brand. **Rejected as infeasible for the
  hack:** USDCx is absent on LocalNet, needs a hand-maintained registry mapping, and a
  bridge user-agreement (`utility-bridge-v0`) — none demoable locally in the time box. We
  keep USDCx as the *production* target and a one-config-line switch, demoing on Amulet.

- **C — Keep `amount` as a bare number; fake settlement in the UI.** Zero Daml work.
  **Rejected:** the privacy-native *atomic settlement* story is the whole pitch; a faked
  transfer fails the "working e2e" judging criterion and the privacy claim.

## Consequences

- **Positive:** one escrow, any CIP-0056 token; USDCx is a config switch, not a rewrite;
  LocalNet demo works today on Amulet; settlement contracts inherit Canton's
  sub-transaction privacy for free; fee-on-runtime keeps us correct across networks; mock
  registry makes settlement unit-testable without a live node.
- **Negative / cost:** the off-ledger plumbing (resolving the registry URL from the admin
  party, calling factory choices via the JSON Ledger API, threading allocation cids
  through the escrow) lands in the M4 backend, not in Daml — the contract stays thin but
  the orchestration grows. The admin-party → registry-URL map must be maintained in app
  config until CNS-based discovery exists.
- **Follow-ups:** (M3) add the `InstrumentId` field + allocation-cid reference to
  `TaskEscrow` and wire the four value choices to the allocation lifecycle; pull exact
  `splice-api-token-*-v1` choice signatures into the model; stand up
  `splice-token-standard-test` in `daml/Tests/`. (M4) registry-URL resolution + factory
  calls over JSON Ledger API.
