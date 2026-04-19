/**
 * Migration 2026-04-18 #6 — Unified communications schema.
 *
 * Renames the misnamed `ai_conversations`/`ai_messages` (which are agent
 * execution-state tables, not customer threads) to `agent_sessions`/
 * `agent_messages`. Frees the `conversations`/`messages` namespace for
 * the real customer-comms unification.
 *
 * Adds:
 *  - conversations             — per (customer, channel, our_endpoint) thread
 *  - messages                  — every touchpoint (SMS/voice/email/voicemail/...)
 *  - blocked_numbers           — spam-block list with full block_type enum
 *  - blocked_call_attempts     — silent audit log of blocked inbound attempts
 *
 * PR 1 scope: schema + dual-write from webhooks + spam-block middleware.
 * No backfill, no read-path cutover. Existing sms_log / call_log / emails
 * keep being read by the inbox until PR 2 cuts over. See DECISIONS.md
 * 2026-04-18 entry.
 */

exports.up = async function (knex) {
  // ── Rename agent execution-state tables ────────────────────
  // ai_conversations is misnamed — it's session state for agent runs, not
  // a customer thread. Rename frees the `conversations` namespace for the
  // real customer-comms entity.
  await knex.schema.renameTable('ai_conversations', 'agent_sessions');
  await knex.schema.renameTable('ai_messages', 'agent_messages');

  // ── conversations ──────────────────────────────────────────
  // One row per (customer, channel, our_endpoint_id). Inbox UI groups by
  // (customer, channel) via a derived view (PR 2); reply-from routing
  // reads the raw rows so the correct Twilio number is used per thread.
  await knex.schema.createTable('conversations', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('customer_id').references('id').inTable('customers').onDelete('SET NULL');
    t.string('channel', 20).notNullable(); // voice, sms, email, newsletter, voicemail, system_note
    t.string('our_endpoint_id', 100); // E.164 Twilio number, email address, beehiiv list+campaign
    t.string('status', 20).defaultTo('open'); // open, closed, archived
    t.timestamp('last_message_at');
    t.timestamp('last_inbound_at');
    t.integer('message_count').defaultTo(0);

    // Unknown-contact case (inbound from non-customer)
    t.boolean('unknown_contact').defaultTo(false);
    t.string('contact_phone', 20);
    t.string('contact_email', 255);
    t.string('contact_label', 150); // best-effort name from Twilio Lookup, etc.

    t.jsonb('metadata').defaultTo('{}');
    t.timestamps(true, true);

    t.index(['customer_id', 'last_message_at']);
    t.index(['channel', 'last_message_at']);
    t.index('contact_phone');
    t.index('our_endpoint_id');
  });

  // Partial uniques: known customer threads dedupe on (customer, channel, endpoint);
  // unknown-contact threads dedupe on (contact, channel, endpoint).
  await knex.raw(`
    CREATE UNIQUE INDEX conversations_customer_dedup
      ON conversations (customer_id, channel, our_endpoint_id)
      WHERE customer_id IS NOT NULL
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX conversations_phone_dedup
      ON conversations (contact_phone, channel, our_endpoint_id)
      WHERE customer_id IS NULL AND contact_phone IS NOT NULL
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX conversations_email_dedup
      ON conversations (contact_email, channel, our_endpoint_id)
      WHERE customer_id IS NULL AND contact_email IS NOT NULL
  `);

  // ── messages ───────────────────────────────────────────────
  await knex.schema.createTable('messages', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('conversation_id').notNullable().references('id').inTable('conversations').onDelete('CASCADE');

    // Denormalized from conversation so the global inbox doesn't need a join.
    t.string('channel', 20).notNullable();

    t.string('direction', 12).notNullable(); // inbound, outbound, internal
    t.text('body'); // SMS body, email body, voice transcript, voicemail transcript
    t.string('subject', 500); // email + newsletter only

    // [{type:'recording', url, duration_seconds},
    //  {type:'attachment', url, filename, mime_type, size_bytes}]
    t.jsonb('media').defaultTo('[]');

    t.string('author_type', 12).notNullable(); // customer, admin, system, agent
    t.uuid('admin_user_id').references('id').inTable('technicians').onDelete('SET NULL');
    t.string('agent_name', 50); // lead_response, csr_coach, voice_screener, etc.

    // Authoring assistance — FKs added when those tables get uuid PKs.
    t.uuid('template_id');
    t.uuid('coach_session_id');

    // Twilio plumbing
    t.string('twilio_sid', 64); // SMS MessageSid OR voice CallSid
    t.string('recording_sid', 64);
    t.integer('duration_seconds');
    t.string('answered_by', 20); // voice only: human, voice_agent, voicemail, missed

    t.string('delivery_status', 20); // queued, sent, delivered, failed, read, opened, clicked

    t.jsonb('metadata').defaultTo('{}');
    t.timestamp('created_at').defaultTo(knex.fn.now()).notNullable();

    t.index(['conversation_id', 'created_at']);
    t.index('twilio_sid');
    t.index(['direction', 'channel', 'created_at']);
    t.index('admin_user_id');
  });

  // ── blocked_numbers ────────────────────────────────────────
  // Spam blocklist. UX (PR 4): "Block this number" dropdown in inbox.
  // PR 1 only fires on `hard_block`; the other enum values are defined
  // now so PR 4's dropdown and the later AI screener don't need a
  // schema change to introduce them.
  await knex.schema.createTable('blocked_numbers', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('number', 20).notNullable(); // E.164
    t.string('block_type', 20).notNullable(); // hard_block, silent_voicemail, ai_screen, sms_silent
    t.uuid('blocked_by').references('id').inTable('technicians').onDelete('SET NULL');
    t.timestamp('blocked_at').defaultTo(knex.fn.now());
    t.text('reason');
    t.boolean('auto_blocked').defaultTo(false); // true = pattern-detection, false = manual
    t.timestamps(true, true);

    t.unique('number');
    t.index('block_type');
  });
  await knex.raw(`
    ALTER TABLE blocked_numbers
      ADD CONSTRAINT blocked_numbers_block_type_check
      CHECK (block_type IN ('hard_block', 'silent_voicemail', 'ai_screen', 'sms_silent'))
  `);

  // ── blocked_call_attempts ──────────────────────────────────
  // Silent audit log. Never notifies, never creates a conversation row,
  // but captures every blocked attempt for the daily pattern-detection
  // digest ("this number tried us 47 times last month").
  await knex.schema.createTable('blocked_call_attempts', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('number', 20).notNullable(); // E.164
    t.string('our_endpoint_id', 100); // which of our 25 numbers they hit
    t.string('channel', 20).notNullable(); // voice, sms
    t.string('block_type', 20).notNullable();
    t.string('twilio_sid', 64); // present if Twilio gave a SID before hangup
    t.timestamp('created_at').defaultTo(knex.fn.now()).notNullable();

    t.index(['number', 'created_at']);
    t.index('created_at');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('blocked_call_attempts');
  await knex.schema.dropTableIfExists('blocked_numbers');
  await knex.schema.dropTableIfExists('messages');
  await knex.schema.dropTableIfExists('conversations');
  await knex.schema.renameTable('agent_messages', 'ai_messages');
  await knex.schema.renameTable('agent_sessions', 'ai_conversations');
};
