/**
 * sitemap-manager.js — verify a URL is in the live sitemap.xml.
 *
 * Used by content-quality-gate.checkSitemapUpdated to confirm the
 * sitemap actually picked up a newly-published URL before the
 * autonomous runner flips the page to live.
 *
 * Astro generates sitemap.xml at build time. After a publish + CF
 * Pages deploy, the new URL should appear within one build cycle.
 * If hasUrl returns false 15+ minutes after merge, the autonomous
 * runner pages-poll a status flag for human review.
 *
 * Simple cache: re-fetch sitemap at most once per 5 minutes per host
 * to avoid hammering CF Pages on every gate check.
 */

const logger = require('../logger');

const DEFAULT_SITEMAP_URL = process.env.SITEMAP_URL || 'https://www.wavespestcontrol.com/sitemap.xml';
const CACHE_TTL_MS = 5 * 60 * 1000;

class SitemapManager {
  constructor() {
    this._cache = new Map(); // sitemapUrl → { fetchedAt, urls: Set }
  }

  /**
   * hasUrl(targetUrl, { sitemapUrl? })
   *
   * Returns { present, sitemap_fetched_at, error? }.
   * Treats sitemap fetch errors as `error` rather than `present: false`
   * so the gate can distinguish "definitely not there" from
   * "couldn't check."
   */
  async hasUrl(targetUrl, { sitemapUrl = DEFAULT_SITEMAP_URL, fetchFn = fetch } = {}) {
    if (!targetUrl) return { present: false, error: 'missing target url' };
    let entry;
    try {
      entry = await this._getCachedOrFetch(sitemapUrl, fetchFn);
    } catch (err) {
      return { present: false, error: `sitemap fetch failed: ${err.message}` };
    }
    const normalized = normalize(targetUrl);
    return {
      present: entry.urls.has(normalized),
      sitemap_fetched_at: entry.fetchedAt,
      total_urls: entry.urls.size,
    };
  }

  /**
   * Return raw <loc> URLs from the cached sitemap (original casing +
   * host preserved). Operator scripts use this for batch URL
   * Inspection — rebuilding URLs from the normalized lookup set
   * stripped `www.` and broke ownership checks on www-verified GSC
   * properties.
   */
  async listUrls({ sitemapUrl = DEFAULT_SITEMAP_URL, limit = null, fetchFn = fetch } = {}) {
    const entry = await this._getCachedOrFetch(sitemapUrl, fetchFn);
    const urls = entry.originals;
    return limit ? urls.slice(0, limit) : urls.slice();
  }

  /**
   * Force a re-fetch on next hasUrl call (e.g. immediately after a
   * deploy). Clears just the targeted sitemap entry — other cached
   * sitemaps stay warm.
   */
  invalidate(sitemapUrl = DEFAULT_SITEMAP_URL) {
    this._cache.delete(sitemapUrl);
  }

  /**
   * Ping Google's sitemap endpoint to nudge a recrawl. Old-school
   * but still functional. Returns { ok, status }. Optional; not
   * required for the gate.
   */
  async pingGoogle(sitemapUrl = DEFAULT_SITEMAP_URL, { fetchFn = fetch } = {}) {
    const pingUrl = `https://www.google.com/ping?sitemap=${encodeURIComponent(sitemapUrl)}`;
    try {
      const res = await fetchFn(pingUrl);
      return { ok: res.ok, status: res.status };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // ── internals ────────────────────────────────────────────────────

  async _getCachedOrFetch(sitemapUrl, fetchFn) {
    const cached = this._cache.get(sitemapUrl);
    if (cached && Date.now() - cached.fetchedAt.getTime() < CACHE_TTL_MS) return cached;
    const res = await fetchFn(sitemapUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const originals = extractRawUrls(xml);
    const urls = new Set(originals.map(normalize));
    const entry = { fetchedAt: new Date(), urls, originals };
    this._cache.set(sitemapUrl, entry);
    logger.info(`[sitemap-manager] cached ${urls.size} URLs from ${sitemapUrl}`);
    return entry;
  }
}

// ── pure helpers ─────────────────────────────────────────────────────

/**
 * Extract URLs from a sitemap.xml — supports both:
 *   - <urlset><url><loc>...</loc></url></urlset>
 *   - <sitemapindex><sitemap><loc>...</loc></sitemap></sitemapindex>
 * For a sitemap index we DON'T recurse here (would explode the cache
 * for sitemap-of-sitemaps cases); caller passes the leaf sitemap URL
 * explicitly when needed. Most Astro builds produce a flat sitemap.
 */
function extractUrls(xml) {
  return new Set(extractRawUrls(xml).map(normalize));
}

function extractRawUrls(xml) {
  const out = [];
  const seen = new Set();
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const raw = m[1];
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

function normalize(url) {
  return String(url || '')
    .trim()
    .toLowerCase()
    .replace(/\?.*$/, '')
    .replace(/#.*$/, '')
    .replace(/\/$/, '')
    .replace(/^https?:\/\/(www\.)?/, '');
}

module.exports = new SitemapManager();
module.exports.SitemapManager = SitemapManager;
module.exports._internals = {
  DEFAULT_SITEMAP_URL,
  CACHE_TTL_MS,
  extractUrls,
  extractRawUrls,
  normalize,
};
