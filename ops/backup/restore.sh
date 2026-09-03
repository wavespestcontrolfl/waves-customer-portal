#!/usr/bin/env bash
# MUTATES the TARGET database (and only the target). Restores one encrypted
# nightly backup produced by .github/workflows/db-backup-drill.yml.
#
#   BACKUP_ENCRYPTION_KEY=... ops/backup/restore.sh <file.dump.enc> <target postgres url>
#
# Used by the nightly drill (target = throwaway CI container) and by a human
# in a real disaster (target = a FRESH Railway Postgres, never the live one —
# see docs/db-backup-restore-drill-runbook.md). Leaves the decrypted
# <name>.dump beside the input for hash verification; delete it when done.
set -euo pipefail

enc="${1:?usage: restore.sh <file.dump.enc> <target postgres url>}"
target="${2:?usage: restore.sh <file.dump.enc> <target postgres url>}"
: "${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY must be set in the environment}"

# The only safe target is an EMPTY database. `pg_restore --clean` drops every
# matching object, so a pasted live URL would erase production. Refuse any
# target that already holds tables unless the caller states, explicitly, that
# this database is meant to be replaced.
existing=$(psql "$target" -Atqc "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')" < /dev/null)
if [ "$existing" != 0 ] && [ "${RESTORE_REPLACE_EXISTING:-}" != "yes" ]; then
  echo "refusing: target already holds $existing table(s) — this may be a live database." >&2
  echo "Restore into a FRESH instance, or set RESTORE_REPLACE_EXISTING=yes only for a database you intend to erase." >&2
  exit 2
fi

plain="${enc%.enc}"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -pass env:BACKUP_ENCRYPTION_KEY -in "$enc" -out "$plain"

# The dump was taken with --no-owner/--no-privileges; --clean/--if-exists make
# the restore idempotent on a target that already holds an older copy.
# Extensions the dump references (vector, pgcrypto, uuid-ossp) are created by
# the dump itself when the target image ships them.
pg_restore --dbname="$target" --no-owner --no-privileges --clean --if-exists \
  --jobs=4 --exit-on-error "$plain"

echo "restored $plain into target"
