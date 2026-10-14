/**
 * recipient_optin follow-up state for the on-site opt-in ask (#5467 follow-up:
 * caller demotion + booking-confirmation replay). When the on-site recipient's
 * YES confirms a visit-bound row (visit_id set), the caller's appointment texts
 * switch off and the recipient gets the booking confirmation they missed:
 *   caller_demoted_at   — the demotion was applied for this phone; it is never
 *                         applied twice (a holder who turned texts back on stays on).
 *   followup_claimed_at — in-flight claim: one process runs the replay; a claim
 *                         older than 10 minutes is a dead attempt and is retaken.
 *   followup_done_at    — the obligation ended (sent, or finally refused).
 * Additive and nullable. Confirmed visit-bound rows that predate this are marked
 * done so the follow-up never fires retroactively for an old YES.
 */

exports.up = async function up(knex) {
  for (const column of ['caller_demoted_at', 'followup_claimed_at', 'followup_done_at']) {
    if (!(await knex.schema.hasColumn('recipient_optin', column))) {
      await knex.schema.alterTable('recipient_optin', (t) => {
        t.timestamp(column, { useTz: true }).nullable();
      });
    }
  }
  await knex('recipient_optin')
    .where({ status: 'confirmed' })
    .whereNotNull('visit_id')
    .whereNull('followup_done_at')
    .update({ followup_done_at: knex.fn.now() });
};

exports.down = async function down(knex) {
  for (const column of ['caller_demoted_at', 'followup_claimed_at', 'followup_done_at']) {
    if (await knex.schema.hasColumn('recipient_optin', column)) {
      await knex.schema.alterTable('recipient_optin', (t) => {
        t.dropColumn(column);
      });
    }
  }
};
