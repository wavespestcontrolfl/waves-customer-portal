/**
 * Lead call/text follow-ups (GATE_LEAD_CALL_TEXT_FOLLOWUP, owner 2026-10-24).
 *
 * One row per automated follow-up to a lead's CALL / TEXT answer:
 *   kind 'text_reply'   — the lead answered TEXT; we asked which service(s).
 *   kind 'call_request' — the lead answered CALL after hours; we asked what
 *                         time tomorrow works, and a clear answer books a
 *                         15-minute call slot.
 *
 * state: asked (our text is out, waiting on the lead) · scheduled (a call
 * slot is booked) · needs_owner (unclear answer, no slot free; a bell went
 * to the owner) · done · cancelled. send_outcome records our text: sent,
 * uncertain (kept: a doubled text is worse than a missed one) or not_sent.
 *
 * The partial unique indexes are the at-most-once guards: one open
 * follow-up per phone, and one booked call per slot.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('lead_callback_requests')) return;
  await knex.schema.createTable('lead_callback_requests', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    t.uuid('lead_id');
    t.string('phone', 20).notNullable();
    t.string('kind', 16).notNullable();
    t.string('state', 16).notNullable().defaultTo('asked');
    t.uuid('request_sms_log_id');
    t.string('send_outcome', 16);
    t.uuid('answer_sms_log_id');
    t.text('answer_text');
    // The ET calendar day the call is for, and the booked slot start.
    t.date('target_date');
    t.timestamp('scheduled_for', { useTz: true });
    t.timestamps(true, true);
  });
  await knex.raw(`
    ALTER TABLE lead_callback_requests
      ADD CONSTRAINT lead_callback_requests_kind_check CHECK (kind IN ('text_reply', 'call_request')),
      ADD CONSTRAINT lead_callback_requests_state_check CHECK (state IN ('asked', 'scheduled', 'needs_owner', 'done', 'cancelled')),
      ADD CONSTRAINT lead_callback_requests_send_outcome_check CHECK (send_outcome IS NULL OR send_outcome IN ('sent', 'uncertain', 'not_sent')),
      ADD CONSTRAINT lead_callback_requests_slot_check CHECK (state <> 'scheduled' OR scheduled_for IS NOT NULL)
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX lead_callback_requests_open_phone_uniq
      ON lead_callback_requests (phone)
      WHERE state IN ('asked', 'scheduled')
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX lead_callback_requests_slot_uniq
      ON lead_callback_requests (scheduled_for)
      WHERE state = 'scheduled'
  `);
  await knex.raw('CREATE INDEX lead_callback_requests_phone_created_idx ON lead_callback_requests (phone, created_at)');
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('lead_callback_requests'))) return;
  const used = await knex('lead_callback_requests').first('id');
  if (used) throw new Error('lead_callback_requests has rows; turn GATE_LEAD_CALL_TEXT_FOLLOWUP off instead of dropping them');
  await knex.schema.dropTable('lead_callback_requests');
};
