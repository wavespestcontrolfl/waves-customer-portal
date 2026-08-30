#!/usr/bin/env bash
# Cloud Agent — per-boot reconciliation (runs every time the environment starts).
# The PostgreSQL server process is not part of the snapshot, so start it here and
# catch up any migrations added on the checked-out branch. Idempotent; returns
# once the database is accepting connections and migrations are current.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "[start] starting PostgreSQL cluster"
sudo pg_ctlcluster 16 main start 2>/dev/null || true
for _ in $(seq 1 30); do sudo -u postgres pg_isready -q && break; sleep 1; done
sudo -u postgres pg_isready

echo "[start] applying any pending migrations"
npm run db:migrate

echo "[start] ready"
