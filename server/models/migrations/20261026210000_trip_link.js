/**
 * Trip link (GATE_TRIP_LINK, owner "TRIP LINK" and "BOTH" 2026-10-26).
 *
 * Two DERIVED tables written only by services/trip-link.js (the 01:40 ET job and the backfill script). They link
 * each Bouncie trip and truck stop to the completed visit it served. Nothing else writes them and nothing in them
 * is a record of truth: a re-run replaces a day.
 *
 * visit_gps_legs, one row per completed scheduled service:
 *   status          matched | no_vehicle | no_destination | no_stop | ambiguous
 *   gps_*           the truck's stop at the visit (arrival, departure, minutes); NULL unless matched
 *   shared_stop_count  how many physical visits matched the same stop (gps_on_site_minutes is already split by it)
 *   drive_*         from the end of the vehicle's previous stop (or the day's first trip) to this stop: minutes,
 *                   miles (NULL when a trip in between has no mileage_log row) and what the previous stop was
 *   leg_group_key   the physical visit (visit_id, else the service id); grouped members share one leg
 * trip_links, one row per Bouncie trip: where it ended and a business / personal SUGGESTION for the mileage review.
 *
 * down() drops both tables: they hold only derived data, which the job rebuilds.
 */
const LEGS = 'visit_gps_legs';
const LINKS = 'trip_links';
const LEG_STATUSES = ['matched', 'no_vehicle', 'no_destination', 'no_stop', 'ambiguous'];
const DRIVE_FROM_KINDS = ['visit', 'supplier', 'business', 'personal', 'home', 'day_start', 'other'];
const ENDS_AT_KINDS = ['visit', 'supplier', 'business', 'personal', 'home', 'other'];
const PURPOSES = ['business', 'personal', 'unclassified'];

exports.LEG_STATUSES = LEG_STATUSES;
exports.DRIVE_FROM_KINDS = DRIVE_FROM_KINDS;
exports.ENDS_AT_KINDS = ENDS_AT_KINDS;
exports.PURPOSES = PURPOSES;

const list = (values) => values.map((value) => `'${value}'`).join(', ');

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(LEGS))) {
    await knex.schema.createTable(LEGS, (t) => {
      t.uuid('scheduled_service_id').primary().references('id').inTable('scheduled_services').onDelete('CASCADE');
      t.text('leg_group_key').notNullable();
      t.uuid('technician_id').nullable();
      t.text('vehicle_imei').nullable();
      t.date('service_date').notNullable();
      t.text('status').notNullable();
      t.timestamp('gps_arrived_at', { useTz: true }).nullable();
      t.timestamp('gps_departed_at', { useTz: true }).nullable();
      t.decimal('gps_on_site_minutes', 8, 2).nullable();
      t.integer('shared_stop_count').notNullable().defaultTo(1);
      t.decimal('drive_minutes', 8, 2).nullable();
      t.decimal('drive_miles', 8, 2).nullable();
      t.text('drive_from_kind').nullable();
      t.specificType('drive_trip_ids', 'text[]').nullable();
      t.decimal('match_distance_m', 8, 1).nullable();
      t.integer('algorithm_version').notNullable();
      t.timestamp('computed_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.index('service_date', 'visit_gps_legs_service_date');
      t.index(['technician_id', 'service_date'], 'visit_gps_legs_technician_date');
    });
    await knex.raw(`ALTER TABLE ${LEGS} ADD CONSTRAINT visit_gps_legs_status_check CHECK (status IN (${list(LEG_STATUSES)}))`);
    await knex.raw(`ALTER TABLE ${LEGS} ADD CONSTRAINT visit_gps_legs_drive_from_kind_check
      CHECK (drive_from_kind IS NULL OR drive_from_kind IN (${list(DRIVE_FROM_KINDS)}))`);
  }
  if (!(await knex.schema.hasTable(LINKS))) {
    await knex.schema.createTable(LINKS, (t) => {
      t.text('bouncie_trip_id').primary();
      t.uuid('mileage_log_id').nullable().references('id').inTable('mileage_log').onDelete('SET NULL');
      t.uuid('technician_id').nullable();
      t.text('vehicle_imei').nullable();
      t.timestamp('trip_start', { useTz: true }).nullable();
      t.timestamp('trip_end', { useTz: true }).nullable();
      t.decimal('distance_miles', 8, 2).nullable();
      t.text('ends_at_kind').nullable();
      t.uuid('ends_at_scheduled_service_id').nullable().references('id').inTable('scheduled_services').onDelete('SET NULL');
      t.text('suggested_purpose').notNullable();
      t.integer('algorithm_version').notNullable();
      t.timestamp('computed_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.index(['technician_id', 'trip_start'], 'trip_links_technician_start');
    });
    await knex.raw(`ALTER TABLE ${LINKS} ADD CONSTRAINT trip_links_ends_at_kind_check
      CHECK (ends_at_kind IS NULL OR ends_at_kind IN (${list(ENDS_AT_KINDS)}))`);
    await knex.raw(`ALTER TABLE ${LINKS} ADD CONSTRAINT trip_links_suggested_purpose_check CHECK (suggested_purpose IN (${list(PURPOSES)}))`);
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists(LINKS);
  await knex.schema.dropTableIfExists(LEGS);
};
