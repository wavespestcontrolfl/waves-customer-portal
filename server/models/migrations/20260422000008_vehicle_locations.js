/**
 * Vehicle locations — single canonical row per device for Live Service Tracking
 * (PR #52 / TrackPage.jsx Phase 2).
 *
 * Option 2 decision: no `vehicles` or `vehicle_assignments` tables. The IMEI
 * on technicians.bouncie_imei stays the canonical device-to-tech link. This
 * table just holds the latest point for each device, keyed on the raw IMEI
 * string the Bouncie webhook sends so the receiver can upsert without
 * joining anything.
 *
 * `reported_at` is the timestamp from the Bouncie event (device clock).
 * `updated_at` is our wall-clock write time — used to gate stale reads
 * on the /track/:token API (>5 min = hide the dot).
 */
exports.up = async function (knex) {
  await knex.schema.createTable('vehicle_locations', (t) => {
    t.string('bouncie_imei').primary();
    t.decimal('lat', 10, 7);
    t.decimal('lng', 10, 7);
    t.decimal('heading', 6, 2);
    t.decimal('speed_mph', 6, 2);
    t.boolean('ignition');
    t.timestamp('reported_at');
    t.timestamp('updated_at').defaultTo(knex.fn.now());
  });

  await knex.raw(
    'CREATE INDEX idx_vehicle_locations_updated_at ON vehicle_locations (updated_at DESC)'
  );
  await knex.raw(
    'CREATE INDEX idx_vehicle_locations_reported_at ON vehicle_locations (reported_at DESC)'
  );
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_vehicle_locations_updated_at');
  await knex.raw('DROP INDEX IF EXISTS idx_vehicle_locations_reported_at');
  await knex.schema.dropTableIfExists('vehicle_locations');
};
