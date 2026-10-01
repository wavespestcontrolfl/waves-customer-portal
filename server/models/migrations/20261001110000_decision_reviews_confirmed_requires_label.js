/**
 * decision_reviews: a confirmed row must carry a label.
 *
 * Codex #5476 r3: label_status 'confirmed_error' / 'confirmed_correct' with a
 * NULL label would export (export-decision-review-fixtures.js, default
 * statuses) as a confirmed case with no ground-truth answer. The creating and
 * package-hash migrations are frozen (pushed), so this is the next correction.
 * Guard first: any such row is demoted to 'unreviewed' (it was never really
 * labeled), then the CHECK lands.
 */
const TABLE = 'decision_reviews';
const CONSTRAINT = 'decision_reviews_confirmed_requires_label_check';

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable(TABLE);
  if (!hasTable) return;
  await knex(TABLE).whereIn('label_status', ['confirmed_error', 'confirmed_correct']).whereNull('label').update({ label_status: 'unreviewed', labeled_by: null, labeled_at: null });
  await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${CONSTRAINT} CHECK (label_status NOT IN ('confirmed_error','confirmed_correct') OR label IS NOT NULL)`);
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable(TABLE);
  if (!hasTable) return;
  await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${CONSTRAINT}`);
};
