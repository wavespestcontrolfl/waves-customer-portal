#!/usr/bin/env bash
# Shared helpers for the Cloud Agent dev environment scripts.
# Sourced by .cursor/install.sh and .cursor/start.sh.

# The local dev database this environment provisions and owns.
LOCAL_DATABASE_URL="postgresql://waves_user:waves_dev_password@127.0.0.1:5432/waves_portal"

# Fail closed if an externally-injected DATABASE_URL (e.g. from the Cloud Agent
# secrets panel) points anywhere other than the local dev Postgres. knexfile.js
# loads .env with dotenv's default (override:false), so a DATABASE_URL already
# present in the process env WINS over the local .env this environment writes —
# meaning `npm run db:migrate` (and the API server) would target that injected
# URL. This environment is local-only; it must never run migrations or serve
# against a remote/preview/PRODUCTION database (AGENTS.md: never point at prod).
assert_local_database_url() {
  local url="${DATABASE_URL:-}"
  [ -z "$url" ] && return 0
  case "$url" in
    *@127.0.0.1:*|*@127.0.0.1/*|*@localhost:*|*@localhost/*) return 0 ;;
  esac
  # Print only the host (never the credentials) for diagnostics.
  local hostpart="${url#*@}"
  hostpart="${hostpart%%[:/]*}"
  echo "[cloud-env] FATAL: DATABASE_URL is set to a non-local host: ${hostpart}" >&2
  echo "[cloud-env] This environment is local-only and refuses to run migrations" >&2
  echo "            or serve against a remote/preview/production database." >&2
  echo "            Remove the injected DATABASE_URL secret (these scripts create" >&2
  echo "            a local database) or point it at 127.0.0.1 / localhost." >&2
  exit 1
}
