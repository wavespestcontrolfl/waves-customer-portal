/**
 * Office approval to move a visit online inside the self-serve move notice
 * window (owner 2026-10-06: a 1 PM visit rained out at 2 PM; the office texted
 * the reschedule link and the composer refused it as "too close to move").
 *
 * Holds the visit START instant the office approved when it inserted the
 * reschedule link. visitInsideMoveNoticeWindow skips the notice rule only
 * while the row still starts at that instant, so any move (by the customer
 * or the office) ends the approval without a cleanup job. NULL = no approval.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('scheduled_services', (t) => {
    t.timestamp('office_move_approved_for', { useTz: true }).nullable();
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('scheduled_services', (t) => {
    t.dropColumn('office_move_approved_for');
  });
};
