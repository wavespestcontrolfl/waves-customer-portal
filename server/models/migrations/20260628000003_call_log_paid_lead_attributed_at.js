/**
 * DNI Phase B2 — add call_log.paid_lead_attributed_at.
 *
 * The paid ad-call lead attribution in twilio-voice-webhook.js fires from
 * /call-complete, which Twilio can redeliver and which has no dedupe of its
 * own. To attribute a connected paid call to a lead EXACTLY ONCE, the handler
 * atomically claims the call_log row:
 *
 *   UPDATE call_log SET paid_lead_attributed_at = now()
 *    WHERE twilio_call_sid = ? AND paid_lead_attributed_at IS NULL
 *
 * and only creates/touches the lead when that update affected 1 row. This
 * nullable timestamp is the claim marker — written ONLY by that path.
 *
 * Idempotent + guarded: no-op if the table or column already exists.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('call_log'))) return;
  if (await knex.schema.hasColumn('call_log', 'paid_lead_attributed_at')) return;
  await knex.schema.alterTable('call_log', (t) => {
    t.timestamp('paid_lead_attributed_at', { useTz: true });
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('call_log'))) return;
  if (!(await knex.schema.hasColumn('call_log', 'paid_lead_attributed_at'))) return;
  await knex.schema.alterTable('call_log', (t) => {
    t.dropColumn('paid_lead_attributed_at');
  });
};
