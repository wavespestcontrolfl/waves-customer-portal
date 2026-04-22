/**
 * Remove legacy external integrations: Google Calendar sync and the
 * WordPress-named fleet-monitoring table.
 *
 *   1. Drop `scheduled_services.external_booking_id`. This column was
 *      renamed from `square_booking_id` in 20260423000005 to support
 *      Google Calendar event dedup in server/services/calendar-sync.js.
 *      That service has been removed (Google Calendar sync is no longer
 *      part of the portal), so the column is dead.
 *
 *   2. Rename `wordpress_sites` → `fleet_sites`. The 15-site spoke fleet
 *      is now on Astro + Cloudflare Pages; no code publishes to or reads
 *      from WordPress anymore. The table still stores useful fleet
 *      monitoring data (pagespeed, content_status, GBP linkage, etc.)
 *      consumed by the Intelligence Bar SEO tools, so we rename rather
 *      than drop.
 *
 * Both changes are hasColumn/hasTable-guarded so the migration is safe
 * to re-run.
 */

exports.up = async (knex) => {
  if (await knex.schema.hasTable('scheduled_services')) {
    if (await knex.schema.hasColumn('scheduled_services', 'external_booking_id')) {
      await knex.schema.alterTable('scheduled_services', (t) => {
        t.dropColumn('external_booking_id');
      });
    }
  }

  const hasOld = await knex.schema.hasTable('wordpress_sites');
  const hasNew = await knex.schema.hasTable('fleet_sites');
  if (hasOld && !hasNew) {
    await knex.schema.renameTable('wordpress_sites', 'fleet_sites');
  }
};

exports.down = async () => {
  // Irreversible: calendar-sync.js and the WordPress code paths are gone
  // from the repo. Roll forward, not back.
};
