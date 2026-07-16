/**
 * blog_posts.auto_share_social column default true → false.
 *
 * Owner rule: customer-facing sends are opt-IN (2026-07-15 audit finding,
 * owner decision 2026-07-16). Every live write path now passes the value
 * explicitly (scheduleBlogPost), so the column default only gates rows
 * inserted by paths that never consider sharing — those must not inherit a
 * silent yes. Existing rows keep their stored values: posts already
 * scheduled under the old contract are untouched, and this cannot
 * retro-share anything (sharing additionally requires the scheduled-publish
 * flow + shared_to_social=false).
 *
 * Raw SET DEFAULT (not knex .alter(), which rewrites the whole column
 * definition) — only the default changes; type/nullability/values untouched.
 */

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('blog_posts');
  if (!hasTable) return;
  const has = await knex.schema.hasColumn('blog_posts', 'auto_share_social');
  if (has) {
    await knex.raw('ALTER TABLE blog_posts ALTER COLUMN auto_share_social SET DEFAULT false');
  }
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('blog_posts');
  if (!hasTable) return;
  const has = await knex.schema.hasColumn('blog_posts', 'auto_share_social');
  if (has) {
    await knex.raw('ALTER TABLE blog_posts ALTER COLUMN auto_share_social SET DEFAULT true');
  }
};
