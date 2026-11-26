/**
 * Follow-up to 20261126130000 (Tuesday to Thursday anchor, frozen once pushed). Runs right after
 * it, in the same deploy batch, so the calendar is already on Thursdays.
 *
 * 1. A weekly draft or queued send that no calendar row links must carry no proof credentials.
 *    20261126130000 unlinks the pending weeks' drafts but leaves their proof_token and
 *    proof_sent_at, and a send older than the weekly registry may have no type. An APPROVED reply
 *    to such an old proof finds the send by its token; with no calendar link and no type it is not
 *    a flagship, so it would take the immediate non-flagship dispatch and skip the Thursday window
 *    and the first-readers audience. So for every draft or scheduled send of type NULL or
 *    'local-weekly-fresh-events' with no calendar link: the proof token, proof time and approval
 *    are cleared (an approval reply then finds no send), a queued send returns to a draft, and a
 *    NULL type becomes the flagship type, which always needs a calendar link to be approved.
 *    Waves Pest Insider and every other type are left alone.
 * 2. A pending Thursday week whose calendar row is still 'drafted' while its linked send is
 *    already 'scheduled' (the proof step can leave this split) was skipped by 20261126130000,
 *    which unqueues only rows marked 'scheduled'. Its send returns to a draft with the proof and
 *    approval cleared and the row goes back to 'planned', unlinked, so the Wednesday autopilot
 *    builds a fresh Thursday-to-Sunday draft, as it does for the other pending weeks. This runs
 *    first, so step 1 then clears nothing twice.
 * Sends already sending or sent keep their state. up() is the only change; down() does nothing
 * (the credentials and links this clears cannot be rebuilt, and the proofs they belonged to are
 * stale by then).
 */

const TODAY_ET = "(NOW() AT TIME ZONE 'America/New_York')::date";
const FLAGSHIP = 'local-weekly-fresh-events';

exports.up = async function up(knex) {
  await knex.transaction(async (trx) => {
    // 2. The split state, while the send is still linked.
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
        AND s.status = 'scheduled'
        AND c.status = 'drafted'
        AND EXTRACT(ISODOW FROM c.week_of) = 4
        AND c.week_of >= ${TODAY_ET}
    `);
    await trx.raw(`
      UPDATE newsletter_calendar c
      SET status = 'planned',
          send_id = NULL,
          updated_at = NOW()
      WHERE c.status = 'drafted'
        AND c.send_id IS NOT NULL
        AND EXTRACT(ISODOW FROM c.week_of) = 4
        AND c.week_of >= ${TODAY_ET}
        AND EXISTS (
          SELECT 1 FROM newsletter_sends s
          WHERE s.id = c.send_id AND s.status = 'draft' AND s.proof_token IS NULL AND s.proof_approved_at IS NULL
        )
    `);

    // 1. Unlinked weekly drafts and queued sends: no proof credentials, never a typeless send.
    await trx.raw(`
      UPDATE newsletter_sends s
      SET newsletter_type = '${FLAGSHIP}',
          status = 'draft',
          scheduled_for = NULL,
          proof_token = NULL,
          proof_sent_at = NULL,
          proof_approved_at = NULL,
          proof_approval_email_id = NULL,
          updated_at = NOW()
      WHERE s.status IN ('draft', 'scheduled')
        AND (s.newsletter_type IS NULL OR s.newsletter_type = '${FLAGSHIP}')
        AND NOT EXISTS (SELECT 1 FROM newsletter_calendar c WHERE c.send_id = s.id)
    `);
  });
};

exports.down = async function down() {
  // Nothing to undo: see the header.
};
