/**
 * decision_reviews.subject_hash: sha256 of the exact subject text Jev was
 * given (typed-decisions/subject-hash.js). A call can be force-reprocessed
 * after Jev answered, replacing its transcript; the review route compares the
 * live text against this hash so a label is never written for an answer whose
 * transcript has since changed (Codex #5505). A digest only, never text.
 * Nullable: rows recorded before this column (and text subjects, whose body
 * does not change) carry none and are not checked.
 */
const TABLE = 'decision_reviews';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  if (await knex.schema.hasColumn(TABLE, 'subject_hash')) return;
  await knex.schema.alterTable(TABLE, (t) => { t.string('subject_hash', 64); });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  if (!(await knex.schema.hasColumn(TABLE, 'subject_hash'))) return;
  await knex.schema.alterTable(TABLE, (t) => { t.dropColumn('subject_hash'); });
};
