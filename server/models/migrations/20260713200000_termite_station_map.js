/**
 * Termite bait station map (station-map-v1).
 *
 * Two tables behind the per-station bait map:
 *  - termite_stations — per-customer registry of the physical in-ground
 *    stations. `geometry_image` stores the technician's satellite mark in
 *    the SAME normalized local-shape contract as
 *    property_zones.geometry_image ({ type: 'circle', cx, cy, r, ref }),
 *    so the zone-drift re-anchoring machinery applies unchanged. Stations
 *    are individually identified (unlike the aggregate counts in the
 *    termite_bait_station typed findings) so per-station status can carry
 *    across visits.
 *  - termite_station_checks — one row per station per completed visit
 *    (service_record), carrying the visit status that colors the customer
 *    report's station pins.
 *
 * Station numbers are per-customer and never reused: the unique
 * (customer_id, station_number) spans retired rows on purpose — "station 7"
 * stays station 7 in every historical report even after it is retired.
 *
 * `program` distinguishes termite from (future) rodent exterior stations;
 * v1 only writes 'termite'.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('termite_stations'))) {
    await knex.schema.createTable('termite_stations', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
      t.integer('station_number').notNullable();
      t.string('program', 20).notNullable().defaultTo('termite');
      t.text('label');
      t.jsonb('geometry_image').notNullable();
      t.boolean('is_active').notNullable().defaultTo(true);
      t.timestamp('retired_at');
      t.timestamps(true, true);
      t.unique(['customer_id', 'station_number']);
    });
    await knex.raw('CREATE INDEX IF NOT EXISTS idx_termite_stations_customer_active ON termite_stations(customer_id) WHERE is_active = true');
  }

  if (!(await knex.schema.hasTable('termite_station_checks'))) {
    await knex.schema.createTable('termite_station_checks', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('station_id').notNullable().references('id').inTable('termite_stations').onDelete('CASCADE');
      t.uuid('service_record_id').notNullable().references('id').inTable('service_records').onDelete('CASCADE');
      t.string('status', 30).notNullable();
      t.specificType('actions', 'text[]').notNullable().defaultTo(knex.raw("'{}'::text[]"));
      t.text('note');
      t.timestamps(true, true);
      t.unique(['station_id', 'service_record_id']);
      t.index(['service_record_id']);
    });
    // Status drives customer-visible pin colors — a value outside the set is
    // a bug, not a new feature; widening requires a migration (house rule:
    // constraints and render legends move in lockstep).
    await knex.raw("ALTER TABLE termite_station_checks ADD CONSTRAINT termite_station_checks_status_check CHECK (status IN ('ok','activity','serviced','inaccessible'))");
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('termite_station_checks');
  await knex.schema.dropTableIfExists('termite_stations');
};
