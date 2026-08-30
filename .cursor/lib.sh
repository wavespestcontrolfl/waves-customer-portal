#!/usr/bin/env bash
# Shared helpers for the Cloud Agent dev environment scripts.
# Sourced by .cursor/install.sh, .cursor/start.sh, and .cursor/dev.sh.

# Resolve our own directory + the repo root from THIS file's location, so the
# helpers work no matter the caller's cwd or how the caller was invoked.
CLOUD_ENV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${CLOUD_ENV_DIR}/.." && pwd)"

# The local dev database this environment provisions and owns.
LOCAL_DATABASE_URL="postgresql://waves_user:waves_dev_password@127.0.0.1:5432/waves_portal"

# Lowercased hostname from a postgres URL. Handles URLs with OR without
# credentials, an optional port, a path/query, and bracketed IPv6.
db_url_host() {
  local u="${1:-}"
  u="${u#*://}"        # drop scheme://
  u="${u##*@}"         # drop credentials up to the last @, if present
  u="${u%%/*}"         # drop /database and anything after
  u="${u%%\?*}"        # drop ?query when there is no path
  if [ "${u#\[}" != "$u" ]; then
    u="${u#\[}"; u="${u%%\]*}"   # bracketed IPv6: take what is inside [...]
  else
    u="${u%%:*}"       # drop :port
  fi
  printf '%s' "$(printf '%s' "$u" | tr '[:upper:]' '[:lower:]')"
}

# True when a hostname is a loopback / local address.
is_local_db_host() {
  case "$1" in
    127.0.0.1|localhost|::1|0.0.0.0) return 0 ;;
    *) return 1 ;;
  esac
}

# Fail closed unless the given URL (default: $DATABASE_URL) targets a local host.
# Never echoes credentials — only the parsed host.
assert_local_database_url() {
  local url="${1-${DATABASE_URL:-}}"
  [ -z "$url" ] && return 0
  local host
  host="$(db_url_host "$url")"
  if is_local_db_host "$host"; then
    return 0
  fi
  _refuse_nonlocal_db "${host:-<unparseable>}"
}

# Resolve the EFFECTIVE Knex database URL exactly as the app will (dotenv-loaded
# .env plus knexfile's fallback vars: DATABASE_PRIVATE_URL / DATABASE_PUBLIC_URL
# / POSTGRES_URL / POSTGRES_PRIVATE_URL / PG* ) and fail closed unless it is
# local. This is the authoritative check — it catches a preexisting/cached .env
# or a fallback var, not just an injected DATABASE_URL. Requires node deps
# (dotenv), so call it AFTER `npm install`.
assert_local_effective_database_url() {
  local host
  host="$(cd "${REPO_ROOT}/server" 2>/dev/null && node -e '
    require("./knexfile");
    const u = process.env.DATABASE_URL || "";
    if (!u) process.exit(0);
    try { process.stdout.write(new URL(u).hostname); }
    catch { process.stdout.write("__unparseable__"); }
  ' 2>/dev/null || true)"
  [ -z "$host" ] && return 0   # nothing resolved yet; the local .env will apply
  host="${host#\[}"; host="${host%\]}"
  host="$(printf '%s' "$host" | tr '[:upper:]' '[:lower:]')"
  if is_local_db_host "$host"; then
    return 0
  fi
  _refuse_nonlocal_db "$host"
}

_refuse_nonlocal_db() {
  local host="$1"
  echo "[cloud-env] FATAL: the effective DATABASE_URL points at a non-local host: ${host}" >&2
  echo "[cloud-env] This environment is local-only and refuses to run migrations" >&2
  echo "            or serve against a remote/preview/production database." >&2
  echo "            Remove the injected DATABASE_URL secret and any cached .env" >&2
  echo "            DATABASE_URL (these scripts create a local database), or point" >&2
  echo "            it at 127.0.0.1 / localhost." >&2
  exit 1
}
