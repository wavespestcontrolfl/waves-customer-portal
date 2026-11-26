/**
 * Rollback companion to 20261126130000 (Tuesday to Thursday anchor), which is already pushed and
 * so frozen. up() changes nothing. down() runs BEFORE that migration's down() (knex rolls back in
 * reverse order), while the calendar is still on its Thursday week_of, and prepares the pending
 * weeks for the Tuesday code:
 *  - a pending week's draft or queued send was proofed (or approved) for a Thursday 6:00 AM send.
 *    It goes back to a plain draft with the proof and approval cleared, so the Tuesday code's
 *    catch-up sends a fresh proof and nothing queued for Thursday can fire on a Tuesday schedule.
 *    Only a draft or queued send: a send already sending or sent keeps its state. A queued week's
 *    calendar row goes back to 'drafted' (still linked).
 *  - target_send_at of every pending week (planned, drafted or queued, Thursday today or ahead)
 *    becomes 06:00 New York time on the Tuesday two days before its Thursday (DST-safe).
 * Past rows keep their recorded times. The week_of move and the CHECK swap stay in 20261126130000.
 */

const TODAY_ET = "(NOW() AT TIME ZONE 'America/New_York')::date";

exports.up = async function up() {
  // Nothing to apply: this migration exists only for its down().
};

exports.down = async function down(knex) {
  await knex.transaction(async (trx) => {
    await trx.raw(`
      UPDATE newsletter_sends s
      SET status = 'draft',
          scheduled_for = NULL,
          proof_token = NULL,
          proof_sent_at = NULL,
          proof_approved_at = NULL,
          proof_approval_email_id = NULL,
          updated_at = NOW()
      FROM newsletter_calendar c
      WHERE c.send_id = s.id
        AND s.status IN ('draft', 'scheduled')
        AND c.status IN ('drafted', 'scheduled')
        AND EXTRACT(ISODOW FROM c.week_of) = 4
        AND c.week_of >= ${TODAY_ET}
    `);

    await trx.raw(`
      UPDATE newsletter_calendar c
      SET status = 'drafted',
          updated_at = NOW()
      WHERE c.status = 'scheduled'
        AND c.send_id IS NOT NULL
        AND EXTRACT(ISODOW FROM c.week_of) = 4
        AND c.week_of >= ${TODAY_ET}
        AND EXISTS (
          SELECT 1 FROM newsletter_sends s
          WHERE s.id = c.send_id AND s.status = 'draft'
        )
    `);

    await trx.raw(`
      UPDATE newsletter_calendar
      SET target_send_at = (((week_of - INTERVAL '2 days')::date + TIME '06:00') AT TIME ZONE 'America/New_York'),
          updated_at = NOW()
      WHERE status IN ('planned', 'drafted', 'scheduled')
        AND EXTRACT(ISODOW FROM week_of) = 4
        AND week_of >= ${TODAY_ET}
    `);
  });
};
