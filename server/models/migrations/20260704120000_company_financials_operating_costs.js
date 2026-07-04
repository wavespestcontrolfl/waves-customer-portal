/**
 * Owner-entered monthly OPERATING overhead on company_financials — the
 * adjusted-EBITDA bridge's authoritative overhead block (Growth Command
 * Center Phase 5).
 *
 * Deliberately NEW `ovh_*` columns: the existing vehicle_cost_per_month /
 * insurance_cost_per_month / software_cost_per_month / admin_cost_per_customer_year
 * are PRICING inputs (job-pricing assumptions) — overloading them would let a
 * pricing tweak silently rewrite the company P&L view, and vice versa. All
 * nullable, no seeds: until the owner enters real figures the bridge keeps
 * falling back to the pricing assumptions (labeled as such in the UI).
 * overhead_entered_at stamps the last deliberate entry.
 */

const COLS = [
  'ovh_office_payroll',
  'ovh_rent',
  'ovh_insurance',
  'ovh_software',
  'ovh_vehicle_fixed',
  'ovh_other_ga',
];

exports.up = async function up(knex) {
  for (const col of COLS) {
    if (!(await knex.schema.hasColumn('company_financials', col))) {
      await knex.schema.alterTable('company_financials', (t) => {
        t.decimal(col, 10, 2).nullable();
      });
    }
  }
  if (!(await knex.schema.hasColumn('company_financials', 'overhead_entered_at'))) {
    await knex.schema.alterTable('company_financials', (t) => {
      t.timestamp('overhead_entered_at').nullable();
    });
  }
};

exports.down = async function down(knex) {
  for (const col of [...COLS, 'overhead_entered_at']) {
    if (await knex.schema.hasColumn('company_financials', col)) {
      await knex.schema.alterTable('company_financials', (t) => {
        t.dropColumn(col);
      });
    }
  }
};
