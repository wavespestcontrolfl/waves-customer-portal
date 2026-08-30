/**
 * Reconcile the one blog_posts row whose planned-era slug shipped a 404 to
 * every social network on 2026-08-29 (autonomous studio link).
 *
 * The post is live on the hub at
 *   https://www.wavespestcontrol.com/pest-control/garage-door-seal-roaches-parrish-fl/
 * (datePublished 2026-05-26 per the page's JSON-LD) but the portal row still
 * carries the pre-publish slug `parrish-garage-door-seal-roach-entry` with
 * astro_status='draft', no astro_live_url and no astro_published_at. Stamp
 * all three the way the pages-poll worker would have, so the studio's
 * live-only link gate can use the row again and the lifecycle state is
 * complete (post-publish-visibility sweeps key on astro_published_at). The
 * slug is left alone (other lanes key refreshes on it).
 */
const SLUG = 'parrish-garage-door-seal-roach-entry';
const LIVE_URL = 'https://www.wavespestcontrol.com/pest-control/garage-door-seal-roaches-parrish-fl/';
const PUBLISHED_AT = '2026-05-26T00:00:00Z';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('blog_posts'))) return;
  if (!(await knex.schema.hasColumn('blog_posts', 'astro_live_url'))) return;
  await knex('blog_posts')
    .where({ slug: SLUG })
    .whereNull('astro_live_url')
    .update({
      astro_live_url: LIVE_URL,
      astro_status: 'live',
      astro_published_at: knex.raw('COALESCE(astro_published_at, ?::timestamptz)', [PUBLISHED_AT]),
      updated_at: knex.fn.now(),
    });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('blog_posts'))) return;
  if (!(await knex.schema.hasColumn('blog_posts', 'astro_live_url'))) return;
  await knex('blog_posts')
    .where({ slug: SLUG, astro_live_url: LIVE_URL })
    .update({ astro_live_url: null, astro_status: 'draft', astro_published_at: null, updated_at: knex.fn.now() });
};
