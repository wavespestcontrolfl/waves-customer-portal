/**
 * Durable pre-provider marker for call-booking-link-text.js's own locked
 * handoff (codex #5018 r13 P1) — replaces the call_log.metadata.
 * handoff_started_at stamp that lane wrote before this migration.
 *
 * neverSendRecheck now ALSO locks the call_log row FOR UPDATE (through
 * messages.create()), closing a race where a forced reprocess could claim
 * processing_token and rewrite the extraction/lead linkage mid-handoff. A
 * marker written to call_log itself, from markerDb()'s own separate
 * connection, would deadlock against that same row lock: the row lock
 * only releases when the handoff transaction commits, and the handoff
 * transaction cannot commit until the marker write (which it awaits)
 * finishes — a hard self-deadlock, not a timing artifact.
 *
 * This table never touches call_log at all, so it never contends with
 * that row lock: `INSERT ... ON CONFLICT (call_log_id) DO NOTHING`, via
 * markerDb(), commits independently and immediately, surviving a rollback
 * of the handoff transaction the same way the old call_log stamp did
 * (codex r11's original guarantee) — now compatible with r13's row lock.
 *
 * call_log_id carries NO foreign key (matches missed_call_text_claims'
 * own call_log_id column) — a plain marker, never a referential
 * constraint on a row that call_log writers touch constantly.
 *
 * Housekeeping: the live sweep deletes rows older than 7 days (any row
 * that old has long since resolved through recoverAbandonedClaim /
 * recoverStaleClaims — see call-booking-link-text.js's own bounds).
 */

exports.up = async function (knex) {
  if (await knex.schema.hasTable('call_booking_link_text_handoffs')) return;
  await knex.schema.createTable('call_booking_link_text_handoffs', (t) => {
    t.uuid('call_log_id').primary();
    t.timestamp('handoff_started_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('call_booking_link_text_handoffs');
};
