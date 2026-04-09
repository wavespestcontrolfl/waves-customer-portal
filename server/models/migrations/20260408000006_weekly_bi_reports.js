exports.up = async function (knex) {
  const exists = await knex.schema.hasTable('weekly_bi_reports');
  if (exists) return;

  await knex.schema.createTable('weekly_bi_reports', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.text('summary');
    t.text('revenue_section');
    t.text('customer_section');
    t.text('operations_section');
    t.text('ads_section');
    t.text('reviews_section');
    t.text('content_seo_section');
    t.text('anomalies_section');
    t.text('action_items');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index('created_at');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('weekly_bi_reports');
};
