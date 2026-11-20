/**
 * sendgrid_webhook_events.machine_open: SendGrid's `sg_machine_open` flag on an open event
 * (machineOpenFlag in routes/webhooks-sendgrid.js). SendGrid sends it on every open: true when
 * Apple Mail Privacy Protection fetched the email, whether or not a person read it; false for a
 * conventional open. The Waves Pest Insider warm audience (services/pest-insider/audience.js)
 * leaves out known machine opens. Rows logged before this column, and events that carry no
 * flag, have none (NULL).
 *
 * Additive and nullable; down drops the column.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sendgrid_webhook_events'))) return;
  if (await knex.schema.hasColumn('sendgrid_webhook_events', 'machine_open')) return;
  await knex.schema.alterTable('sendgrid_webhook_events', (t) => {
    t.boolean('machine_open');
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('sendgrid_webhook_events'))) return;
  if (!(await knex.schema.hasColumn('sendgrid_webhook_events', 'machine_open'))) return;
  await knex.schema.alterTable('sendgrid_webhook_events', (t) => {
    t.dropColumn('machine_open');
  });
};
