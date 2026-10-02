/**
 * Supersedes 20261002010000_decision_reviews_provider (frozen once pushed) so
 * the provider key rolls back safely (Codex r1 on #5555).
 *
 * That migration's `down` checked for rows from a second provider and then
 * altered the table, with nothing stopping an insert in between: a second
 * provider's row written (or still uncommitted) during the rollback could
 * survive the check, and dropping `provider` would relabel it as the default
 * provider's. This `down` takes an ACCESS EXCLUSIVE lock on the table first,
 * so the check and the alters see the same rows, and then does the whole
 * rollback itself. Rollbacks run newest first, so it always runs before the
 * superseded `down`, which then finds no `provider` column and does nothing.
 *
 * `up` re-asserts the superseded migration's end state (it is idempotent), so
 * the two can never disagree: a rollback of this file alone followed by a
 * re-run restores the column and the key.
 */
const previous = require('./20261002010000_decision_reviews_provider');

const TABLE = 'decision_reviews';
const OLD_UNIQUE = 'decision_reviews_subject_question_uniq';
const NEW_UNIQUE = 'decision_reviews_provider_subject_question_uniq';
const CHECK = 'decision_reviews_provider_check';
const DEFAULT_PROVIDER = 'typesafe';

exports.up = async function up(knex) {
  await previous.up(knex);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  if (!(await knex.schema.hasColumn(TABLE, 'provider'))) return;
  // Held to the end of the migration's transaction: no writer can add a
  // second provider's row between the check below and the column drop.
  await knex.raw(`LOCK TABLE ${TABLE} IN ACCESS EXCLUSIVE MODE`);
  const other = await knex(TABLE).whereNot({ provider: DEFAULT_PROVIDER }).first('id');
  if (other) {
    throw new Error(`${TABLE} holds rows from a provider other than ${DEFAULT_PROVIDER}; export or remove them before rolling back the provider key`);
  }
  await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${OLD_UNIQUE}`);
  await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${OLD_UNIQUE} UNIQUE (capability, package_id, subject_type, subject_id, question_id)`);
  await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${NEW_UNIQUE}`);
  await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${CHECK}`);
  await knex.schema.alterTable(TABLE, (t) => { t.dropColumn('provider'); });
};
