/**
 * Move the flagship calendar anchor from Tuesday to Thursday (owner approved
 * 2026-11-26: the weekly events email sends Thursday 6:00 AM ET and lists
 * Thursday through Sunday, where it sent Tuesday and listed Tuesday through
 * Monday).
 *
 * The CHECK installed by 20260716150000 only admits Tuesdays. Runtime planning
 * now uses Thursday as week_of, so the constraint and the existing anchors move
 * in the same transaction. A Tuesday row becomes the Thursday two days later,
 * and the unique week_of index cannot collide (Tuesday rows are 7 days apart).
 *
 * What a row means after the move, so nothing sends twice and nothing crashes:
 *  - sent / skipped / sending rows only change week_of. The first Thursday after
 *    an old Tuesday week keeps that week's outcome: an issue that went out on
 *    Tuesday is not followed by another two days later, and a skipped week
 *    stays skipped.
 *  - planned / drafted / scheduled rows whose Thursday has not passed, and whose
 *    send (if any) is still a draft or only queued, are reset to 'planned' with
 *    the send unlinked. Their lineup was locked for a Tuesday-Monday window and
 *    the draft has no first-readers audience record, so the Wednesday autopilot
 *    builds a fresh draft for the Thursday-Sunday window. A queued send is
 *    reverted to a draft with its approval cleared (nothing queued survives the
 *    move); the orphaned draft stays in History for the owner to delete.
 *  - target_send_at of every row from this week on becomes 06:00 New York time
 *    on its Thursday (PostgreSQL's named zone, so DST-safe). The runtime sender
 *    only delivers a flagship whose scheduled_for is the current issue Thursday
 *    6:00 AM ET, so no row keeps a Tuesday target.
 *  - Past rows keep their recorded times.
 *
 * down() restores Tuesday week_of, re-times pending weeks to Tuesday 06:00 New York time, and
 * resets the pending drafts and queued sends to plain drafts with their proof and approval
 * cleared, so a fresh Tuesday proof can run.
 */

const TODAY_ET = "(NOW() AT TIME ZONE 'America/New_York')::date";

exports.up = async function up(knex) {
  await knex.transaction(async (trx) => {
    await trx.raw(`
      ALTER TABLE newsletter_calendar
      DROP CONSTRAINT IF EXISTS chk_calendar_week_of_tuesday
    `);

    // Unqueue sends that will be re-drafted (calendar still on its Tuesday week_of here).
    await trx.raw(`
      UPDATE newsletter_sends s
      SET status = 'draft',
          scheduled_for = NULL,
          proof_approved_at = NULL,
          proof_approval_email_id = NULL,
          updated_at = NOW()
      FROM newsletter_calendar c
      WHERE c.send_id = s.id
        AND s.status = 'scheduled'
        AND c.status = 'scheduled'
        AND EXTRACT(ISODOW FROM c.week_of) = 2
        AND (c.week_of + INTERVAL '2 days')::date >= ${TODAY_ET}
    `);

    await trx.raw(`
      UPDATE newsletter_calendar c
      SET status = 'planned',
          send_id = NULL,
          updated_at = NOW()
      WHERE c.status IN ('drafted', 'scheduled')
        AND c.send_id IS NOT NULL
        AND EXTRACT(ISODOW FROM c.week_of) = 2
        AND (c.week_of + INTERVAL '2 days')::date >= ${TODAY_ET}
        AND EXISTS (
          SELECT 1 FROM newsletter_sends s
          WHERE s.id = c.send_id AND s.status = 'draft'
        )
    `);

    await trx.raw(`
      UPDATE newsletter_calendar
      SET week_of = (week_of + INTERVAL '2 days')::date,
          updated_at = NOW()
      WHERE EXTRACT(ISODOW FROM week_of) = 2
    `);

    await trx.raw(`
      UPDATE newsletter_calendar
      SET target_send_at = ((week_of + TIME '06:00') AT TIME ZONE 'America/New_York'),
          updated_at = NOW()
      WHERE status IN ('planned', 'drafted', 'scheduled')
        AND week_of >= ${TODAY_ET}
    `);

    // Fail loudly instead of silently re-anchoring an unexpected/corrupt row.
    // Under the old CHECK every surviving row is a Tuesday, and so now a Thursday.
    const unexpected = await trx('newsletter_calendar')
      .whereRaw('EXTRACT(ISODOW FROM week_of) <> 4')
      .first('id', 'week_of');
    if (unexpected) {
      throw new Error(`newsletter_calendar row ${unexpected.id} has non-Thursday week_of ${unexpected.week_of}`);
    }

    await trx.raw(`
      ALTER TABLE newsletter_calendar
      ADD CONSTRAINT chk_calendar_week_of_thursday
      CHECK (EXTRACT(ISODOW FROM week_of) = 4)
    `);
  });
};

exports.down = async function down(knex) {
  await knex.transaction(async (trx) => {
    await trx.raw(`
      ALTER TABLE newsletter_calendar
      DROP CONSTRAINT IF EXISTS chk_calendar_week_of_thursday
    `);

    // A pending week's draft or queued send was proofed (or approved) for a Thursday 6:00 AM
    // send. Roll it back to a plain draft with the proof and approval cleared, so the Tuesday
    // code's catch-up sends a fresh proof and nothing queued for Thursday can fire on a Tuesday
    // schedule. Calendar still on its Thursday week_of here. Only a draft or queued send:
    // a send already sending or sent keeps its state.
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
      SET week_of = (week_of - INTERVAL '2 days')::date,
          updated_at = NOW()
      WHERE EXTRACT(ISODOW FROM week_of) = 4
    `);

    // Pending weeks (planned, drafted or queued, whose Thursday is today or ahead) go back to
    // 06:00 New York time on their Tuesday. Past rows keep their recorded times.
    await trx.raw(`
      UPDATE newsletter_calendar
      SET target_send_at = ((week_of + TIME '06:00') AT TIME ZONE 'America/New_York'),
          updated_at = NOW()
      WHERE status IN ('planned', 'drafted', 'scheduled')
        AND (week_of + INTERVAL '2 days')::date >= ${TODAY_ET}
    `);

    const unexpected = await trx('newsletter_calendar')
      .whereRaw('EXTRACT(ISODOW FROM week_of) <> 2')
      .first('id', 'week_of');
    if (unexpected) {
      throw new Error(`newsletter_calendar row ${unexpected.id} has non-Tuesday week_of ${unexpected.week_of}`);
    }

    await trx.raw(`
      ALTER TABLE newsletter_calendar
      ADD CONSTRAINT chk_calendar_week_of_tuesday
      CHECK (EXTRACT(ISODOW FROM week_of) = 2)
    `);
  });
};
