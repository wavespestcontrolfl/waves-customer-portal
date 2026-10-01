/**
 * decision_reviews: a confirmed status matches its verdict.
 *
 * Codex #5476 r9 (after the v2 label-shape CHECK, 20261001150000, frozen):
 * confirmed_correct must carry verdict 'jev_right' and confirmed_error must
 * carry 'jev_wrong', so a status-based accuracy count can never disagree with
 * the fixture's expected answer; 'unclear' is never a confirmed status (it is
 * label_status 'disagreement'). Same shape and provenance rules as v2, plus
 * the pairing; contradictory confirmed rows are demoted to 'unreviewed' first.
 */
const TABLE = 'decision_reviews';
const OLD = 'decision_reviews_confirmed_label_shape_v2_check';
const CONSTRAINT = 'decision_reviews_confirmed_label_shape_v3_check';
const LABEL_OK = "(label IS NOT NULL AND jsonb_typeof(label) = 'object' AND label->>'verdict' IS NOT NULL AND label->>'verdict' IN ('jev_right','jev_wrong','unclear') AND (label->>'verdict' <> 'jev_wrong' OR jsonb_exists(label, 'correct_value')))";
const PROVENANCE_OK = "(labeled_by IS NOT NULL AND btrim(labeled_by) <> '' AND labeled_at IS NOT NULL)";
const PAIRING_OK = "((label_status = 'confirmed_correct' AND label->>'verdict' = 'jev_right') OR (label_status = 'confirmed_error' AND label->>'verdict' = 'jev_wrong'))";
const CONFIRMED = "label_status IN ('confirmed_error','confirmed_correct')";

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable(TABLE);
  if (!hasTable) return;
  await knex(TABLE)
    .whereRaw(`${CONFIRMED} AND NOT COALESCE(${LABEL_OK} AND ${PROVENANCE_OK} AND ${PAIRING_OK}, false)`)
    .update({ label_status: 'unreviewed', labeled_by: null, labeled_at: null });
  await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${OLD}`);
  await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${CONSTRAINT} CHECK (NOT (${CONFIRMED}) OR COALESCE(${LABEL_OK} AND ${PROVENANCE_OK} AND ${PAIRING_OK}, false))`);
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable(TABLE);
  if (!hasTable) return;
  await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${CONSTRAINT}`);
  await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${OLD} CHECK (NOT (${CONFIRMED}) OR COALESCE(${LABEL_OK} AND ${PROVENANCE_OK}, false))`);
};

exports.PAIRING_OK = PAIRING_OK;
