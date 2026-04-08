/**
 * Backlink Strategy Agent report storage.
 */
exports.up = async function (knex) {
  const exists = await knex.schema.hasTable('backlink_strategy_reports');
  if (exists) return;

  await knex.schema.createTable('backlink_strategy_reports', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.text('summary');
    t.text('profile_health');
    t.integer('new_targets_added').defaultTo(0);
    t.integer('competitor_gaps_found').defaultTo(0);
    t.text('editorial_recommendations');
    t.text('citation_issues');
    t.text('llm_visibility');
    t.text('action_items');
    t.timestamp('created_at').defaultTo(knex.fn.now());

    t.index('created_at');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('backlink_strategy_reports');
};
