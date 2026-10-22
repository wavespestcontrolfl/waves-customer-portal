/**
 * Event URL snapshot per newsletter send (security audit run 2, 2026-10-22,
 * GATE_NEWSLETTER_CLICK_BOUND). At send time the sender stores
 * { eventId: event_url } for the send's lineup, and the click redirect
 * follows that snapshot, so a feed that later re-points or re-uses an
 * event row cannot change where an emailed link goes. Additive, nullable.
 */

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('newsletter_sends');
  if (!hasTable) return;
  const has = await knex.schema.hasColumn('newsletter_sends', 'event_url_snapshot');
  if (!has) {
    await knex.schema.alterTable('newsletter_sends', (t) => t.jsonb('event_url_snapshot'));
  }
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('newsletter_sends');
  if (!hasTable) return;
  const has = await knex.schema.hasColumn('newsletter_sends', 'event_url_snapshot');
  if (has) {
    await knex.schema.alterTable('newsletter_sends', (t) => t.dropColumn('event_url_snapshot'));
  }
};
