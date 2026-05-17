/**
 * Backfill legacy equipment maintenance logs into canonical maintenance_records.
 *
 * The old Equipment page wrote to equipment_maintenance_log while the newer
 * maintenance surface reads maintenance_records. Keep the old table for now,
 * but copy rows once and tag them with their legacy source id.
 */
exports.up = async function (knex) {
  const hasLegacy = await knex.schema.hasTable('equipment_maintenance_log');
  const hasRecords = await knex.schema.hasTable('maintenance_records');
  if (!hasLegacy || !hasRecords) return;

  const hasLegacyId = await knex.schema.hasColumn(
    'maintenance_records',
    'legacy_equipment_maintenance_log_id'
  );
  if (!hasLegacyId) {
    await knex.schema.alterTable('maintenance_records', (t) => {
      t.uuid('legacy_equipment_maintenance_log_id').nullable();
    });
  }

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS maintenance_records_legacy_equipment_log_uidx
    ON maintenance_records (legacy_equipment_maintenance_log_id)
    WHERE legacy_equipment_maintenance_log_id IS NOT NULL
  `);

  await knex.raw(`
    INSERT INTO maintenance_records (
      legacy_equipment_maintenance_log_id,
      equipment_id,
      maintenance_type,
      task_name,
      description,
      performed_at,
      performed_by,
      hours_at_service,
      parts_cost,
      total_cost,
      created_at,
      updated_at
    )
    SELECT
      eml.id,
      eml.equipment_id,
      CASE
        WHEN eml.service_type = 'calibration' THEN 'calibration'
        ELSE 'legacy'
      END,
      COALESCE(NULLIF(INITCAP(REPLACE(eml.service_type, '_', ' ')), ''), 'Maintenance'),
      NULLIF(CONCAT_WS(
        E'\\n',
        NULLIF(eml.notes, ''),
        CASE
          WHEN NULLIF(eml.parts_used, '') IS NOT NULL THEN 'Parts used: ' || eml.parts_used
          ELSE NULL
        END
      ), ''),
      COALESCE(eml.service_date::timestamptz, eml.created_at, NOW()),
      eml.performed_by,
      eml.hours_at_service,
      COALESCE(eml.cost, 0),
      COALESCE(eml.cost, 0),
      COALESCE(eml.created_at, NOW()),
      NOW()
    FROM equipment_maintenance_log eml
    WHERE NOT EXISTS (
      SELECT 1
      FROM maintenance_records mr
      WHERE mr.legacy_equipment_maintenance_log_id = eml.id
    )
  `);
};

exports.down = async function (knex) {
  const hasRecords = await knex.schema.hasTable('maintenance_records');
  if (!hasRecords) return;

  const hasLegacyId = await knex.schema.hasColumn(
    'maintenance_records',
    'legacy_equipment_maintenance_log_id'
  );
  if (!hasLegacyId) return;

  await knex('maintenance_records')
    .whereNotNull('legacy_equipment_maintenance_log_id')
    .del();

  await knex.raw('DROP INDEX IF EXISTS maintenance_records_legacy_equipment_log_uidx');
  await knex.schema.alterTable('maintenance_records', (t) => {
    t.dropColumn('legacy_equipment_maintenance_log_id');
  });
};
