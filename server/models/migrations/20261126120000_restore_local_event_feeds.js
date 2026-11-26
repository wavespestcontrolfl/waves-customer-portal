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
 * up() records each touched row's prior values in a side table; down()
 * restores only the fields up() changed, per row, and never turns off a feed
 * that was already on before up(). down() drops the side table.
 */
const { recordAuditEvent } = require('../../services/audit-log');

// audit_log.action is varchar(96): `migration:<name>:enabled` must fit.
const MIGRATION = '20261126120000_restore_local_event_feeds';
const PRIOR_TABLE = 'event_source_restore_20261126';

const HONEST_UA = 'WavesNewsletterBot/1.0 (+https://portal.wavespestcontrol.com)';
const CVB_URL = 'https://www.bradentongulfislands.com/wp-json/wp/v2/event?per_page=100';
const SELBY_URL = 'https://selby.org/events';
const NORTH_PORT_URL = 'https://www.northportfl.gov/Community-Recreation/Events';
const SARASOTA_OLD_URL = 'https://www.sarasotafl.gov/government/parks-recreation-and-natural-resources/events';
const SARASOTA_NEW_URL = 'https://www.sarasotafl.gov/Events-directory';
const LISTING_PATCH = { contentSelector: '.events-list-container', maxHtmlChars: 30000 };

// scrape_config keys up() sets per feed; down() restores exactly these keys.
const CVB_PATCH = { jsonAdapter: 'eventastic' };
const SELBY_PATCH = { userAgent: HONEST_UA };

async function mergeScrapeConfigById(knex, id, patch) {
  await knex.raw(
    `UPDATE event_sources
     SET scrape_config = COALESCE(scrape_config, '{}'::jsonb) || ?::jsonb, updated_at = now()
     WHERE id = ?`,
    [JSON.stringify(patch), id],
  );
}

// Put each patched key back to its recorded value, or remove it when the row
// had no such key before; keys up() never set are left as they are now.
async function restoreScrapeConfigKeys(knex, id, patch, before) {
  const prior = before || {};
  for (const key of Object.keys(patch)) {
    if (Object.prototype.hasOwnProperty.call(prior, key)) {
      await mergeScrapeConfigById(knex, id, { [key]: prior[key] });
    } else {
      await knex.raw(
        `UPDATE event_sources SET scrape_config = COALESCE(scrape_config, '{}'::jsonb) - ?::text, updated_at = now() WHERE id = ?`,
        [key, id],
      );
    }
  }
}

// Record a row's values once, before up() first changes it. A rerun keeps the
// first record, so down() always returns to the state before the first run.
async function recordPrior(knex, row) {
  await knex(PRIOR_TABLE).insert({
    source_id: row.id,
    feed_url_before: row.feed_url,
    url_before: row.url,
    feed_type_before: row.feed_type,
    enabled_before: row.enabled,
    scrape_config_before: JSON.stringify(row.scrape_config || {}),
    consecutive_failures_before: row.consecutive_failures,
    consecutive_zero_yields_before: row.consecutive_zero_yields,
    last_error_before: row.last_error,
  }).onConflict('source_id').ignore();
}

async function findSource(knex, feedUrl) {
  return knex('event_sources').where({ feed_url: feedUrl }).first();
}

// Turn a source on (only if it is off) and judge its next pull fresh.
async function enableSource(knex, row, canAudit) {
  if (row.enabled) return;
  await knex('event_sources').where({ id: row.id }).update({
    enabled: true,
    consecutive_failures: 0,
    consecutive_zero_yields: 0,
    last_error: null,
    updated_at: knex.fn.now(),
  });
  await knex(PRIOR_TABLE).where({ source_id: row.id }).update({ enabled_changed: true });
  if (!canAudit) return;
  // audit_log.actor_id is a uuid column: the migration names itself in action + metadata.
  await recordAuditEvent({
    actor_type: 'system',
    action: `migration:${MIGRATION}:enabled`,
    resource_type: 'event_sources',
    resource_id: String(row.id),
    metadata: {
      migration: MIGRATION, source: row.name, feed_url: row.feed_url, column: 'enabled', before: false, after: true,
    },
    critical: true,
    trx: knex,
  });
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('event_sources'))) return;
  const canAudit = await knex.schema.hasTable('audit_log');
  if (!(await knex.schema.hasTable(PRIOR_TABLE))) {
    await knex.schema.createTable(PRIOR_TABLE, (t) => {
      t.uuid('source_id').primary();
      t.text('feed_url_before');
      t.text('url_before');
      t.string('feed_type_before', 16);
      t.boolean('enabled_before');
      t.jsonb('scrape_config_before');
      t.integer('consecutive_failures_before');
      t.integer('consecutive_zero_yields_before');
      t.text('last_error_before');
      t.boolean('enabled_changed').notNullable().defaultTo(false);
      t.boolean('feed_type_changed').notNullable().defaultTo(false);
      t.boolean('renamed').notNullable().defaultTo(false);
    });
  }

  // Bradenton Area CVB: JSON adapter in place of the LLM page scrape.
  const cvb = await findSource(knex, CVB_URL);
  if (cvb) {
    await recordPrior(knex, cvb);
    if (cvb.feed_type !== 'json') {
      await knex('event_sources').where({ id: cvb.id }).update({ feed_type: 'json', updated_at: knex.fn.now() });
      await knex(PRIOR_TABLE).where({ source_id: cvb.id }).update({ feed_type_changed: true });
    }
    await mergeScrapeConfigById(knex, cvb.id, CVB_PATCH);
    await enableSource(knex, cvb, canAudit);
  }

  // Selby: identify honestly; the host drops the "Mozilla/5.0 (compatible; ...Bot" form.
  const selby = await findSource(knex, SELBY_URL);
  if (selby) {
    await recordPrior(knex, selby);
    await mergeScrapeConfigById(knex, selby.id, SELBY_PATCH);
    await enableSource(knex, selby, canAudit);
  }

  // North Port and City of Sarasota: repaired, still off (see header).
  const northPort = await findSource(knex, NORTH_PORT_URL);
  if (northPort) {
    await recordPrior(knex, northPort);
    await mergeScrapeConfigById(knex, northPort.id, LISTING_PATCH);
  }

  // Only the row that holds the old (404) URL is renamed, and only when no
  // other row already owns the new URL; that other row is left untouched.
  const sarasota = await findSource(knex, SARASOTA_OLD_URL);
  const newUrlOwner = await findSource(knex, SARASOTA_NEW_URL);
  if (sarasota && !newUrlOwner) {
    await recordPrior(knex, sarasota);
    await knex('event_sources').where({ id: sarasota.id })
      .update({ feed_url: SARASOTA_NEW_URL, url: SARASOTA_NEW_URL, updated_at: knex.fn.now() });
    await knex(PRIOR_TABLE).where({ source_id: sarasota.id }).update({ renamed: true });
    await mergeScrapeConfigById(knex, sarasota.id, LISTING_PATCH);
  }
};

// Restores, per recorded row, only what up() changed: feed_type and the
// scrape_config keys it set, the rename, and enabled (plus the health fields it
// reset) only where up() turned the feed on. A feed that was already on before
// up() is never turned off.
exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('event_sources'))) return;
  if (!(await knex.schema.hasTable(PRIOR_TABLE))) return;

  const patchByUrl = {
    [CVB_URL]: CVB_PATCH,
    [SELBY_URL]: SELBY_PATCH,
    [NORTH_PORT_URL]: LISTING_PATCH,
    [SARASOTA_OLD_URL]: LISTING_PATCH,
  };
  const priors = await knex(PRIOR_TABLE).select('*');
  for (const prior of priors) {
    const patch = patchByUrl[prior.feed_url_before];
    if (patch) await restoreScrapeConfigKeys(knex, prior.source_id, patch, prior.scrape_config_before);

    const restore = { updated_at: knex.fn.now() };
    if (prior.feed_type_changed) restore.feed_type = prior.feed_type_before;
    if (prior.enabled_changed) {
      restore.enabled = prior.enabled_before;
      restore.consecutive_failures = prior.consecutive_failures_before;
      restore.consecutive_zero_yields = prior.consecutive_zero_yields_before;
      restore.last_error = prior.last_error_before;
    }
    if (prior.renamed) {
      const oldTaken = await knex('event_sources').where({ feed_url: prior.feed_url_before }).whereNot({ id: prior.source_id }).first('id');
      if (!oldTaken) {
        restore.feed_url = prior.feed_url_before;
        restore.url = prior.url_before;
      }
    }
    await knex('event_sources').where({ id: prior.source_id }).update(restore);
  }
  await knex.schema.dropTable(PRIOR_TABLE);
};
