/**
 * Migration 066 — Content Scheduling
 *
 * Adds scheduling columns to blog_posts and social_media_posts
 * for the content calendar and auto-publish pipeline.
 */

exports.up = async function (knex) {
  // ── blog_posts: add scheduling columns ──────────────────────────
  const blogCols = await knex('information_schema.columns')
    .where({ table_name: 'blog_posts', table_schema: 'public' })
    .select('column_name');
  const blogColNames = blogCols.map(c => c.column_name);

  await knex.schema.alterTable('blog_posts', t => {
    if (!blogColNames.includes('scheduled_publish_at')) {
      t.timestamp('scheduled_publish_at');
    }
    if (!blogColNames.includes('auto_share_social')) {
      t.boolean('auto_share_social').defaultTo(true);
    }
    if (!blogColNames.includes('publish_status')) {
      t.string('publish_status', 20);
    }
  });

  // ── social_media_posts: add scheduling columns ──────────────────
  const socialCols = await knex('information_schema.columns')
    .where({ table_name: 'social_media_posts', table_schema: 'public' })
    .select('column_name');
  const socialColNames = socialCols.map(c => c.column_name);

  await knex.schema.alterTable('social_media_posts', t => {
    if (!socialColNames.includes('scheduled_for')) {
      t.timestamp('scheduled_for');
    }
    if (!socialColNames.includes('custom_content')) {
      t.jsonb('custom_content');
    }
    if (!socialColNames.includes('publish_status')) {
      t.string('publish_status', 20);
    }
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('blog_posts', t => {
    t.dropColumn('scheduled_publish_at');
    t.dropColumn('auto_share_social');
    t.dropColumn('publish_status');
  });

  await knex.schema.alterTable('social_media_posts', t => {
    t.dropColumn('custom_content');
    t.dropColumn('publish_status');
    // scheduled_for may have existed before this migration — leave it
  });
};
