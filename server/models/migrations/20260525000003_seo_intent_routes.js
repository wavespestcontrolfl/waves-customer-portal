exports.up = async function (knex) {
  await knex.schema.createTable('gsc_query_page_map', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('query').notNullable();
    t.text('page_url').notNullable();
    t.string('domain', 200);
    t.integer('clicks').defaultTo(0);
    t.integer('impressions').defaultTo(0);
    t.decimal('ctr', 8, 4);
    t.decimal('position', 8, 2);
    t.date('date_from').notNullable();
    t.date('date_to').notNullable();
    t.timestamps(true, true);

    t.unique(['query', 'page_url', 'domain', 'date_from']);
    t.index('query');
    t.index('page_url');
    t.index('domain');
  });

  await knex.schema.createTable('seo_intent_routes', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('query_cluster', 300).notNullable();
    t.string('domain', 200);
    t.string('intent_type', 30);
    t.string('expected_page_type', 30);
    t.text('intended_url');
    t.text('actual_winner_url');
    t.string('actual_winner_page_type', 30);
    t.jsonb('competing_urls');
    t.string('misroute_type', 40);
    t.string('misroute_severity', 10);
    t.integer('impressions_total');
    t.integer('clicks_total');
    t.string('status', 20).notNullable().defaultTo('open');
    t.timestamps(true, true);

    t.unique(['query_cluster', 'domain']);
    t.index('misroute_type');
    t.index('status');
    t.index('misroute_severity');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('seo_intent_routes');
  await knex.schema.dropTableIfExists('gsc_query_page_map');
};
