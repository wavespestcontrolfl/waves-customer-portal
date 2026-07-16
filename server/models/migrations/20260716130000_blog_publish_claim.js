/**
 * Manual-publish claim marker for blog_posts.
 *
 * publishAstro runs a long external branch/commit/PR workflow and persists
 * astro markers only at the END. The scheduler lane owns rows with
 * publish_status='publishing' during that window, but the manual
 * /publish-astro lane could not reuse that marker — pages-poll treats
 * publishing + pr_open as authorization to AUTO-MERGE, and the admin lane's
 * contract is a human "Approve & Go Live" click. publish_claimed_at is a
 * lane-neutral claim the destructive guards (DELETE / generate / PUT) check
 * and pages-poll never reads; staleness is inherent in the timestamp
 * (claims older than the guard window are ignored), so a crashed publish
 * needs no sweep to unwedge the row.
 */

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('blog_posts');
  if (!hasTable) return;
  const has = await knex.schema.hasColumn('blog_posts', 'publish_claimed_at');
  if (!has) {
    await knex.schema.alterTable('blog_posts', (t) => t.timestamp('publish_claimed_at', { useTz: true }));
  }
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('blog_posts');
  if (!hasTable) return;
  const has = await knex.schema.hasColumn('blog_posts', 'publish_claimed_at');
  if (has) {
    await knex.schema.alterTable('blog_posts', (t) => t.dropColumn('publish_claimed_at'));
  }
};
