// Every sweep over outbox_messages (the send queue in
// reschedule-link-promises.sweep, and its used-link reconciliation pass)
// ordered its LIMIT-100 slice by updated_at alone. A row a sweep examines but
// leaves unchanged never advances updated_at — a review row parked for the
// SAME reason on every pass (parkReview's own guard skips the write when
// nothing changed), or a promise with no matching evidence yet — so a
// backlog of exactly those rows sorts to the front forever and starves every
// newer row behind it once 100 accumulate (codex #4293 P1, two sites).
//
// last_scanned_at decouples "was examined this tick" from "changed this
// tick": every sweep stamps it on every row it looks at, regardless of
// outcome, and ordering by (last_scanned_at NULLS FIRST, updated_at) means a
// row that was scanned moves to the back of the line even when nothing about
// it changed — the same guarantee updated_at was supposed to give, restored.
exports.up = async function up(knex) {
  const has = await knex.schema.hasColumn('outbox_messages', 'last_scanned_at');
  if (!has) {
    await knex.schema.alterTable('outbox_messages', (t) => {
      t.timestamp('last_scanned_at', { useTz: true }).nullable();
    });
  }
  await knex.raw('CREATE INDEX IF NOT EXISTS outbox_messages_last_scanned_at_index ON outbox_messages (last_scanned_at)');
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS outbox_messages_last_scanned_at_index');
  const has = await knex.schema.hasColumn('outbox_messages', 'last_scanned_at');
  if (has) await knex.schema.alterTable('outbox_messages', (t) => { t.dropColumn('last_scanned_at'); });
};
