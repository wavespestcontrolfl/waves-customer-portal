/**
 * Event-source residential-proxy egress — 2026-08-04 "Event sources
 * unhealthy" alerts (Visit Sarasota 403×8, Visit St. Pete 403×7, The
 * Gabber XML-parse failures ×3; the failures starved the 2026-08-04
 * newsletter autopilot to a skip at 1/5 eligible events).
 *
 * Diagnosis: all three hosts block the app's DATACENTER egress IP, not
 * its user agent — the same URLs answer 200 to any UA (including the
 * bot UA) from a residential connection, and The Gabber already carries
 * a browser-UA override yet gets served a non-XML challenge page in
 * prod. A UA change therefore can't fix these; only the egress IP can.
 *
 * Repair: opt the three sources into residential-proxy egress via
 * scrape_config.proxy='residential' (handler support ships in the same
 * PR — event-ingestion.js resolveProxyConfig; the gateway itself comes
 * from EVENT_PULL_PROXY_URL, vendor-agnostic). Until that env var is
 * provisioned, opted-in sources degrade to DIRECT pulls with a warning
 * log — behavior identical to today, so this flip is safe to ship ahead
 * of the vendor decision and turnkey once the operator provisions a
 * gateway. Merge-patch preserves any operator-edited keys, same
 * convention as 20260622000001.
 *
 * The two Visit DMOs also get the browser userAgent the scrape handler
 * now honors — through a clean residential exit there is no reason to
 * look like a bot to a WAF that already demonstrated it blocks on
 * reputation signals.
 */

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const PROXIED_FEED_URLS = [
  'https://www.visitsarasota.com/events-festivals',
  'https://www.visitstpeteclearwater.com/events',
  'https://thegabber.com/evofeed',
];

async function mergeScrapeConfig(knex, feedUrl, patch) {
  await knex.raw(
    `UPDATE event_sources
     SET scrape_config = COALESCE(scrape_config, '{}'::jsonb) || ?::jsonb,
         updated_at = now()
     WHERE feed_url = ?`,
    [JSON.stringify(patch), feedUrl],
  );
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('event_sources'))) return;

  await mergeScrapeConfig(knex, 'https://www.visitsarasota.com/events-festivals', {
    proxy: 'residential',
    userAgent: BROWSER_UA,
  });
  await mergeScrapeConfig(knex, 'https://www.visitstpeteclearwater.com/events', {
    proxy: 'residential',
    userAgent: BROWSER_UA,
  });
  // The Gabber keeps its existing browser UA — only the egress changes.
  await mergeScrapeConfig(knex, 'https://thegabber.com/evofeed', {
    proxy: 'residential',
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('event_sources'))) return;

  // Strip only the proxy key — unlike contentSelector-style keys, it IS
  // a behavior change, so down must actually turn it off. userAgent is
  // left in place (harmless, indistinguishable from an operator edit —
  // same convention as 20260622000001).
  // (No jsonb `?` key-exists guard — knex.raw would read it as a binding
  // placeholder; `- 'proxy'` is already a no-op when the key is absent.)
  await knex.raw(
    `UPDATE event_sources
     SET scrape_config = scrape_config - 'proxy',
         updated_at = now()
     WHERE feed_url = ANY(?) AND scrape_config IS NOT NULL`,
    [PROXIED_FEED_URLS],
  );
};
