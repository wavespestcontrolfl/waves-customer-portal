/**
 * Migration — per-notification delivery channel for billing notices
 *
 * Adds SMS / email / both channel selection to the two billing notifications
 * the customer portal's Billing Preferences card exposes (billing reminders,
 * payment confirmations), mirroring the appointment-notice channels shipped
 * in 20260622000011.
 *
 * Unlike the appointment channels (account-level, resolved from the primary
 * profile), these live per-row next to the billing_reminder /
 * payment_confirmation_sms toggles they modify — billing sends target the
 * charged customer row, and the toggles + billing_email are already per-row.
 *
 * Defaults to 'sms' so existing customers see no behavior change.
 */
exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('notification_prefs');
  if (!hasTable) return;

  const channelCols = [
    'billing_reminder_channel',
    'payment_confirmation_channel',
  ];

  for (const col of channelCols) {
    const has = await knex.schema.hasColumn('notification_prefs', col);
    if (!has) {
      await knex.schema.alterTable('notification_prefs', (t) => {
        t.string(col, 10).defaultTo('sms');
      });
    }
  }
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('notification_prefs');
  if (!hasTable) return;

  const channelCols = [
    'billing_reminder_channel',
    'payment_confirmation_channel',
  ];

  for (const col of channelCols) {
    const has = await knex.schema.hasColumn('notification_prefs', col);
    if (has) {
      await knex.schema.alterTable('notification_prefs', (t) => t.dropColumn(col));
    }
  }
};
