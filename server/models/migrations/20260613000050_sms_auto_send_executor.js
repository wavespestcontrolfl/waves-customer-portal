/**
 * SMS Auto-Send Executor (brand-voice loop, Phase E) — message_drafts status.
 *
 * Adds 'auto_sent' to the status enum: a verified house-voice draft for an
 * intent flipped to 'auto_send' (sms_intent_modes) whose reply was sent to the
 * customer automatically by the executor. Like 'suggested', an 'auto_sent'
 * draft is structurally out of the nightly judge (it queries status='shadow')
 * — the outbound IS the draft text, so judging it against itself would be
 * meaningless. The draft is only flipped to 'auto_sent' AFTER the provider
 * confirms the send; a draft whose send is blocked/fails stays 'shadow' and
 * the judge still covers it.
 *
 * agent_decisions.status carries the executor's claim lifecycle
 * ('sending' → 'auto_sent' / 'auto_send_failed') but that column has no CHECK
 * constraint (free VARCHAR(30)), so no schema change is needed there.
 */

exports.up = async function up(knex) {
  await knex.raw('ALTER TABLE message_drafts DROP CONSTRAINT IF EXISTS message_drafts_status_check');
  await knex.raw(
    `ALTER TABLE message_drafts ADD CONSTRAINT message_drafts_status_check CHECK (status IN ('pending','approved','revised','rejected','sent','shadow','suggested','auto_sent'))`
  );
  await knex.raw(
    `CREATE INDEX IF NOT EXISTS message_drafts_auto_sent_created_idx ON message_drafts (created_at) WHERE status = 'auto_sent'`
  );
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS message_drafts_auto_sent_created_idx');
  // Auto-sent rows would violate the restored constraint. They were really
  // sent to customers — park them as 'sent' (the legacy terminal value),
  // never delete the record of an outbound.
  await knex('message_drafts').where({ status: 'auto_sent' }).update({ status: 'sent' });
  await knex.raw('ALTER TABLE message_drafts DROP CONSTRAINT IF EXISTS message_drafts_status_check');
  await knex.raw(
    `ALTER TABLE message_drafts ADD CONSTRAINT message_drafts_status_check CHECK (status IN ('pending','approved','revised','rejected','sent','shadow','suggested'))`
  );
};
