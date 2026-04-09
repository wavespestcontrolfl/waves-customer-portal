exports.up = async function (knex) {
  // ga4_daily_metrics
  const hasDailyMetrics = await knex.schema.hasTable('ga4_daily_metrics');
  if (!hasDailyMetrics) {
    await knex.schema.createTable('ga4_daily_metrics', (t) => {
      t.increments('id').primary();
      t.date('date').notNullable();
      t.integer('sessions').defaultTo(0);
      t.integer('users').defaultTo(0);
      t.integer('new_users').defaultTo(0);
      t.integer('pageviews').defaultTo(0);
      t.decimal('bounce_rate', 5, 2).defaultTo(0);
      t.decimal('avg_session_duration', 8, 2).defaultTo(0);
      t.integer('conversions').defaultTo(0);
      t.string('top_source', 100);
      t.string('top_medium', 100);
      t.string('top_landing_page', 500);
      t.decimal('mobile_pct', 5, 2).defaultTo(0);
      t.decimal('desktop_pct', 5, 2).defaultTo(0);
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.unique('date');
    });
  }

  // ga4_traffic_sources
  const hasTrafficSources = await knex.schema.hasTable('ga4_traffic_sources');
  if (!hasTrafficSources) {
    await knex.schema.createTable('ga4_traffic_sources', (t) => {
      t.increments('id').primary();
      t.date('date').notNullable();
      t.string('source', 100);
      t.string('medium', 100);
      t.integer('sessions').defaultTo(0);
      t.integer('users').defaultTo(0);
      t.integer('conversions').defaultTo(0);
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.index('date');
      t.unique(['date', 'source', 'medium']);
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('ga4_traffic_sources');
  await knex.schema.dropTableIfExists('ga4_daily_metrics');
};
