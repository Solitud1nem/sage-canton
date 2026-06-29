# Toolchain & verified references — sage-canton

Canonical, **source-verified** setup notes so we never re-derive (or re-vet) this from
scratch. Every URL below was checked against official Digital Asset / Canton Network docs
on **2026-06-26**. When something here drifts, re-verify against the linked source and bump
the "verified" date.

> Provenance: domain `get.digitalasset.com` confirmed via TLS cert
> (`subject=get.digitalasset.com`, CA: Google Trust Services) and its
> `/install/latest` endpoint returned `3.5.1` — matching the `daml.yaml` SDK comment.

---

## 1. Build toolchain — `dpm` (Daml Package Manager)

**Use `dpm`, NOT the legacy `daml` assistant.** This project is on the new toolchain
(see `README.md`). The old `curl https://get.daml.com | sh` installs the
*legacy* `daml` assistant — **wrong tool, do not use it here.**

- Publisher: **Digital Asset** (creators of Daml/Canton).
- Official install doc: https://docs.digitalasset.com/build/3.4/dpm/manual-install.html
- Dpm overview: https://docs.digitalasset.com/build/3.4/dpm/dpm.html
- Configuration (`$DPM_HOME`, registry overrides): https://docs.digitalasset.com/build/3.4/dpm/configuration.html
- Download domain: `https://get.digitalasset.com/` (HTTPS only; DA publishes **no**
  separate checksum/signature — transport security only, by their design).
- Installs into `$DPM_HOME` (home dir), **no `sudo`**, does not touch system dirs.

### Verified install commands (verbatim from DA manual-install)

```bash
VERSION="$(curl -sS https://get.digitalasset.com/install/latest)"          # -> 3.5.1 (2026-06-26)
ARCH="$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')"
OS="$(uname | tr '[:upper:]' '[:lower:]')"
TARBALL="dpm-${VERSION}-${OS}-${ARCH}.tar.gz"
TMPDIR="$(mktemp -d)"
curl -SLf "https://get.digitalasset.com/install/dpm-sdk/${TARBALL}" -o "${TMPDIR}/${TARBALL}" --progress-bar
mkdir -p "${TMPDIR}/extracted"
tar xzf "${TMPDIR}/${TARBALL}" -C "${TMPDIR}/extracted" --strip-components 1
"${TMPDIR}/extracted/bin/dpm" bootstrap "${TMPDIR}/extracted"
"${TMPDIR}/extracted/bin/dpm" version
```

- Then `dpm install` (in repo root) pulls the SDK version pinned in `daml.yaml`.
- **JDK 17 is required to run `dpm test`** (the Daml script-service runs on the JVM).
  `dpm build` compiles without it, but `dpm test` fails with
  `Failed to run java: posix_spawnp: does not exist` until a JRE is on PATH.
- Endpoints: `/install/latest`, `/install/dpm-sdk/<tarball>`, unstable at
  `/unstable/install/`.

### JDK 17 without sudo (portable Temurin — what we actually used)

When `apt`/`sudo` isn't available, install a portable JRE from **Eclipse Adoptium**
(the JDK source Daml docs recommend; domain `adoptium.net` TLS-verified):

```bash
mkdir -p "$HOME/.local/jdk" && cd "$HOME/.local/jdk"
curl -sSL "https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jre/hotspot/normal/eclipse" -o jre.tgz
tar xzf jre.tgz && rm jre.tgz                       # -> ~/.local/jdk/jdk-17.x.y+z-jre/
```

### PATH for any new shell / session

`dpm` installs to `~/.dpm/bin`; the portable JRE lives under `~/.local/jdk`. Export both:

```bash
export JAVA_HOME="$(find "$HOME/.local/jdk" -maxdepth 1 -name 'jdk-17*' | head -1)"
export PATH="$JAVA_HOME/bin:$HOME/.dpm/bin:$PATH"
# then: dpm build --all && dpm test --package-root daml-tests   (multi-package: prod + tests)
```

---

## 2. SDK / protocol version pinning

- `daml.yaml: sdk-version` MUST match the **target Canton network's** protocol version.
- As of 2026-06: **MainNet → 3.4.12**, **TestNet/DevNet → 3.5.1**. Repo currently pins
  `3.3.0` (stale — fix before M1 build).
- Always confirm against the **Version Compatibility Dashboard**:
  https://docs.canton.network/shared/version-compatibility-dashboard
- Note: from SDK 3.5 the `override-components` config field is replaced by `components`.

---

## 3. Settlement — CIP-0056 token standard (USDCx)

We do **not** implement token transfers; we drive the standard's **Allocation / DvP**
(escrow-style) primitive. The sage-canton `provider` party is the allocation **executor**.

- CIP-0056 spec (canonical): https://github.com/canton-foundation/cips/blob/main/cip-0056/cip-0056.md
- Token Standard APIs (Splice): https://docs.global.canton.network.sync.global/app_dev/token_standard/index.html
- DA integration guide: https://docs.digitalasset.com/integrate/devnet/token-standard/index.html
- "What is CIP-56" primer: https://www.canton.network/blog/what-is-cip-56-a-guide-to-cantons-token-standard

### Verified package names (`splice-api-token-*-v1`)

| Package | Role |
| ------- | ---- |
| `splice-api-token-metadata-v1` | token metadata / identification |
| `splice-api-token-holding-v1` | `Holding` interface (UTXO holdings) |
| `splice-api-token-transfer-instruction-v1` | transfer execution |
| `splice-api-token-allocation-v1` | **allocations (escrow-style payments)** |
| `splice-api-token-allocation-instruction-v1` | allocation instruction execution |
| `splice-api-token-allocation-request-v1` | allocation requests |
| `splice-api-token-burn-mint-v1` | mint/burn (USDC mint/burn maps here) |

### Allocation lifecycle (maps to our TaskEscrow choices)

- **Fund (task creation):** requester locks USDCx into an `Allocation` with
  `executor = provider`. (Factory `*_Allocate` choice; confirm exact name from the
  allocation-instruction package against the pinned registry.)
- **Pay (`Approve` / `Resolve→payWorker`):** `provider` exercises
  **`Allocation_ExecuteTransfer`** → funds to worker, atomically.
- **Refund (`Refund` / `Resolve→!payWorker` / `Expired`):** **`Allocation_Withdraw`**
  (requester reclaims) or **`Allocation_Cancel`** (joint sender/receiver/executor).

> **Fee model (verified 2026-06-29):** NOT a fixed protocol fee. The factory choice
> response **metadata** returns the fee + any sender-change at runtime — read it, do not
> hardcode. Separately, Canton traffic fees are paid in Canton Coin (app provider can pay
> for a rebate). Still to pull before wiring: exact factory `*_Allocate` choice name +
> argument shape from `splice-api-token-allocation-instruction-v1`.

### Reference implementation to copy from (verified 2026-06-29)

cn-quickstart ships a **worked allocation app** — copy its shape for `TaskEscrow` M3:
`cn-quickstart/quickstart/daml/licensing/daml/Licensing/License.daml`.

- Imports: `Splice.Api.Token.{MetadataV1, HoldingV1, AllocationV1, AllocationRequestV1}`.
- Carries the instrument as a field: `licenseFeeInstrumentId : InstrumentId`.
- Implements `interface instance AllocationRequest` → declares `SettlementInfo`
  (`executor = provider`, `allocateBefore`/`settleBefore` deadlines, `settlementRef`) and
  a `transferLegs` map of `TransferLeg { sender; receiver; amount; instrumentId }`.
- Settlement choice `LicenseRenewalRequest_CompleteRenewal`:
  `allocationCid : ContractId Allocation`, `extraArgs : ExtraArgs` → `fetch @Allocation`,
  assert `transferLegId`/`transferLeg`/`settlement` match the request, then
  `exercise allocationCid (Allocation_ExecuteTransfer extraArgs)`. ← our `Approve` pay-leg.
- **Exact CIP-0056 interface DARs** are vendored at `quickstart/daml/dars/` after
  `make build`: `splice-api-token-{metadata,holding,allocation,allocation-request,
  allocation-instruction,transfer-instruction}-v1-1.0.0.dar`; mock registry for tests at
  `splice-token-standard-test-1.0.6.dar`; Canton Coin impl at `splice-amulet-0.1.14.dar`.
  Add these as `data-dependencies` in our `daml.yaml` to wire M3.

### USDC on Canton (USDCx) — verified deployment facts (2026-06-29)

USDCx = a CIP-0056 token issued via DA Utilities (xReserve, impl package `utility-bridge-v0`).
**Not available on LocalNet/DevNet** — dev settles on **Amulet (Canton Coin)**; USDCx is a
config switch on TestNet/MainNet (see ADR-0017). The admin-party → registry-URL mapping has
**no on-ledger resolver yet** — the app must maintain it in config.

| | Instrument admin party (`InstrumentId.admin`) | Registry base URL |
| --- | --- | --- |
| **MainNet** (live since 2025-12-04) | `decentralized-usdc-interchain-rep::12208115f1e168dd7e792320be9c4ca720c751a02a3053c7606e1c1cd3dad9bf60ef` | `https://api.utilities.digitalasset.com` |
| **TestNet** | `decentralized-usdc-interchain-rep::122049e2af8a725bd19759320fc83c638e7718973eac189d8f201309c512d1ffec61` | `https://api.utilities.digitalasset-staging.com` |
| **DevNet / LocalNet** | not published — use **Amulet** (`InstrumentId.id = "Amulet"`, local registry) | `LOCALNET_REGISTRY_API_URL` |

- Token-metadata endpoint pattern: `<base>/api/token-standard/v0/registrars/<adminParty>/registry/metadata/v1/instruments`.
- Verify the live **instrument**-admin party against that endpoint before hardcoding — the
  bridge-agreement party and the instrument-admin party may differ.
- xReserve / USDCx docs: https://docs.digitalasset.com/integrate/devnet/usdcx-support/index.html
- Mock registry for Daml-Script tests: `splice-token-standard-test`
  (https://github.com/hyperledger-labs/splice/tree/main/token-standard).

---

## 4. Local end-to-end — CN Quickstart (LocalNet) — VERIFIED run (2026-06-29)

Real multi-participant node + Canton Coin + wallet. Heavier than `dpm sandbox`. We brought
this up and ran `TaskEscrow` on it end-to-end; the exact steps that worked:

**Prerequisites:** Docker (Desktop WSL2 integration on, ~8 GB RAM), Nix ≥ 2.25 with flakes
enabled (`echo 'experimental-features = nix-command flakes' >> ~/.config/nix/nix.conf`),
direnv. JDK/Daml SDK come from the repo's nix devshell — you do NOT need them on the host.

**Bring-up:**
```bash
git clone https://github.com/digital-asset/cn-quickstart.git && cd cn-quickstart
# skip the interactive `make setup` by pre-writing quickstart/.env.local:
#   OBSERVABILITY_ENABLED=false / AUTH_MODE=shared-secret / PARTY_HINT=quickstart-sage-1 / TEST_MODE=off
nix develop --command bash -c 'cd quickstart && make build && make start'
```
First run pulls ~8-10 GB of Canton/Splice images and the SV bootstrap (splice container
`health: starting`) takes several minutes — normal. `make start` exits 0 when ~15
containers are healthy. `make stop` / `make start` reuse the cached images (fast).

**Participant ports (host = container, directly published):**

| Participant | gRPC ledger | admin | JSON Ledger API |
| --- | --- | --- | --- |
| App User | 2901 | 2902 | 2975 |
| App Provider | 3901 | 3902 | 3975 |
| SV | 4901 | 4902 | 4975 |

**Auth (shared-secret mode):** the ledger API needs an HS256 JWT signed with secret
`unsafe`, claims `{"sub":"ledger-api-user","aud":"https://canton.network.global"}`. Mint it
with `jwt-cli encode hs256 --s unsafe --p '{...}'` (in any splice container) or with openssl.
No token → 401; valid token → 200.

**Run our DAR on it (what worked):**
```bash
# 1. upload the DAR via JSON Ledger API (admin)
curl -H "Authorization: Bearer $JWT" -H "Content-Type: application/octet-stream" \
     --data-binary @.daml/dist/sage-canton-0.1.1.dar  http://localhost:3975/v2/packages
# 2. allocate parties:   POST http://localhost:3975/v2/parties {"partyIdHint":"worker",...}
# 3. grant the submitting user actAs rights (else PERMISSION_DENIED on submit):
#    POST /v2/users/ledger-api-user/rights  {rights:[{kind:{CanActAs:{value:{party:"…"}}}},…]}
# 4. run a script that takes parties as INPUT (not allocateParty):
dpm script --dar .daml/dist/sage-canton-0.1.1.dar \
  --script-name Tests.TestTaskEscrow:liveHappyPathFromInput \
  --ledger-host localhost --ledger-port 3901 \
  --access-token-file jwt.txt --input-file parties.json
```
Gotchas we hit: (a) **version+name collision** — re-uploading a changed DAR with the same
`name:version` fails `KNOWN_PACKAGE_VERSION`; bump `version` in `daml.yaml`. (b) a SDK-3.5.1
DAR uploads + runs fine on the 3.4.11 LocalNet participant. (c) the submitting user must
hold `CanActAs` for every party it acts as — `allocateParty`-inside-the-script does NOT
grant that, hence the input-driven script + explicit rights grant (this is also the M4
backend pattern).

### Live Amulet settlement runbook (VERIFIED end-to-end 2026-06-29)

Settling a `TaskEscrow` in REAL Canton Coin on the running node — all over HTTP, no wallet
UI. Implemented in `scripts/live_settlement_demo.py` (`setup` then `run`). The exact moves:

1. **Tap Amulet:** `POST http://localhost:2903/api/validator/v0/wallet/tap` `{"amount":"1000.0"}`
   with a JWT `sub=app-user` (the only wallet user here). Funds the app-user validator's
   primary party — use THAT as the escrow `requester` (get it from
   `GET …:2903/api/validator/v0/wallet/user-status` → `party_id`).
2. **DSO / instrument admin:** `GET …:4000/registry/metadata/v1/info` (Host: `scan.localhost`)
   → `adminId` = `DSO::1220…`. The Amulet instrument is `{admin: DSO, id: "Amulet"}`.
3. **Create + drive** the escrow over the JSON Ledger API
   (`POST …:2975/v2/commands/submit-and-wait-for-transaction`, `actAs` = the parties).
4. **Fund the allocation via the REAL registry factory** (the quickstart backend does NOT
   expose this — only execute/withdraw/cancel contexts):
   `POST …:4000/registry/allocation-instruction/v1/allocation-factory` (Host
   `scan.localhost`, no auth) with `{"choiceArguments": <AllocationFactory_Allocate args>,
   "excludeDebitedHoldings": false}` → returns `factoryId`, `choiceContextData`, 3
   `disclosedContracts`. Then exercise `AllocationFactory_Allocate` on `factoryId` (interface
   id `…allocation-instruction-v1…:AllocationFactory`, `actAs=[requester]`,
   `disclosedContracts` attached) → locks Amulet, creates the `AmuletAllocation`.
5. **Settle:** `POST …:4000/registry/allocations/v1/{allocId}/choice-contexts/execute-transfer`
   → transfer choice-context + disclosures; then the worker exercises `SettlePayment` on the
   escrow with `allocationCid` + `extraArgs.context`, attaching those disclosures PLUS the
   `AmuletAllocation` itself (it's only stakeholdered to dso/sender/executor, so disclose it
   to the worker). Result: worker's Amulet balance increases by the reward; escrow → Paid.

Gotchas we hit: (a) `settlement.requestedAt` must be ≤ ledger time — use a real timestamp
slightly in the past, NOT a fixed future one. (b) the escrow's stored `createdAt`/`deadline`
and the allocation spec's `requestedAt`/`allocateBefore`/`settleBefore` must be byte-identical
(SettlePayment asserts `SettlementInfo ==`) — compute them from ONE time base per run.
(c) filter holding inputs to UNLOCKED only (`LockedAmulet` also implements `Holding`).
(d) the SV scan/registry ingests new contracts async — retry the execute-transfer context
call until the fresh allocation is visible.

- Repo: https://github.com/digital-asset/cn-quickstart.git
- Install doc: https://docs.digitalasset.com/build/3.4/quickstart/download/cnqs-installation.html
- Reference app using the token standard: `quickstart/daml/licensing/` (see §3).

### Cross-participant privacy runbook (VERIFIED 2026-06-29)

Stakeholders on DIFFERENT participants — requester/provider on **App User** (:2975), worker
on **App Provider** (:3975) — same global synchronizer. Implemented in
`scripts/cross_participant_demo.py`; design in ADR-0018. The moves:

1. **Allocate each party on its HOME participant** (`POST :2975|:3975 /v2/parties`) and grant
   that participant's `ledger-api-user` `CanActAs` for its own parties. Party ids carry the
   home participant's namespace; cross-participant references are by global party id.
2. **Create on App User** (`actAs=[provider,requester]`, the signatories) with `worker` (an
   App-Provider party) as observer. Canton replicates the contract to App Provider because the
   worker is a stakeholder there.
3. **Check visibility** via `/v2/state/active-contracts` on each participant: stakeholders see
   1, outsiders on either participant see 0.
4. **Worker exercises `Accept` from App Provider** (`actAs=[worker]` on :3975) — its home
   participant authorizes; App User never holds the worker's `CanActAs`. The state change
   propagates back (App User provider sees `Accepted`).

Gotchas: (a) the package must be **vetted on BOTH** participants AND they must share a
synchronizer, else create fails `NO_SYNCHRONIZER_FOR_SUBMISSION`. (b) On a dev node whose
`sage-canton` package lineage is already tainted on each participant (a prior, different
v0.1.x vetted → smart-upgrade rejects the clean successor; see the M3/test-split notes), build
the identical contract under a **fresh name** (`sage-canton-xc`) so it vets cleanly on both,
and pass its id via `PACKAGE_ID`. On a fresh participant the production package vets directly.
(c) No external-party signing needed for this authority model — that's the self-custody layer
(`/v2/interactive-submission/prepare`+`execute`, endpoints confirmed present), ADR-0018 §2.

---

## 5. Canonical doc index (bookmark these)

| Topic | URL |
| ----- | --- |
| Canton Network docs (root) | https://docs.canton.network/ |
| All pages (machine list) | https://docs.canton.network/llms.txt |
| DA platform build docs (3.4) | https://docs.digitalasset.com/build/3.4/ |
| Version compatibility | https://docs.canton.network/shared/version-compatibility-dashboard |
| dpm | https://docs.digitalasset.com/build/3.4/dpm/dpm.html |
| Token standard APIs | https://docs.global.canton.network.sync.global/app_dev/token_standard/index.html |
| CIP-0056 spec | https://github.com/canton-foundation/cips/blob/main/cip-0056/cip-0056.md |
| CN Quickstart | https://docs.digitalasset.com/build/3.4/quickstart/download/cnqs-installation.html |
| Canton dev resources | https://www.canton.network/developer-resources |

Deeper engineering reference (privacy model, Daml idioms, JSON Ledger API, dpm) lives in the
KB `platform-canton-network` — read it before non-trivial Daml/settlement work.
