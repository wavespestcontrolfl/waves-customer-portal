/**
 * Migration 019 — Social Media Hardening
 *
 * Adds audit trail columns and uniqueness constraints to social_media_posts
 * for the production safety layer before enabling automated posting.
 */

exports.up = async function (knex) {
  const cols = await knex('information_schema.columns')
    .where({ table_name: 'social_media_posts', table_schema: 'public' })
    .select('column_name');
  const existing = new Set(cols.map(c => c.column_name));

  await knex.schema.alterTable('social_media_posts', t => {
    if (!existing.has('ai_model')) t.string('ai_model', 80);
    if (!existing.has('ai_raw_output')) t.text('ai_raw_output');
    if (!existing.has('published_content')) t.jsonb('published_content');
  });


  // Deduplicate existing rows before adding unique indexes.
  // Keep the most recent row for each source_url / source_guid.
  await knex.raw(`
    DELETE FROM social_media_posts a
    USING social_media_posts b
    WHERE a.source_url IS NOT NULL
      AND a.source_type IN ('rss', 'blog_scheduled', 'newsletter')
      AND a.source_url = b.source_url
      AND b.source_type IN ('rss', 'blog_scheduled', 'newsletter')
      AND (a.created_at < b.created_at OR (a.created_at = b.created_at AND a.id < b.id))
  `);
  await knex.raw(`
    DELETE FROM social_media_posts a
    USING social_media_posts b
    WHERE a.source_guid IS NOT NULL
      AND a.source_type IN ('rss', 'blog_scheduled', 'newsletter')
      AND a.source_guid = b.source_guid
      AND b.source_type IN ('rss', 'blog_scheduled', 'newsletter')
      AND (a.created_at < b.created_at OR (a.created_at = b.created_at AND a.id < b.id))
  `);
  // Partial unique indexes for deduplication
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_social_posts_source_url_unique
    ON social_media_posts (source_url)
    WHERE source_url IS NOT NULL AND source_type IN ('rss', 'blog_scheduled', 'newsletter')
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_social_posts_source_guid_unique
    ON social_media_posts (source_guid)
    WHERE source_guid IS NOT NULL AND source_type IN ('rss', 'blog_scheduled', 'newsletter')
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_social_posts_source_url_unique');
  await knex.raw('DROP INDEX IF EXISTS idx_social_posts_source_guid_unique');

  const cols = await knex('information_schema.columns')
    .where({ table_name: 'social_media_posts', table_schema: 'public' })
    .select('column_name');
  const existing = new Set(cols.map(c => c.column_name));

  await knex.schema.alterTable('social_media_posts', t => {
    if (existing.has('ai_model')) t.dropColumn('ai_model');
    if (existing.has('ai_raw_output')) t.dropColumn('ai_raw_output');
    if (existing.has('published_content')) t.dropColumn('published_content');
  });
};
