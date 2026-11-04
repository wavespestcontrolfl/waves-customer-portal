/**
 * day_replan_plans: the apply writer's outcome (owner ruling 2026-11-03, PR 2 of 3, GATE_DAY_REPLAN=true).
 * Additive and nullable; shadow rows and plans that were never attempted leave all three null.
 *
 * apply_status: 'applied' | 'skipped' | 'rolled_back' | 'failed'
 *   applied      every changed visit was written
 *   skipped      nothing was written (apply_reason: changed_since_plan, no_safe_sequence, no_hour_changes)
 *   rolled_back  a step failed and every step already made was undone (apply_reason: step_failed:<code>)
 *   failed       a step failed and the undo failed too; the day needs a person (apply_reason: rollback_failed:<code>)
 * applied_at: when an 'applied' day finished. Rows planned in apply mode also carry mode = 'apply'.
 * The migration of the table itself (20261104000000) is frozen and untouched.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('day_replan_plans', (t) => {
    t.text('apply_status').nullable();
    t.text('apply_reason').nullable();
    t.timestamp('applied_at', { useTz: true }).nullable();
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('day_replan_plans', (t) => {
    t.dropColumn('applied_at');
    t.dropColumn('apply_reason');
    t.dropColumn('apply_status');
  });
};
