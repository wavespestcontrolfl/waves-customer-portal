// Explicit correction marker for first-touch holds (Codex #3084 r39): the
// r36 merge guard treated ANY during-run updated_at bump as operator
// approval of the row's target, but claims and re-pends bump updated_at
// too — a sweep claim racing a force-reprocess could pin a prior cycle's
// unreviewed address. corrected_at is written ONLY by the email-correction
// fanout's retargets, so recordFirstTouchHold's merge can preserve exactly
// the targets an operator actually asserted.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('first_touch_holds'))) return;
  if (await knex.schema.hasColumn('first_touch_holds', 'corrected_at')) return;
  await knex.schema.alterTable('first_touch_holds', (t) => {
    t.timestamp('corrected_at');
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('first_touch_holds'))) return;
  if (!(await knex.schema.hasColumn('first_touch_holds', 'corrected_at'))) return;
  await knex.schema.alterTable('first_touch_holds', (t) => {
    t.dropColumn('corrected_at');
  });
};
