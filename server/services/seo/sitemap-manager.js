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
const MAX_SITEMAPS = 25;
const MAX_SITEMAP_DEPTH = 4;

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
    const originals = await fetchSitemapUrls(sitemapUrl, fetchFn);
    const urls = new Set(originals.map(normalize));
    const entry = { fetchedAt: new Date(), urls, originals };
    this._cache.set(sitemapUrl, entry);
    logger.info(`[sitemap-manager] cached ${urls.size} URLs from ${sitemapUrl}`);
    return entry;
  }
}

// ── pure helpers ─────────────────────────────────────────────────────

/**
 * Extract URLs from a sitemap.xml — supports:
 *   - <urlset><url><loc>...</loc></url></urlset>
 *   - <sitemapindex><sitemap><loc>...</loc></sitemap></sitemapindex>
 * extractUrls/extractRawUrls are intentionally pure single-document
 * parsers. _getCachedOrFetch uses fetchSitemapUrls to recurse indexes.
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
    const raw = decodeXmlText(m[1]);
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

async function fetchSitemapUrls(sitemapUrl, fetchFn, state = { visited: new Set(), depth: 0 }) {
  const resolvedUrl = resolveSitemapUrl(sitemapUrl, sitemapUrl);
  if (!resolvedUrl) return [];
  if (!isHttpUrl(resolvedUrl)) throw new Error(`Unsupported sitemap URL: ${resolvedUrl}`);
  if (state.visited.has(resolvedUrl)) return [];
  const rootUrl = state.rootUrl || resolvedUrl;
  const isRoot = resolvedUrl === rootUrl;
  if (!isRoot && state.visited.size > MAX_SITEMAPS) {
    throw new Error(`Sitemap index limit exceeded (${MAX_SITEMAPS})`);
  }
  if (state.depth > MAX_SITEMAP_DEPTH) {
    throw new Error(`Sitemap depth limit exceeded (${MAX_SITEMAP_DEPTH})`);
  }

  state.visited.add(resolvedUrl);

  const res = await fetchFn(resolvedUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  const locs = extractRawUrls(xml);

  if (!isSitemapIndex(xml)) return locs;

  const urls = [];
  const seen = new Set();
  for (const loc of locs) {
    const childUrl = resolveSitemapUrl(loc, resolvedUrl);
    if (!childUrl) continue;
    if (!isAllowedSitemapChild(childUrl, rootUrl)) continue;
    const childUrls = await fetchSitemapUrls(childUrl, fetchFn, {
      visited: state.visited,
      depth: state.depth + 1,
      rootUrl,
    });
    for (const child of childUrls) {
      if (seen.has(child)) continue;
      seen.add(child);
      urls.push(child);
    }
  }
  return urls;
}

function isSitemapIndex(xml) {
  return /<\s*sitemapindex\b/i.test(String(xml || ''));
}

function resolveSitemapUrl(loc, baseUrl) {
  try {
    return new URL(String(loc || '').trim(), baseUrl).toString();
  } catch {
    return null;
  }
}

function isHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isAllowedSitemapChild(childUrl, rootUrl) {
  try {
    const child = new URL(childUrl);
    const root = new URL(rootUrl);
    const childHost = child.hostname.replace(/^www\./i, '').toLowerCase();
    const rootHost = root.hostname.replace(/^www\./i, '').toLowerCase();
    return isHttpUrl(childUrl) && childHost === rootHost;
  } catch {
    return false;
  }
}

function decodeXmlText(value) {
  return String(value || '')
    .trim()
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
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
  MAX_SITEMAPS,
  MAX_SITEMAP_DEPTH,
  extractUrls,
  extractRawUrls,
  fetchSitemapUrls,
  isSitemapIndex,
  resolveSitemapUrl,
  isAllowedSitemapChild,
  normalize,
};
