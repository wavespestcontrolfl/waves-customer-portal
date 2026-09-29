/**
 * events_raw.last_featured_occurrence_at: the start_at of the occurrence a
 * sent newsletter actually shipped (set by newsletter-sender.js's
 * markEventsFeatured). The calendar-year recurrence rule (owner ruling
 * 2026-09-27) compares the candidate's ET year with the FEATURED OCCURRENCE's
 * year. last_featured_at is only the send time, which misattributes a January
 * event shipped in a late-December issue, and a feed can later advance the
 * same row to a new date in place. NULL on rows featured before this column
 * existed; readers fall back to the send-time estimate for those.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('events_raw'))) return;
  if (!(await knex.schema.hasColumn('events_raw', 'last_featured_occurrence_at'))) {
    await knex.schema.alterTable('events_raw', (t) => {
      t.timestamp('last_featured_occurrence_at', { useTz: true }).nullable();
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('events_raw'))) return;
  if (await knex.schema.hasColumn('events_raw', 'last_featured_occurrence_at')) {
    await knex.schema.alterTable('events_raw', (t) => {
      t.dropColumn('last_featured_occurrence_at');
    });
  }
};
