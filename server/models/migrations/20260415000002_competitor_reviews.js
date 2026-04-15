/**
 * Competitor review tracking — store tracked competitor businesses and
 * periodically snapshot their Google rating + review count for trend analysis.
 *
 * Two tables:
 *   competitor_businesses  — one row per tracked competitor
 *   competitor_review_cache — time-series of rating/review-count snapshots
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('competitor_businesses'))) {
    await knex.schema.createTable('competitor_businesses', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('name', 200).notNullable();
      t.string('google_place_id', 150).notNullable().unique();
      t.string('market', 100);
      t.string('category', 50);
      t.decimal('current_rating', 3, 2);
      t.integer('current_review_count');
      t.timestamp('last_synced_at');
      t.boolean('active').defaultTo(true);
      t.text('notes');
      t.timestamps(true, true);
      t.index('market');
      t.index('active');
    });
  }

  if (!(await knex.schema.hasTable('competitor_review_cache'))) {
    await knex.schema.createTable('competitor_review_cache', (t) => {
      t.increments('id').primary();
      t.uuid('competitor_id').notNullable();
      t.decimal('rating', 3, 2);
      t.integer('review_count');
      t.date('snapshot_date').notNullable();
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.unique(['competitor_id', 'snapshot_date']);
      t.index('snapshot_date');
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('competitor_review_cache');
  await knex.schema.dropTableIfExists('competitor_businesses');
};
