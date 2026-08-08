/**
 * Re-grade already-measured LAUNCH rows under the new launch regime.
 *
 * checkPending only visits rows whose checked_14d_at / checked_21d_at is still
 * NULL, so without this every optimization measured before the regime landed
 * keeps its insufficient_data verdict forever — including (at time of writing)
 * 24 pages that demonstrably earned traffic, one of them 8,283 impressions and
 * 75 clicks. The rollup would report nothing until brand-new pages aged 21
 * days, which is exactly the blindness the regime change exists to end.
 *
 * Pure recomputation from metrics ALREADY stored on the row — no GSC re-query,
 * no measurement re-run. The cohort is chosen the same way the runtime chooses
 * the regime: rows with NO USABLE BASELINE (< 30 impressions), which is the
 * precondition that makes a difference impossible to compute. Deliberately NOT
 * action_type — new_supporting_blog can update an existing slug, so it would
 * sweep in pages that have a real baseline and score their ordinary traffic as
 * a launch. Rows with a baseline are left alone: diff-in-diff is right there.
 *
 * Thresholds are inlined rather than imported so this migration stays a
 * point-in-time operation that cannot drift when the service constants change.
 * Source of truth: launchVerdict() in server/services/seo/impact-tracker.js
 * (LAUNCH_MIN_IMPRESSIONS=30, LAUNCH_RANKED_POSITION=20).
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('content_optimization_impact'))) return;
  if (!(await knex.schema.hasTable('autonomous_runs'))) return;

  const res = await knex.raw(`
    WITH graded AS (
      SELECT i.id,
             COALESCE(
               (CASE WHEN i.metrics_21d::text <> '{}' THEN i.metrics_21d ELSE NULL END),
               i.metrics_14d
             ) AS m
      FROM content_optimization_impact i
      WHERE i.verdict = 'insufficient_data'
        AND COALESCE(i.baseline_impressions, 0) < 30
        AND (i.checked_14d_at IS NOT NULL OR i.checked_21d_at IS NOT NULL)
    ), scored AS (
      SELECT id,
             COALESCE((m->>'impressions')::numeric, 0) AS impr,
             COALESCE((m->>'clicks')::numeric, 0)      AS clicks,
             NULLIF(m->>'position', '')::numeric        AS pos
      FROM graded WHERE m IS NOT NULL
    )
    UPDATE content_optimization_impact t
       SET verdict = CASE
             WHEN s.impr >= 30 AND (s.clicks > 0 OR (s.pos IS NOT NULL AND s.pos > 0 AND s.pos <= 20))
               THEN 'improved'
             WHEN s.impr < 30 AND s.clicks = 0
               THEN 'insufficient_data'
             ELSE 'neutral'
           END,
           -- Volume-based confidence, matching launchVerdict: min(1, impr/200).
           verdict_confidence = ROUND(LEAST(1, s.impr / 200.0), 2),
           -- launchVerdict returns both as null and the admin UI labels a
           -- non-null value as control-adjusted lift, so leaving the old
           -- diff-regime numbers behind would mislabel launch rows.
           estimated_lift_position = NULL,
           estimated_lift_clicks_pct = NULL,
           updated_at = now()
      FROM scored s
     WHERE t.id = s.id
  `);
  const n = res.rowCount != null ? res.rowCount : (res.rows ? res.rows.length : 0);
  console.log(`[20260808070000] re-graded ${n} launch row(s) under the launch regime`);
};

/**
 * Down is a deliberate NO-OP.
 *
 * up recomputes a verdict from metrics already on the row; it does not create
 * state that can be meaningfully "put back". The prior value was
 * insufficient_data with a confidence produced by the diff formula, and that
 * formula does not apply to these rows — restoring it would re-assert a
 * grade the code itself no longer believes.
 *
 * Every mechanical reconstruction considered was destructive or wrong:
 *   - reset all improved/neutral launch rows → destroys verdicts the RUNTIME
 *     wrote after this migration, which it never created;
 *   - bound that by migration_time → still catches pre-migration rows up never
 *     touched, still cannot restore the original confidence, and silently
 *     misses rows that stayed insufficient_data but had confidence rewritten.
 * Recording prior values durably would mean a table whose only purpose is to
 * un-improve accurate data.
 *
 * The meaningful rollback here is reverting the CODE: with the launch regime
 * gone, checkPending simply stops producing these verdicts. Rows already
 * graded keep a verdict that is more accurate than insufficient_data, which is
 * strictly better than deleting correct data for the sake of symmetry.
 */
exports.down = async function down() {
  // Intentionally empty — see above.
};
