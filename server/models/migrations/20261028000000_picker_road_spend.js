/**
 * Daily Google road-time spend for the staff pickers
 * (services/scheduling/picker-road-spend.js, GATE_PICKER_ROAD_CHECK; owner
 * 2026-10-27: "we just have to make sure costs are appropriate").
 *
 * One row per (bucket, Eastern calendar day):
 *   bucket          'all' (the account) or 'staff:<technicians.id>' (who asked)
 *   day             America/New_York date the lookups were bought on
 *   pro_elements    traffic-aware Route Matrix elements (Google "Pro" SKU)
 *   plain_elements  road-time elements without traffic ("Essentials" SKU)
 *   updated_at      last reservation
 *
 * Counters only: no customer data, no addresses. The picker reserves its
 * lookups here before calling Google, so every process shares the same daily
 * and monthly ceilings (an in-process allowance resets on every deploy).
 * Idempotent create; down() drops the table.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('picker_road_spend')) return;
  await knex.schema.createTable('picker_road_spend', (t) => {
    t.text('bucket').notNullable();
    t.date('day').notNullable();
    t.integer('pro_elements').notNullable().defaultTo(0);
    t.integer('plain_elements').notNullable().defaultTo(0);
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.primary(['bucket', 'day']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('picker_road_spend');
};
