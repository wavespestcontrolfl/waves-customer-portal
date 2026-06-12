/**
 * sms_intent_modes — per-intent graduation state for the SMS brand-voice
 * loop (Phase D, suggest mode).
 *
 * Each triage intent class is independently promoted along the ladder
 * shadow → suggest (→ auto-send, Phase E). 'suggest' surfaces the house-voice
 * draft as an Agent Review card in the comms composer — a human still reads,
 * optionally edits, and presses Send. 'shadow' keeps Phase B/C behavior
 * (silent draft, nightly judge).
 *
 * Hard rules enforced in code, not rows: the escalation class
 * (customer_issue_needs_review) and scheduling_intent=true drafts never
 * become suggestions regardless of mode.
 *
 * Also adds 'suggested' to the message_drafts status enum: a draft that was
 * published as a composer suggestion. Suggested rows are excluded from the
 * nightly judge (it queries status='shadow' only) — if the human sends the
 * suggestion, the outbound IS the draft text, and judging a draft against
 * itself would inflate scores. Suggest-mode telemetry comes from
 * agent_decisions (accepted / corrected / ignored / expired) instead.
 */

const SEED_INTENTS = [
  'GENERAL',
  'needs_customer_lookup',
  'no_reply_needed',
  'billing_question_needs_review',
  'customer_issue_needs_review',
  'photo_or_attachment_needs_review',
  'customer_nudge_needs_reply',
  'general_customer_sms_needs_review',
];

exports.up = async function (knex) {
  const exists = await knex.schema.hasTable('sms_intent_modes');
  if (!exists) {
    await knex.schema.createTable('sms_intent_modes', (t) => {
      t.string('intent', 50).primary();
      t.string('mode', 20).notNullable().defaultTo('shadow');
      t.string('updated_by', 100);
      t.text('reason');
      t.timestamps(true, true);
    });

    await knex('sms_intent_modes').insert(
      SEED_INTENTS.map((intent) => ({ intent, mode: 'shadow', updated_by: 'migration' }))
    );
  }

  await knex.raw('ALTER TABLE message_drafts DROP CONSTRAINT IF EXISTS message_drafts_status_check');
  await knex.raw(
    `ALTER TABLE message_drafts ADD CONSTRAINT message_drafts_status_check CHECK (status IN ('pending','approved','revised','rejected','sent','shadow','suggested'))`
  );

  await knex.raw(
    `CREATE INDEX IF NOT EXISTS message_drafts_suggested_created_idx ON message_drafts (created_at) WHERE status = 'suggested'`
  );
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS message_drafts_suggested_created_idx');

  // Suggested rows would violate the restored constraint — park them as
  // rejected (mirrors the Phase B down for shadow rows).
  await knex('message_drafts').where({ status: 'suggested' }).update({ status: 'rejected' });
  await knex.raw('ALTER TABLE message_drafts DROP CONSTRAINT IF EXISTS message_drafts_status_check');
  await knex.raw(
    `ALTER TABLE message_drafts ADD CONSTRAINT message_drafts_status_check CHECK (status IN ('pending','approved','revised','rejected','sent','shadow'))`
  );

  await knex.schema.dropTableIfExists('sms_intent_modes');
};
