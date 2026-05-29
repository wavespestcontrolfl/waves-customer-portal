/**
 * Persist the locked event-id list on each newsletter_sends row.
 *
 * The flagship digest is assembled from a set of events_raw rows (the locked
 * `events[].eventId`s), but the send row never recorded which events it
 * shipped. The sender therefore couldn't advance events_raw.times_featured
 * when a newsletter went out, so the recurring-series freshness gate
 * (fresh_series_launch while times_featured <= 2) never decayed for the
 * automated path — the same recurring event could headline week after week.
 *
 * event_ids is written at draft time by createNewsletterDraft (and the
 * draft-from-plan path) from the locked events, and read by sendCampaign on
 * the first 'sent' transition to bump times_featured + recompute freshness.
 * Defaults to '[]' so every existing/manual send is a no-op.
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('newsletter_sends', (table) => {
    table.jsonb('event_ids').notNullable().defaultTo('[]');
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('newsletter_sends', (table) => {
    table.dropColumn('event_ids');
  });
};
