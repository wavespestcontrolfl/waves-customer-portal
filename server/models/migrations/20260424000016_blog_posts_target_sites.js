/**
 * Per-post site targeting for the Astro spoke fleet.
 *
 * Before: every blog_posts row committed into the shared astro repo was
 * picked up by ALL 15 Cloudflare Pages projects — same post, 15 domains,
 * duplicate-content SEO penalty.
 *
 * After: `target_sites` is a JSONB array of site keys. Each spoke's
 * Astro build filters the content collection by this field and excludes
 * posts that don't match its SITE_KEY env var. Legacy posts with NULL /
 * empty `target_sites` render everywhere (backward-compat — no surprise
 * unpublishes when the filter ships).
 *
 * The canonical list of site keys lives in server/services/content-astro/
 * spoke-sites.js so the server frontmatter builder and the client
 * multi-select both stay in lock-step with the Astro repo's SITE_KEY.
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('blog_posts', (t) => {
    t.jsonb('target_sites');
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('blog_posts', (t) => {
    t.dropColumn('target_sites');
  });
};
