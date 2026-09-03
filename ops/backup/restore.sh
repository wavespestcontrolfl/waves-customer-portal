#!/usr/bin/env bash
# MUTATES the TARGET database (and only the target). Restores one encrypted
# nightly backup produced by .github/workflows/db-backup-drill.yml.
#
#   BACKUP_ENCRYPTION_KEY=... EXPECTED_SHA256=<plaintext_sha256 from the manifest> \
#     ops/backup/restore.sh <file.tar.enc> <target postgres url>
#
# Used by the nightly drill (target = throwaway CI container) and by a human
# in a real disaster (target = a FRESH Railway Postgres, never the live one —
# see docs/db-backup-restore-drill-runbook.md). Refuses a target that already
# holds any user object (table, sequence, function, type) unless
# RESTORE_REPLACE_EXISTING=yes, and replace mode drops every user schema and
# recreates public first. The payload is a tar of the database
# dump plus the cluster globals (roles, memberships); globals are applied
# first so the dump's ACLs have their grantees. Leaves the decrypted
# <name>.tar and <name>.d/ (mode 0600/0700) beside the input for hash
# verification; delete them when done.
set -euo pipefail

enc="${1:?usage: restore.sh <file.tar.enc> <target postgres url>}"
target="${2:?usage: restore.sh <file.tar.enc> <target postgres url>}"
: "${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY must be set in the environment}"
# The manifest's plaintext sha256 is REQUIRED: pg_restore --list only proves
# the catalog, not every data block, and AES-CBC alone is malleable. Nothing
# touches the target until the decrypted bytes match it.
: "${EXPECTED_SHA256:?EXPECTED_SHA256 must be set to plaintext_sha256 from the manifest of this backup (.json beside the object, or latest.json)}"
[[ "$EXPECTED_SHA256" =~ ^[0-9a-fA-F]{64}$ ]] || { echo "EXPECTED_SHA256 must be 64 hex characters" >&2; exit 2; }

# The only safe target is an EMPTY database — a pasted live URL would be
# erased. Refuse any target that already holds any user object unless the caller
# states, explicitly, that this database is meant to be replaced. Replace mode
# recreates the schema so nothing added after the backup survives as a hybrid
# (`pg_restore --clean` alone only drops objects the archive knows about) —
# and only AFTER the archive has been decrypted and validated.
# "Holds anything" means any user object — relation, function, or type — in
# any non-system schema, not just tables: a half-finished earlier restore
# leaves sequences and functions behind that would collide with this one.
# Objects an extension owns are ignored so a fresh Railway instance whose
# image pre-installs vector/pgcrypto still reads as empty.
user_objects_sql="
  WITH ext AS (SELECT objid FROM pg_depend WHERE deptype = 'e'),
       ns  AS (SELECT oid, nspname FROM pg_namespace
                WHERE nspname NOT IN ('pg_catalog','information_schema')
                  AND nspname NOT LIKE 'pg\_toast%' AND nspname NOT LIKE 'pg\_temp%')
  SELECT count(*) FROM (
    SELECT c.oid FROM pg_class c JOIN ns ON ns.oid = c.relnamespace
      WHERE c.relkind IN ('r','p','v','m','S','f') AND c.oid NOT IN (SELECT objid FROM ext)
    UNION ALL
    SELECT p.oid FROM pg_proc p JOIN ns ON ns.oid = p.pronamespace
      WHERE p.oid NOT IN (SELECT objid FROM ext)
    UNION ALL
    SELECT t.oid FROM pg_type t JOIN ns ON ns.oid = t.typnamespace
      WHERE t.typtype IN ('e','d','r')
        AND t.oid NOT IN (SELECT objid FROM ext)
  ) o"
existing=$(psql "$target" -Atqc "$user_objects_sql" < /dev/null)
if [ "$existing" != 0 ] && [ "${RESTORE_REPLACE_EXISTING:-}" != "yes" ]; then
  echo "refusing: target already holds $existing user object(s) — this may be a live database." >&2
  echo "Restore into a FRESH instance, or set RESTORE_REPLACE_EXISTING=yes only for a database you intend to erase." >&2
  exit 2
fi

# The plaintext is the whole production database: never world-readable.
umask 077
plain="${enc%.enc}"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -pass env:BACKUP_ENCRYPTION_KEY -in "$enc" -out "$plain"

# openssl rather than sha256sum: the drill runs on Ubuntu, a real recovery
# runs on an operator Mac whose sha256sum has no --check.
actual=$(openssl dgst -sha256 -r "$plain" | cut -d' ' -f1)
[ "$actual" = "$(printf '%s' "$EXPECTED_SHA256" | tr 'A-F' 'a-f')" ] \
  || { echo "checksum mismatch: decrypted $plain is $actual, expected $EXPECTED_SHA256 — corrupt, wrong backup, or tampered. Target untouched." >&2; exit 1; }

dir="$plain.d"
rm -rf "$dir"; mkdir "$dir"
tar -xf "$plain" -C "$dir"

# Structural validation as well, still BEFORE touching the target.
[ -s "$dir/globals.sql" ] || { echo "archive is missing globals.sql" >&2; exit 1; }
pg_restore --list "$dir/waves-portal.dump" > /dev/null || { echo "archive dump is not a readable pg_restore archive" >&2; exit 1; }

if [ "$existing" != 0 ]; then
  echo "RESTORE_REPLACE_EXISTING=yes: erasing $existing user object(s) on target" >&2
  # One table per transaction: a single DROP SCHEMA ... CASCADE over a
  # ~600-table schema with its indexes and FKs exceeds the default
  # max_locks_per_transaction and fails.
  psql "$target" -Atqc "SELECT quote_ident(table_schema)||'.'||quote_ident(table_name) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type='BASE TABLE'" < /dev/null \
    | while read -r t; do psql "$target" -v ON_ERROR_STOP=1 -Atqc "DROP TABLE IF EXISTS $t CASCADE" < /dev/null > /dev/null; done
  # Then everything else (views, types, functions, sequences, extensions) by
  # dropping every user schema outright — the dump recreates what it needs.
  psql "$target" -Atqc "SELECT quote_ident(nspname) FROM pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema') AND nspname NOT LIKE 'pg\_toast%' AND nspname NOT LIKE 'pg\_temp%'" < /dev/null \
    | while read -r n; do psql "$target" -v ON_ERROR_STOP=1 -Atqc "DROP SCHEMA IF EXISTS $n CASCADE" < /dev/null > /dev/null; done
  psql "$target" -v ON_ERROR_STOP=1 -Atqc "CREATE SCHEMA public" < /dev/null > /dev/null
  [ "$(psql "$target" -Atqc "$user_objects_sql" < /dev/null)" = 0 ] || { echo "target still holds user objects after cleanup — aborting before restore" >&2; exit 1; }
fi

# Cluster globals first: roles and role memberships (no passwords). Roles that
# already exist on the target (postgres, the app user on Railway) are fine;
# any other error is real.
errs=$(psql "$target" -f "$dir/globals.sql" 2>&1 >/dev/null | grep -E 'ERROR' | grep -v 'already exists' || true)
[ -z "$errs" ] || { echo "globals.sql failed:" >&2; echo "$errs" >&2; exit 1; }

# The dump was taken with --no-owner but WITH privileges, so the grants to
# the roles just created come back. Extensions it references (vector,
# pgcrypto, uuid-ossp) are created by the dump itself when the target image
# ships them.
pg_restore --dbname="$target" --no-owner \
  --jobs=4 --exit-on-error "$dir/waves-portal.dump"

echo "restored $dir/waves-portal.dump (+ globals) into target"
