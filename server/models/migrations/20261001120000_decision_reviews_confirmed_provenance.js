/**
 * decision_reviews: a confirmed row carries its complete provenance.
 *
 * Codex #5476 r4 (after r3's label-only CHECK): a confirmed_error /
 * confirmed_correct row must have the label AND who labeled it AND when, or
 * the export treats an unverifiable row as ground truth. This replaces the
 * 20261001110000 constraint (frozen, already pushed) with the full set so the
 * contract is one CHECK rather than one per column. Guard first: a confirmed
 * row missing any of the three is demoted to 'unreviewed' (it was never a
 * complete human label).
 */
const TABLE = 'decision_reviews';
const OLD = 'decision_reviews_confirmed_requires_label_check';
const CONSTRAINT = 'decision_reviews_confirmed_provenance_check';
const CONFIRMED = ['confirmed_error', 'confirmed_correct'];

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable(TABLE);
  if (!hasTable) return;
  await knex(TABLE)
    .whereIn('label_status', CONFIRMED)
    .where((q) => q.whereNull('label').orWhereNull('labeled_by').orWhereNull('labeled_at'))
    .update({ label_status: 'unreviewed', labeled_by: null, labeled_at: null });
  await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${OLD}`);
  await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${CONSTRAINT} CHECK (label_status NOT IN ('confirmed_error','confirmed_correct') OR (label IS NOT NULL AND labeled_by IS NOT NULL AND labeled_at IS NOT NULL))`);
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable(TABLE);
  if (!hasTable) return;
  await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${CONSTRAINT}`);
  await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${OLD} CHECK (label_status NOT IN ('confirmed_error','confirmed_correct') OR label IS NOT NULL)`);
};
