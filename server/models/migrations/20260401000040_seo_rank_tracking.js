exports.up = async function (knex) {
  await knex.schema.createTable('seo_competitors', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('name').notNullable();
    t.string('domain');
    t.string('market_area');
    t.boolean('active').defaultTo(true);
    t.timestamps(true, true);
  });

  await knex.schema.createTable('seo_target_keywords', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('keyword').notNullable();
    t.string('primary_city');
    t.string('service_category');
    t.text('target_url');
    t.integer('priority').defaultTo(2); // 1=daily, 2=weekly, 3=long-tail
    t.integer('monthly_volume');
    t.timestamps(true, true);
  });

  await knex.schema.createTable('seo_rank_history', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('keyword_id').references('id').inTable('seo_target_keywords').onDelete('CASCADE');
    t.date('check_date').notNullable();
    t.integer('organic_position');
    t.integer('map_pack_position');
    t.jsonb('serp_features');
    t.boolean('ai_overview_cited').defaultTo(false);
    t.jsonb('ai_overview_sources');
    t.jsonb('competitor_positions');
    t.timestamps(true, true);
    t.unique(['keyword_id', 'check_date']);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('seo_rank_history');
  await knex.schema.dropTableIfExists('seo_target_keywords');
  await knex.schema.dropTableIfExists('seo_competitors');
};
