# Public demo hosting — the judge-reachable live product

The demo backend holds the Seaport OIDC secret and CanActAs rights for every demo party,
so its REST surface is gated: set `API_TOKEN=<random>` in the environment
(`openssl rand -hex 16`) and hand out the UI link as

```
https://<public-host>/?token=<API_TOKEN>
```

The UI picks the token up once from the query string, stores it locally, strips it from
the URL, and sends it on every mutating call. GET routes (health, party-scoped lists,
balances) stay open; they leak nothing without full party ids.

```
judge's browser ──HTTPS──▶ backend+UI (Fly.io) ──OIDC m2m──▶ Seaport DevNet validator
                                                              (v2 JSON Ledger API)
```

## Primary: Fly.io (deployed, verified 2026-07-02)

Mirrors the EVM Sage pattern (`sage-demo-agents.fly.dev`). One container = backend + UI,
stable URL, independent of any dev machine: **https://sage-canton.fly.dev**.

One-time setup:

```bash
fly apps create sage-canton
grep -E '^(SEAPORT_CLIENT_SECRET|ANTHROPIC_API_KEY|API_TOKEN)=' backend/.env | fly secrets import
```

Deploy (config in `fly.toml`, image in `Dockerfile`, context trimmed by `.dockerignore`):

```bash
fly deploy --remote-only
```

Notes:
- `min_machines_running = 1` keeps one machine warm for the judging window (a cold start
  is ~2 s; scale to 0 after judging to stop paying).
- Secrets live in Fly, not in the image; `LEDGER_TARGET=seaport-devnet` is plain env in
  `fly.toml`.
- Verified end-to-end through the public URL: provision → create task → agent run with
  live web-search research → fact-check (8/8 citations) → REAL Canton Coin settlement,
  worker 0 → 100 CC on the Seaport node.

## Fallback: Cloudflare Tunnel to a local backend

If Fly is unavailable, `scripts/serve-public.sh` exposes a locally running backend via a
Cloudflare Tunnel (quick tunnel for testing — ephemeral URL; named tunnel for a stable
hostname, needs `cloudflared tunnel login` + a zone in the account). The script refuses
to start without `API_TOKEN` in `backend/.env`.

Network gotchas (verified 2026-07-02):
- Some ISPs block parts of Cloudflare's `104.16.0.0/13` range. Symptom: quick tunnel
  fails with `Post "https://api.trycloudflare.com/tunnel": context deadline exceeded`
  while `www.cloudflare.com` works. Workaround: pin `api.trycloudflare.com` to a
  reachable Cloudflare edge IP in `/etc/hosts` (e.g. `104.16.123.96`). Named tunnels are
  unaffected (management via `api.cloudflare.com`, data via
  `region{1,2}.v2.argotunnel.com` — both reachable).
- QUIC (udp/7844) may be blocked; the script forces `--protocol http2` (tcp/443).
- WSL: the tunnel and backend die with the WSL VM — use `tmux`/`nohup` and disable
  Windows sleep for the judging window.
