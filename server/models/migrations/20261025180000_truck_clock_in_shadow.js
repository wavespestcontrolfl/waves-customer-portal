'use strict';

/**
 * truck_clock_in_shadow: one row per technician per Eastern work day, written by
 * the truck clock-in hook (services/truck-clock-in.js, GATE_TRUCK_CLOCK_IN =
 * shadow or true; owner 2026-10-25).
 *
 * The row is the FIRST trigger of the day (the truck's first GPS arrival at one of
 * the technician's visits, or the start of the truck's first trip within 200 m of
 * the office). UNIQUE (technician_id, work_date) keeps only that first one; a later
 * trigger the same day inserts nothing (ON CONFLICT DO NOTHING).
 *
 *   would_clock_in  true when every condition held (no active shift, truck-use
 *                   agreement signed). In 'true' mode it is the actual outcome.
 *   skip_reason     NULL when would_clock_in; else already_clocked_in,
 *                   agreement_not_signed, agreement_unknown or clock_in_failed.
 *                   Free text on purpose: a later reason needs no migration.
 *   lat / lng       the GPS point that fired the trigger.
 *
 * Audit trail only. Nothing reads it to decide anything. Additive and idempotent.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('truck_clock_in_shadow')) return;
  await knex.schema.createTable('truck_clock_in_shadow', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('technician_id').notNullable().references('id').inTable('technicians').onDelete('CASCADE');
    t.date('work_date').notNullable();
    t.string('trigger', 30).notNullable();
    t.timestamp('event_at', { useTz: true }).notNullable();
    t.boolean('would_clock_in').notNullable();
    t.string('skip_reason', 60);
    t.decimal('lat', 10, 7);
    t.decimal('lng', 10, 7);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['technician_id', 'work_date']);
  });
  await knex.raw(`ALTER TABLE truck_clock_in_shadow ADD CONSTRAINT truck_clock_in_shadow_trigger_check
    CHECK ("trigger" IN ('first_arrival', 'office_trip_start'))`);
  await knex.raw(`ALTER TABLE truck_clock_in_shadow ADD CONSTRAINT truck_clock_in_shadow_skip_check
    CHECK ((would_clock_in AND skip_reason IS NULL) OR (NOT would_clock_in AND skip_reason IS NOT NULL))`);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('truck_clock_in_shadow');
};
