/**
 * Move the flagship calendar anchor from Thursday to Tuesday.
 *
 * The original table CHECK only admits Thursdays. Runtime planning now uses
 * Tuesday as week_of, so the constraint and existing anchors must move in the
 * same transaction. Existing Thursday rows represent the same issue week and
 * move back two days. Future planned/drafted/SCHEDULED targets move to 06:00
 * local time on that Tuesday using PostgreSQL's named time zone (DST-safe),
 * and a scheduled campaign's linked newsletter_sends.scheduled_for moves with
 * its calendar row — the runtime scheduler only delivers a flagship whose
 * scheduled_for is the current issue Tuesday 6:00 AM ET, so a stale Thursday
 * time would strand a proof-approved send until it aged out and reverted.
 * Sent history is left untouched.
 */

exports.up = async function up(knex) {
  await knex.transaction(async (trx) => {
    await trx.raw(`
      ALTER TABLE newsletter_calendar
      DROP CONSTRAINT IF EXISTS chk_calendar_week_of_thursday
    `);

    await trx.raw(`
      UPDATE newsletter_calendar
      SET week_of = (week_of - INTERVAL '2 days')::date,
          updated_at = NOW()
      WHERE EXTRACT(ISODOW FROM week_of) = 4
    `);

    await trx.raw(`
      UPDATE newsletter_calendar
      SET target_send_at = ((week_of + TIME '06:00') AT TIME ZONE 'America/New_York'),
          updated_at = NOW()
      WHERE status IN ('planned', 'drafted', 'scheduled')
        AND target_send_at > NOW()
    `);

    await trx.raw(`
      UPDATE newsletter_sends s
      SET scheduled_for = ((c.week_of + TIME '06:00') AT TIME ZONE 'America/New_York'),
          updated_at = NOW()
      FROM newsletter_calendar c
      WHERE c.send_id = s.id
        AND s.status = 'scheduled'
        AND s.scheduled_for > NOW()
    `);

    // Fail loudly instead of silently re-anchoring an unexpected/corrupt row.
    // Under the old CHECK every surviving row is Thursday, and therefore now
    // Tuesday. This guard also keeps a drifted environment from accepting a
    // misleading calendar conversion.
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

exports.down = async function down(knex) {
  await knex.transaction(async (trx) => {
    await trx.raw(`
      ALTER TABLE newsletter_calendar
      DROP CONSTRAINT IF EXISTS chk_calendar_week_of_tuesday
    `);
    await trx.raw(`
      UPDATE newsletter_calendar
      SET week_of = (week_of + INTERVAL '2 days')::date,
          updated_at = NOW()
      WHERE EXTRACT(ISODOW FROM week_of) = 2
    `);
    await trx.raw(`
      ALTER TABLE newsletter_calendar
      ADD CONSTRAINT chk_calendar_week_of_thursday
      CHECK (EXTRACT(ISODOW FROM week_of) = 4)
    `);
  });
};
