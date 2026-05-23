exports.up = async function (knex) {
  await knex.schema.createTable('seo_url_experiments', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

    t.text('url').notNullable();
    t.string('action_type', 60).notNullable();
    t.date('publish_date');
    t.string('target_query_cluster', 200);

    // Pre-period KPIs (28d before publish_date)
    t.integer('pre_28d_clicks');
    t.integer('pre_28d_impressions');
    t.decimal('pre_28d_ctr', 8, 4);
    t.decimal('pre_28d_position', 8, 2);

    // Post-period KPIs (28d after publish_date + 7d stabilization)
    t.integer('post_28d_clicks');
    t.integer('post_28d_impressions');
    t.decimal('post_28d_ctr', 8, 4);
    t.decimal('post_28d_position', 8, 2);

    // Status changes
    t.boolean('canonical_status_change').defaultTo(false);
    t.boolean('indexation_status_change').defaultTo(false);

    // State
    t.string('status', 20).notNullable().defaultTo('running');
    t.text('notes');

    t.timestamps(true, true);

    t.index('url');
    t.index('status');
    t.index('publish_date');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('seo_url_experiments');
};
