/**
 * Keeps the pre-provider unique key for this deployment (Codex r11 on #5555).
 *
 * 20261002010000 (pushed, so frozen) adds the provider key AND drops the old
 * five-column unique in one step. A server process from before this PR still
 * upserts with `ON CONFLICT (capability, package_id, subject_type, subject_id,
 * question_id)`; during a rolling deploy, or after a code rollback, Postgres
 * would reject every shadow insert from it once that constraint is gone
 * ("no unique or exclusion constraint matching the ON CONFLICT specification").
 *
 * Expand first, contract later: this file puts the old constraint back, so
 * both conflict targets work while only Jev writes (no second provider writer
 * ships in this PR, and every existing row is typesafe, so the five-column
 * key still holds). The PR that adds the second writer drops it: two
 * providers' rows for one subject and question cannot coexist under it.
 *
 * Skipped, loudly, when another provider already has rows (a development
 * database): the old key cannot be rebuilt over them and is not needed there.
 * down removes the constraint again (the state 010000 left).
 */
const TABLE = 'decision_reviews';
const OLD_UNIQUE = 'decision_reviews_subject_question_uniq';
const DEFAULT_PROVIDER = 'typesafe';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  if (!(await knex.schema.hasColumn(TABLE, 'provider'))) return;
  const other = await knex(TABLE).whereNot({ provider: DEFAULT_PROVIDER }).first('id');
  if (other) {
     
    console.warn(`[migration] ${TABLE} already holds rows from another provider; the old unique key is not restored`);
    return;
  }
  await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${OLD_UNIQUE}`);
  await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${OLD_UNIQUE} UNIQUE (capability, package_id, subject_type, subject_id, question_id)`);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${OLD_UNIQUE}`);
};

exports.OLD_UNIQUE = OLD_UNIQUE;
