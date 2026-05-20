/**
 * Contact recipient routing knobs.
 *
 * The customer record already stores the account owner and optional
 * service_contact_* fields. These preferences cover the two gaps that showed
 * up in landlord/tenant workflows:
 *   - billing_email can now carry a display name for invoice greetings.
 *   - service reports can optionally copy the account owner when a distinct
 *     on-location contact receives the report by default.
 */
exports.up = async function up(knex) {
  const hasPrefs = await knex.schema.hasTable('notification_prefs');
  if (!hasPrefs) return;

  const hasBillingContactName = await knex.schema.hasColumn('notification_prefs', 'billing_contact_name');
  const hasServiceReportNotifyPrimary = await knex.schema.hasColumn('notification_prefs', 'service_report_notify_primary');

  if (!hasBillingContactName || !hasServiceReportNotifyPrimary) {
    await knex.schema.alterTable('notification_prefs', (table) => {
      if (!hasBillingContactName) table.string('billing_contact_name', 120).nullable();
      if (!hasServiceReportNotifyPrimary) table.boolean('service_report_notify_primary').defaultTo(false);
    });
  }
};

exports.down = async function down(knex) {
  const hasPrefs = await knex.schema.hasTable('notification_prefs');
  if (!hasPrefs) return;

  const hasBillingContactName = await knex.schema.hasColumn('notification_prefs', 'billing_contact_name');
  const hasServiceReportNotifyPrimary = await knex.schema.hasColumn('notification_prefs', 'service_report_notify_primary');

  if (hasBillingContactName || hasServiceReportNotifyPrimary) {
    await knex.schema.alterTable('notification_prefs', (table) => {
      if (hasBillingContactName) table.dropColumn('billing_contact_name');
      if (hasServiceReportNotifyPrimary) table.dropColumn('service_report_notify_primary');
    });
  }
};
