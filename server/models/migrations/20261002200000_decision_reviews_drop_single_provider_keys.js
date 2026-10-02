/**
 * Contract step of the provider key (#5555): drops the two five-column
 * uniques that kept a pre-provider server able to upsert while only Jev
 * wrote, now that this PR adds the second writer (the Clef shadow leg).
 * Two providers' rows for one subject and question cannot coexist under
 * either, so the leg's rows would be rejected while they stand.
 *   - decision_reviews_subject_question_uniq (restored by 20261002050000)
 *   - decision_reviews_subject_question_legacy_uniq (20261002005000)
 * The provider key (decision_reviews_provider_subject_question_uniq) stays
 * and is the recorder's only conflict target since #5555, so the server this
 * deploy replaces keeps writing throughout. A code rollback to before #5555
 * would need the old key back: that is this file's down.
 *
 * down re-adds both, and refuses (naming the table) while another provider
 * has rows: rebuilding the five-column key over them would mean deleting
 * review evidence, which a rollback must never do silently.
 */
const TABLE = 'decision_reviews';
const OLD_UNIQUE = 'decision_reviews_subject_question_uniq';
const LEGACY_UNIQUE = 'decision_reviews_subject_question_legacy_uniq';
const DEFAULT_PROVIDER = 'typesafe';
const FIVE = '(capability, package_id, subject_type, subject_id, question_id)';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${OLD_UNIQUE}`);
  await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${LEGACY_UNIQUE}`);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  if (await knex.schema.hasColumn(TABLE, 'provider')) {
    const other = await knex(TABLE).whereNot({ provider: DEFAULT_PROVIDER }).first('id');
    if (other) {
      throw new Error(`${TABLE} holds rows from a provider other than ${DEFAULT_PROVIDER}; export or remove them before restoring the single-provider keys`);
    }
  }
  await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${LEGACY_UNIQUE}`);
  await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${LEGACY_UNIQUE} UNIQUE ${FIVE}`);
  await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${OLD_UNIQUE}`);
  await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${OLD_UNIQUE} UNIQUE ${FIVE}`);
};

exports.OLD_UNIQUE = OLD_UNIQUE;
exports.LEGACY_UNIQUE = LEGACY_UNIQUE;
