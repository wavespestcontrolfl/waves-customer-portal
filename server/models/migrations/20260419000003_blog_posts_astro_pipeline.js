/**
 * Migration — blog_posts v2 columns + astro publish pipeline state.
 *
 * Adds:
 *   - v2 frontmatter fields (author_slug, reviewer_slug, fact_checked_by,
 *     category, post_type, service_areas_tag jsonb, related_services jsonb,
 *     hero_image_alt, reading_time_min)
 *   - Astro publish workflow state (astro_status enum, PR + branch refs,
 *     Cloudflare Pages preview URL, live URL, error + timestamps)
 *
 * `astro_status` lifecycle (driven by astro-publisher + pages-poll worker):
 *   draft           → no PR open yet
 *   pr_open         → PR created, Cloudflare building
 *   build_failed    → preview build failed (fixable, retry via re-publish)
 *   merged          → PR merged to main (transient — clears when live seen)
 *   live            → hub/spoke production build seen the post
 *   publish_failed  → GitHub commit/PR creation itself blew up (auth, conflict)
 *
 * `wordpress_post_id` is kept intentionally — legacy WP publish path is
 * being retired over the next 5–10 posts; removal is a follow-up PR.
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('blog_posts', (t) => {
    // v2 byline + authority
    t.string('author_slug');
    t.string('reviewer_slug');
    t.string('fact_checked_by');

    // v2 taxonomy
    t.string('category');
    t.string('post_type');
    t.jsonb('service_areas_tag');
    t.jsonb('related_services');

    // v2 hero metadata (featured_image_url already exists for hero src)
    t.string('hero_image_alt');
    t.integer('reading_time_min');

    // Astro publish pipeline state
    t.string('astro_status', 20).defaultTo('draft');
    t.integer('astro_pr_number');
    t.string('astro_branch_name');
    t.string('astro_commit_sha');
    t.text('astro_preview_url');
    t.text('astro_live_url');
    t.text('astro_publish_error');
    t.timestamp('astro_published_at');
    t.timestamp('astro_merged_at');

    t.index('astro_status');
    t.index('author_slug');
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('blog_posts', (t) => {
    t.dropIndex('astro_status');
    t.dropIndex('author_slug');
    t.dropColumn('author_slug');
    t.dropColumn('reviewer_slug');
    t.dropColumn('fact_checked_by');
    t.dropColumn('category');
    t.dropColumn('post_type');
    t.dropColumn('service_areas_tag');
    t.dropColumn('related_services');
    t.dropColumn('hero_image_alt');
    t.dropColumn('reading_time_min');
    t.dropColumn('astro_status');
    t.dropColumn('astro_pr_number');
    t.dropColumn('astro_branch_name');
    t.dropColumn('astro_commit_sha');
    t.dropColumn('astro_preview_url');
    t.dropColumn('astro_live_url');
    t.dropColumn('astro_publish_error');
    t.dropColumn('astro_published_at');
    t.dropColumn('astro_merged_at');
  });
};
