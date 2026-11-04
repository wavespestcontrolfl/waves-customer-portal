/**
 * day_replan_plans: the nightly day re-plan's SHADOW log (owner ruling 2026-11-03, GATE_DAY_REPLAN,
 * services/day-replan). One row per planned technician-day per run: what the planner WOULD do. Nothing
 * reads it to change a visit; PR 2 will write the new hours from the planner, not from this table.
 *
 * Ids and minutes only: no customer name, address or phone number. `changes` holds
 * [{ id, from: 'HH:MM', to: 'HH:MM' }] (empty unless accepted); `fixed` holds
 * { baseline: 'stored' | 'clock' | 'slot_order' (the current route the saving was measured against),
 * baseline_drive_min, stored_order_stale, stops: [{ id, why, note? }] } with one stop entry per stop that kept its hour. `reason` is accepted | saving_below_floor | no_feasible_order.
 * technician_id has no foreign key on purpose: this is a log, and a technician row must never be
 * blocked by it. Additive; down drops the table.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('day_replan_plans', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('run_id').notNullable();
    t.text('mode').notNullable();
    t.uuid('technician_id').notNullable();
    t.date('service_date').notNullable();
    t.integer('stop_count').notNullable();
    t.decimal('current_drive_min', 10, 2).notNullable();
    t.decimal('planned_drive_min', 10, 2).nullable();
    t.decimal('saved_min', 10, 2).notNullable().defaultTo(0);
    t.integer('current_end_min').notNullable();
    t.integer('planned_end_min').nullable();
    t.boolean('accepted').notNullable().defaultTo(false);
    t.text('reason').notNullable();
    t.jsonb('changes').notNullable().defaultTo('[]');
    t.jsonb('fixed').notNullable().defaultTo('[]');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['service_date'], 'day_replan_plans_service_date_idx');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('day_replan_plans');
};
