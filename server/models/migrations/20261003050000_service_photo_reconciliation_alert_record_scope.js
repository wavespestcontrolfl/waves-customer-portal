/**
 * Scope unresolved photo-reconciliation handoffs to the completion record.
 *
 * A scheduled visit can have more than one completion record. Reconciliation
 * of one record must neither block nor resolve the office repair for another.
 */

const INDEX_NAME = 'idx_dispatch_alerts_photo_reconcile_one_unresolved';
const MIGRATION_NAME = '20261003050000_service_photo_reconciliation_alert_record_scope';

exports.up = async function up(knex) {
  // The preceding migration created this name with visit-wide uniqueness.
  // Reuse the name after replacing its key so existing preview histories and
  // fresh deploys converge on the same final schema.
  await knex.raw(`DROP INDEX IF EXISTS ${INDEX_NAME}`);

  await knex.raw(`
    WITH ranked AS (
      SELECT
        id,
        row_number() OVER (
          PARTITION BY job_id, payload->>'serviceRecordId'
          ORDER BY created_at ASC, id ASC
        ) AS rn
      FROM dispatch_alerts
      WHERE type = 'service_photo_reconciliation_required'
        AND resolved_at IS NULL
        AND job_id IS NOT NULL
        AND payload->>'serviceRecordId' IS NOT NULL
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
    CREATE UNIQUE INDEX ${INDEX_NAME}
      ON dispatch_alerts (job_id, (payload->>'serviceRecordId'))
      WHERE type = 'service_photo_reconciliation_required'
        AND resolved_at IS NULL
        AND job_id IS NOT NULL
        AND payload->>'serviceRecordId' IS NOT NULL
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS ${INDEX_NAME}`);
  await require('./20261003040000_service_photo_reconciliation_alert_dedupe').up(knex);
};
