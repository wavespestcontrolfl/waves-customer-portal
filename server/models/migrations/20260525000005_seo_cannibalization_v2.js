exports.up = async function (knex) {
  await knex.schema.alterTable('seo_cannibalization_flags', (t) => {
    t.text('winner_url');
    t.integer('winner_clicks');
    t.integer('winner_impressions');
    t.integer('total_waste_impressions');
    t.text('action_taken');
    t.string('domain', 200);
    t.index('domain');
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('seo_cannibalization_flags', (t) => {
    t.dropIndex('domain');
    t.dropColumn('domain');
    t.dropColumn('action_taken');
    t.dropColumn('total_waste_impressions');
    t.dropColumn('winner_impressions');
    t.dropColumn('winner_clicks');
    t.dropColumn('winner_url');
  });
};
