/**
 * Social series intake (owner decision 2026-11-01): the weekly numbered series
 * posts made on the owner's other Mac now reach Facebook, Instagram and Google
 * Business through the portal (routes/social-series-ingest.js) instead of the
 * paid Zernio API. One social_media_posts row per series post, scheduled and
 * published by the existing content scheduler.
 *
 *   video_url        the hosted MP4 of a video post (image_url holds a still post's picture).
 *   gbp_location_ids jsonb array of WAVES_LOCATIONS ids for the GBP channel; NULL = every location.
 *   idx_social_posts_series_guid_unique  one row per series post id (source_guid 'series:<id>'),
 *                    which is what makes a re-sent post idempotent.
 */
exports.up = async function (knex) {
  const cols = await knex('information_schema.columns')
    .where({ table_name: 'social_media_posts', table_schema: 'public' })
    .select('column_name');
  const existing = new Set(cols.map((c) => c.column_name));

  await knex.schema.alterTable('social_media_posts', (t) => {
    if (!existing.has('video_url')) t.string('video_url', 1000);
    if (!existing.has('gbp_location_ids')) t.jsonb('gbp_location_ids');
  });

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_social_posts_series_guid_unique
    ON social_media_posts (source_guid)
    WHERE source_type = 'series'
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_social_posts_series_guid_unique');

  const cols = await knex('information_schema.columns')
    .where({ table_name: 'social_media_posts', table_schema: 'public' })
    .select('column_name');
  const existing = new Set(cols.map((c) => c.column_name));

  await knex.schema.alterTable('social_media_posts', (t) => {
    if (existing.has('video_url')) t.dropColumn('video_url');
    if (existing.has('gbp_location_ids')) t.dropColumn('gbp_location_ids');
  });
};
