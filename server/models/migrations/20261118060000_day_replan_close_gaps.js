/**
 * day_replan_plans.close_gaps: the close-gaps measurement for each planned tech-day (owner 2026-11-18, "shadow, but i
 * want admin notifications"; services/day-replan/close-gaps.js). It records the day's open time as booked and under
 * the night's best plan, what the packed-day rule (P1), the per-home same-customer lock (P2) and a block-aware booking
 * picker (S1) would change, and the lock on each remaining wait. Measuring only: nothing reads it to change a visit.
 * Additive and nullable (older rows and a failed measurement leave it null); earlier day_replan_plans migrations are
 * frozen and untouched. Down drops the column.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('day_replan_plans', (t) => {
    t.jsonb('close_gaps').nullable();
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('day_replan_plans', (t) => {
    t.dropColumn('close_gaps');
  });
};
