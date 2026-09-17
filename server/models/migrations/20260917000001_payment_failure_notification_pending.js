/** Keep webhook claims durable while admin notification delivery is pending. */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('stripe_payment_notification_log'))) return;
  if (!(await knex.schema.hasColumn('stripe_payment_notification_log', 'pending_payload'))) {
    await knex.schema.alterTable('stripe_payment_notification_log', (table) => {
      // Existing delivered claims remain null and must never be replayed.
      table.jsonb('pending_payload').nullable();
    });
  }
  await knex.raw(`CREATE INDEX IF NOT EXISTS stripe_payment_notification_pending_idx
    ON stripe_payment_notification_log (notified_at)
    WHERE pending_payload IS NOT NULL`);
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('stripe_payment_notification_log'))) return;
  await knex.raw('DROP INDEX IF EXISTS stripe_payment_notification_pending_idx');
  if (await knex.schema.hasColumn('stripe_payment_notification_log', 'pending_payload')) {
    await knex.schema.alterTable('stripe_payment_notification_log', (table) => {
      table.dropColumn('pending_payload');
    });
  }
};
