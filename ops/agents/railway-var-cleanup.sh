#!/usr/bin/env bash
# MUTATES (dry-run default): deletes named Railway service variables.
#
# Dry run lists which of the named vars actually exist on the service and
# prints the delete commands without running them. --execute deletes them
# one at a time. NOTE: Railway can trigger a service redeploy per delete —
# batch your list and expect a rebuild after.
#
# Usage (repo root, after `railway login` + `railway link`):
#   ops/agents/railway-var-cleanup.sh VAR [VAR...]                       # dry run
#   ops/agents/railway-var-cleanup.sh --execute VAR [VAR...]
#   ops/agents/railway-var-cleanup.sh --service waves-customer-portal VAR [VAR...]
#   ops/agents/railway-var-cleanup.sh --environment production VAR [VAR...]
set -euo pipefail

EXECUTE=0
SERVICE="waves-customer-portal"
# Pinned explicitly — the railway CLI otherwise inherits whatever environment
# the repo happens to be linked to, which could silently retarget deletes.
ENVIRONMENT="production"
VARS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --execute) EXECUTE=1 ;;
    --service) SERVICE="$2"; shift ;;
    --environment) ENVIRONMENT="$2"; shift ;;
    -*) echo "unknown flag: $1" >&2; exit 2 ;;
    *) VARS+=("$1") ;;
  esac
  shift
done

if [ "${#VARS[@]}" -eq 0 ]; then
  echo "usage: $0 [--execute] [--service <name>] [--environment <env>] VAR [VAR...]" >&2
  exit 2
fi

command -v railway >/dev/null 2>&1 || { echo "railway CLI not found" >&2; exit 1; }
command -v jq      >/dev/null 2>&1 || { echo "jq not found (brew install jq)" >&2; exit 1; }

# Existing variable NAMES only — never print values (railway variables is a
# cred dump; jq keeps just the keys).
EXISTING="$(railway variables --service "$SERVICE" --environment "$ENVIRONMENT" --json | jq -r 'keys[]')"

echo "service: $SERVICE   environment: $ENVIRONMENT"
MISSING=0
for v in "${VARS[@]}"; do
  if ! printf '%s\n' "$EXISTING" | grep -qxF "$v"; then
    echo "SKIP  $v — not set on $SERVICE ($ENVIRONMENT)"
    MISSING=$((MISSING + 1))
    continue
  fi
  if [ "$EXECUTE" = "1" ]; then
    echo "DELETE $v"
    railway variable delete "$v" --service "$SERVICE" --environment "$ENVIRONMENT"
  else
    echo "WOULD DELETE  $v   (railway variable delete $v --service $SERVICE --environment $ENVIRONMENT)"
  fi
done

if [ "$EXECUTE" = "0" ]; then
  echo ""
  echo "DRY RUN — nothing deleted. Re-run with --execute to delete."
else
  echo ""
  echo "Done. Railway may redeploy $SERVICE — check: railway deployment list"
fi
