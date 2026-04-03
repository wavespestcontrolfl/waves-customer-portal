/**
 * Migration 039 — Call Logging + Waves AI Assistant
 *
 * Tables:
 *  - call_log             (every inbound/outbound voice call)
 *  - ai_conversations     (active AI conversation sessions, channel-agnostic)
 *  - ai_messages          (individual messages within a conversation)
 *  - ai_escalations       (items escalated to human for review)
 */

exports.up = async function (knex) {

  // ── Call Log ────────────────────────────────────────────────
  await knex.schema.createTable('call_log', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('customer_id').references('id').inTable('customers').onDelete('SET NULL');
    t.string('direction'); // inbound, outbound
    t.string('from_phone', 20);
    t.string('to_phone', 20);
    t.string('twilio_call_sid', 64);
    t.string('status'); // ringing, in-progress, completed, busy, no-answer, failed, canceled
    t.integer('duration_seconds');
    t.string('answered_by'); // human, voicemail, unknown
    t.string('recording_url', 500);
    t.string('recording_sid', 64);
    t.integer('recording_duration_seconds');
    t.text('transcription'); // auto-transcribed text
    t.string('transcription_status'); // pending, completed, failed
    t.string('call_outcome'); // booked, estimate_sent, callback_scheduled, info_given, voicemail, missed, spam
    t.string('handled_by'); // tech name or 'ai_assistant'
    t.text('notes');
    t.jsonb('metadata');
    t.timestamps(true, true);

    t.index('customer_id');
    t.index('twilio_call_sid');
    t.index('created_at');
  });

  // ── AI Conversations ───────────────────────────��────────────
  await knex.schema.createTable('ai_conversations', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('customer_id').references('id').inTable('customers').onDelete('SET NULL');
    t.string('channel'); // sms, portal_chat, whatsapp, email
    t.string('channel_identifier'); // phone number for sms, session id for portal
    t.string('status').defaultTo('active'); // active, timeout, escalated, resolved
    t.timestamp('last_activity_at');
    t.timestamp('timeout_at'); // auto-set to last_activity + 30 min
    t.integer('message_count').defaultTo(0);
    t.boolean('escalated').defaultTo(false);
    t.string('escalation_reason');
    t.string('resolved_by'); // ai, human, timeout
    t.text('conversation_summary'); // AI-generated summary on close
    t.jsonb('context_snapshot'); // customer context at conversation start
    t.timestamps(true, true);

    t.index('customer_id');
    t.index('channel_identifier');
    t.index('status');
  });

  // ── AI Messages ─────────────────────────────────────────────
  await knex.schema.createTable('ai_messages', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('conversation_id').references('id').inTable('ai_conversations').onDelete('CASCADE');
    t.string('role'); // user, assistant, system, tool_use, tool_result
    t.text('content');
    t.string('channel'); // sms, portal_chat
    t.jsonb('tool_calls'); // if assistant used tools
    t.jsonb('tool_results'); // results from tool calls
    t.boolean('sent_to_customer').defaultTo(false); // was this reply actually sent?
    t.boolean('requires_approval').defaultTo(false); // needs human approval before sending
    t.string('approved_by');
    t.timestamps(true, true);

    t.index('conversation_id');
  });

  // ── AI Escalations ──────────────────────────────────────────
  await knex.schema.createTable('ai_escalations', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('conversation_id').references('id').inTable('ai_conversations').onDelete('CASCADE');
    t.uuid('customer_id').references('id').inTable('customers').onDelete('SET NULL');
    t.string('reason'); // schedule_change, cancellation, complaint, billing_dispute, complex_question, ai_uncertain
    t.text('summary'); // AI's summary of why it's escalating
    t.text('customer_message'); // the message that triggered escalation
    t.text('ai_draft_response'); // what the AI would have said
    t.string('priority'); // urgent, normal, low
    t.string('status').defaultTo('pending'); // pending, claimed, resolved, dismissed
    t.string('claimed_by'); // admin who took it
    t.text('resolution_notes');
    t.timestamps(true, true);

    t.index('status');
    t.index('priority');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('ai_escalations');
  await knex.schema.dropTableIfExists('ai_messages');
  await knex.schema.dropTableIfExists('ai_conversations');
  await knex.schema.dropTableIfExists('call_log');
};
