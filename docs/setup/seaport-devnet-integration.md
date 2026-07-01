# Seaport DevNet integration — runbook (M8)

**Goal:** deploy sage-canton to the Seaport shared **DevNet "5n sandbox"** validator so the
submission has a *live, judge-reachable* product (Seaport's Contracts tab shows the full
create/exercise/archive history to judges). This is **additive** — LocalNet stays the fallback
for the video and the only home of the cross-participant (ADR-0018) demo.

> **Security:** the OIDC **client secret** lives ONLY in `backend/.env` (git-ignored). Never
> commit it, never paste it into the repo, KB, deck, or a screen recording. This doc uses the
> env-var name; the value is in the Seaport access PDF.

---

## 1. Access data (from the Seaport access PDF)

| What | Value |
| ---- | ----- |
| Ledger REST (v2 JSON Ledger API) | `https://ledger-api.validator.devnet.sandbox.fivenorth.io/` |
| Ledger WebSocket | `wss://ledger-api.validator.devnet.sandbox.fivenorth.io/v2/...` |
| OIDC token endpoint (Authentik) | `https://auth.sandbox.fivenorth.io/application/o/token/` |
| OIDC grant | `client_credentials` |
| `client_id` | `validator-devnet-m2m` |
| `client_secret` | **in the PDF → `backend/.env` only** |
| `audience` | `validator-devnet-m2m` |
| `scope` | `daml_ledger_api` |
| Access-token lifetime | **8 hours** → the backend must detect expiry and refresh |
| WS subprotocols (order matters) | `jwt.token.<token>` **then** `daml.ws.auth` |

**Important architectural fact:** this is a **single m2m credential for one shared validator**
→ all our parties (provider / requester / worker / arbiter) sit on **one participant**.
Single-node sub-transaction privacy (an `outsider` party sees 0 escrows) still holds here.
**Cross-participant privacy (M7 / ADR-0018) canNOT be shown on Seaport** — it needs two
participant nodes; keep it as the LocalNet recording.

---

## 2. Environment variables

Add to `backend/.env` (git-ignored) and commit a `backend/.env.example` with the names only:

```dotenv
# --- Seaport DevNet target ---
LEDGER_TARGET=seaport-devnet                    # selects the Seaport profile in config.ts
SEAPORT_LEDGER_URL=https://ledger-api.validator.devnet.sandbox.fivenorth.io
SEAPORT_WS_URL=wss://ledger-api.validator.devnet.sandbox.fivenorth.io
SEAPORT_OIDC_TOKEN_URL=https://auth.sandbox.fivenorth.io/application/o/token/
SEAPORT_CLIENT_ID=validator-devnet-m2m
SEAPORT_CLIENT_SECRET=__PUT_THE_SECRET_FROM_THE_PDF_HERE__   # NEVER commit the real value
SEAPORT_AUDIENCE=validator-devnet-m2m
SEAPORT_SCOPE=daml_ledger_api

# Parties (fill after step 5 decides the party model)
SAGE_PROVIDER_PARTY=
SAGE_REQUESTER_PARTY=
SAGE_WORKER_PARTY=
SAGE_ARBITER_PARTY=
```

`backend/.env.example` = the same block with every value blanked (keeps `.env` shape in git).

---

## 3. Auth: OIDC client_credentials + 8h refresh

### 3.1 Manual token exchange (verify by hand first)

```bash
curl -X POST 'https://auth.sandbox.fivenorth.io/application/o/token/' \
  --header 'Content-Type: application/x-www-form-urlencoded' \
  --data 'grant_type=client_credentials' \
  --data "client_id=$SEAPORT_CLIENT_ID" \
  --data "client_secret=$SEAPORT_CLIENT_SECRET" \
  --data "audience=$SEAPORT_AUDIENCE" \
  --data "scope=$SEAPORT_SCOPE"
# -> { "access_token": "...", "expires_in": 28800, "token_type": "Bearer", ... }
```

### 3.2 Backend module — `backend/src/auth.ts` (new)

A small token provider with in-memory cache + refresh. Node 18+ has global `fetch`.

```ts
// backend/src/auth.ts
interface CachedToken { token: string; expiresAt: number; }

let cache: CachedToken | null = null;

export interface OidcConfig {
  tokenUrl: string; clientId: string; clientSecret: string;
  audience: string; scope: string;
}

export async function getSeaportToken(cfg: OidcConfig): Promise<string> {
  const now = Date.now();
  // refresh 60s before actual expiry to avoid mid-request expiry
  if (cache && cache.expiresAt - 60_000 > now) return cache.token;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    audience: cfg.audience,
    scope: cfg.scope,
  });
  const res = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`OIDC token exchange failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cache = { token: json.access_token, expiresAt: now + json.expires_in * 1000 };
  return cache.token;
}
```

> Also handle **401 mid-flight**: if a Ledger API call returns 401, clear `cache` and retry once
> (an 8h token can expire during a long demo session).

---

## 4. Backend changes — file by file

We already speak the **v2 JSON Ledger API with hand-written types** (deliberately, not
`dpm codegen-js` which targets the deprecated v1) — so this is a **config + auth swap, not a
client rewrite**. `@c7/ledger` is not needed.

| File | Change |
| ---- | ------ |
| `src/config.ts` | Add a `seaport-devnet` target: `ledgerUrl`, `wsUrl`, and an `auth` block (mode `oidc`) reading the `SEAPORT_*` env vars. Keep the existing LocalNet target (mode `self-mint`). Select via `LEDGER_TARGET`. |
| `src/auth.ts` (new) | The OIDC provider above. |
| `src/jwt.ts` | Keep the LocalNet self-mint path. Introduce a single `getToken()` that dispatches on the target's auth mode: `self-mint` → existing minter; `oidc` → `getSeaportToken(cfg)`. |
| `src/ledger.ts` | Base URL from config; `Authorization: Bearer ${await getToken()}` on every request; on 401 clear the OIDC cache and retry once. |
| `src/registry.ts` | On Seaport there is no `scan.localhost` Host hack — point at the DevNet Amulet registry URL **if** one is reachable (see §7). Guard behind the target. |
| `src/provision.ts` | Party model depends on §5. Either allocate our 4 parties on the shared validator, or read them from `SAGE_*_PARTY` env (Loop-wallet Party IDs). |
| `package.json` | Add `"smoke:seaport": "node dist/smoke-seaport.js"` (see §6). |

---

## 5. Party model — Q1 RESOLVED → **Path A (allocate on the shared validator)** ✅

Probed 2026-07-01 with the m2m token (`npm run probe:seaport`):
- our ledger user id is **`6`** (username `otc-canton-fund-oauth`, primaryParty
  `5nsandbox-devnet-2::1220a14c…`) — NOT the OAuth `client_id`; the participant keys the user
  off the JWT **`sub`** claim, so `grantActAs` must target `6` (see `currentUserId()` in `jwt.ts`);
- the user holds **`ParticipantAdmin`** + `CanExecuteAsAnyParty` + `CanReadAsAnyParty` (plus 312
  `CanActAs` / 179 `CanReadAs` for pre-existing sandbox parties);
- `POST /v2/parties {partyIdHint:"sagecanton"}` → **200** (`sagecanton::1220a14c…`).

So we **allocate our own provider/requester/worker/arbiter** on the shared participant and
`grantActAs` them to user `6`. `provision.ts` needs no Loop-wallet path. All parties share the
participant namespace suffix `::1220a14c…` (single participant, as expected — no cross-participant
story here). Path B (Loop-wallet Party IDs) is unnecessary.

> Note: the participant has `CanExecuteAsAnyParty`/`CanReadAsAnyParty` but **not**
> `CanActAsAnyParty`, so ordinary `submit-and-wait` (actAs) still needs an explicit `CanActAs`
> grant per party — which we can issue because we are `ParticipantAdmin`.

---

## 6. Smoke test — DO THIS FIRST (unblocks everything)

`backend/src/smoke-seaport.ts` (new): exchange a token, hit ledger-end.

```ts
import { getSeaportToken } from "./auth.js";
const cfg = {
  tokenUrl: process.env.SEAPORT_OIDC_TOKEN_URL!,
  clientId: process.env.SEAPORT_CLIENT_ID!,
  clientSecret: process.env.SEAPORT_CLIENT_SECRET!,
  audience: process.env.SEAPORT_AUDIENCE!,
  scope: process.env.SEAPORT_SCOPE!,
};
const token = await getSeaportToken(cfg);
const res = await fetch(`${process.env.SEAPORT_LEDGER_URL}/v2/state/ledger-end`, {
  headers: { Authorization: `Bearer ${token}` },
});
console.log(res.status, await res.text());   // expect 200 + an offset
```

Or by hand:

```bash
TOKEN=$(curl -s -X POST "$SEAPORT_OIDC_TOKEN_URL" \
  -d grant_type=client_credentials -d client_id=$SEAPORT_CLIENT_ID \
  -d client_secret=$SEAPORT_CLIENT_SECRET -d audience=$SEAPORT_AUDIENCE \
  -d scope=$SEAPORT_SCOPE | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')

curl -s -X GET "$SEAPORT_LEDGER_URL/v2/state/ledger-end" \
  -H "Authorization: Bearer $TOKEN"
# expect: 200 with {"offset": ...}
```

---

## 7. Settlement on DevNet — OPEN QUESTION Q2 (the money-moment)

Our settlement is instrument-config (Amulet on LocalNet, USDCx on Test/MainNet). On the 5n
sandbox we must find out **what token is reachable**:

1. Does the sandbox expose an **Amulet (Canton Coin) CIP-0056 registry + factory** callable over
   the API, and can the **Loop wallet faucet CC** to our parties?
   - **YES** → set `instrumentId` to DevNet Amulet, fund via faucet, run the real
     `SettlePayment` on Seaport → **money moves on a public node** (upgrades the headline from
     LocalNet → public).
   - **NO / uncertain** → fallback: run **lifecycle-only** on Seaport (status choices, still a
     real live deploy) and keep **real settlement as the LocalNet recording**; or deploy our own
     mock registry DAR to Seaport for real (if less prestigious) token movement.
2. Reuse the existing settlement path (`EscrowService` fund→settle in `src/escrow.ts` +
   `src/registry.ts`) — only the registry URL + `instrumentId` change; the Daml choices are
   untouched.

---

## 8. DAR upload & Daml re-target — Q3 RESOLVED → **0.1.4 vets as-is on DevNet** ✅

Verified 2026-07-01:
- the DevNet validator reports **`version 3.5.6`** (`GET /v2/version`) — newer than the KB's
  3.5.1 and our LF 2.2 / SDK-3.4.11 build target;
- the clean **`sage-canton-0.1.4.dar`** (674 KiB, pkg `46b3e0f3…`) **uploaded via
  `POST /v2/packages` and vetted with no error** — no re-pin/rebuild needed. Fresh participant ⇒
  the LocalNet vetting-lineage problem does not apply.
- **Gotcha (3.5.6):** the `/v2/state/active-contracts` template filter requires a
  **package-NAME** identifier (`#sage-canton:TaskEscrow:TaskEscrow`), not a package id — even
  though create/exercise commands accept the package-id form. `EscrowService` now qualifies
  commands by package id (`this.te`) and ACS queries by package name (`this.teQuery`,
  `config.packageName`). Package-name matching also spans DAR upgrades.
- `dpm test --package-root daml-tests` stays **14 green** (unchanged SDK).

---

## 9. Demo topology (lock this, then update the deck)

| Runs where | What it shows |
| ---------- | ------------- |
| **Seaport DevNet (live)** | lifecycle create→accept→complete→approve · single-node privacy (`outsider` sees 0) · settlement *if* token available (§7) · optionally external-party self-custody signing (single-participant-friendly) · judges interact + see the Contracts tab |
| **LocalNet (recorded)** | **cross-participant** privacy (ADR-0018) — the two-participant story that can't run on one shared validator |

Update `DECK-PLAN.md` + `README.md`: "live on Seaport DevNet" for the reachable parts;
"cross-participant proven on LocalNet (recorded)" for the differentiator.

---

## 10. Checklist / sequence

1. [~] `backend/.env.example` committed (names only) ✅; **fill `backend/.env` from the PDF** — pending (the `SEAPORT_CLIENT_SECRET`).
2. [~] **Smoke** (§6): `npm run smoke:seaport` wired ✅ (`src/smoke-seaport.ts`); **live run pending the secret** (expects `GET /v2/state/ledger-end` → 200).
3. [x] `src/auth.ts` (OIDC cache+refresh) + `config.ts` `seaport-devnet` target (`LEDGER_TARGET`) + `jwt.ts` async `getToken()` dispatch + `ledger.ts` Bearer + 401-clear-and-retry ✅. `src/dotenv.ts` loads `backend/.env`. Typecheck + full build green; LocalNet path unchanged.
4. [x] **Party model decided** (§5, Q1) → **Path A** (allocate; user `6` is `ParticipantAdmin`).
       `seaport-e2e.ts` allocates + grants at run time; standing `SAGE_*_PARTY` still optional.
5. [x] **Prod DAR uploaded + vetted** (§8, Q3) — `0.1.4` on validator `3.5.6`, no re-pin.
6. [x] **Lifecycle e2e on Seaport** — `npm run e2e:seaport`: create→accept→complete→**Paid**,
       privacy holds (worker sees 1, outsider 0). Still TODO: eyeball it in the Contracts tab.
7. [ ] Decide **settlement** (§7, Q2); wire instrument/registry or fall back.
8. [ ] Lock **topology** (§9); update `DECK-PLAN.md` + `README.md`.
9. [ ] Write **ADR-0019** (deployment target = Seaport single-participant + OIDC auth).
10. [ ] Append a "Seaport DevNet access" section to KB `platform-canton-network` (no secret).

Keep the LocalNet path intact as the video fallback throughout.

---

## 11. Open questions (gating — nail early)

1. ~~Party allocation on the shared validator with the m2m token?~~ **RESOLVED** → yes, Path A
   (user `6` = `ParticipantAdmin`). §5.
2. Amulet registry + CC faucet reachable on the DevNet sandbox? (gates §7) — **still open, next.**
3. ~~Does the clean `0.1.4` DAR vet on DevNet as-is, or re-pin SDK?~~ **RESOLVED** → vets as-is on
   `3.5.6`. §8.
4. External-party `prepare`/`execute` through the shared validator with m2m auth? (bonus §9) — open.
5. Exact "live product" link judges open + their org/team access. — open.
