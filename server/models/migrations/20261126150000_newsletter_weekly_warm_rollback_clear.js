/**
 * Rollback companion to the weekly warm-up (20261126130100 and 20261126140000, both frozen once
 * pushed). up() changes nothing. down() runs FIRST on a rollback (knex reverses order), while
 * the calendar is still on Thursdays: a pending week's unsent draft or queued send that carries
 * the weekly warm plan (segment_filter.holdout = 'weekly-warm') gets that plan cleared. The older
 * sender knows only the 'pest-insider' holdout and would narrow this one to zero recipients, so
 * the week's proof would fail with zero_recipients and the linked calendar row would retry it
 * forever. Cleared, the week takes the older code's audience (every active reader, still behind
 * the proof approval). Sends already sending or sent keep their plan.
 */

const TODAY_ET = "(NOW() AT TIME ZONE 'America/New_York')::date";

exports.up = async function up() {
  // Nothing to apply: this migration exists only for its down().
};

exports.down = async function down(knex) {
  await knex.raw(`
    UPDATE newsletter_sends s
    SET segment_filter = NULL,
        updated_at = NOW()
    FROM newsletter_calendar c
    WHERE c.send_id = s.id
      AND s.status IN ('draft', 'scheduled')
      AND s.segment_filter->>'holdout' = 'weekly-warm'
      AND EXTRACT(ISODOW FROM c.week_of) = 4
      AND c.week_of >= ${TODAY_ET}
  `);
};
