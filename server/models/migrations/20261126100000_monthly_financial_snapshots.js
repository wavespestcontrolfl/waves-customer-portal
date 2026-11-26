/**
 * Office cost per stop (owner approved 2026-11-25).
 *
 * 1. company_financials gets two nullable inputs for the owner's own office time:
 *    owner_office_hours_per_month x owner_office_hourly_rate = the monthly allowance
 *    added to the office cost. NULL or 0 = not counted. They sit on company_financials
 *    next to the ovh_* operating costs, edited in Settings -> Operating costs.
 * 2. monthly_financial_snapshots keeps one row per calendar month (month = the first
 *    day, unique) so the dashboard can chart a month's office cost per stop later, after
 *    the ledger and the settings have moved on. Written by services/monthly-financial-
 *    snapshot.js (a cron on the 2nd, and the backfill script).
 *
 * Both parts are additive and idempotent. down() drops only what this migration added.
 */

const SETTINGS_COLS = [
  ['owner_office_hours_per_month', 6, 2],
  ['owner_office_hourly_rate', 8, 2],
];

exports.up = async function up(knex) {
  for (const [col, precision, scale] of SETTINGS_COLS) {
    if (!(await knex.schema.hasColumn('company_financials', col))) {
      await knex.schema.alterTable('company_financials', (t) => {
        t.decimal(col, precision, scale).nullable();
      });
    }
  }

  if (!(await knex.schema.hasTable('monthly_financial_snapshots'))) {
    await knex.schema.createTable('monthly_financial_snapshots', (t) => {
      t.increments('id').primary();
      t.date('month').notNullable().unique(); // first day of the ET calendar month
      t.decimal('completed_job_revenue', 12, 2).notNullable().defaultTo(0); // service_records basis
      t.decimal('cash_revenue', 12, 2).notNullable().defaultTo(0); // P&L basis
      t.decimal('gross_margin_pct', 7, 2); // NULL = no revenue that month
      t.decimal('office_cost', 12, 2).notNullable().defaultTo(0); // ledger + owner allowance
      t.decimal('owner_allowance', 12, 2).notNullable().defaultTo(0); // the owner-time part of office_cost
      t.integer('paid_stops').notNullable().defaultTo(0);
      t.decimal('office_cost_per_stop', 12, 2); // NULL = zero paid stops
      t.decimal('net_income', 12, 2).notNullable().defaultTo(0); // P&L net income
      t.decimal('net_margin_pct', 7, 2); // NULL = no cash revenue
      t.timestamp('computed_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('created_at').defaultTo(knex.fn.now());
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('monthly_financial_snapshots');
  for (const [col] of SETTINGS_COLS) {
    if (await knex.schema.hasColumn('company_financials', col)) {
      await knex.schema.alterTable('company_financials', (t) => {
        t.dropColumn(col);
      });
    }
  }
};

exports.SETTINGS_COLS = SETTINGS_COLS;
