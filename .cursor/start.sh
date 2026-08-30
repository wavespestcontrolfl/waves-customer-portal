#!/usr/bin/env bash
# Cloud Agent — per-boot startup. Provisions INFRASTRUCTURE ONLY:
# PostgreSQL comes up and pending migrations are applied against the local
# database. It deliberately does NOT auto-launch the application server —
# server/index.js boots side-effecting workers (receipt/SMS/email delivery
# queues, S3 photo-reclaim, the scheduler's paid LLM canary, etc.), so merely
# booting the agent must never be able to spend money or contact providers.
# Start the app on demand with `.cursor/dev.sh` (see the printed hint).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=.cursor/lib.sh
source "${SCRIPT_DIR}/lib.sh"
cd "${REPO_ROOT}"

# Fast pre-check on an injected DATABASE_URL, then the authoritative effective
# check (dotenv .env + knexfile fallbacks) before any migration runs.
assert_local_database_url

echo "[start] starting PostgreSQL cluster"
sudo pg_ctlcluster 16 main start 2>/dev/null || true
for _ in $(seq 1 30); do sudo -u postgres pg_isready -q && break; sleep 1; done
sudo -u postgres pg_isready

assert_local_effective_database_url

echo "[start] applying any pending migrations"
npm run db:migrate

cat <<'HINT'
[start] Infrastructure ready (PostgreSQL up, migrations applied).
[start] The application server is NOT auto-started (its boot workers can send
        SMS/email and mutate S3 when credentials are present).
[start] To run the dev servers (API :3001 + Vite client :5173) on demand:

            bash .cursor/dev.sh

HINT
