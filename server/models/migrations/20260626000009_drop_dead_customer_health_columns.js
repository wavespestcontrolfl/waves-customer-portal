/**
 * Drop the dead customers.health_score / health_risk columns.
 *
 * These were written nightly by the removed customer-health-v2 scorer but read
 * by nothing — every health reader (the /admin/health dashboard, the customers
 * list, Customer 360, the retention agent) consumes the customer_health_scores
 * table, not these columns. With the v2 scorer gone, they are pure dead weight.
 *
 * Re-creatable on rollback (reverse of 20260401000063). Guarded so it is safe
 * to run on a DB where the columns were never created.
 */
exports.up = async function (knex) {
  const cols = await knex.raw(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'customers'"
  );
  const existing = cols.rows.map(r => r.column_name);
  await knex.schema.alterTable('customers', t => {
    if (existing.includes('health_score')) t.dropColumn('health_score');
    if (existing.includes('health_risk')) t.dropColumn('health_risk');
  });
};

exports.down = async function (knex) {
  const cols = await knex.raw(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'customers'"
  );
  const existing = cols.rows.map(r => r.column_name);
  await knex.schema.alterTable('customers', t => {
    if (!existing.includes('health_score')) t.integer('health_score');
    if (!existing.includes('health_risk')) t.string('health_risk', 20);
  });
};
