/**
 * Moves the vehicle fixed share of drive_cost from job_costs to service_records (L11a,
 * GATE_TECH_COST_RATES; pre-push audit 2026-10-26).
 *
 * 20261026233000 put it on job_costs. The adjusted-EBITDA bridge reads gross profit from
 * service_records, and costing writes service_records only for a completed, unambiguous record,
 * so the bridge must net exactly the share those rows carry. The share now sits beside the
 * drive_cost it is part of and is written by the same column-guarded write-through, which also
 * keeps older migrations that re-cost visits working before this column exists. NULL = no cost
 * card applied. job_costs.vehicle_fixed_cost was never in production: dropped here.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasColumn('job_costs', 'vehicle_fixed_cost')) {
    await knex.schema.alterTable('job_costs', (t) => {
      t.dropColumn('vehicle_fixed_cost');
    });
  }
  if (!(await knex.schema.hasColumn('service_records', 'vehicle_fixed_cost'))) {
    await knex.schema.alterTable('service_records', (t) => {
      t.decimal('vehicle_fixed_cost', 10, 2).nullable();
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('service_records', 'vehicle_fixed_cost')) {
    await knex.schema.alterTable('service_records', (t) => {
      t.dropColumn('vehicle_fixed_cost');
    });
  }
  // 20261026233000's own down drops this column again.
  if (!(await knex.schema.hasColumn('job_costs', 'vehicle_fixed_cost'))) {
    await knex.schema.alterTable('job_costs', (t) => {
      t.decimal('vehicle_fixed_cost', 10, 2).nullable();
    });
  }
};
