/**
 * Office photo-reconciliation handoffs are idempotent per visit.
 *
 * A technician can retry POST /photos/reconcile after losing access to the
 * visit or after losing the first response. createAlertOnce relies on a
 * matching unique index for concurrent callers to collapse onto the same
 * unresolved dispatch alert.
 */

const INDEX_NAME = 'idx_dispatch_alerts_photo_reconcile_one_unresolved';
const MIGRATION_NAME = '20261003040000_service_photo_reconciliation_alert_dedupe';

exports.up = async function up(knex) {
  await knex.raw(`
    WITH ranked AS (
      SELECT
        id,
        row_number() OVER (PARTITION BY job_id ORDER BY created_at ASC, id ASC) AS rn
      FROM dispatch_alerts
      WHERE type = 'service_photo_reconciliation_required'
        AND resolved_at IS NULL
        AND job_id IS NOT NULL
    )
    UPDATE dispatch_alerts AS a
    SET
      resolved_at = now(),
      payload = coalesce(a.payload, '{}'::jsonb) || jsonb_build_object(
        'dedupedByMigration', '${MIGRATION_NAME}'
      )
    FROM ranked
    WHERE a.id = ranked.id
      AND ranked.rn > 1
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX_NAME}
      ON dispatch_alerts (job_id)
      WHERE type = 'service_photo_reconciliation_required'
        AND resolved_at IS NULL
        AND job_id IS NOT NULL
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS ${INDEX_NAME}`);
};
