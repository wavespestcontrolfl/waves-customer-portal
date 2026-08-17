/**
 * contact_correction_jobs — durable work queue for SMS contact
 * corrections (codex #3413 r17).
 *
 * Two failure modes the in-memory slot machinery could not cover:
 *  1. Overlapping deploy instances: the per-sender run chain was
 *     process-local, so two rapid corrections routed to different
 *     instances could snapshot the same original fields and commit in
 *     the wrong order (the CAS then rejects the customer's NEWER
 *     message). The queue is the cross-instance fence: workers claim
 *     jobs in insertion (arrival) order per sender.
 *  2. Deploy/exit after the webhook ack: the detached LLM run died
 *     with the process while the MessageSid claim stayed durable, so
 *     Twilio's retry was ignored and the correction was lost. A row is
 *     persisted BEFORE the ack; a retryable worker claims it.
 *
 * Lifecycle: reserved (webhook entry, arrival-order marker) → queued
 * (branch decided to run; payload attached) → running → done/failed,
 * or → cancelled (route released an un-run reservation). Rows left
 * 'reserved' by a dead instance are promoted or cancelled by the
 * worker's stale sweep.
 *
 * Reversible — down() drops the table; the webhook falls back to
 * skipping corrections (never blocks inbound SMS).
 */

exports.up = async function up(knex) {
  await knex.schema.createTable('contact_correction_jobs', (t) => {
    // bigserial — insertion order IS the per-sender ordering fence.
    t.bigIncrements('id').primary();

    // tail-10 digits of the sender phone: the ordering key (same identity
    // the runner's batch binding uses).
    t.string('sender_key', 20).notNullable();
    // Verbatim From — the runner's senderPhone batch-binding input.
    t.string('sender_phone', 30);
    t.string('message_sid', 64);
    t.text('body');

    // Attached when the route decides to run (enqueue).
    t.uuid('customer_id').nullable();
    t.uuid('sms_log_id').nullable();
    // CAS baseline captured at webhook match time (round-15 semantics);
    // null → the runner falls back to a run-start read.
    t.jsonb('expected_values');

    t.string('status', 30).notNullable().defaultTo('reserved');
    t.string('cancel_reason', 60);
    t.integer('attempts').notNullable().defaultTo(0);
    t.integer('max_attempts').notNullable().defaultTo(3);
    t.timestamp('next_attempt_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('locked_at');
    t.string('locked_by', 120);
    t.text('last_error');
    t.jsonb('result');
    t.timestamp('completed_at');
    t.timestamps(true, true);

    t.index(['status', 'next_attempt_at']);
    t.index(['sender_key', 'status']);
    t.index(['customer_id', 'status']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('contact_correction_jobs');
};
