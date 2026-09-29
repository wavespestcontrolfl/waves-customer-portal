/**
 * One-time re-scoring of the upcoming pending event backlog (owner ruling
 * 2026-09-27: drop the missing_price / unclear_age deductions, score with
 * Opus 5.5 at max effort under the calibrated prompt).
 *
 * Auto-curation examines each event once (curated_at). Upcoming pending rows
 * it already examined were scored under the old rules and would never be
 * looked at again, so this clears their stored assessment and curated_at.
 * The daily 6:15 AM ET curation run re-examines them, up to its per-run
 * limit, earliest start first.
 *
 * Scope: pending, not merged, starting from today (ET) on, that auto-curation
 * examined and scored (score_breakdown present) with no hard-policy
 * rejection code. Policy rejections (open houses, retail promos...) don't
 * depend on the removed deductions, so re-scoring them would only spend model
 * calls.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('events_raw'))) return;
  await knex.raw(`
    UPDATE events_raw
    SET curated_at = NULL,
        editorial_score = NULL,
        score_breakdown = NULL,
        rejection_codes = NULL,
        audience_tags = NULL,
        novelty_type = NULL,
        editorial_evidence = NULL,
        curation_note = 'Re-opened for re-scoring under the 2026-09-27 rubric',
        updated_at = now()
    WHERE admin_status = 'pending'
      AND merged_into IS NULL
      AND curated_at IS NOT NULL
      AND score_breakdown IS NOT NULL
      AND COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(rejection_codes::jsonb) = 'array' THEN rejection_codes::jsonb END), 0) = 0
      AND start_at >= (date_trunc('day', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York')
  `);
};

// Documented no-op (waves-db data-correction rule): the cleared assessments
// can't be restored, and the re-scoring is the intended state.
exports.down = async function down() {};
