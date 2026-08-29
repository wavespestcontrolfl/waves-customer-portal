// "Email from a customer" bell: the first Gmail full sync is mailbox HISTORY
// and must never notify, while a later full sync (expired history cursor)
// carries genuinely new mail. last_sync_at is written on failed/incomplete
// runs too, so it cannot tell the two apart — this column is set exactly
// once, when a full sync COMPLETES. Existing installs that hold a cursor
// have completed one: backfilled so they are never mistaken for a first connect.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_sync_state'))) return;
  if (await knex.schema.hasColumn('email_sync_state', 'initial_sync_completed_at')) return;
  await knex.schema.alterTable('email_sync_state', (table) => {
    table.timestamp('initial_sync_completed_at', { useTz: true }).nullable();
    // Boundary of the FIRST scan, stamped once before the remote listing
    // begins and reused by every retry: mail received before it is history.
    table.timestamp('initial_scan_started_at', { useTz: true }).nullable();
  });
  // Proof of completion: a cursor, OR a completed run whose cursor was
  // cleared by Gmail's history-expiry (errors = 'History expired…'), OR a
  // mailbox the portal already holds mail for. The third covers the
  // established mailbox whose history-expiry recovery FAILED before this
  // migration ran — that path overwrites `errors` and leaves the cursor
  // null, so the first two predicates alone would read it as a first
  // connect and silence every bell for mail before the new scan boundary
  // (codex r5). The asymmetry is deliberate: mis-reading a still-failing
  // FIRST connect as established costs at most the 24h age guard's worth of
  // bells (bounded noise); the reverse permanently loses customer alerts.
  const [{ count }] = await knex('emails').count('* as count');
  const hasMail = Number(count) > 0;
  await knex('email_sync_state')
    .whereNotNull('last_sync_at')
    .where(function completed() {
      this.whereNotNull('last_history_id')
        .orWhere(function expired() { this.whereNull('last_history_id').where('errors', 'like', 'History expired%'); });
      if (hasMail) this.orWhereRaw('true');
    })
    .update({ initial_sync_completed_at: knex.raw('last_sync_at') });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('email_sync_state'))) return;
  if (!(await knex.schema.hasColumn('email_sync_state', 'initial_sync_completed_at'))) return;
  await knex.schema.alterTable('email_sync_state', (table) => {
    table.dropColumn('initial_sync_completed_at');
    table.dropColumn('initial_scan_started_at');
  });
};
