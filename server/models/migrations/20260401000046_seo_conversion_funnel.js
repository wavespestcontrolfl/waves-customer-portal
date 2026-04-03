exports.up = async function (knex) {
  await knex.schema.createTable('seo_conversion_funnel', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.date('date').notNullable();
    t.uuid('keyword_id').references('id').inTable('seo_target_keywords').onDelete('SET NULL');
    t.text('landing_page');
    t.integer('gsc_impressions').defaultTo(0);
    t.integer('gsc_clicks').defaultTo(0);
    t.integer('estimate_requests').defaultTo(0);
    t.integer('estimates_sent').defaultTo(0);
    t.integer('jobs_booked').defaultTo(0);
    t.decimal('revenue', 10, 2).defaultTo(0);
    t.timestamps(true, true);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('seo_conversion_funnel');
};
