/**
 * Bring back local Sarasota/Manatee event feeds (owner yes 2026-11-26).
 * Ten sources were off. Each was re-probed on 2026-11-26 with plain GETs
 * (robots.txt read first, declared bot User-Agent, no bot-wall workaround).
 *
 * RE-ENABLED (response parsed through the real pipeline; see the PR body):
 *   - Bradenton Area CVB: the WP REST event post type now carries the real
 *     schedule in meta_fields (eventastic_start_date / _start_time). The
 *     2026-07-11 disable found only publish timestamps. Switched to
 *     feed_type 'json' with the 'eventastic' adapter (event-json-adapters.js):
 *     38 items, 18 one-off events inside the 90-day window.
 *   - Marie Selby Botanical Gardens: the host resets the connection (HTTP/2
 *     PROTOCOL_ERROR, same as the pulls since 2026-10-31) for a User-Agent
 *     that starts "Mozilla/5.0 (compatible; ...Bot" and serves 200 to a
 *     plain self-identifying one. userAgent is now the honest
 *     "WavesNewsletterBot/1.0 (+portal url)"; nothing is spoofed.
 *
 * REPAIRED BUT LEFT OFF (the repaired page parses, but the host's Akamai edge
 * 403'd the datacenter pull in 2026-06 and this was probed from a residential
 * address, so prod reachability is unproven; flip enabled after one pull is
 * seen to work):
 *   - City of North Port: its Events page lists upcoming events in
 *     .events-list-container, past the 25 KB default cut; the container is
 *     pinned (10 events, 2026-12-05 to 2027-05-01).
 *   - City of Sarasota: the stored URL is a 404. The city's own listing is
 *     /Events-directory, same Granicus markup (10 events on page 1 of 2).
 *
 * NOT FIXABLE (no change):
 *   - City of Bradenton: /events is the special-event permit page; the city
 *     publishes no calendar.
 *   - City of Venice: Akamai Access Denied for every path, robots.txt included.
 *   - Visit Sarasota County, Sarasota Chamber, Venice Area Chamber:
 *     Cloudflare Managed Challenge on every path.
 *   - Ringling Museum: page parses, but Cloudflare 403s the prod datacenter
 *     address (since 2026-11-07); unprovable from here.
 *
 * region_zone: every re-enabled row keeps coverage_geo[0] a city that
 * cityToZone maps (bradenton and sarasota, manatee and sarasota zones); items
 * with their own city (palmetto, parrish, cortez) map to manatee too.
 *
 * down() restores the values this migration replaced, by feed_url.
 */
const { recordAuditEvent } = require('../../services/audit-log');

// audit_log.action is varchar(96): `migration:<name>:enabled` must fit.
const MIGRATION = '20261126120000_restore_local_event_feeds';

const HONEST_UA = 'WavesNewsletterBot/1.0 (+https://portal.wavespestcontrol.com)';
const CVB_URL = 'https://www.bradentongulfislands.com/wp-json/wp/v2/event?per_page=100';
const SELBY_URL = 'https://selby.org/events';
const NORTH_PORT_URL = 'https://www.northportfl.gov/Community-Recreation/Events';
const SARASOTA_OLD_URL = 'https://www.sarasotafl.gov/government/parks-recreation-and-natural-resources/events';
const SARASOTA_NEW_URL = 'https://www.sarasotafl.gov/Events-directory';
const LISTING_SELECTOR = '.events-list-container';

async function mergeScrapeConfig(knex, feedUrl, patch) {
  await knex.raw(
    `UPDATE event_sources
     SET scrape_config = COALESCE(scrape_config, '{}'::jsonb) || ?::jsonb, updated_at = now()
     WHERE feed_url = ?`,
    [JSON.stringify(patch), feedUrl],
  );
}

async function removeScrapeConfigKeys(knex, feedUrl, keys) {
  for (const key of keys) {
    await knex.raw(
      `UPDATE event_sources
       SET scrape_config = COALESCE(scrape_config, '{}'::jsonb) - ?::text, updated_at = now()
       WHERE feed_url = ?`,
      [key, feedUrl],
    );
  }
}

// Turn a source on and judge its next pull fresh (old streaks must not count).
async function enableSource(knex, feedUrl, canAudit) {
  const rows = await knex('event_sources').where({ feed_url: feedUrl, enabled: false }).select('id', 'name');
  for (const row of rows) {
    await knex('event_sources').where({ id: row.id }).update({
      enabled: true,
      consecutive_failures: 0,
      consecutive_zero_yields: 0,
      last_error: null,
      updated_at: knex.fn.now(),
    });
    if (!canAudit) continue;
    // audit_log.actor_id is a uuid column: the migration names itself in action + metadata.
    await recordAuditEvent({
      actor_type: 'system',
      action: `migration:${MIGRATION}:enabled`,
      resource_type: 'event_sources',
      resource_id: String(row.id),
      metadata: {
        migration: MIGRATION, source: row.name, feed_url: feedUrl, column: 'enabled', before: false, after: true,
      },
      critical: true,
      trx: knex,
    });
  }
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('event_sources'))) return;
  const canAudit = await knex.schema.hasTable('audit_log');

  // Bradenton Area CVB: JSON adapter in place of the LLM page scrape.
  await knex('event_sources').where({ feed_url: CVB_URL }).update({ feed_type: 'json', updated_at: knex.fn.now() });
  await mergeScrapeConfig(knex, CVB_URL, { jsonAdapter: 'eventastic' });
  await enableSource(knex, CVB_URL, canAudit);

  // Selby: identify honestly; the host drops the "Mozilla/5.0 (compatible; ...Bot" form.
  await mergeScrapeConfig(knex, SELBY_URL, { userAgent: HONEST_UA });
  await enableSource(knex, SELBY_URL, canAudit);

  // North Port and City of Sarasota: repaired, still off (see header).
  await mergeScrapeConfig(knex, NORTH_PORT_URL, { contentSelector: LISTING_SELECTOR, maxHtmlChars: 30000 });
  const sarasotaTaken = await knex('event_sources').where({ feed_url: SARASOTA_NEW_URL }).first('id');
  if (!sarasotaTaken) {
    await knex('event_sources').where({ feed_url: SARASOTA_OLD_URL })
      .update({ feed_url: SARASOTA_NEW_URL, url: SARASOTA_NEW_URL, updated_at: knex.fn.now() });
  }
  await mergeScrapeConfig(knex, SARASOTA_NEW_URL, { contentSelector: LISTING_SELECTOR, maxHtmlChars: 30000 });
};

// Restores the values up() replaced (the seeded/repaired ones recorded in the
// 20260525000002 and 20260611000015 migrations). Rows go back to enabled=false.
exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('event_sources'))) return;

  await knex('event_sources').where({ feed_url: CVB_URL })
    .update({ feed_type: 'scrape', enabled: false, updated_at: knex.fn.now() });
  await removeScrapeConfigKeys(knex, CVB_URL, ['jsonAdapter']);

  await knex('event_sources').where({ feed_url: SELBY_URL }).update({ enabled: false, updated_at: knex.fn.now() });
  await removeScrapeConfigKeys(knex, SELBY_URL, ['userAgent']);

  await mergeScrapeConfig(knex, NORTH_PORT_URL, { contentSelector: null });
  await removeScrapeConfigKeys(knex, NORTH_PORT_URL, ['maxHtmlChars']);

  await mergeScrapeConfig(knex, SARASOTA_NEW_URL, { contentSelector: null });
  await removeScrapeConfigKeys(knex, SARASOTA_NEW_URL, ['maxHtmlChars']);
  const oldTaken = await knex('event_sources').where({ feed_url: SARASOTA_OLD_URL }).first('id');
  if (!oldTaken) {
    await knex('event_sources').where({ feed_url: SARASOTA_NEW_URL })
      .update({ feed_url: SARASOTA_OLD_URL, url: SARASOTA_OLD_URL, updated_at: knex.fn.now() });
  }
};
