/**
 * Event-level click attribution for the flagship newsletter (owner spec
 * 2026-07-28, PR 5). One row per (send, event, recipient, kind) — a
 * changed mind / repeat tap never double-counts. Read by the click-rate
 * learning aggregation and the admin per-send rollup. Additive.
 */

exports.up = async function up(knex) {
  const has = await knex.schema.hasTable('newsletter_event_clicks');
  if (has) return;
  await knex.schema.createTable('newsletter_event_clicks', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('send_id').notNullable();
    t.uuid('event_id').notNullable();
    t.string('engagement_token', 64).notNullable();
    t.smallint('position');
    t.string('kind', 16).notNullable().defaultTo('details');
    t.timestamp('clicked_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['send_id', 'event_id', 'engagement_token', 'kind']);
    t.index(['event_id']);
    t.index(['send_id']);
    t.index(['clicked_at']);
  });
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasTable('newsletter_event_clicks');
  if (has) await knex.schema.dropTable('newsletter_event_clicks');
};
