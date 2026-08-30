#!/usr/bin/env bash
# Cloud Agent — on-demand dev servers (run this when you want to work on the app).
# Starts the API (:3001) and the Vite client (:5173), staying attached.
#
# The API runs under NODE_ENV=test so server/index.js skips
# initScheduledJobs()/initBankingSync() — no paid LLM canary and no automated
# cron on startup. Feature gates still resolve as non-production, so dev
# features remain usable; the Vite client stays in development mode. Note the
# app's boot queues (receipt/photo/etc.) still start here by design: they no-op
# against the fresh local database and can only reach a provider if you have
# injected that provider's credentials — this is a deliberate `dev.sh` action,
# not automatic agent startup.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=.cursor/lib.sh
source "${SCRIPT_DIR}/lib.sh"
cd "${REPO_ROOT}"

# Make sure PostgreSQL is up (start.sh may not have run in this shell).
sudo pg_ctlcluster 16 main start 2>/dev/null || true
PG_PORT="$(pg_local_port)"
for _ in $(seq 1 30); do sudo -u postgres pg_isready -p "${PG_PORT}" -q && break; sleep 1; done
sudo -u postgres pg_isready -p "${PG_PORT}"

# Never serve against a remote/prod database; pins DATABASE_URL to the local PG16.
assert_local_effective_database_url

# Apply any migrations authored/checked-out since the per-boot start.sh pass —
# this on-demand entrypoint bypasses the root `predev` hook, so run it here.
echo "[dev] applying any pending migrations"
npm run db:migrate

echo "[dev] launching API (:3001, NODE_ENV=test — no cron/canary) + Vite client (:5173)"
exec npx concurrently -k -n api,web -c blue,green \
  "cd server && NODE_ENV=test npm run dev" \
  "cd client && npm run dev"
