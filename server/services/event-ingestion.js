/**
 * Newsletter event ingestion (P3a). Pulls RSS feeds listed in the
 * event_sources table, normalizes the items into events_raw, and
 * upserts on (source_id, external_id) so re-running is idempotent
 * and edited events get refreshed.
 *
 * Only RSS is implemented in P3a — the iCal handler + Playwright
 * scrape handler land in P3b. event_sources.feed_type guards this:
 * non-rss rows are skipped (with a warn-level log) so the cron can
 * pre-seed iCal/scrape sources without failing.
 *
 * Each pull is bounded by:
 *   - 15s HTTP timeout
 *   - 200 items per feed (most local-news RSS caps at ~20-50; this is
 *     a safety margin against runaway feeds)
 *   - 90 days forward window — events with start_at > now+90d are
 *     dropped on insert (we don't write the customer about an event
 *     three months out)
 *
 * Per-source failure tracking:
 *   - On success: last_pull_status='success', consecutive_failures=0
 *   - On failure: increments consecutive_failures, stores last_error.
 *     The dashboard can render a health badge from this; the cron
 *     does NOT auto-disable a failing source (operator decides).
 */

const db = require('../models/db');
const logger = require('./logger');

let Parser;
try {
  Parser = require('rss-parser');
} catch {
  Parser = null;
}

const HTTP_TIMEOUT_MS = 15000;
const MAX_ITEMS_PER_FEED = 200;
const FORWARD_WINDOW_DAYS = 90;

// Best-effort city extraction from venue / location strings. Falls back
// to null when nothing recognizable. The full geocoding pass lives in
// P3b — this is just enough to populate the dashboard tile's city
// label without a Google Geocoding API call per event.
const KNOWN_CITIES = [
  'tampa', 'st petersburg', 'st pete', 'clearwater', 'gulfport',
  'bradenton', 'palmetto', 'parrish', 'lakewood ranch', 'ellenton',
  'sarasota', 'siesta key', 'longboat key', 'venice', 'nokomis',
  'osprey', 'north port', 'englewood', 'port charlotte', 'punta gorda',
  'wellen park', 'cortez', 'anna maria',
];

function extractCity(text) {
  if (!text || typeof text !== 'string') return null;
  const haystack = text.toLowerCase();
  for (const city of KNOWN_CITIES) {
    if (haystack.includes(city)) return city.replace(/\s+/g, ' ');
  }
  return null;
}

function parseDateOrNull(raw) {
  if (!raw) return null;
  try {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return null;
    return d;
  } catch {
    // `d` is scoped to the try block — return null directly so a single
    // malformed feed date doesn't fail the whole source ingestion run.
    return null;
  }
}

// Allowlist URL protocols. RSS data is external/untrusted; rendering a
// `javascript:` (or `data:`, etc.) URL into an <a href> would execute on
// click. Apply at ingestion boundary so bad URLs never reach the DB,
// AND at render boundary on the client (defense in depth).
function safeHttpUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

// Returns the dedup key for an RSS item. `guid` is the standard but
// some feeds omit it; fall back to `link` then a synthetic hash.
function externalIdFor(item) {
  if (item.guid) return String(item.guid).slice(0, 256);
  if (item.link) return String(item.link).slice(0, 256);
  // Synthetic fallback — lossy but stable enough that re-pulls match.
  return `${(item.title || '').slice(0, 100)}|${item.pubDate || ''}`.slice(0, 256);
}

async function pullRssSource(source) {
  if (!Parser) {
    throw new Error('rss-parser not installed');
  }
  const parser = new Parser({
    timeout: HTTP_TIMEOUT_MS,
    headers: {
      // Some sources block default Node/axios UAs; mimic a browser.
      'User-Agent': 'Mozilla/5.0 (compatible; WavesNewsletterBot/1.0; +https://portal.wavespestcontrol.com)',
    },
  });

  const feed = await parser.parseURL(source.feed_url);
  const items = (feed.items || []).slice(0, MAX_ITEMS_PER_FEED);

  const cutoffMs = Date.now() + FORWARD_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const now = Date.now();

  let upserted = 0;
  let dropped = 0;

  for (const item of items) {
    const start = parseDateOrNull(item.isoDate || item.pubDate);
    // Drop events scheduled more than 90d out (we'd never write about
    // them in a near-term newsletter). NULL start_at is fine — those
    // are evergreen items (ongoing markets, exhibits) we keep.
    if (start && start.getTime() > cutoffMs) { dropped += 1; continue; }
    // Drop events that already happened more than 24h ago. Some RSS
    // feeds publish post-event recaps; we don't want them in tiles.
    if (start && start.getTime() < now - 24 * 60 * 60 * 1000) { dropped += 1; continue; }

    const externalId = externalIdFor(item);
    const title = (item.title || '(untitled)').slice(0, 512);
    const description = item.contentSnippet || item.content || item.summary || null;
    // Reject non-http(s) URLs at the ingestion boundary so a compromised
    // RSS feed can't seed `javascript:` (or other) links into the DB.
    const eventUrl = safeHttpUrl(item.link);
    const imageUrl = safeHttpUrl(item.enclosure?.url || item['itunes:image']?.href);
    const categories = Array.isArray(item.categories) && item.categories.length
      ? JSON.stringify(item.categories.map(String))
      : null;

    // Best-effort city from title + description; falls back to source
    // coverage_geo[0] so the tile always has *something*.
    const city = extractCity(title) || extractCity(description) || (source.coverage_geo?.[0] || null);

    await db('events_raw')
      .insert({
        source_id: source.id,
        external_id: externalId,
        title,
        description,
        start_at: start,
        venue_name: null, // P3b normalizer pulls these from description
        venue_address: null,
        city,
        event_url: eventUrl,
        image_url: imageUrl,
        categories,
      })
      .onConflict(['source_id', 'external_id'])
      .merge({
        title,
        description,
        start_at: start,
        city,
        event_url: eventUrl,
        image_url: imageUrl,
        categories,
        pulled_at: db.fn.now(),
        updated_at: db.fn.now(),
      });

    upserted += 1;
  }

  return { upserted, dropped, total: items.length };
}

async function ingestSource(source) {
  const startedAt = Date.now();
  try {
    if (source.feed_type !== 'rss') {
      // P3a only handles RSS. iCal + scrape land in P3b.
      logger.warn(`[event-ingestion] Skipping ${source.name} — feed_type=${source.feed_type} not implemented in P3a`);
      return { source: source.name, skipped: true };
    }

    const result = await pullRssSource(source);

    await db('event_sources').where({ id: source.id }).update({
      last_pulled_at: db.fn.now(),
      last_pull_status: 'success',
      last_error: null,
      consecutive_failures: 0,
      updated_at: db.fn.now(),
    });

    const ms = Date.now() - startedAt;
    logger.info(
      `[event-ingestion] ${source.name}: ${result.upserted} upserted, ${result.dropped} dropped (window/recap), ${ms}ms`
    );
    return { source: source.name, ...result, ms };
  } catch (err) {
    const ms = Date.now() - startedAt;
    await db('event_sources').where({ id: source.id })
      .update({
        last_pulled_at: db.fn.now(),
        last_pull_status: 'error',
        last_error: String(err.message || err).slice(0, 1024),
        consecutive_failures: db.raw('consecutive_failures + 1'),
        updated_at: db.fn.now(),
      });
    logger.error(`[event-ingestion] ${source.name} FAILED in ${ms}ms: ${err.message}`);
    return { source: source.name, error: err.message, ms };
  }
}

/**
 * Run all enabled sources in priority order. Sources are pulled
 * sequentially (not parallel) — the volume is small (~6-20 sources)
 * and serial keeps log lines coherent + avoids hammering any single
 * shared CDN if multiple feeds happen to be on the same provider.
 */
async function ingestAllEnabledSources() {
  const sources = await db('event_sources')
    .where({ enabled: true })
    .orderBy('priority_tier', 'asc')
    .orderBy('name', 'asc');

  if (!sources.length) {
    logger.info('[event-ingestion] No enabled sources — nothing to do');
    return { sources: 0, results: [] };
  }

  logger.info(`[event-ingestion] Starting pull for ${sources.length} enabled source(s)`);
  const results = [];
  for (const source of sources) {
    results.push(await ingestSource(source));
  }
  const totalUpserted = results.reduce((sum, r) => sum + (r.upserted || 0), 0);
  const failed = results.filter((r) => r.error).length;
  logger.info(
    `[event-ingestion] Done: ${totalUpserted} upserted across ${sources.length} source(s), ${failed} failed`
  );
  return { sources: sources.length, totalUpserted, failed, results };
}

module.exports = {
  ingestAllEnabledSources,
  ingestSource, // exported for ad-hoc admin-triggered pulls
};
