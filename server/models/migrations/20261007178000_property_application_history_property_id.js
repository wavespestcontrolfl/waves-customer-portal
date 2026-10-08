/**
 * The treated property, frozen on the application ledger (Codex round 12 on #6104).
 *
 * The per-lawn yearly counts and minimum intervals placed each property_application_history row at the
 * property of its visit, by joining service_records -> scheduled_services.property_id. Staff can change
 * a visit's property after it was completed (appointment-address correction), which would move the
 * pesticide history to another lawn and could clear one lawn's cap while tripping another's. The
 * ledger is the state-auditable record of what was applied WHERE, so it carries the property itself.
 *
 *   property_application_history.property_id   uuid, nullable, no foreign key (a deleted property
 *                                               must never block or null out an application record)
 *
 * It is written at completion (compliance.createComplianceRecords) from the visit's property at that
 * moment and never rewritten. Existing rows are backfilled ONCE from the visit's property, in batches
 * of 1,000, and the backfill is audited with its count. A row with no visit, or a visit with no
 * property, stays NULL: readers fall back to the visit join for those legacy rows only, and an
 * unplaced row still counts at every property, as before.
 *
 * down() drops the index and the column (the column holds only what this migration and the completion
 * writer put there; the visit join is the old reading).
 */
const BATCH = 1000;
const MIGRATION = '20261007178000_property_application_history_property_id';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('property_application_history'))) return;
  if (!(await knex.schema.hasColumn('property_application_history', 'property_id'))) {
    await knex.schema.alterTable('property_application_history', (t) => {
      t.uuid('property_id').nullable();
      t.index(['customer_id', 'property_id'], 'idx_pah_customer_property');
    });
  }
  let total = 0;
  for (;;) {
     
    const result = await knex.raw(`
      WITH batch AS (
        SELECT pah.id, ss.property_id
          FROM property_application_history pah
          JOIN service_records sr ON sr.id = pah.service_record_id
          JOIN scheduled_services ss ON ss.id = sr.scheduled_service_id
         WHERE pah.property_id IS NULL AND ss.property_id IS NOT NULL
         LIMIT ${BATCH}
      )
      UPDATE property_application_history p SET property_id = batch.property_id
        FROM batch WHERE p.id = batch.id`);
    if (!result.rowCount) break;
    total += result.rowCount;
  }
  if (total && (await knex.schema.hasTable('audit_log'))) {
    const { recordAuditEvent } = require('../../services/audit-log');
    await recordAuditEvent({
      actor_type: 'system',
      action: 'property_application_history.property_id_backfill',
      resource_type: 'property_application_history',
      resource_id: null,
      metadata: { migration: MIGRATION, rowsBackfilled: total, source: 'scheduled_services.property_id via service_records', batchSize: BATCH },
      critical: true,
      trx: knex,
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('property_application_history'))) return;
  if (await knex.schema.hasColumn('property_application_history', 'property_id')) {
    await knex.schema.alterTable('property_application_history', (t) => {
      t.dropIndex(['customer_id', 'property_id'], 'idx_pah_customer_property');
      t.dropColumn('property_id');
    });
  }
};
