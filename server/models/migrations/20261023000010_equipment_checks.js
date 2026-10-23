'use strict';

/**
 * equipment_checks — one row per truck check (docs/tool-inventory-tracker-scope.md,
 * PR 1; dark behind GATE_TRUCK_KIT).
 *
 * A technician confirms what is on their truck: `vehicle_id` is the equipment
 * row with category 'vehicle' (there is no vehicles table, by the 2026-04
 * decision in 20260422000008_vehicle_locations.js), `results` holds one entry
 * per item on the truck's kit as [{ equipment_id, state, note }] with state
 * present | missing | damaged, and the three counts are denormalized so the
 * last check reads without parsing. Missing and damaged items open
 * maintenance_alerts rows (tool_missing / tool_damaged) from
 * server/services/truck-kit.js; this table is the history.
 *
 * Additive, idempotent (hasTable guard), no backfill.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('equipment_checks')) return;
  await knex.schema.createTable('equipment_checks', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('vehicle_id').notNullable().references('id').inTable('equipment').onDelete('CASCADE');
    t.uuid('technician_id').nullable().references('id').inTable('technicians').onDelete('SET NULL');
    t.timestamp('checked_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.jsonb('results').notNullable().defaultTo('[]');
    t.integer('item_count').notNullable().defaultTo(0);
    t.integer('missing_count').notNullable().defaultTo(0);
    t.integer('damaged_count').notNullable().defaultTo(0);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw('CREATE INDEX equipment_checks_vehicle_checked_idx ON equipment_checks (vehicle_id, checked_at DESC)');
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('equipment_checks');
};
