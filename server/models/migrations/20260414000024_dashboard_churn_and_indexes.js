exports.up = async function (knex) {
  const hasChurnedAt = await knex.schema.hasColumn('customers', 'churned_at');
  if (!hasChurnedAt) {
    await knex.schema.alterTable('customers', (t) => {
      t.timestamp('churned_at').nullable();
    });
    // Backfill existing inactive customers with their updated_at as a best-effort churn date
    await knex.raw(`
      UPDATE customers
      SET churned_at = updated_at
      WHERE active = false AND churned_at IS NULL AND updated_at IS NOT NULL
    `);
    await knex.raw(`CREATE INDEX IF NOT EXISTS idx_customers_churned_at ON customers(churned_at) WHERE churned_at IS NOT NULL`);
  }

  // Latest-row lookup on customer_health_scores needs this composite index
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_customer_health_scores_customer_created ON customer_health_scores(customer_id, created_at DESC)`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_customer_health_scores_customer_created`);
  await knex.raw(`DROP INDEX IF EXISTS idx_customers_churned_at`);
  const hasChurnedAt = await knex.schema.hasColumn('customers', 'churned_at');
  if (hasChurnedAt) {
    await knex.schema.alterTable('customers', (t) => { t.dropColumn('churned_at'); });
  }
};
