# Public demo hosting — Cloudflare Tunnel in front of the local backend

The judge-reachable "live product" link. The backend stays on the dev machine (it holds
the Seaport OIDC secret and the CanActAs rights; nothing secret leaves the box) and talks
to the Seaport DevNet shared validator; a Cloudflare Tunnel exposes it over public HTTPS.

```
judge's browser ──HTTPS──▶ Cloudflare edge ──tunnel──▶ localhost:8088 (backend+UI)
                                                            │ OIDC m2m (8h refresh)
                                                            ▼
                                          Seaport DevNet shared validator (v2 JSON API)
```

## Access control

The REST surface is god-mode (the backend can act as every demo party), so mutating
routes are gated: set `API_TOKEN=<random>` in `backend/.env` (`openssl rand -hex 16`).
The UI picks the token up once from the query string and stores it locally — the link to
hand out is:

```
https://<public-host>/?token=<API_TOKEN>
```

GET routes (health, party-scoped task lists, balances) stay open; they leak nothing
without knowing full party ids. `scripts/serve-public.sh` refuses to start without a
token.

## Quick tunnel (testing only)

```bash
./scripts/serve-public.sh        # prints a random https://….trycloudflare.com URL
```

No Cloudflare account needed. The URL changes on every restart and has no uptime
guarantee — never hand it to judges.

## Named tunnel (the judge link)

One-time setup (needs a Cloudflare account with a zone/domain added):

```bash
cloudflared tunnel login                       # browser auth; select the zone
cloudflared tunnel create sage-canton          # writes ~/.cloudflared/<id>.json creds
cloudflared tunnel route dns sage-canton demo.<your-zone>   # CNAME -> the tunnel
```

Run:

```bash
TUNNEL_NAME=sage-canton ./scripts/serve-public.sh
# -> https://demo.<your-zone>/?token=<API_TOKEN>
```

Keep the machine awake for the judging window; the 8h Seaport OIDC token auto-refreshes.

## Network gotchas (verified 2026-07-02)

- Some ISPs block parts of Cloudflare's `104.16.0.0/13` range. Symptom: quick tunnel
  fails with `Post "https://api.trycloudflare.com/tunnel": context deadline exceeded`
  while `www.cloudflare.com` (different range) works. Workaround for the QUICK tunnel:
  pin the API host to a reachable Cloudflare edge IP in `/etc/hosts`:
  `104.16.123.96 api.trycloudflare.com`. Named tunnels are unaffected (management goes
  via `api.cloudflare.com`, data via `region{1,2}.v2.argotunnel.com` — both reachable).
- QUIC (udp/7844) may be blocked too; the script forces `--protocol http2` (tcp/443).
- WSL: the tunnel and backend die with the WSL VM. Before the judging window, start
  `serve-public.sh` in a persistent session (`tmux`/`nohup`) and disable Windows sleep.
