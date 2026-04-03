exports.up = async function (knex) {
  await knex.schema.createTable('seo_content_decay_alerts', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('url').notNullable();
    t.uuid('blog_post_id').references('id').inTable('blog_posts').onDelete('SET NULL');
    t.string('alert_type'); // position_drop, traffic_drop, impression_drop
    t.string('metric_name');
    t.decimal('previous_value', 10, 2);
    t.decimal('current_value', 10, 2);
    t.decimal('change_pct', 8, 2);
    t.string('period'); // 30d, 60d, 90d
    t.string('status').defaultTo('open'); // open, refreshed, dismissed
    t.timestamps(true, true);
  });

  await knex.schema.createTable('seo_cannibalization_flags', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('query').notNullable();
    t.jsonb('urls').notNullable();
    t.jsonb('impressions_split');
    t.jsonb('clicks_split');
    t.text('recommendation');
    t.string('status').defaultTo('open'); // open, resolved, dismissed
    t.timestamps(true, true);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('seo_cannibalization_flags');
  await knex.schema.dropTableIfExists('seo_content_decay_alerts');
};
