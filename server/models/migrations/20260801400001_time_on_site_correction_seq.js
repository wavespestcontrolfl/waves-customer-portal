/**
 * Monotonic revision for time-on-site corrections (codex P2 #3152 round 17).
 *
 * The correction fences (finalization moved-stamp detection, markComplete's
 * transition/already-complete stamp predicates) compared the corrected
 * MINUTES value — but a correction that re-saves the same minutes (e.g. to
 * repair end fields that an earlier save clamped) is invisible to a value
 * comparison, so an in-flight finalization could still overwrite it.
 * This column is bumped (COALESCE(seq,0)+1) inside the correction PATCH's
 * row-locked transaction on EVERY save, giving the fences a version that
 * always moves. NULL = the row has never been corrected.
 */
exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('scheduled_services');
  if (!hasTable) return;
  const hasColumn = await knex.schema.hasColumn('scheduled_services', 'time_on_site_correction_seq');
  if (hasColumn) return;
  await knex.schema.alterTable('scheduled_services', (t) => {
    t.integer('time_on_site_correction_seq').nullable();
  });
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('scheduled_services');
  if (!hasTable) return;
  const hasColumn = await knex.schema.hasColumn('scheduled_services', 'time_on_site_correction_seq');
  if (!hasColumn) return;
  await knex.schema.alterTable('scheduled_services', (t) => {
    t.dropColumn('time_on_site_correction_seq');
  });
};
