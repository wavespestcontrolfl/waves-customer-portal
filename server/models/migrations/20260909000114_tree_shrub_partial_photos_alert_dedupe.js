/**
 * tree_shrub_assessment_partial_photos alerts are idempotent per visit.
 *
 * POST /api/tech/services/:id/photos/reconcile raises this alert through
 * createAlertOnce, whose INSERT ... ON CONFLICT DO NOTHING only dedupes when a
 * unique index covers the type. Without one, a reconciliation retried after a
 * lost response inserts a second unresolved alert and broadcasts it again
 * (pre-push Codex P1, PR #4091). Same storage-level guard as the project
 * follow-up alert (20260521000007).
 */

exports.up = async function up(knex) {
  await knex.raw(`
    WITH ranked AS (
      SELECT
        id,
        row_number() OVER (PARTITION BY job_id ORDER BY created_at ASC, id ASC) AS rn
      FROM dispatch_alerts
      WHERE type = 'tree_shrub_assessment_partial_photos'
        AND resolved_at IS NULL
        AND job_id IS NOT NULL
    )
    UPDATE dispatch_alerts AS a
    SET
      resolved_at = now(),
      payload = coalesce(a.payload, '{}'::jsonb) || jsonb_build_object(
        'dedupedByMigration', '20260909000114_tree_shrub_partial_photos_alert_dedupe'
      )
    FROM ranked
    WHERE a.id = ranked.id
      AND ranked.rn > 1
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_alerts_ts_partial_photos_one_unresolved
      ON dispatch_alerts (job_id)
      WHERE type = 'tree_shrub_assessment_partial_photos'
        AND resolved_at IS NULL
        AND job_id IS NOT NULL
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_dispatch_alerts_ts_partial_photos_one_unresolved');
};
