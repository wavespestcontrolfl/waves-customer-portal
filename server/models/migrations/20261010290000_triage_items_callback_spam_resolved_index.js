// The commitments watchdog's reconcile scan (call-recording-processor
// reconcileCorrectedCallbackVerdicts) also starts from the cards the nightly
// triage sweep closed on callback-spam evidence, which carry no parent stamp
// (codex #6271 r15 P1). Same shape as 20261010280000.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('triage_items'))) return;
  await knex.raw(
    "CREATE INDEX IF NOT EXISTS triage_items_callback_spam_resolved_index ON triage_items (call_log_id) WHERE status = 'resolved' AND resolution_rule = 'callback_spam'",
  );
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS triage_items_callback_spam_resolved_index');
};
