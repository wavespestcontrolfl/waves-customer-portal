/**
 * Google Search Console API Service
 *
 * Fetches query/page/device performance, Core Web Vitals, and indexing status.
 * Requires a Google service account with Search Console API access.
 *
 * ENV:
 *   GOOGLE_SERVICE_ACCOUNT_JSON — path to service account key file
 *   GSC_SITE_URL — the verified property URL (e.g. "https://wavespestcontrol.com")
 */

const db = require('../../models/db');
const logger = require('../logger');
const { etDateString, addETDays } = require('../../utils/datetime-et');

// Lazy-load googleapis (~71MB) — only when first GSC method is called
let google;
function getGoogle() {
  if (google === undefined) {
    try { google = require('googleapis').google; } catch { google = null; }
  }
  return google;
}

const DEFAULT_SITE_URL = process.env.GSC_SITE_URL || 'https://www.wavespestcontrol.com/';
const DEFAULT_GSC_REQUEST_TIMEOUT_MS = 30000;

// All 15 Waves network domains — GSC properties to query
// Canonical list lives in normalize-url.js so the GSC sync and the SEO
// allowlist (URL intelligence, sitemap validation) can never diverge.
const { NETWORK_DOMAINS } = require('../../utils/normalize-url');

function normalizeDomain(value) {
  return String(value || DEFAULT_SITE_URL)
    .trim()
    .replace(/^sc-domain:/i, '')
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
}

function siteUrlForDomain(domain) {
  if (!domain) return DEFAULT_SITE_URL;
  const normalized = normalizeDomain(domain);
  if (normalized === normalizeDomain(DEFAULT_SITE_URL)) return DEFAULT_SITE_URL;
  // Spoke domains may be registered as domain properties (sc-domain:) or URL-prefix (https://)
  // Store both formats so syncDailyData can fall back
  return `https://${normalized}/`;
}

function domainPropertyUrl(domain) {
  return `sc-domain:${normalizeDomain(domain)}`;
}

function applyDomainFilter(query, domain) {
  return domain ? query.where('domain', normalizeDomain(domain)) : query;
}

function positiveInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function gscRequestTimeoutMs(value = process.env.GSC_REQUEST_TIMEOUT_MS) {
  return positiveInt(value, DEFAULT_GSC_REQUEST_TIMEOUT_MS);
}

function gscRequestOptions(signal = null) {
  const options = { timeout: gscRequestTimeoutMs() };
  if (signal) options.signal = signal;
  return options;
}

function abortReason(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error(signal?.reason ? String(signal.reason) : 'GSC sync aborted');
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal);
}

// Branded query patterns for Waves
const BRANDED_PATTERNS = [
  /waves/i, /waveguard/i, /wave guard/i, /waves pest/i, /waves lawn/i,
];

// City mapping for query classification
const CITY_PATTERNS = {
  bradenton: /bradenton/i,
  sarasota: /sarasota/i,
  venice: /venice/i,
  parrish: /parrish/i,
  lakewood_ranch: /lakewood\s*ranch/i,
  palmetto: /palmetto/i,
};

// Service mapping for query classification
const SERVICE_PATTERNS = {
  pest: /pest\s*control|exterminator|bug|insect|ant|spider|cockroach|roach/i,
  termite: /termite|termit/i,
  rodent: /rodent|rat|mouse|mice|rat\s*exclusion/i,
  mosquito: /mosquito/i,
  lawn: /lawn|grass|turf|weed|fertiliz/i,
  tree_shrub: /tree|shrub|palm|ornamental/i,
  specialty: /bed\s*bug|flea|tick|wasp|bee|hornet|fire\s*ant/i,
};

class SearchConsoleService {
  constructor() {
    this.auth = null;
    this.webmasters = null;
  }

  async init() {
    if (this.webmasters) return true;
    const g = getGoogle();
    if (!g) {
      logger.warn('googleapis not installed — GSC sync disabled');
      return false;
    }

    try {
      const saEnv = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
      if (!saEnv) {
        logger.warn('GOOGLE_SERVICE_ACCOUNT_JSON not set — GSC sync disabled');
        return false;
      }

      // Support both a JSON string (Railway) and a file path (local dev)
      let authOptions;
      try {
        let jsonStr = saEnv.trim();
        if (jsonStr.startsWith('{') && !jsonStr.endsWith('}')) jsonStr += '\n}';
        const credentials = JSON.parse(jsonStr);
        authOptions = {
          credentials,
          scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
        };
      } catch {
        authOptions = {
          keyFile: saEnv,
          scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
        };
      }

      this.auth = new g.auth.GoogleAuth(authOptions);

      this.webmasters = g.searchconsole({ version: 'v1', auth: this.auth });
      return true;
    } catch (err) {
      logger.error(`GSC init failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Sync daily performance data from GSC.
   * Pulls query-level and page-level data for the given date range.
   */
  async syncDailyData(daysBack = 3, domain = null, options = {}) {
    const { signal = null } = options || {};
    throwIfAborted(signal);

    const ready = await this.init();
    throwIfAborted(signal);
    if (!ready) {
      logger.info('GSC not configured — skipping sync');
      return { synced: false };
    }

    let siteUrl = siteUrlForDomain(domain);
    const normalizedDomain = normalizeDomain(siteUrl);

    const endDate = new Date(Date.now() - 2 * 86400000); // GSC data has 2-day lag
    const startDate = new Date(endDate - daysBack * 86400000);
    const startStr = startDate.toISOString().split('T')[0];
    const endStr = endDate.toISOString().split('T')[0];

    logger.info(`GSC sync: ${startStr} to ${endStr} for ${siteUrl}`);

    try {
      // 1. Query-level data (all devices)
      await this.syncQueries(startStr, endStr, siteUrl, { signal });

      // 2. Page-level data
      await this.syncPages(startStr, endStr, siteUrl, { signal });

      // 3. Device breakdown (sitewide)
      await this.syncDeviceBreakdown(startStr, endStr, siteUrl, { signal });

      // 4. Sitewide totals
      await this.syncSitewideTotals(startStr, endStr, siteUrl, { signal });

      // 5. Query→page mapping (which queries rank on which pages)
      await this.syncQueryPageMap(startStr, endStr, siteUrl, { signal });

      logger.info(`GSC sync complete for ${siteUrl}`);
      return { synced: true, period: { start: startStr, end: endStr }, domain: normalizedDomain, siteUrl };
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') throw err;

      // If URL-prefix property failed with permission error, try domain property format
      const isDomainProp = siteUrl.startsWith('sc-domain:');
      if (!isDomainProp && /permission/i.test(err.message)) {
        const dpUrl = domainPropertyUrl(domain);
        logger.info(`GSC retrying with domain property: ${dpUrl}`);
        try {
          siteUrl = dpUrl;
          await this.syncQueries(startStr, endStr, siteUrl, { signal });
          await this.syncPages(startStr, endStr, siteUrl, { signal });
          await this.syncDeviceBreakdown(startStr, endStr, siteUrl, { signal });
          await this.syncSitewideTotals(startStr, endStr, siteUrl, { signal });
          await this.syncQueryPageMap(startStr, endStr, siteUrl, { signal });
          logger.info(`GSC sync complete for ${siteUrl}`);
          return { synced: true, period: { start: startStr, end: endStr }, domain: normalizedDomain, siteUrl };
        } catch (retryErr) {
          if (signal?.aborted || retryErr?.name === 'AbortError') throw retryErr;
          logger.error(`GSC sync failed for ${siteUrl}: ${retryErr.message}`);
          return { synced: false, error: retryErr.message };
        }
      }

      logger.error(`GSC sync failed for ${siteUrl}: ${err.message}`);
      return { synced: false, error: err.message };
    }
  }

  /**
   * Sync GSC data across ALL network domains.
   */
  async syncAllDomains(daysBack = 3) {
    const results = [];
    for (const domain of NETWORK_DOMAINS) {
      try {
        const r = await this.syncDailyData(daysBack, domain);
        results.push({ domain, ...r });
      } catch (err) {
        results.push({ domain, synced: false, error: err.message });
      }
    }
    return results;
  }

  async syncQueries(startDate, endDate, siteUrl = DEFAULT_SITE_URL, options = {}) {
    const { signal = null } = options || {};
    throwIfAborted(signal);
    const domain = normalizeDomain(siteUrl);
    const response = await this.webmasters.searchanalytics.query({
      siteUrl,
      requestBody: {
        startDate,
        endDate,
        dimensions: ['query', 'date'],
        rowLimit: 5000,
        type: 'web',
      },
    }, gscRequestOptions(signal));

    const rows = response.data.rows || [];
    for (const row of rows) {
      throwIfAborted(signal);
      const query = row.keys[0];
      const date = row.keys[1];
      const isBranded = BRANDED_PATTERNS.some(p => p.test(query));

      await db('gsc_queries')
        .insert({
          query,
          date,
          clicks: row.clicks,
          impressions: row.impressions,
          ctr: row.ctr,
          position: row.position,
          is_branded: isBranded,
          service_category: this.classifyService(query),
          city_target: this.classifyCity(query),
          intent_type: this.classifyIntent(query),
          domain,
        })
        .onConflict(['query', 'date', 'domain'])
        .merge();
    }

    logger.info(`GSC queries synced: ${rows.length} rows for ${domain}`);
  }

  async syncPages(startDate, endDate, siteUrl = DEFAULT_SITE_URL, options = {}) {
    const { signal = null } = options || {};
    throwIfAborted(signal);
    const domain = normalizeDomain(siteUrl);
    const response = await this.webmasters.searchanalytics.query({
      siteUrl,
      requestBody: {
        startDate,
        endDate,
        dimensions: ['page', 'date'],
        rowLimit: 2000,
        type: 'web',
      },
    }, gscRequestOptions(signal));

    const rows = response.data.rows || [];
    for (const row of rows) {
      throwIfAborted(signal);
      const pageUrl = row.keys[0];
      const date = row.keys[1];

      await db('gsc_pages')
        .insert({
          page_url: pageUrl,
          date,
          clicks: row.clicks,
          impressions: row.impressions,
          ctr: row.ctr,
          position: row.position,
          page_type: this.classifyPageType(pageUrl),
          service_category: this.classifyPageService(pageUrl),
          city_target: this.classifyPageCity(pageUrl),
          domain,
        })
        .onConflict(['page_url', 'date', 'domain'])
        .merge();
    }

    logger.info(`GSC pages synced: ${rows.length} rows for ${domain}`);
  }

  async syncDeviceBreakdown(startDate, endDate, siteUrl = DEFAULT_SITE_URL, options = {}) {
    const { signal = null } = options || {};
    throwIfAborted(signal);
    const domain = normalizeDomain(siteUrl);
    const response = await this.webmasters.searchanalytics.query({
      siteUrl,
      requestBody: {
        startDate,
        endDate,
        dimensions: ['device', 'date'],
        type: 'web',
      },
    }, gscRequestOptions(signal));

    const rows = response.data.rows || [];
    for (const row of rows) {
      throwIfAborted(signal);
      const device = row.keys[0].toLowerCase(); // MOBILE, DESKTOP, TABLET
      const date = row.keys[1];

      await db('gsc_performance_daily')
        .insert({
          date,
          device,
          clicks: row.clicks,
          impressions: row.impressions,
          ctr: row.ctr,
          avg_position: row.position,
          domain,
        })
        .onConflict(['date', 'device', 'domain'])
        .merge({
          clicks: row.clicks,
          impressions: row.impressions,
          ctr: row.ctr,
          avg_position: row.position,
          updated_at: new Date(),
        });
    }
  }

  async syncSitewideTotals(startDate, endDate, siteUrl = DEFAULT_SITE_URL, options = {}) {
    const { signal = null } = options || {};
    throwIfAborted(signal);
    const domain = normalizeDomain(siteUrl);
    const response = await this.webmasters.searchanalytics.query({
      siteUrl,
      requestBody: {
        startDate,
        endDate,
        dimensions: ['date'],
        type: 'web',
      },
    }, gscRequestOptions(signal));

    const totalRows = response.data.rows || [];
    throwIfAborted(signal);

    // Query rows are incomplete because GSC anonymizes some query data. Keep the
    // branded/non-brand split as a labeled-query breakdown, but use the true
    // date-level GSC totals for sitewide clicks/impressions/CTR/position.
    const queries = await db('gsc_queries')
      .where('date', '>=', startDate)
      .where('date', '<=', endDate)
      .where('domain', domain);
    throwIfAborted(signal);

    // Group by date
    const byDate = {};
    for (const q of queries) {
      throwIfAborted(signal);
      const d = typeof q.date === 'string' ? q.date.split('T')[0] : new Date(q.date).toISOString().split('T')[0];
      if (!byDate[d]) byDate[d] = { branded_clicks: 0, branded_impressions: 0, nonbrand_clicks: 0, nonbrand_impressions: 0 };
      if (q.is_branded) {
        byDate[d].branded_clicks += q.clicks;
        byDate[d].branded_impressions += q.impressions;
      } else {
        byDate[d].nonbrand_clicks += q.clicks;
        byDate[d].nonbrand_impressions += q.impressions;
      }
    }

    for (const row of totalRows) {
      throwIfAborted(signal);
      const date = row.keys[0];
      const data = byDate[date] || {
        branded_clicks: 0,
        branded_impressions: 0,
        nonbrand_clicks: 0,
        nonbrand_impressions: 0,
      };
      const labeledClicks = data.branded_clicks + data.nonbrand_clicks;
      const labeledImpressions = data.branded_impressions + data.nonbrand_impressions;

      const record = {
        clicks: row.clicks || 0,
        impressions: row.impressions || 0,
        ctr: row.ctr || 0,
        avg_position: row.position || null,
        branded_clicks: data.branded_clicks,
        branded_impressions: data.branded_impressions,
        nonbrand_clicks: data.nonbrand_clicks,
        nonbrand_impressions: data.nonbrand_impressions,
        metadata: {
          source: 'searchanalytics_date_total',
          labeledClicks,
          labeledImpressions,
          hiddenClicks: Math.max(0, (row.clicks || 0) - labeledClicks),
          hiddenImpressions: Math.max(0, (row.impressions || 0) - labeledImpressions),
        },
      };

      await db('gsc_performance_daily')
        .insert({ date, device: 'all', domain, ...record })
        .onConflict(['date', 'device', 'domain'])
        .merge({ ...record, updated_at: new Date() });
    }
  }

  async syncQueryPageMap(startDate, endDate, siteUrl = DEFAULT_SITE_URL, options = {}) {
    const { signal = null } = options || {};
    throwIfAborted(signal);
    const domain = normalizeDomain(siteUrl);
    try {
      const response = await this.webmasters.searchanalytics.query({
        siteUrl,
        requestBody: {
          startDate,
          endDate,
          dimensions: ['date', 'query', 'page'],
          rowLimit: 25000,
          type: 'web',
        },
      }, gscRequestOptions(signal));

      const rows = response.data.rows || [];
      throwIfAborted(signal);
      await db.transaction(async (trx) => {
        throwIfAborted(signal);
        await trx('gsc_query_page_map')
          .where('domain', domain)
          .where('date_from', '<=', endDate)
          .where('date_to', '>=', startDate)
          .del();

        for (const row of rows) {
          throwIfAborted(signal);
          const date = row.keys[0];
          const query = row.keys[1];
          const pageUrl = row.keys[2];

          await trx('gsc_query_page_map')
            .insert({
              query,
              page_url: pageUrl,
              domain,
              clicks: row.clicks || 0,
              impressions: row.impressions || 0,
              ctr: row.ctr || 0,
              position: row.position || 0,
              date_from: date,
              date_to: date,
            })
            .onConflict(['query', 'page_url', 'domain', 'date_from'])
            .merge({ clicks: row.clicks || 0, impressions: row.impressions || 0, ctr: row.ctr || 0, position: row.position || 0, date_to: date, updated_at: new Date() });
        }
      });

      logger.info(`GSC query-page map synced: ${rows.length} daily rows for ${domain}`);
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') throw err;
      logger.warn(`GSC query-page map sync failed for ${domain}: ${err.message}`);
    }
  }

  // ── Classification helpers ──────────────────────────────────────

  classifyService(query) {
    for (const [cat, pattern] of Object.entries(SERVICE_PATTERNS)) {
      if (pattern.test(query)) return cat;
    }
    return null;
  }

  classifyCity(query) {
    for (const [city, pattern] of Object.entries(CITY_PATTERNS)) {
      if (pattern.test(query)) return city;
    }
    if (/near me/i.test(query)) return 'local_intent';
    return null;
  }

  classifyIntent(query) {
    if (/emergency|urgent|asap|24.?hour|same.?day/i.test(query)) return 'emergency';
    if (/cost|price|how much|cheap|affordable/i.test(query)) return 'commercial';
    if (/how to|what is|diy|get rid/i.test(query)) return 'informational';
    if (BRANDED_PATTERNS.some(p => p.test(query))) return 'navigational';
    return 'service';
  }

  classifyPageType(url) {
    const path = new URL(url, DEFAULT_SITE_URL).pathname.toLowerCase();
    if (path === '/' || path === '') return 'homepage';
    if (/blog|article|news/i.test(path)) return 'blog';
    for (const [, pattern] of Object.entries(CITY_PATTERNS)) {
      if (pattern.test(path)) return 'city';
    }
    for (const [, pattern] of Object.entries(SERVICE_PATTERNS)) {
      if (pattern.test(path)) return 'service';
    }
    return 'landing';
  }

  classifyPageService(url) {
    const path = new URL(url, DEFAULT_SITE_URL).pathname.toLowerCase();
    for (const [cat, pattern] of Object.entries(SERVICE_PATTERNS)) {
      if (pattern.test(path)) return cat;
    }
    return null;
  }

  classifyPageCity(url) {
    const path = new URL(url, DEFAULT_SITE_URL).pathname.toLowerCase();
    for (const [city, pattern] of Object.entries(CITY_PATTERNS)) {
      if (pattern.test(path)) return city;
    }
    return null;
  }

  /**
   * Get aggregated GSC data for a period (used by SEO advisor and dashboard).
   * @param {number} periodDays — number of days to look back
   * @param {string|null} domain — filter to a specific domain (e.g., 'bradentonflpestcontrol.com'), or null for all/default
   */
  async getPerformanceSummary(periodDays = 28, domain = null) {
    const since = etDateString(addETDays(new Date(), -periodDays));
    const prevSince = etDateString(addETDays(new Date(), -periodDays * 2));

    // Current period sitewide
    const current = await applyDomainFilter(db('gsc_performance_daily')
      .where('date', '>=', since)
      .where('device', 'all'), domain);

    const previous = await applyDomainFilter(db('gsc_performance_daily')
      .where('date', '>=', prevSince)
      .where('date', '<', since)
      .where('device', 'all'), domain);

    const sum = (rows) => ({
      clicks: rows.reduce((s, r) => s + (r.clicks || 0), 0),
      impressions: rows.reduce((s, r) => s + (r.impressions || 0), 0),
      brandedClicks: rows.reduce((s, r) => s + (r.branded_clicks || 0), 0),
      nonbrandClicks: rows.reduce((s, r) => s + (r.nonbrand_clicks || 0), 0),
      brandedImpressions: rows.reduce((s, r) => s + (r.branded_impressions || 0), 0),
      nonbrandImpressions: rows.reduce((s, r) => s + (r.nonbrand_impressions || 0), 0),
    });

    const cur = sum(current);
    const prev = sum(previous);

    cur.ctr = cur.impressions > 0 ? cur.clicks / cur.impressions : 0;
    prev.ctr = prev.impressions > 0 ? prev.clicks / prev.impressions : 0;

    // Top queries
    const topQueries = await applyDomainFilter(db('gsc_queries')
      .where('date', '>=', since), domain)
      .select('query', 'is_branded', 'service_category', 'city_target')
      .sum('clicks as clicks')
      .sum('impressions as impressions')
      .avg('position as avg_position')
      .groupBy('query', 'is_branded', 'service_category', 'city_target')
      .orderBy('clicks', 'desc')
      .limit(50);

    // Top pages
    const topPages = await applyDomainFilter(db('gsc_pages')
      .where('date', '>=', since), domain)
      .select('page_url', 'page_type', 'service_category', 'city_target')
      .sum('clicks as clicks')
      .sum('impressions as impressions')
      .avg('position as avg_position')
      .groupBy('page_url', 'page_type', 'service_category', 'city_target')
      .orderBy('clicks', 'desc')
      .limit(30);

    // Device breakdown
    const devices = await applyDomainFilter(db('gsc_performance_daily')
      .where('date', '>=', since), domain)
      .whereNot('device', 'all')
      .select('device')
      .sum('clicks as clicks')
      .sum('impressions as impressions')
      .groupBy('device');

    // Page 2 opportunities (positions 4-15)
    const opportunities = await applyDomainFilter(db('gsc_queries')
      .where('date', '>=', since), domain)
      .where('is_branded', false)
      .select('query', 'service_category', 'city_target')
      .sum('clicks as clicks')
      .sum('impressions as impressions')
      .avg('position as avg_position')
      .groupBy('query', 'service_category', 'city_target')
      .havingRaw('avg(position) >= 4 AND avg(position) <= 15')
      .orderBy('impressions', 'desc')
      .limit(20);

    // Queries losing clicks (compare periods)
    const prevQueries = await applyDomainFilter(db('gsc_queries')
      .where('date', '>=', prevSince)
      .where('date', '<', since), domain)
      .select('query')
      .sum('clicks as clicks')
      .groupBy('query');

    const prevQueryMap = {};
    prevQueries.forEach(q => { prevQueryMap[q.query] = parseInt(q.clicks); });

    const declining = topQueries
      .filter(q => {
        const prevClicks = prevQueryMap[q.query] || 0;
        return prevClicks > 0 && parseInt(q.clicks) < prevClicks * 0.8;
      })
      .map(q => ({
        query: q.query,
        currentClicks: parseInt(q.clicks),
        previousClicks: prevQueryMap[q.query],
        changePct: Math.round(((parseInt(q.clicks) - prevQueryMap[q.query]) / prevQueryMap[q.query]) * 100),
      }))
      .slice(0, 10);

    // CWV
    const cwv = await db('gsc_core_web_vitals')
      .orderBy('date', 'desc')
      .limit(10);

    // Indexing issues
    const indexIssues = await db('gsc_indexing_issues')
      .where('status', 'active')
      .orderBy('last_seen', 'desc');

    return {
      current: cur,
      previous: prev,
      change: {
        clicks: prev.clicks > 0 ? Math.round(((cur.clicks - prev.clicks) / prev.clicks) * 100) : 0,
        impressions: prev.impressions > 0 ? Math.round(((cur.impressions - prev.impressions) / prev.impressions) * 100) : 0,
        nonbrandClicks: prev.nonbrandClicks > 0 ? Math.round(((cur.nonbrandClicks - prev.nonbrandClicks) / prev.nonbrandClicks) * 100) : 0,
      },
      topQueries,
      topPages,
      devices,
      opportunities,
      declining,
      cwv,
      indexIssues,
      period: { days: periodDays, since },
    };
  }
}

module.exports = new SearchConsoleService();
