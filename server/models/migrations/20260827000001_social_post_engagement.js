/**
 * Per-platform engagement for our OWN published social posts (likes /
 * comments / shares), pulled daily by the engagement-ingest cron from the
 * Facebook Graph and Instagram Graph APIs. Until now the only engagement numbers in the portal were
 * hand-entered competitor rows (competitor_social_posts) and the analytics
 * "top posts" were just the most recent — the count column names mirror
 * that table so own vs competitor posts compare side by side.
 *
 * One row per (post, platform); a publish event fans out to N platforms and
 * platform post ids live in social_media_posts.platforms_posted, which is
 * why this is a child table rather than columns on the post.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('social_post_engagement', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('post_id').notNullable().references('id').inTable('social_media_posts').onDelete('CASCADE');
    t.string('platform', 20).notNullable();
    t.string('platform_post_id', 300).notNullable();
    t.integer('likes_count').notNullable().defaultTo(0);
    t.integer('comments_count').notNullable().defaultTo(0);
    // Nullable: NULL = the provider did not expose a share count for this
    // media (Facebook Video nodes, Instagram media without the insight) —
    // distinct from a measured zero.
    t.integer('shares_count');
    t.integer('engagement_score').notNullable().defaultTo(0);
    t.timestamp('fetched_at').notNullable().defaultTo(knex.fn.now());
    // NULL until the first successful fetch — a row created by a failed
    // first attempt carries default-zero counts that are NOT data; the
    // analytics rollup excludes rows with no success stamp.
    t.timestamp('last_success_at');
    t.text('last_error');
    t.timestamps(true, true);
    // The unique (post_id, platform) index also serves the only reader
    // (filter by post_id); no other indexes until a query needs them.
    t.unique(['post_id', 'platform']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('social_post_engagement');
};
