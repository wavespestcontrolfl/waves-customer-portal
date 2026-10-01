/**
 * decision_reviews: the confirmed-label shape CHECK, written correctly.
 *
 * Supersedes 20261001140000 (frozen, already pushed), whose predicate had two
 * faults the pre-push audit caught: it used the jsonb `?` operator, which knex
 * reads in raw SQL as a bind placeholder, and a missing verdict made the
 * predicate SQL NULL — a CHECK accepts NULL and the cleanup's NOT(...) skipped
 * such rows. Same contract, stated so it can never be NULL and with
 * jsonb_exists() in place of the operator:
 *   { "verdict": "jev_right" | "jev_wrong" | "unclear", "correct_value" present for jev_wrong }
 *   plus non-blank labeled_by and labeled_at, for confirmed_error / confirmed_correct rows.
 */
const TABLE = 'decision_reviews';
const OLD = 'decision_reviews_confirmed_label_shape_check';
const CONSTRAINT = 'decision_reviews_confirmed_label_shape_v2_check';
const LABEL_OK = "(label IS NOT NULL AND jsonb_typeof(label) = 'object' AND label->>'verdict' IS NOT NULL AND label->>'verdict' IN ('jev_right','jev_wrong','unclear') AND (label->>'verdict' <> 'jev_wrong' OR jsonb_exists(label, 'correct_value')))";
const PROVENANCE_OK = "(labeled_by IS NOT NULL AND btrim(labeled_by) <> '' AND labeled_at IS NOT NULL)";
const CONFIRMED = "label_status IN ('confirmed_error','confirmed_correct')";

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable(TABLE);
  if (!hasTable) return;
  await knex(TABLE)
    .whereRaw(`${CONFIRMED} AND NOT COALESCE(${LABEL_OK} AND ${PROVENANCE_OK}, false)`)
    .update({ label_status: 'unreviewed', labeled_by: null, labeled_at: null });
  await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${OLD}`);
  await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${CONSTRAINT} CHECK (NOT (${CONFIRMED}) OR COALESCE(${LABEL_OK} AND ${PROVENANCE_OK}, false))`);
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable(TABLE);
  if (!hasTable) return;
  await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${CONSTRAINT}`);
};

exports.LABEL_OK = LABEL_OK;
exports.PROVENANCE_OK = PROVENANCE_OK;
