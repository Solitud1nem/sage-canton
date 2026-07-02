# syntax=docker/dockerfile:1.7
# sage-canton demo backend + UI — single container for Fly.io (mirrors the EVM Sage
# pattern: backend on Fly, judges get a stable https://sage-canton.fly.dev link).
# The backend is zero-runtime-dependency Node, so the runtime stage is just
# node + dist/ + the static frontend. Secrets (SEAPORT_CLIENT_SECRET,
# ANTHROPIC_API_KEY, API_TOKEN) come from `fly secrets`, not the image.

# ── Stage 1: compile TypeScript ─────────────────────────────────────
FROM node:22-slim AS builder
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json backend/tsconfig.json ./
RUN npm ci
COPY backend/src ./src
RUN npm run build

# ── Stage 2: runtime (no node_modules — the backend has zero runtime deps) ──
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app/backend
COPY --from=builder /app/backend/dist ./dist
# server.js resolves the UI at ../../frontend relative to dist/
COPY frontend /app/frontend
EXPOSE 8088
CMD ["node", "dist/server.js"]
