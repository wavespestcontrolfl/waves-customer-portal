#!/usr/bin/env bash
# Cloud Agent — per-boot startup (runs on each container start; stays attached).
# The PostgreSQL server process is not part of the snapshot, so start it here,
# then launch the API server + Vite client. `npm run dev` runs `predev`
# (knex migrate) first, so any migrations added on the checked-out branch are
# applied before the servers come up.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "[start] starting PostgreSQL cluster"
sudo pg_ctlcluster 16 main start 2>/dev/null || true
for _ in $(seq 1 30); do sudo -u postgres pg_isready -q && break; sleep 1; done
sudo -u postgres pg_isready

echo "[start] launching API server (:3001) + Vite client (:5173) via npm run dev"
exec npm run dev
