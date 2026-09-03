/**
 * call_commitments — one row per promise detected on a processed call.
 *
 * Before this table, "what did we promise the caller" lived in four places
 * that did not know about each other: the V2 extraction's quote_promised
 * flag (read by promised-estimate-watcher), the CSR coach's
 * ai_follow_up_tasks, the disposition label callback_task_created (which
 * nothing read), and the relay's crash-recovery markers. None of them
 * represented what the CUSTOMER agreed to do, none carried transcript
 * evidence the office could check, and a reprocess could not tell a human
 * edit from a stale AI output.
 *
 * Invariants the schema itself enforces:
 *   - one row per (call, commitment identity): the extractor's dedupe key,
 *     so a reprocess upserts instead of duplicating;
 *   - party / kind / status / source / human_state are CHECK-constrained —
 *     a writer with a typo fails here instead of shipping an unrenderable row;
 *   - a human-touched row is marked (human_state, reviewed_by/at) so the
 *     AI upsert can refuse to overwrite it (the refusal lives in
 *     services/call-commitments.js; the columns are the contract);
 *   - cascade on call_log delete (the spam disposition deletes the row).
 *
 * Reversible: down drops the table. No backfill — commitments appear as
 * calls are processed with the gate on; a force reprocess back-fills a call.
 */

const KINDS = [
  // Waves promised to…
  'send_estimate', 'send_appointment_confirmation', 'callback', 'send_report',
  'send_paperwork', 'technician_follow_up', 'schedule_visit',
  // The customer agreed to…
  'send_photos', 'confirm_date', 'call_back', 'provide_info', 'make_payment',
  'other',
];

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('call_commitments')) return;
  await knex.schema.createTable('call_commitments', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('call_log_id').notNullable().references('id').inTable('call_log').onDelete('CASCADE');
    // Stable identity across passes: party:kind for the enumerated kinds,
    // party:other:<slug> for free-form ones (services/call-commitments.js).
    t.string('commitment_key', 160).notNullable();
    t.string('party', 16).notNullable();
    t.string('kind', 40).notNullable();
    t.text('description').notNullable();
    // sms | email | call | in_person | unknown — free text on purpose; the
    // channel is descriptive, not routed on.
    t.string('channel', 24);
    t.timestamp('due_at', { useTz: true });
    // stated = the caller/agent named a time; suggested = derived default.
    t.string('due_basis', 16);
    t.decimal('confidence', 4, 3);
    // [{ quote, speaker, segment_index, start_ms, end_ms, char_offset, matched }]
    t.jsonb('evidence').notNullable().defaultTo('[]');
    t.string('source', 8).notNullable().defaultTo('ai');
    t.integer('processing_generation');
    t.integer('last_seen_generation');
    t.string('extractor_version', 40);
    // The audio the AI row was written from. A reprocess from a different
    // recording (webhook replace, adopted parked audio) resets the AI
    // fulfillment of rows this SID does not match before reusing their keys.
    t.string('recording_sid', 64);
    t.string('status', 16).notNullable().defaultTo('open');
    // { kind, record_type, record_id, basis, matched_at, note }
    t.jsonb('fulfillment');
    t.timestamp('fulfilled_at', { useTz: true });
    // confirmed | dismissed | edited — NULL means untouched by a human.
    t.string('human_state', 16);
    t.text('human_note');
    t.string('reviewed_by', 80);
    t.timestamp('reviewed_at', { useTz: true });
    t.timestamps(true, true);

    t.unique(['call_log_id', 'commitment_key']);
    t.index(['call_log_id']);
  });
  await knex.raw(`
    ALTER TABLE call_commitments
      ADD CONSTRAINT call_commitments_party_check CHECK (party IN ('waves', 'customer')),
      ADD CONSTRAINT call_commitments_kind_check CHECK (kind IN (${KINDS.map((k) => `'${k}'`).join(', ')})),
      ADD CONSTRAINT call_commitments_status_check CHECK (status IN ('open', 'fulfilled', 'dismissed')),
      ADD CONSTRAINT call_commitments_source_check CHECK (source IN ('ai', 'human')),
      ADD CONSTRAINT call_commitments_human_state_check CHECK (human_state IS NULL OR human_state IN ('confirmed', 'dismissed', 'edited')),
      ADD CONSTRAINT call_commitments_due_basis_check CHECK (due_basis IS NULL OR due_basis IN ('stated', 'suggested'))
  `);
  // The open-obligations queue: what is still owed, oldest due first.
  await knex.raw(`
    CREATE INDEX call_commitments_open_due_idx
      ON call_commitments (due_at, created_at)
      WHERE status = 'open'
  `);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('call_commitments'))) return;
  await knex.schema.dropTable('call_commitments');
};

exports.COMMITMENT_KINDS = KINDS;
