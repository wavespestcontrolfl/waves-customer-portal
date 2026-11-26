/**
 * Cross-sell number (owner approved 2026-11-26): three columns on monthly_financial_snapshots, all NULL until a month is
 * written by services/cross-sell-rate.js (the 2nd-of-month cron, or server/scripts/backfill-cross-sell-snapshots.js).
 *
 *   recurring_customers      integer  customers with at least one family of recurring service on the schedule
 *   multi_service_customers  integer  of those, customers with two or more families (pest + lawn, pest + mosquito, ...)
 *   multi_service_sources    jsonb    for the multi-service customers, how the added service came in
 *                                     ({ app, service_report_card, website_quote, estimate, phone_call, imported, office })
 *
 * NULL = a row stored before these columns existed. Additive and idempotent. Down drops the three columns (the stored numbers
 * can be rebuilt from scheduled_services by the backfill script, so nothing is lost for good).
 */
const COLUMNS = ['recurring_customers', 'multi_service_customers', 'multi_service_sources'];

exports.up = async function up(knex) {
  const has = {};
  for (const name of COLUMNS) has[name] = await knex.schema.hasColumn('monthly_financial_snapshots', name);
  if (COLUMNS.every((name) => has[name])) return;
  await knex.schema.alterTable('monthly_financial_snapshots', (t) => {
    if (!has.recurring_customers) t.integer('recurring_customers').nullable();
    if (!has.multi_service_customers) t.integer('multi_service_customers').nullable();
    if (!has.multi_service_sources) t.jsonb('multi_service_sources').nullable();
  });
};

exports.down = async function down(knex) {
  const present = [];
  for (const name of COLUMNS) {
    if (await knex.schema.hasColumn('monthly_financial_snapshots', name)) present.push(name);
  }
  if (!present.length) return;
  await knex.schema.alterTable('monthly_financial_snapshots', (t) => {
    t.dropColumns(...present);
  });
};
