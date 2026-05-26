/**
 * Add prep guide analytics table and expiry column.
 *
 * prep_guide_views: logs each page view with IP hash for dedup.
 * projects.prep_expires_at: optional expiration for prep tokens.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('prep_guide_views'))) {
    await knex.schema.createTable('prep_guide_views', (t) => {
      t.increments('id').primary();
      t.integer('project_id').notNullable().references('id').inTable('projects').onDelete('CASCADE');
      t.string('ip_hash', 64).nullable();
      t.string('user_agent', 512).nullable();
      t.timestamp('viewed_at').defaultTo(knex.fn.now());
      t.index(['project_id', 'viewed_at']);
    });
  }

  const [hasPrepExpiresAt, hasPrepFirstViewedAt, hasPrepViewCount] = await Promise.all([
    knex.schema.hasColumn('projects', 'prep_expires_at'),
    knex.schema.hasColumn('projects', 'prep_first_viewed_at'),
    knex.schema.hasColumn('projects', 'prep_view_count'),
  ]);

  if (!hasPrepExpiresAt || !hasPrepFirstViewedAt || !hasPrepViewCount) {
    await knex.schema.alterTable('projects', (t) => {
      if (!hasPrepExpiresAt) t.timestamp('prep_expires_at').nullable();
      if (!hasPrepFirstViewedAt) t.timestamp('prep_first_viewed_at').nullable();
      if (!hasPrepViewCount) t.integer('prep_view_count').defaultTo(0);
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('prep_guide_views');
  await knex.schema.alterTable('projects', (t) => {
    t.dropColumn('prep_expires_at');
    t.dropColumn('prep_first_viewed_at');
    t.dropColumn('prep_view_count');
  });
};
