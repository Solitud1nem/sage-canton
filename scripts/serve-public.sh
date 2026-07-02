#!/usr/bin/env bash
# Serve the sage-canton demo (backend + UI) publicly via a Cloudflare Tunnel.
#
# The backend keeps running locally (it holds the Seaport OIDC secret and CanActAs
# rights); the tunnel only exposes an HTTPS front. Mutating REST routes are gated by
# API_TOKEN (backend/.env) — hand out the UI link as  https://<host>/?token=<API_TOKEN>.
#
# Modes:
#   ./scripts/serve-public.sh                # quick tunnel (random *.trycloudflare.com URL,
#                                            # no account; fine for testing, NOT for judges)
#   TUNNEL_NAME=sage-canton ./scripts/serve-public.sh
#                                            # named tunnel (stable hostname; requires
#                                            # `cloudflared tunnel login` + a zone, see
#                                            # docs/setup/public-demo-hosting.md)
set -euo pipefail
cd "$(dirname "$0")/.."

CLOUDFLARED="${CLOUDFLARED:-$(command -v cloudflared || echo "$HOME/.local/bin/cloudflared")}"
PORT="${PORT:-8088}"

grep -q '^API_TOKEN=..*' backend/.env || {
  echo "backend/.env has no API_TOKEN — refusing to expose an ungated god-mode API." >&2
  echo "Add one:  printf 'API_TOKEN=%s\n' \"\$(openssl rand -hex 16)\" >> backend/.env" >&2
  exit 1
}

(cd backend && npm run build)

echo "starting backend on :$PORT ..."
(cd backend && PORT="$PORT" node dist/server.js) &
BACKEND_PID=$!
trap 'kill $BACKEND_PID 2>/dev/null || true' EXIT
sleep 2
curl -sf "localhost:$PORT/health" >/dev/null || { echo "backend failed to start" >&2; exit 1; }

if [ -n "${TUNNEL_NAME:-}" ]; then
  echo "starting NAMED tunnel '$TUNNEL_NAME' (stable hostname) ..."
  exec "$CLOUDFLARED" tunnel --protocol http2 run --url "http://localhost:$PORT" "$TUNNEL_NAME"
else
  echo "starting QUICK tunnel (ephemeral URL; use TUNNEL_NAME=... for the judge link) ..."
  exec "$CLOUDFLARED" tunnel --protocol http2 --url "http://localhost:$PORT"
fi
