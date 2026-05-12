exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('seo_content_qa_scores'))) return;

  await knex.raw(`
    DELETE FROM seo_content_qa_scores older
    USING seo_content_qa_scores newer
    WHERE older.blog_post_id IS NOT NULL
      AND newer.blog_post_id IS NOT NULL
      AND older.blog_post_id = newer.blog_post_id
      AND (
        newer.created_at > older.created_at
        OR (newer.created_at = older.created_at AND newer.id::text > older.id::text)
      )
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS seo_content_qa_scores_blog_post_id_unique
    ON seo_content_qa_scores (blog_post_id)
    WHERE blog_post_id IS NOT NULL
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS seo_content_qa_scores_blog_post_id_unique');
};
