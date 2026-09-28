// Two #5081 follow-ups (owner go 2026-09-28).
//
// due_local: the promise's stated time as the commitments model SPOKE it —
// the ET wall clock 'YYYY-MM-DDTHH:MM' — beside due_at, the instant. When
// the model writes a seasonally wrong ET offset ("15:00-05:00" in July)
// due_at lands an hour off the spoken time; the slot-booking proof reads
// due_local so it compares wall clocks with the call's confirmed slot (the
// booking path's rule). Readers use it only while it still agrees with
// due_at (same instant or the one-hour season slip), so any writer that
// edits due_at without it leaves a stale value ignored, never trusted.
//
// call_commitments_slot_kept_idx: the slot-proof lapse sweep runs every
// 15 minutes over promises kept by a booking for their promised slot —
// partial on exactly that predicate so it never scans the ledger.
// Plain index, not CONCURRENTLY: migrations run inside a transaction
// pre-deploy (same as call_log_callback_linkage_indexes).
exports.up = async function up(knex) {
  const has = await knex.schema.hasTable('call_commitments');
  if (!has) return;
  const hasCol = await knex.schema.hasColumn('call_commitments', 'due_local');
  if (!hasCol) {
    await knex.schema.alterTable('call_commitments', (t) => { t.string('due_local', 16).nullable(); });
    await knex.raw("ALTER TABLE call_commitments ADD CONSTRAINT call_commitments_due_local_format CHECK (due_local IS NULL OR due_local ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$')");
  }
  await knex.raw(
    "CREATE INDEX IF NOT EXISTS call_commitments_slot_kept_idx ON call_commitments (call_log_id) WHERE status = 'fulfilled' AND human_state IS NULL AND (fulfillment ->> 'basis') = 'visit_booked_at_the_promised_time'",
  );
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasTable('call_commitments');
  if (!has) return;
  await knex.raw('DROP INDEX IF EXISTS call_commitments_slot_kept_idx');
  await knex.raw('ALTER TABLE call_commitments DROP CONSTRAINT IF EXISTS call_commitments_due_local_format');
  if (await knex.schema.hasColumn('call_commitments', 'due_local')) {
    await knex.schema.alterTable('call_commitments', (t) => { t.dropColumn('due_local'); });
  }
};
