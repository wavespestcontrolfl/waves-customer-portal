/**
 * Migration — explicit-choice marker for the 72h reminder delivery channel
 *
 * GATE_REMINDER_72H_EMAIL_FIRST (PR #3588) promotes a one-time visit's
 * DEFAULT 'sms' 72h-reminder channel to email. But 20260622000011 added
 * service_reminder_72h_channel with defaultTo('sms'), which backfilled every
 * existing row — a stored 'sms' cannot be told apart from a customer who
 * deliberately picked Text in the portal's delivery-method control (Codex
 * #3588 P1). This boolean records explicitness going FORWARD: the
 * notifications route stamps it true on any customer write of
 * serviceReminder72hChannel, and the reminder cron's email-first promotion
 * skips rows where it is true.
 *
 * Default false is the historical truth (no existing row is a provable
 * explicit choice — the portal select only fires onChange, so re-picking the
 * shown default never wrote at all), not a behavior toggle.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('notification_prefs'))) return;
  if (await knex.schema.hasColumn('notification_prefs', 'service_reminder_72h_channel_explicit')) return;
  await knex.schema.alterTable('notification_prefs', (t) => {
    t.boolean('service_reminder_72h_channel_explicit').defaultTo(false);
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('notification_prefs'))) return;
  if (!(await knex.schema.hasColumn('notification_prefs', 'service_reminder_72h_channel_explicit'))) return;
  await knex.schema.alterTable('notification_prefs', (t) => {
    t.dropColumn('service_reminder_72h_channel_explicit');
  });
};
