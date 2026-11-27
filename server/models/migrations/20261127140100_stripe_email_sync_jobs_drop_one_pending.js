/**
 * stripe_email_sync_jobs: drop the one-pending-row unique index (20261127140000) and index pending rows by customer
 * instead. A customer merge repoints these rows from the retired record to the kept one (the merge FK sweep); with both
 * records holding a pending job the unique index would abort the merge. Two pending rows for one customer are harmless:
 * each job locks the customer row and writes the email on file at that moment, and enqueue() skips the insert when a
 * pending row already exists. Down restores the unique index only when no customer has two pending rows.
 */
exports.up = async function up(knex) {
  await knex.raw('DROP INDEX IF EXISTS stripe_email_sync_jobs_one_pending');
  await knex.raw("CREATE INDEX IF NOT EXISTS stripe_email_sync_jobs_pending_customer ON stripe_email_sync_jobs (customer_id) WHERE status = 'pending'");
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS stripe_email_sync_jobs_pending_customer');
  const dup = await knex.raw("SELECT 1 FROM stripe_email_sync_jobs WHERE status = 'pending' GROUP BY customer_id HAVING count(*) > 1 LIMIT 1");
  if (!dup.rows.length) {
    await knex.raw("CREATE UNIQUE INDEX IF NOT EXISTS stripe_email_sync_jobs_one_pending ON stripe_email_sync_jobs (customer_id) WHERE status = 'pending'");
  }
};
