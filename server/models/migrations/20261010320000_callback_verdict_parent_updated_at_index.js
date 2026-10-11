// The reconcile scan's obsolete-settlement sources start from a stamped
// parent that CHANGED recently (a replacement recording rewrites updated_at)
// instead of walking every stamped parent ever (codex #6271 r32).
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('call_log'))) return;
  await knex.raw(
    "CREATE INDEX IF NOT EXISTS call_log_callback_verdict_parent_updated_at_index ON call_log (updated_at) WHERE direction = 'inbound' AND metadata->'callback_verdict' IS NOT NULL",
  );
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS call_log_callback_verdict_parent_updated_at_index');
};
