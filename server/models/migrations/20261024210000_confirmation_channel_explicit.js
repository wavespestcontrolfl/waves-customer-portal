/**
 * Migration — explicit-choice marker for the booking confirmation channel
 *
 * GATE_NEW_CLIENT_CONFIRM_EMAIL (owner 2026-10-24) promotes a NEW client's
 * DEFAULT 'sms' booking-confirmation channel to 'both' (text + email). But the
 * appointment_confirmation_channel column was added with defaultTo('sms'),
 * which backfilled every existing row — a stored 'sms' cannot be told apart
 * from a customer who deliberately picked Text in the portal's
 * delivery-method control. This boolean records explicitness going FORWARD:
 * the notifications route stamps it true on any customer write of
 * appointmentConfirmationChannel, and the confirmation promotion skips rows
 * where it is true. Same shape as 20260829000001_reminder_72h_channel_explicit
 * (Codex #3588 P1).
 *
 * Default false is the historical truth (no existing row is a provable
 * explicit choice), not a behavior toggle. Additive and idempotent.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('notification_prefs'))) return;
  if (await knex.schema.hasColumn('notification_prefs', 'appointment_confirmation_channel_explicit')) return;
  await knex.schema.alterTable('notification_prefs', (t) => {
    t.boolean('appointment_confirmation_channel_explicit').defaultTo(false);
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('notification_prefs'))) return;
  if (!(await knex.schema.hasColumn('notification_prefs', 'appointment_confirmation_channel_explicit'))) return;
  await knex.schema.alterTable('notification_prefs', (t) => {
    t.dropColumn('appointment_confirmation_channel_explicit');
  });
};
