/**
 * route_check_runs: the hourly route check's SHADOW log (owner 2026-11-19, "do whatever you reccomend";
 * services/day-replan/route-check.js). One row per hourly run: the openings a new job fits in the rest of today and
 * the next staffed days, counted for dispatch and for online booking, and what the ad budget rule WOULD do.
 * Nothing reads it to change a visit, a time, a budget or a message.
 *
 * Ids and minutes only: no customer name, address or phone number. `days` holds one entry per tech-day
 * [{ date, technician_id, stops, openings: [{ kind, start, min, slots, online }], slots, online, skip? }];
 * `totals` the today / next staffed days / 7-day figures; `ad_shadow` { decision: full | floor, onlineAhead, live }.
 * Additive; down drops the table.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('route_check_runs', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.timestamp('run_at', { useTz: true }).notNullable();
    t.date('service_date').notNullable();
    t.text('status').notNullable();
    t.jsonb('days').notNullable().defaultTo('[]');
    t.jsonb('totals').notNullable().defaultTo('{}');
    t.jsonb('ad_shadow').notNullable().defaultTo('{}');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['service_date'], 'route_check_runs_service_date_idx');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('route_check_runs');
};
