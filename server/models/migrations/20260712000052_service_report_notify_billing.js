/**
 * Service-report copy for the billing recipient.
 *
 * Landlord/tenant accounts where the account is under the occupant: the
 * billing_email payer gets invoices only, but had no way to also receive the
 * post-service report. service_report_notify_billing opts the billing
 * recipient into report emails (only meaningful when billing_email is set).
 */
exports.up = async function up(knex) {
  const hasPrefs = await knex.schema.hasTable('notification_prefs');
  if (!hasPrefs) return;

  const hasColumn = await knex.schema.hasColumn('notification_prefs', 'service_report_notify_billing');
  if (!hasColumn) {
    await knex.schema.alterTable('notification_prefs', (table) => {
      table.boolean('service_report_notify_billing').defaultTo(false);
    });
  }
};

exports.down = async function down(knex) {
  const hasPrefs = await knex.schema.hasTable('notification_prefs');
  if (!hasPrefs) return;

  const hasColumn = await knex.schema.hasColumn('notification_prefs', 'service_report_notify_billing');
  if (hasColumn) {
    await knex.schema.alterTable('notification_prefs', (table) => {
      table.dropColumn('service_report_notify_billing');
    });
  }
};
