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
  });
  // Proof of completion is a cursor: failed/incomplete runs stamp
  // last_sync_at but never last_history_id (codex P1).
  await knex('email_sync_state').whereNotNull('last_history_id').whereNotNull('last_sync_at').update({ initial_sync_completed_at: knex.raw('last_sync_at') });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('email_sync_state'))) return;
  if (!(await knex.schema.hasColumn('email_sync_state', 'initial_sync_completed_at'))) return;
  await knex.schema.alterTable('email_sync_state', (table) => {
    table.dropColumn('initial_sync_completed_at');
  });
};
