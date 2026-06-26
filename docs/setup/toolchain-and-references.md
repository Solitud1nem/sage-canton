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
(see `CLAUDE.md`, `README.md`). The old `curl https://get.daml.com | sh` installs the
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
# then: dpm build && dpm test
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

> Still to pull exactly before wiring: the factory `*_Allocate` choice name + argument
> shape, USDCx registry admin party + registry URL + fee model. Tracked in `PLANNING.md`
> M3 and `CLAUDE.md` open items.

### USDC on Canton (USDCx)

- USDC = a CIP-0056 standard token via DA Utilities (xReserve): mint/burn docs at
  https://docs.digitalasset.com/usdc/xreserve/overview.html

---

## 4. Local end-to-end — CN Quickstart (LocalNet)

For M2 (real multi-party node + Canton Coin + wallet). Heavier than `dpm sandbox`.

- Repo: https://github.com/digital-asset/cn-quickstart.git
- Install doc: https://docs.digitalasset.com/build/3.4/quickstart/download/cnqs-installation.html
- Prerequisites: **Docker Desktop** (~8 GB RAM), **Nix** ≥ 2.25.2, **direnv**, **curl**;
  Windows → **WSL 2** (admin). JDK/Daml SDK come inside the Docker env.
- Fast path: `docker login` → `cd quickstart` → `make setup` (Observability off, OAuth2 on,
  default party hint, TEST MODE off) → `make build` → `make capture-logs` (separate term) →
  `make start`.
- LocalNet = local validator + local super-validator (synchronizer); used for Canton Coin +
  wallet + USDCx flows.

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
