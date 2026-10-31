/**
 * job_costs.vehicle_fixed_cost (L11a, GATE_TECH_COST_RATES; pre-push audit 2026-10-26).
 *
 * With a vehicle cost card, a visit's drive_cost carries a share of the vehicle's yearly fixed cost.
 * The adjusted-EBITDA bridge also subtracts the vehicle's monthly fixed cost as overhead, so the share
 * the window's visits already carry must come out of that overhead, or it counts twice. This column
 * records the share (the part of drive_cost that is vehicle fixed cost). NULL = no vehicle card was
 * applied (gate off, no card): today's rows. Derived data; a recalculation rewrites it.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasColumn('job_costs', 'vehicle_fixed_cost')) return;
  await knex.schema.alterTable('job_costs', (t) => {
    t.decimal('vehicle_fixed_cost', 10, 2).nullable();
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasColumn('job_costs', 'vehicle_fixed_cost'))) return;
  await knex.schema.alterTable('job_costs', (t) => {
    t.dropColumn('vehicle_fixed_cost');
  });
};
