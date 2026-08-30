/**
 * Reconcile the one blog_posts row whose planned-era slug shipped a 404 to
 * every social network on 2026-08-29 (autonomous studio link).
 *
 * The post is live on the hub at
 *   https://www.wavespestcontrol.com/pest-control/garage-door-seal-roaches-parrish-fl/
 * but the portal row still carries the pre-publish slug
 * `parrish-garage-door-seal-roach-entry` with astro_status='draft' and no
 * astro_live_url. Stamp the live URL + status the pages-poll worker would
 * have written, so the studio's live-only link gate can use the row again.
 * The slug is left alone (other lanes key refreshes on it).
 */
const SLUG = 'parrish-garage-door-seal-roach-entry';
const LIVE_URL = 'https://www.wavespestcontrol.com/pest-control/garage-door-seal-roaches-parrish-fl/';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('blog_posts'))) return;
  if (!(await knex.schema.hasColumn('blog_posts', 'astro_live_url'))) return;
  await knex('blog_posts')
    .where({ slug: SLUG })
    .whereNull('astro_live_url')
    .update({ astro_live_url: LIVE_URL, astro_status: 'live', updated_at: knex.fn.now() });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('blog_posts'))) return;
  if (!(await knex.schema.hasColumn('blog_posts', 'astro_live_url'))) return;
  await knex('blog_posts')
    .where({ slug: SLUG, astro_live_url: LIVE_URL })
    .update({ astro_live_url: null, astro_status: 'draft', updated_at: knex.fn.now() });
};
