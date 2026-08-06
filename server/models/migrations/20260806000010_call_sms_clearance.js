/**
 * scheduled_services.call_sms_cleared_at — the durable record that a
 * call-created booking's CALL-LEVEL SMS clearance was affirmed (the
 * processor's v2/implied-consent gates passed for this visit's call).
 * Written by call-recording-processor at the same decision point that
 * releases the card/confirmation SMS legs; read by the pre-visit card
 * invitation backstop so it can honor call-level TCPA holds days later
 * (codex #3234 r2/r3 — no prior artifact recorded the decision:
 * appointment_reminders rows register regardless of the hold, and
 * confirmation_sent_at stamps even on skipped sends).
 *
 * NULL = never cleared (held, pre-feature history, or not call-created).
 * Additive and idempotent both ways.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('scheduled_services'))) return;
  if (await knex.schema.hasColumn('scheduled_services', 'call_sms_cleared_at')) return;
  await knex.schema.alterTable('scheduled_services', (t) => {
    t.timestamp('call_sms_cleared_at', { useTz: true }).nullable();
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('scheduled_services'))) return;
  if (!(await knex.schema.hasColumn('scheduled_services', 'call_sms_cleared_at'))) return;
  await knex.schema.alterTable('scheduled_services', (t) => {
    t.dropColumn('call_sms_cleared_at');
  });
};
