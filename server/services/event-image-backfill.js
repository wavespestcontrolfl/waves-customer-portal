/**
 * og:image backfill for newsletter events.
 *
 * Most feed sources carry no image, so events_raw.image_url is NULL for the
 * bulk of the pool and the flagship's per-card thumbnails render on only a
 * fraction of cards. This service probes each imageless event's own page
 * for og:image / twitter:image metadata and fills image_url — the same
 * enrichment the 07-28 rescue edition got by hand.
 *
 * Safety model (mirrors event-reverify.js, whose transport it reuses):
 *   - Event pages are feed-controlled URLs, so every fetch goes through
 *     assertPublicHttpUrl (global-unicast allowlist, DNS pinning) and
 *     pinnedGet (wall-clock timeout, 200KiB byte cap, manual redirects).
 *   - The EXTRACTED image url is never fetched server-side — it is stored
 *     and later rendered by the recipient's mail client. It is validated
 *     as http(s), length-bounded, and GIF-shaped urls are rejected
 *     (isLikelyGifUrl — the thumbnail contract is still event art).
 *   - Fill-only: rows are selected with image_url IS NULL and the UPDATE
 *     re-asserts whereNull('image_url'), so a hand-set or feed-provided
 *     image is never overwritten.
 *   - Every probed row gets image_backfill_attempted_at stamped (success
 *     or failure) and is retried at most weekly, so pages with no
 *     og:image don't burn a fetch every run.
 *
 * Kill switch: NEWSLETTER_IMAGE_BACKFILL=false (default ON).
 */

const db = require('../models/db');
const logger = require('./logger');
const { assertPublicHttpUrl, pinnedGet } = require('./event-reverify');
const { isLikelyGifUrl } = require('./newsletter-draft');

const MAX_BATCH = 25;
const MAX_REDIRECTS = 3;
const RETRY_AFTER_DAYS = 7;
const MAX_URL_LEN = 1024; // events_raw.image_url is varchar(1024)

function backfillEnabled() {
  return process.env.NEWSLETTER_IMAGE_BACKFILL !== 'false';
}

/**
 * Pull og:image (preferred) or twitter:image out of a page's HTML.
 * Handles both attribute orders and resolves relative urls against the
 * page url. Returns null unless the result is a plausible still-image
 * http(s) url that fits the column.
 */
// HTML attribute values arrive entity-escaped (&amp; in signed CDN query
// strings is the common case) — decode before URL resolution or the
// stored request carries an `amp;`-prefixed parameter and breaks.
function decodeEntities(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'");
}

function extractImageUrl(html, pageUrl) {
  const head = String(html || '');
  // Walk <meta> tags in DOCUMENT order and bucket by kind, so a page's
  // og:image array keeps its declared priority regardless of how each
  // tag orders its attributes; twitter:image is only a fallback bucket.
  const og = [];
  const twitter = [];
  for (const [tag] of head.matchAll(/<meta\b[^>]*>/gi)) {
    const contentMatch = tag.match(/content=["']([^"']+)["']/i);
    if (!contentMatch) continue;
    if (/property=["']og:image(?::secure_url)?["']/i.test(tag)) og.push(contentMatch[1]);
    else if (/name=["']twitter:image["']/i.test(tag)) twitter.push(contentMatch[1]);
  }
  for (const rawCandidate of [...og, ...twitter]) {
    let candidate = decodeEntities(rawCandidate.trim());
    try {
      candidate = new URL(candidate, pageUrl).toString();
    } catch {
      continue;
    }
    if (!/^https?:\/\//i.test(candidate)) continue;
    if (candidate.length > MAX_URL_LEN) continue; // truncating a url breaks it — skip
    if (isLikelyGifUrl(candidate)) continue;
    return candidate;
  }
  return null;
}

/**
 * Fetch an event page through the pinned transport, following up to
 * MAX_REDIRECTS manually (each hop re-vetted). Returns the body text or
 * null — any refusal, non-2xx, or transport error is simply "no image".
 */
async function fetchPage(rawUrl, { lookup, get = pinnedGet } = {}) {
  let currentUrl = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const check = await assertPublicHttpUrl(currentUrl, lookup ? { lookup } : {});
    if (!check.ok) return null;
    const resp = await get(check.url, check.address, check.family);
    if (resp.status >= 300 && resp.status < 400) {
      if (!resp.location || hop === MAX_REDIRECTS) return null;
      try {
        currentUrl = new URL(resp.location, check.url).toString();
      } catch {
        return null;
      }
      continue;
    }
    if (resp.status < 200 || resp.status >= 300) return null;
    return { text: String(resp.text || ''), finalUrl: check.url };
  }
  return null;
}

/**
 * Backfill a batch of imageless, newsletter-eligible events.
 * Rows are probed oldest-start-first (soonest to feature). Serial on
 * purpose — 25 external fetches once a day needs no concurrency.
 */
async function backfillBatch({ limit = MAX_BATCH, lookup, get, knex = db } = {}) {
  if (!backfillEnabled()) {
    return { processed: 0, filled: 0, skipped: true };
  }
  const retryBefore = new Date(Date.now() - RETRY_AFTER_DAYS * 24 * 60 * 60 * 1000);
  const rows = await knex('events_raw')
    .select('id', 'title', 'event_url')
    .whereNull('image_url')
    .whereNotNull('event_url')
    // Article-mode extraction assigns one roundup article's url to every
    // event it mentions (and deliberately leaves their images null — the
    // article art is ambiguous). Probing a shared url would stamp the
    // SAME article og:image onto all of them, so shared urls are skipped.
    // Only rows that are themselves ACTIVE (same predicates as this
    // outer query) signal the article-roundup ambiguity: merged losers
    // keep their event_url, a recurring event's expired previous
    // occurrence shares its detail url, and rejected siblings are out of
    // the newsletter's pool — none of those should permanently exclude
    // the one active occurrence from backfill.
    .whereNotExists(function sharedUrl() {
      this.select(knex.raw('1'))
        .from('events_raw as dup')
        .whereRaw('dup.event_url = events_raw.event_url')
        .whereRaw('dup.id <> events_raw.id')
        .whereRaw('dup.merged_into IS NULL')
        .whereRaw("dup.admin_status IN ('pending','approved','featured')")
        .whereRaw("(dup.freshness_status IS NULL OR dup.freshness_status NOT IN ('expired','stale_recurring'))")
        .whereRaw('(dup.start_at IS NULL OR dup.start_at >= now())');
    })
    .whereIn('admin_status', ['pending', 'approved', 'featured'])
    .whereNull('merged_into')
    .where((q) => q.whereNull('freshness_status').orWhereNotIn('freshness_status', ['expired', 'stale_recurring']))
    .where((q) => q.whereNull('start_at').orWhere('start_at', '>=', new Date()))
    .where((q) => q.whereNull('image_backfill_attempted_at').orWhere('image_backfill_attempted_at', '<', retryBefore))
    .orderByRaw('start_at ASC NULLS LAST')
    .limit(limit);

  let filled = 0;
  for (const row of rows) {
    let imageUrl = null;
    try {
      const page = await fetchPage(row.event_url, { lookup, get });
      if (page) imageUrl = extractImageUrl(page.text, page.finalUrl);
    } catch (err) {
      logger.warn(`[event-image-backfill] ${row.id} fetch failed: ${err.message}`);
    }
    const now = new Date();
    // Both updates re-assert event_url = the url we actually fetched: a
    // concurrent ingestion run can change the url (clearing image_url and
    // the attempt stamp) between SELECT and UPDATE, and without the guard
    // old-page art could become the new page's poster — or the no-image
    // stamp could re-close a backoff ingestion deliberately re-opened.
    if (imageUrl) {
      // Fill-only: re-assert NULL so a concurrent feed re-pull or admin
      // edit that set an image between SELECT and UPDATE is never clobbered.
      const updated = await knex('events_raw')
        .where({ id: row.id })
        .where('event_url', row.event_url)
        .whereNull('image_url')
        .update({ image_url: imageUrl, image_backfill_attempted_at: now, updated_at: now });
      if (updated) filled += 1;
    } else {
      await knex('events_raw')
        .where({ id: row.id })
        .where('event_url', row.event_url)
        .update({ image_backfill_attempted_at: now });
    }
  }
  logger.info(`[event-image-backfill] Done: ${rows.length} probed, ${filled} filled`);
  return { processed: rows.length, filled, skipped: false };
}

module.exports = {
  backfillEnabled,
  backfillBatch,
  extractImageUrl,
  fetchPage,
};
