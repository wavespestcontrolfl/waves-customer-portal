/**
 * Rollback order check for the provider key (Codex r3 on #5555). The three
 * earlier files are pushed, and the migration guard freezes a pushed
 * migration, so this check gets its own file:
 *   20261002010000 adds `provider` to the unique key.
 *   20261002020000 re-asserts that; its `down` is the full revert under a lock.
 *   20261002030000 owns the column comment and a rollback guard CHECK.
 *
 * A batch rollback runs every file of the newest ledger batch, newest first,
 * and stops. With 020000 in that batch and 010000 in an older one it would
 * run 020000's full revert and leave 010000 recorded as applied with its
 * column gone, which `migrate:latest` cannot repair. This file's `down` runs
 * before every other `down` of the key, so it reads the ledger and refuses,
 * before anything is touched, while the two frozen files sit in DIFFERENT
 * batches, printing the one-line ledger fix. Once they share a batch, every
 * rollback that reaches 020000 reaches 010000 too, and a rollback that stops
 * earlier keeps the column, CHECK and key as recorded. The check is the only
 * thing this `down` does; `up` re-asserts 030000's end state (idempotent).
 */
const guard = require('./20261002030000_decision_reviews_provider_rollback_guard');

const TABLE = 'decision_reviews';
const FIRST_FILE = '20261002010000_decision_reviews_provider.js';
const LOCK_FILE = '20261002020000_decision_reviews_provider_rollback_lock.js';

function ledgerTable(knex) {
  const cfg = knex.client?.config?.migrations || {};
  const name = cfg.tableName || 'knex_migrations';
  return cfg.schemaName ? `${cfg.schemaName}.${name}` : name;
}

// Read-only. Throws while a batch rollback from here could run 020000's down
// without 010000's: the two files recorded in different batches.
async function assertEarlierFilesShareABatch(knex) {
  const ledger = ledgerTable(knex);
  const rows = await knex(ledger).whereIn('name', [FIRST_FILE, LOCK_FILE]).select('name', 'batch');
  const first = rows.find((r) => r.name === FIRST_FILE);
  const lock = rows.find((r) => r.name === LOCK_FILE);
  if (!first || !lock || Number(first.batch) === Number(lock.batch)) return;
  throw new Error(
    `${TABLE}: ${FIRST_FILE} is recorded in batch ${first.batch} but ${LOCK_FILE} in batch ${lock.batch}; `
    + 'a batch rollback would run the second file\'s down (the full revert of the provider key) and stop, leaving the first recorded as applied with its column gone. '
    + `Put them in one batch first, then roll back again: UPDATE ${ledger} SET batch = ${lock.batch} WHERE name = '${FIRST_FILE}';`,
  );
}

exports.up = async function up(knex) {
  await guard.up(knex);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  if (!(await knex.schema.hasColumn(TABLE, 'provider'))) return;
  await assertEarlierFilesShareABatch(knex);
};

exports.FIRST_FILE = FIRST_FILE;
exports.LOCK_FILE = LOCK_FILE;
