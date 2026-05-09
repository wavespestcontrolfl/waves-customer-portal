/**
 * SendGrid webhook replay protection.
 *
 * - sendgrid_webhook_events stores provider event ids so retried/replayed
 *   batches do not double-apply newsletter or automation counters.
 * - newsletter_send_deliveries.unsubscribed_at makes SendGrid unsubscribe
 *   events idempotent even if two distinct provider events represent the
 *   same recipient action.
 */

exports.up = async function (knex) {
  const hasEvents = await knex.schema.hasTable('sendgrid_webhook_events');
  if (!hasEvents) {
    await knex.schema.createTable('sendgrid_webhook_events', (t) => {
      t.string('event_id').primary();
      t.string('event_type', 64);
      t.string('message_id');
      t.string('email');
      t.string('status', 32).notNullable().defaultTo('processed');
      t.timestamp('processed_at').defaultTo(knex.fn.now());
      t.timestamps(true, true);
      t.index(['message_id', 'email']);
    });
  }

  const hasUnsubscribedAt = await knex.schema.hasColumn('newsletter_send_deliveries', 'unsubscribed_at');
  if (!hasUnsubscribedAt) {
    await knex.schema.alterTable('newsletter_send_deliveries', (t) => {
      t.timestamp('unsubscribed_at');
    });
  }
};

exports.down = async function (knex) {
  const hasUnsubscribedAt = await knex.schema.hasColumn('newsletter_send_deliveries', 'unsubscribed_at');
  if (hasUnsubscribedAt) {
    await knex.schema.alterTable('newsletter_send_deliveries', (t) => {
      t.dropColumn('unsubscribed_at');
    });
  }

  await knex.schema.dropTableIfExists('sendgrid_webhook_events');
};
