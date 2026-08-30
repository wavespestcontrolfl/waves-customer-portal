#!/usr/bin/env bash
# Shared helpers for the Cloud Agent dev environment scripts.
# Sourced by .cursor/install.sh, .cursor/start.sh, and .cursor/dev.sh.

# Resolve our own directory + the repo root from THIS file's location, so the
# helpers work no matter the caller's cwd or how the caller was invoked.
CLOUD_ENV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${CLOUD_ENV_DIR}/.." && pwd)"

# This is a development environment. Force NODE_ENV=development for every script
# that sources this file (install/start/dev), so a preserved .env or an injected
# process NODE_ENV=test/production can't change knex config selection (migrations)
# or the server's mode (feature gates, the catalog-name prime). dotenv uses
# override:false, so exporting here wins over .env.
export NODE_ENV=development

PG_MAJOR="16"

# Port of the PostgreSQL $PG_MAJOR 'main' cluster. On a cached image that
# already has an older cluster on 5432, `apt install postgresql-16` puts the 16
# cluster on the next free port — so never assume 5432. Falls back to 5432 only
# before the cluster exists (fresh image), where 16/main is created on 5432.
pg_local_port() {
  local p=""
  if command -v pg_lsclusters >/dev/null 2>&1; then
    p="$(pg_lsclusters -h 2>/dev/null | awk -v v="${PG_MAJOR}" '$1==v && $2=="main"{print $3; exit}')"
  fi
  printf '%s' "${p:-5432}"
}

# The local dev database this environment provisions and owns, on the resolved
# PostgreSQL 16 port. A function (not a constant) so the port is always current.
local_database_url() {
  printf 'postgresql://waves_user:waves_dev_password@127.0.0.1:%s/waves_portal' "$(pg_local_port)"
}

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
# Never echoes credentials — only the parsed host. This is the cheap pre-check;
# the authoritative resolver (assert_local_effective_database_url) runs later.
assert_local_database_url() {
  local url="${1-${DATABASE_URL:-}}"
  # Mirror knexfile's hasUsableDatabaseUrl (server/knexfile.js): trimmed-blank,
  # 'undefined', and 'null' are treated as UNSET so fallback vars / the local DB
  # apply — don't misread those sentinels as a non-local hostname and abort.
  url="${url#"${url%%[![:space:]]*}"}"   # ltrim
  url="${url%"${url##*[![:space:]]}"}"   # rtrim
  case "$url" in ""|undefined|null) return 0 ;; esac
  local host
  host="$(db_url_host "$url")"
  if is_local_db_host "$host"; then
    return 0
  fi
  _refuse_nonlocal_db "${host:-<unparseable>}"
}

# Resolve the EFFECTIVE Knex database HOST exactly as pg will (dotenv-loaded
# .env plus knexfile's fallback vars, parsed with pg-connection-string — the
# SAME parser pg/Knex use, so a `?host=` query override that outranks the URL
# authority is honored, not the misleading authority host) and then:
#   - refuse (fail closed) if the effective host is non-local;
#   - otherwise EXPORT the canonical local URL, so migrate/the server always
#     target the provisioned PostgreSQL 16 cluster (right port + creds) even if
#     the effective URL is empty (preserved .env with no DATABASE_URL) or a
#     preserved/stale .env points at a local-but-wrong port/cluster.
# Requires node deps (pg-connection-string, a pg dependency), so call it AFTER
# `npm install`. The export persists to the caller (runs in the caller's shell).
assert_local_effective_database_url() {
  local host
  host="$(cd "${REPO_ROOT}/server" 2>/dev/null && node -e '
    require("./knexfile");
    const u = process.env.DATABASE_URL || "";
    if (!u) process.exit(0);
    try { process.stdout.write(String(require("pg-connection-string").parse(u).host || "")); }
    catch { process.stdout.write("__unparseable__"); }
  ' 2>/dev/null || true)"

  if [ -z "$host" ]; then
    export DATABASE_URL="$(local_database_url)"
    echo "[cloud-env] no DATABASE_URL resolved — using the local database on port $(pg_local_port)"
    return 0
  fi
  if [ "$host" = "__unparseable__" ]; then
    _refuse_nonlocal_db "<unparseable>"
  fi

  host="${host#\[}"; host="${host%\]}"
  host="$(printf '%s' "$host" | tr '[:upper:]' '[:lower:]')"

  # A leading '/' is a unix-socket directory (pg's `host=` socket form) — local.
  case "$host" in
    /*) : ;;
    *) is_local_db_host "$host" || _refuse_nonlocal_db "$host" ;;
  esac

  # Local host: pin to the canonical local URL (correct PG16 port + creds) so a
  # preserved/stale .env can never migrate/serve the wrong local cluster.
  export DATABASE_URL="$(local_database_url)"
  return 0
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
