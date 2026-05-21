/**
 * Project-closeout follow-up alerts are idempotent per scheduled job.
 *
 * Closing a project-backed service can create a follow_up_needed Action Queue
 * card. Two admins can click close at the same time, so the read-side dedupe in
 * project-completion.js needs a storage-level guard.
 */

exports.up = async function up(knex) {
  await knex.raw(`
    WITH ranked AS (
      SELECT
        id,
        row_number() OVER (PARTITION BY job_id ORDER BY created_at ASC, id ASC) AS rn
      FROM dispatch_alerts
      WHERE type = 'follow_up_needed'
        AND resolved_at IS NULL
        AND job_id IS NOT NULL
        AND payload->>'source' = 'project_completion'
    )
    UPDATE dispatch_alerts AS a
    SET
      resolved_at = now(),
      payload = coalesce(a.payload, '{}'::jsonb) || jsonb_build_object(
        'dedupedByMigration', '20260521000007_project_followup_alert_dedupe'
      )
    FROM ranked
    WHERE a.id = ranked.id
      AND ranked.rn > 1
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_alerts_project_followup_one_unresolved
      ON dispatch_alerts (job_id)
      WHERE type = 'follow_up_needed'
        AND resolved_at IS NULL
        AND job_id IS NOT NULL
        AND payload->>'source' = 'project_completion'
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_dispatch_alerts_project_followup_one_unresolved');
};
