/**
 * Migration 104 — Enhanced notification preferences
 *
 * Per-type channel selection (SMS/email/both), new notification types,
 * and quiet hours support.
 */
exports.up = async function (knex) {
  const hasTable = await knex.schema.hasTable('notification_prefs');
  if (!hasTable) return;

  // Per-type channel columns (sms | email | both)
  const channelCols = [
    ['service_reminder_channel', 'sms'],
    ['en_route_channel', 'sms'],
    ['service_complete_channel', 'sms'],
    ['billing_channel', 'sms'],
    ['seasonal_channel', 'email'],
    ['review_request_channel', 'sms'],
    ['referral_channel', 'sms'],
    ['marketing_channel', 'email'],
    ['payment_receipt_channel', 'sms'],
    ['weather_alert_channel', 'sms'],
  ];

  for (const [col, defaultVal] of channelCols) {
    const has = await knex.schema.hasColumn('notification_prefs', col);
    if (!has) {
      await knex.schema.alterTable('notification_prefs', (t) => {
        t.string(col, 10).defaultTo(defaultVal);
      });
    }
  }

  // New notification type toggles
  const toggleCols = [
    ['review_request', true],
    ['referral_nudge', true],
    ['marketing_offers', true],
    ['weather_alerts', true],
    ['payment_receipt', true],
  ];

  for (const [col, defaultVal] of toggleCols) {
    const has = await knex.schema.hasColumn('notification_prefs', col);
    if (!has) {
      await knex.schema.alterTable('notification_prefs', (t) => {
        t.boolean(col).defaultTo(defaultVal);
      });
    }
  }

  // Quiet hours
  const quietCols = [
    ['quiet_hours_start', (t) => t.time('quiet_hours_start')],
    ['quiet_hours_end', (t) => t.time('quiet_hours_end')],
  ];

  for (const [col, builder] of quietCols) {
    const has = await knex.schema.hasColumn('notification_prefs', col);
    if (!has) {
      await knex.schema.alterTable('notification_prefs', builder);
    }
  }
};

exports.down = async function (knex) {
  const hasTable = await knex.schema.hasTable('notification_prefs');
  if (!hasTable) return;

  const colsToDrop = [
    'service_reminder_channel', 'en_route_channel', 'service_complete_channel',
    'billing_channel', 'seasonal_channel', 'review_request_channel', 'referral_channel',
    'marketing_channel', 'payment_receipt_channel', 'weather_alert_channel',
    'review_request', 'referral_nudge', 'marketing_offers', 'weather_alerts', 'payment_receipt',
    'quiet_hours_start', 'quiet_hours_end',
  ];

  for (const col of colsToDrop) {
    const has = await knex.schema.hasColumn('notification_prefs', col);
    if (has) {
      await knex.schema.alterTable('notification_prefs', (t) => t.dropColumn(col));
    }
  }
};
