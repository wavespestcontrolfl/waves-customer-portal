// Negative keywords the ads advisor has proposed, the owner approved or
// declined, and Google holds (owner plan A, 2026-11-02, PR 1 of 2). This table
// is the advisor's memory: it reads every row so it stops re-proposing the
// same words. PR 1 only creates and reads it; no Google write and no data here.
//
//   text       normalized: lowercase, trimmed, single spaces (services/ads/negative-keywords.js)
//   match_type 'phrase' by default; the same word may exist once per match type
//   source     owner_list | advisor | manual
//   state      pending (waiting on the owner) | active (in Google) | declined |
//              removed (taken out of Google) | failed (Google refused)
//   metrics    clicks, cost and conversions when the advisor drafted it
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('ad_negative_keywords')) return;
  await knex.schema.createTable('ad_negative_keywords', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('campaign_id').notNullable().references('id').inTable('ad_campaigns').onDelete('CASCADE');
    t.string('text', 80).notNullable();
    t.string('match_type', 10).notNullable().defaultTo('phrase');
    t.string('source', 20).notNullable();
    t.string('state', 20).notNullable();
    t.string('google_resource_name', 255).nullable();
    t.text('reason').nullable();
    t.jsonb('metrics').nullable();
    t.string('decided_by', 64).nullable();
    t.timestamp('decided_at', { useTz: true }).nullable();
    t.timestamp('pushed_at', { useTz: true }).nullable();
    t.timestamp('removed_at', { useTz: true }).nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['campaign_id', 'text', 'match_type'], { indexName: 'ad_negative_keywords_campaign_text_match_uq' });
    t.index(['campaign_id', 'state'], 'ad_negative_keywords_campaign_state_idx');
  });
  await knex.raw(`ALTER TABLE ad_negative_keywords ADD CONSTRAINT ad_negative_keywords_source_check
    CHECK (source IN ('owner_list', 'advisor', 'manual'))`);
  await knex.raw(`ALTER TABLE ad_negative_keywords ADD CONSTRAINT ad_negative_keywords_state_check
    CHECK (state IN ('pending', 'active', 'declined', 'removed', 'failed'))`);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('ad_negative_keywords');
};
