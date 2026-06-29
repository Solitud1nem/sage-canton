# sage-canton backend

Typed TypeScript orchestration over the **Canton v2 JSON Ledger API** + the **Amulet
CIP-0056 registry**. This is the seam the M5 frontend and agent runners talk to: it exposes
the `TaskEscrow` lifecycle and real-token settlement as a small REST API, and runs the
idempotent automation (auto-expire overdue tasks, optional auto-settle).

Verified end-to-end against a live cn-quickstart LocalNet (worker paid real Canton Coin).

## Why direct v2, not `@daml/ledger`

`dpm codegen-js` emits `@daml/types` bindings whose decoders target the **deprecated v1**
JSON API. Canton 3.x serves the **v2** JSON Ledger API, so this backend speaks v2 directly
with hand-written types (`src/types.ts`) verified against the live node. (codegen-js output
is still handy as a type reference; not required at runtime.)

## Layout

| file | role |
| ---- | ---- |
| `src/config.ts`   | endpoints, auth, party/instrument config (env-overridable) |
| `src/jwt.ts`      | HS256 shared-secret token minting |
| `src/ledger.ts`   | v2 JSON Ledger API client (submit, ACS query, party/DAR admin) |
| `src/registry.ts` | Amulet registry client — uses `node:http` (fetch drops the `Host` header the SV nginx needs) |
| `src/wallet.ts`   | Splice validator wallet API — `tap` test Amulet, resolve the wallet party |
| `src/escrow.ts`   | `EscrowService` — lifecycle + the fund→settle orchestration |
| `src/automation.ts` | idempotent reconciliation poller |
| `src/server.ts`   | REST API (zero-dependency `node:http`) + static UI hosting |
| `src/agent/`      | flagship: AI research agent (worker) + paid fact-checker (arbiter) |
| `src/demo.ts`     | end-to-end settlement smoke test against a live node |
| `src/agent-demo.ts` | flagship demo: a paid run + a disputed (no-payout) run |

## Run

```bash
npm install
npm run typecheck                 # tsc --noEmit
npm run demo                      # provision parties, tap, create->...->settle on a live node
npm run agent-demo                # flagship: AI agent + fact-checker, a paid + a disputed run
PORT=8088 npm run dev             # REST API + demo UI (tsx watch)
# real LLM for the research agent (optional; offline fallback otherwise):
#   ANTHROPIC_API_KEY=sk-... npm run agent-demo
# optional automation: AUTOMATION_PROVIDER=<party> AUTO_SETTLE=0 npm run dev
```

The server also serves the **demo UI** (`../frontend/`) at `http://localhost:8088/` — click
*Start session* → *Fund & create* → *Accept* → *Complete* → *Settle*, and flip the
perspective to `outsider` to watch sub-transaction privacy (it sees 0 escrows).

Prereqs: LocalNet up + this project's DAR uploaded (`PACKAGE_ID` defaults to the 0.1.2 build;
override via env after a rebuild). See `../docs/setup/toolchain-and-references.md` §4.

## REST API

| method + path | body | does |
| ------------- | ---- | ---- |
| `GET /health` | — | package id + DSO |
| `GET /tasks?party=P` | — | escrows visible to `P` |
| `POST /tasks` | `{provider,requester,worker,arbiter,taskRef,amount[,instrumentId,deadlineSeconds]}` | create (Created); instrument defaults to Amulet |
| `POST /tasks/:cid/accept` | `{worker}` | worker accepts |
| `POST /tasks/:cid/complete` | `{worker,completionRef}` | worker submits result |
| `POST /tasks/:cid/approve` | `{requester}` | requester approves (status only) |
| `POST /tasks/:cid/settle` | `{provider}` | fund allocation + worker claims → **real token transfer**, Paid |
| `POST /tasks/:cid/expire` | `{provider}` | expire after deadline |
| `POST /admin/tap` | `{amount}` | mint test Amulet to the wallet party (dev) |

## Follow-ups
- Read model via **PQS** instead of polling the ACS (scales; current poller is fine for the demo).
- **External-party signing** (`prepare`/`execute`) so agents self-custody instead of the
  backend holding `CanActAs` — needed for the cross-participant privacy story.
