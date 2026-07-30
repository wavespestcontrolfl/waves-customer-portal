// The email-change fanout rotates engagement tokens by subscriber
// (customer-email-fanout.js: WHERE subscriber_id = ?), but the deliveries
// ledger only had composite indexes led by send_id — every rotation was a
// full-table scan. Plain index (not CONCURRENTLY: migrations run inside a
// transaction pre-deploy, and the ledger is small enough for a fast build).
exports.up = async function up(knex) {
  const has = await knex.schema.hasTable('newsletter_send_deliveries');
  if (!has) return;
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS newsletter_send_deliveries_subscriber_id_index ON newsletter_send_deliveries (subscriber_id)',
  );
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasTable('newsletter_send_deliveries');
  if (!has) return;
  await knex.raw('DROP INDEX IF EXISTS newsletter_send_deliveries_subscriber_id_index');
};
