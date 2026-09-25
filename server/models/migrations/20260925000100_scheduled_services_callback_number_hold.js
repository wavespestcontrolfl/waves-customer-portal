/**
 * scheduled_services.callback_number_hold_at — the durable record that this
 * visit's confirmation SMS was held because the caller disclaimed the
 * inbound ANI as not their own with no spoken callback to use instead
 * (callback_number_needed; call-triage-flags.js's
 * callerIdDisclaimedNeedsCallback). Written by call-recording-processor at
 * the same decision point that would otherwise leave the confirmation SMS
 * the only artifact of the hold; read by the appointment-reminders 72h/24h
 * cron so a reminder pass — which runs independently of the call pipeline
 * and has no notion of a call-level hold — never texts the disclaimed ANI
 * days later (P1-C, 2026-09-25).
 *
 * Lifted by the SAME durable clearance signal the card-request backstop
 * already honors: scheduled_services.call_sms_cleared_at
 * (20260806000010_call_sms_clearance.js). A hold is active while
 * callback_number_hold_at IS NOT NULL AND call_sms_cleared_at IS NULL —
 * once anything stamps call_sms_cleared_at for this visit (the booking-time
 * confirm-leg clearance, or a later office-confirm hook), the reminder cron
 * treats the hold as resolved.
 *
 * NULL = never held (not call-created, or the confirmation SMS was never
 * blocked by this specific flag). Additive and idempotent both ways.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('scheduled_services'))) return;
  if (await knex.schema.hasColumn('scheduled_services', 'callback_number_hold_at')) return;
  await knex.schema.alterTable('scheduled_services', (t) => {
    t.timestamp('callback_number_hold_at', { useTz: true }).nullable();
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('scheduled_services'))) return;
  if (!(await knex.schema.hasColumn('scheduled_services', 'callback_number_hold_at'))) return;
  await knex.schema.alterTable('scheduled_services', (t) => {
    t.dropColumn('callback_number_hold_at');
  });
};
