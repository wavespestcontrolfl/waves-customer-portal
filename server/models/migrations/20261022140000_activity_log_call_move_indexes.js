// no-show-detector.js reads the slot a call promised from BOTH activity
// actions that record a call moving a visit (CALL_MOVE_ACTIONS): an applied
// reschedule and, since GATE_CALL_MAKEUP_MOVE, a make-up of a missed
// recurring visit. Its two reads (by visit id, and the recall by destination
// date) filter `action IN (...)`, which the old single-action partial indexes
// (20260911000100, 20260911000180) cannot serve. The same expressions,
// partial on both actions, replace them; a query on either action alone still
// matches the wider predicate. Plain index, not CONCURRENTLY: migrations run
// inside a transaction pre-deploy (same as the indexes it replaces).
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('activity_log'))) return;
  await knex.raw(`CREATE INDEX IF NOT EXISTS activity_log_call_move_visit_idx
    ON activity_log ((metadata->>'scheduled_service_id'))
    WHERE action IN ('call_reschedule_applied', 'call_makeup_move_applied')`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS activity_log_call_move_window_idx
    ON activity_log ((metadata->'to'->>'date'))
    WHERE action IN ('call_reschedule_applied', 'call_makeup_move_applied')`);
  await knex.raw('DROP INDEX IF EXISTS activity_log_applied_reschedule_visit_idx');
  await knex.raw('DROP INDEX IF EXISTS activity_log_applied_window_idx');
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('activity_log'))) return;
  await knex.raw(`CREATE INDEX IF NOT EXISTS activity_log_applied_reschedule_visit_idx
    ON activity_log ((metadata->>'scheduled_service_id'))
    WHERE action = 'call_reschedule_applied'`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS activity_log_applied_window_idx
    ON activity_log ((metadata->'to'->>'date'))
    WHERE action = 'call_reschedule_applied'`);
  await knex.raw('DROP INDEX IF EXISTS activity_log_call_move_window_idx');
  await knex.raw('DROP INDEX IF EXISTS activity_log_call_move_visit_idx');
};
