/**
 * Migration — per-notification delivery channel for appointment notices
 *
 * Adds SMS / email / both channel selection to the three appointment
 * notifications the customer portal exposes (new appointment confirmation,
 * 72-hour reminder, 24-hour reminder). Lets a customer who travels overseas
 * receive these by email instead of (or in addition to) SMS.
 *
 * Defaults to 'sms' so existing customers see no behavior change — SMS stays
 * the primary channel with the existing email fallback on delivery failure.
 */
exports.up = async function (knex) {
  const hasTable = await knex.schema.hasTable('notification_prefs');
  if (!hasTable) return;

  const channelCols = [
    'appointment_confirmation_channel',
    'service_reminder_72h_channel',
    'service_reminder_24h_channel',
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

exports.down = async function (knex) {
  const hasTable = await knex.schema.hasTable('notification_prefs');
  if (!hasTable) return;

  const channelCols = [
    'appointment_confirmation_channel',
    'service_reminder_72h_channel',
    'service_reminder_24h_channel',
  ];

  for (const col of channelCols) {
    const has = await knex.schema.hasColumn('notification_prefs', col);
    if (has) {
      await knex.schema.alterTable('notification_prefs', (t) => t.dropColumn(col));
    }
  }
};
