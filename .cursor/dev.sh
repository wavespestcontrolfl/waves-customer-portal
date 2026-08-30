#!/usr/bin/env bash
# Cloud Agent — on-demand dev servers (run this when you want to work on the app).
# Starts the API (:3001) and the Vite client (:5173), staying attached.
#
# This is the REAL development server, in NODE_ENV=development — same as
# `npm run dev`: full dev behavior, including the catalog-name cache prime and
# every scheduled/queue worker. It is a DELIBERATE action, distinct from
# automatic agent startup: booting an agent runs only start.sh (infrastructure
# only, no app server), so merely booting can never spend money or contact a
# provider. When you run this launcher you are opting into the full app; with no
# provider credentials configured the workers/crons no-op (external calls need
# those keys, and the local database starts empty).
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

echo "[dev] launching API (:3001, NODE_ENV=development) + Vite client (:5173)"
exec npx concurrently -k -n api,web -c blue,green \
  "cd server && npm run dev" \
  "cd client && npm run dev"
