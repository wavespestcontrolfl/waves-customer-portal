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
 * no measurement re-run. Only verdict + verdict_confidence are touched, and
 * only on rows whose run PUBLISHED a page (action_type = new_supporting_blog).
 * Refresh rows are left entirely alone: diff-in-diff is correct for them.
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
      JOIN autonomous_runs r ON r.id = i.run_id
      WHERE r.action_type = 'new_supporting_blog'
        AND i.verdict = 'insufficient_data'
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
           updated_at = now()
      FROM scored s
     WHERE t.id = s.id
  `);
  const n = res.rowCount != null ? res.rowCount : (res.rows ? res.rows.length : 0);
  console.log(`[20260808070000] re-graded ${n} launch row(s) under the launch regime`);
};

/**
 * Down restores insufficient_data — but ONLY for the exact cohort up touched.
 *
 * up regrades launch rows that were ALREADY MEASURED when it ran. Once the
 * launch regime is live, checkPending grades new launches itself, and those
 * verdicts are real data this migration never created. A blanket
 * "reset every improved/neutral launch row" down would destroy them.
 *
 * The cohort is therefore pinned by time: rows whose measurement landed BEFORE
 * this migration ran, read from knex_migrations. Anything measured after is
 * runtime output and is left alone. If the migration row cannot be read the
 * cohort is unidentifiable, so we touch nothing rather than guess.
 */
exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('content_optimization_impact'))) return;
  if (!(await knex.schema.hasTable('autonomous_runs'))) return;

  const marker = await knex.raw(
    'SELECT migration_time FROM knex_migrations WHERE name = ? ORDER BY id DESC LIMIT 1',
    ['20260808070000_regrade_launch_verdicts.js'],
  );
  const ranAt = marker.rows && marker.rows[0] && marker.rows[0].migration_time;
  if (!ranAt) return;

  await knex.raw(`
    UPDATE content_optimization_impact t
       SET verdict = 'insufficient_data', verdict_confidence = NULL, updated_at = now()
      FROM autonomous_runs r
     WHERE r.id = t.run_id
       AND r.action_type = 'new_supporting_blog'
       AND t.verdict IN ('improved', 'neutral')
       AND COALESCE(t.checked_21d_at, t.checked_14d_at) < ?
  `, [ranAt]);
};
