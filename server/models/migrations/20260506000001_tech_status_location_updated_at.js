/**
 * Split tech_status semantic freshness from GPS freshness.
 *
 * updated_at changes for status/current_job transitions. location_updated_at
 * changes only when a GPS source writes lat/lng, so customer/admin maps do
 * not treat a status-only update as a fresh vehicle position.
 */
exports.up = async function (knex) {
  const hasColumn = await knex.schema.hasColumn('tech_status', 'location_updated_at');
  if (!hasColumn) {
    await knex.schema.alterTable('tech_status', (t) => {
      t.timestamp('location_updated_at', { useTz: true });
    });
  }

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_tech_status_location_updated
      ON tech_status (location_updated_at)
  `);

  await knex.raw(`
    DO $$
    BEGIN
      IF to_regclass('public.vehicle_locations') IS NOT NULL THEN
        UPDATE tech_status ts
           SET lat = vl.lat,
               lng = vl.lng,
               location_updated_at = vl.updated_at
          FROM technicians t
          JOIN vehicle_locations vl ON vl.bouncie_imei = t.bouncie_imei
         WHERE ts.tech_id = t.id
           AND ts.location_updated_at IS NULL
           AND vl.lat IS NOT NULL
           AND vl.lng IS NOT NULL
           AND t.bouncie_imei IS NOT NULL;
      END IF;
    END $$;
  `);
};

exports.down = async function (knex) {
  const hasColumn = await knex.schema.hasColumn('tech_status', 'location_updated_at');
  if (hasColumn) {
    await knex.raw('DROP INDEX IF EXISTS idx_tech_status_location_updated');
    await knex.schema.alterTable('tech_status', (t) => {
      t.dropColumn('location_updated_at');
    });
  }
};
