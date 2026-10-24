/**
 * Migration — every notification_prefs row that exists at this cutover counts
 * as an explicit confirmation-channel choice (Codex #6593 security P2)
 *
 * 20261024210000 added appointment_confirmation_channel_explicit with default
 * false, so every existing row read as "never chosen". But the portal let a
 * customer set Appointment updates back to Text long before the stamp existed,
 * and a stored 'sms' cannot be told apart from the default. Any row written
 * before the stamp may hold a deliberate Text choice, and
 * GATE_NEW_CLIENT_CONFIRM_EMAIL must never email a customer who picked Text.
 * So every row that exists now is marked true, and false is left only for rows
 * created after this cutover: a new customer's row is created with the default
 * (at customer creation), and the notifications route stamps true on any
 * customer write of the channel.
 *
 * Production 2026-10-24 (read-only): 1,589 rows, one per customer; 1,584 hold
 * 'sms' or NULL. So the new-client promotion reaches only customers created
 * after this migration runs.
 *
 * down() is a documented no-op: a backfilled true cannot be told apart from a
 * customer's later stamp, so a revert would erase real choices. The column
 * itself goes with 20261024210000's down().
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('notification_prefs'))) return;
  if (!(await knex.schema.hasColumn('notification_prefs', 'appointment_confirmation_channel_explicit'))) return;
  await knex('notification_prefs').update({ appointment_confirmation_channel_explicit: true });
};

exports.down = async function down() {
  // Documented no-op (see the header): the backfill is indistinguishable from later customer stamps.
};
