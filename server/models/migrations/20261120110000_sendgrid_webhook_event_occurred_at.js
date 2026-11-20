/**
 * sendgrid_webhook_events.occurred_at: the event's own time, from SendGrid's `timestamp`
 * (eventOccurredAt in routes/webhooks-sendgrid.js), next to created_at, the time the webhook
 * logged it. A batch SendGrid re-sends after a webhook outage logs its events hours after they
 * happened. The Waves Pest Insider warm audience (services/pest-insider/audience.js) measures its
 * 90-day window on this column. Rows logged before it have none (NULL).
 *
 * Additive and nullable; down drops the column.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sendgrid_webhook_events'))) return;
  if (await knex.schema.hasColumn('sendgrid_webhook_events', 'occurred_at')) return;
  await knex.schema.alterTable('sendgrid_webhook_events', (t) => {
    t.timestamp('occurred_at', { useTz: true });
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('sendgrid_webhook_events'))) return;
  if (!(await knex.schema.hasColumn('sendgrid_webhook_events', 'occurred_at'))) return;
  await knex.schema.alterTable('sendgrid_webhook_events', (t) => {
    t.dropColumn('occurred_at');
  });
};
