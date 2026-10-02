/**
 * Keeps a five-column conflict target present through the WHOLE provider-key
 * migration batch (Codex r13 on #5555). It sorts before 20261002010000 on
 * purpose.
 *
 * A server process from before the provider key upserts with
 * `ON CONFLICT (capability, package_id, subject_type, subject_id, question_id)`.
 * 010000 (pushed, so frozen) commits the drop of that constraint before
 * 020000-040000 run, and 050000 restores it only at the end of the batch; an
 * old process writing in between (a rolling deploy runs migrations while the
 * previous server is still live) would fail with "no unique or exclusion
 * constraint matching the ON CONFLICT specification".
 *
 * ON CONFLICT infers its arbiter from the COLUMNS, not the constraint name, so
 * this file adds a second unique on the same five columns under another name
 * before 010000 drops the original. A matching arbiter then exists at every
 * commit of the batch. 050000's restored original is redundant beside it and
 * harmless. The PR that adds the second provider's writer drops both: two
 * providers' rows for one subject and question cannot coexist under either.
 *
 * Skipped, loudly, when the table already holds another provider's rows (a
 * database that ran the later files first): the key cannot be built there and
 * no pre-provider process writes to it. down removes the constraint.
 */
const TABLE = 'decision_reviews';
const LEGACY_UNIQUE = 'decision_reviews_subject_question_legacy_uniq';
const DEFAULT_PROVIDER = 'typesafe';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  if (await knex.schema.hasColumn(TABLE, 'provider')) {
    const other = await knex(TABLE).whereNot({ provider: DEFAULT_PROVIDER }).first('id');
    if (other) {
       
      console.warn(`[migration] ${TABLE} already holds rows from another provider; the legacy conflict target is not added`);
      return;
    }
  }
  await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${LEGACY_UNIQUE}`);
  await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${LEGACY_UNIQUE} UNIQUE (capability, package_id, subject_type, subject_id, question_id)`);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${LEGACY_UNIQUE}`);
};

exports.LEGACY_UNIQUE = LEGACY_UNIQUE;
