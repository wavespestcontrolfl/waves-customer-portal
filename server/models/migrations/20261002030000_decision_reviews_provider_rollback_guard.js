/**
 * Rollback guard for the provider key (Codex r2 on #5555). Both earlier files
 * are frozen (pushed, so a deploy ran them):
 *   20261002010000 adds `provider` to the unique key; its `down` checks for a
 *   second provider's rows and then alters, with nothing stopping an insert
 *   in between.
 *   20261002020000 re-asserts that end state; its `down` performs the whole
 *   revert under a lock. Rolled back on its own it leaves 010000 recorded as
 *   applied with the column gone until `migrate:latest` re-runs its `up`.
 * knex runs each rolled-back migration in its own transaction, so a lock
 * taken in one `down` is gone before the next runs; a lock alone cannot make
 * the chain safe.
 *
 * This file owns exactly two things and touches nothing else: a COMMENT on
 * the column, and a rollback guard. Its `down` takes an ACCESS EXCLUSIVE
 * lock, refuses while a second provider has rows (which aborts a full
 * rollback before either earlier `down` runs), and otherwise installs the
 * guard: a CHECK that admits only the default provider. The guard outlives
 * this transaction, so between here and the earlier `down`s' own checks a
 * second provider's insert FAILS loudly instead of being relabeled when the
 * column drops; dropping the column drops the guard with it. Its `up`
 * removes the guard and writes the comment. A single-step `migrate:down` of
 * this file keeps the column, CHECK and key exactly as recorded and only
 * refuses second-provider writes until `migrate:latest` re-runs this `up`.
 */
const TABLE = 'decision_reviews';
const DEFAULT_PROVIDER = 'typesafe';
const GUARD = 'decision_reviews_provider_rollback_guard';
const COMMENT = 'Provider that answered (typesafe = Jev, cloudflare = Clef); part of the unique key since 20261002010000';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  if (!(await knex.schema.hasColumn(TABLE, 'provider'))) return;
  await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${GUARD}`);
  await knex.raw(`COMMENT ON COLUMN ${TABLE}.provider IS '${COMMENT.replace(/'/g, "''")}'`);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  if (!(await knex.schema.hasColumn(TABLE, 'provider'))) return;
  await knex.raw(`LOCK TABLE ${TABLE} IN ACCESS EXCLUSIVE MODE`);
  const other = await knex(TABLE).whereNot({ provider: DEFAULT_PROVIDER }).first('id');
  if (other) {
    throw new Error(`${TABLE} holds rows from a provider other than ${DEFAULT_PROVIDER}; export or remove them before rolling back the provider key`);
  }
  await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${GUARD}`);
  await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${GUARD} CHECK (provider = '${DEFAULT_PROVIDER}')`);
  await knex.raw(`COMMENT ON COLUMN ${TABLE}.provider IS NULL`);
};

exports.GUARD = GUARD;
exports.COMMENT = COMMENT;
