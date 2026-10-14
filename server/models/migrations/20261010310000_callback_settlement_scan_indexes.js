// Two scans the commitments watchdog runs every tick under
// GATE_CALLBACK_SPAM_CLOSES_PARENT read through these (codex #6271 r22):
// the reconcile scan joins sweep-closed cards to every office callback
// linked to the parent (any status, so the spam-only index of 20261010270000
// does not serve it), and the lapse scan starts from outbound calls changed
// recently (a reprocess rewrites updated_at). Same shape as 20261010280000.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('call_log'))) return;
  await knex.raw(
    "CREATE INDEX IF NOT EXISTS call_log_admin_callback_related_call_id_index ON call_log ((metadata->>'relatedCallId')) WHERE source = 'admin-callback'",
  );
  await knex.raw(
    "CREATE INDEX IF NOT EXISTS call_log_outbound_updated_at_index ON call_log (updated_at) WHERE direction LIKE 'outbound%'",
  );
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS call_log_admin_callback_related_call_id_index');
  await knex.raw('DROP INDEX IF EXISTS call_log_outbound_updated_at_index');
};
