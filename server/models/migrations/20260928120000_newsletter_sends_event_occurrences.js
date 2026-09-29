/**
 * newsletter_sends.event_occurrences: { [eventId]: start_at ISO } for the
 * occurrences fact-locked into a draft (newsletter-draft.js
 * lockEventFactsFromDb). The sender stamps events_raw.last_featured_occurrence_at
 * from it, because an RSS/iCal row can be advanced in place between drafting
 * and delivery while the email still shows the drafted date. NULL for sends
 * drafted before this column, or built without locked facts; the sender
 * falls back to the row's live start_at for those.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('newsletter_sends'))) return;
  if (!(await knex.schema.hasColumn('newsletter_sends', 'event_occurrences'))) {
    await knex.schema.alterTable('newsletter_sends', (t) => t.jsonb('event_occurrences'));
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('newsletter_sends'))) return;
  if (await knex.schema.hasColumn('newsletter_sends', 'event_occurrences')) {
    await knex.schema.alterTable('newsletter_sends', (t) => t.dropColumn('event_occurrences'));
  }
};
