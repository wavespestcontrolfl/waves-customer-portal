/**
 * decision_reviews: the confirmed label's SHAPE.
 *
 * Codex #5476 r6 (after r5's integrity contract): '{}'::jsonb passed the
 * "label is a JSON object" test. The label written by the review route has one
 * fixed shape, so the schema pins it:
 *   { "verdict": "jev_right" | "jev_wrong" | "unclear", "correct_value"?: any, "note"?: string }
 * and a "jev_wrong" verdict must carry correct_value (the answer the reviewer
 * says was right). This replaces the r5 provenance CHECK with one that adds
 * the shape; confirmed rows whose label does not fit are demoted to unreviewed.
 */
const TABLE = 'decision_reviews';
const OLD = 'decision_reviews_confirmed_label_provenance_check';
const CONSTRAINT = 'decision_reviews_confirmed_label_shape_check';
const LABEL_OK = "(label IS NOT NULL AND jsonb_typeof(label) = 'object' AND label->>'verdict' IN ('jev_right','jev_wrong','unclear') AND (label->>'verdict' <> 'jev_wrong' OR label ? 'correct_value'))";
const PROVENANCE_OK = "(labeled_by IS NOT NULL AND btrim(labeled_by) <> '' AND labeled_at IS NOT NULL)";
const CONFIRMED = "label_status IN ('confirmed_error','confirmed_correct')";

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable(TABLE);
  if (!hasTable) return;
  await knex(TABLE)
    .whereRaw(`${CONFIRMED} AND NOT (${LABEL_OK} AND ${PROVENANCE_OK})`)
    .update({ label_status: 'unreviewed', labeled_by: null, labeled_at: null });
  await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${OLD}`);
  await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${CONSTRAINT} CHECK (NOT (${CONFIRMED}) OR (${LABEL_OK} AND ${PROVENANCE_OK}))`);
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable(TABLE);
  if (!hasTable) return;
  await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${CONSTRAINT}`);
  await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${OLD} CHECK (label_status NOT IN ('confirmed_error','confirmed_correct') OR (label IS NOT NULL AND jsonb_typeof(label) = 'object' AND labeled_by IS NOT NULL AND btrim(labeled_by) <> '' AND labeled_at IS NOT NULL))`);
};

exports.LABEL_OK = LABEL_OK;
exports.PROVENANCE_OK = PROVENANCE_OK;
