#!/usr/bin/env bash
# Cloud Agent — per-boot startup (runs on each container start; stays attached).
# The PostgreSQL server process is not part of the snapshot, so start it here,
# then launch the API server + Vite client.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=.cursor/lib.sh
source "$(dirname "$0")/lib.sh"

# Refuse a remote/prod DATABASE_URL injected via the secrets panel before the
# server (or migrations) can target it.
assert_local_database_url

echo "[start] starting PostgreSQL cluster"
sudo pg_ctlcluster 16 main start 2>/dev/null || true
for _ in $(seq 1 30); do sudo -u postgres pg_isready -q && break; sleep 1; done
sudo -u postgres pg_isready

echo "[start] applying any pending migrations"
npm run db:migrate

# Boot the API in the app's side-effect-safe mode: NODE_ENV=test makes
# index.js skip initScheduledJobs()/initBankingSync(), so merely booting the
# agent never fires the paid LLM canary or any automated cron — even if
# provider credentials are injected via the secrets panel. Feature gates still
# resolve as non-production (all dev features usable). The Vite client stays in
# development mode (dotenv's NODE_ENV=development applies to it). See the two
# Codex P1 findings on PR #3620.
echo "[start] launching API (:3001, NODE_ENV=test — no cron side effects) + Vite client (:5173)"
exec npx concurrently -k -n api,web -c blue,green \
  "cd server && NODE_ENV=test npm run dev" \
  "cd client && npm run dev"
