/**
 * index-status-monitor.js — read-only Google URL Inspection API monitor.
 *
 * Per v3.1 plan: this module ONLY reads. It does not submit URLs to
 * Google. (URL Inspection's `urlInspection.index.inspect` endpoint
 * returns the indexed/indexable status of an already-known URL —
 * it's not a submission endpoint. The actual Indexing API
 * `urlNotifications.publish` is policy-restricted to JobPosting /
 * BroadcastEvent and explicitly out of scope; submission is handled
 * by indexnow-submit.js instead.)
 *
 * Use cases:
 *   - 24h post-publish: did Google index the new URL?
 *   - Coverage diagnostics: which of our city-service pages are
 *     stuck on "Crawled - currently not indexed"?
 *   - Canonical sanity: did Google pick a different canonical than
 *     we declared?
 *
 * Auth: reuses GOOGLE_SERVICE_ACCOUNT_JSON env (already set up for
 * the existing search-console.js service). Requires the
 * `https://www.googleapis.com/auth/webmasters.readonly` scope —
 * grant the service account that scope + add it as Owner in
 * Search Console (one-time operator task).
 */

const db = require('../../models/db');
const logger = require('../logger');

// URL Inspection requires siteUrl to match the verified GSC property
// EXACTLY — URL-prefix properties must keep the trailing slash, and
// the property is verified for the www host (apex is redirect-only).
// The previous default failed inspection out of the box.
const SITE_URL = process.env.GSC_SITE_URL || 'https://www.wavespestcontrol.com/';
const INSPECTION_ENDPOINT = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';

// googleapis is heavy (~71MB) — lazy load only when first needed.
let google;
function getGoogle() {
  if (google === undefined) {
    try { google = require('googleapis').google; }
    catch { google = null; }
  }
  return google;
}

// Reuse the same auth pattern as search-console.js so a single
// credential path serves both. If the existing service module is
// available, delegate auth to it.
let _searchConsole;
function getSearchConsoleAuth() {
  if (_searchConsole !== undefined) return _searchConsole;
  try { _searchConsole = require('./search-console'); }
  catch { _searchConsole = null; }
  return _searchConsole;
}

class IndexStatusMonitor {
  /**
   * Inspect a single URL via URL Inspection API.
   * Returns { ok, coverage_state, indexing_state, canonical_url,
   *           canonical_matches, verdict, raw, error? }.
   * Caller is responsible for any retry/backoff.
   */
  async inspect(url, { fetchFn = fetch } = {}) {
    if (!url || typeof url !== 'string') return { ok: false, error: 'invalid url' };
    const accessToken = await this._getAccessToken();
    if (!accessToken) return { ok: false, error: 'no_access_token' };

    let res;
    try {
      res = await fetchFn(INSPECTION_ENDPOINT, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          inspectionUrl: url,
          siteUrl: SITE_URL,
        }),
      });
    } catch (err) {
      return { ok: false, error: `fetch_failed:${err.message}` };
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 240)}` };
    }

    const data = await res.json();
    return parseInspection(url, data);
  }

  async inspectAndPersist(url, opts = {}) {
    const result = await this.inspect(url, opts);
    if (result.ok) {
      await this._persist(url, result).catch((err) =>
        logger.warn(`[index-status-monitor] persist failed for ${url}: ${err.message}`)
      );
    } else {
      await db('content_index_status').where('url', url).update({
        inspection_checked_at: new Date(),
        inspection_error: result.error,
        updated_at: new Date(),
      }).catch(() => {}); // best-effort; ignore if table missing
    }
    return result;
  }

  /**
   * Bulk-inspect with simple per-call delay to stay under URL Inspection
   * quota (Google currently caps at 600/min/property).
   */
  async inspectMany(urls, { delayMs = 200, fetchFn = fetch } = {}) {
    const out = [];
    for (const url of urls) {
      const result = await this.inspectAndPersist(url, { fetchFn });
      out.push({ url, result });
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }
    return out;
  }

  // ── internals ─────────────────────────────────────────────────────

  async _getAccessToken() {
    // Prefer reusing the existing search-console module's auth so
    // credential setup is shared. Falls back to googleapis client
    // directly if the SC module isn't on this branch.
    const sc = getSearchConsoleAuth();
    if (sc?.getAccessToken) {
      try { return await sc.getAccessToken(); } catch { /* fall through */ }
    }
    const g = getGoogle();
    if (!g) return null;
    const saEnv = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!saEnv) return null;
    try {
      // Mirror search-console.js: accept raw JSON (Railway) OR file
      // path (local dev). The keyFile-only fallback previously failed
      // on Railway with no_access_token because the env var holds the
      // JSON body, not a path.
      const scopes = ['https://www.googleapis.com/auth/webmasters.readonly'];
      let authOptions;
      try {
        let jsonStr = saEnv.trim();
        if (jsonStr.startsWith('{') && !jsonStr.endsWith('}')) jsonStr += '\n}';
        const credentials = JSON.parse(jsonStr);
        authOptions = { credentials, scopes };
      } catch {
        authOptions = { keyFile: saEnv, scopes };
      }
      const auth = new g.auth.GoogleAuth(authOptions);
      const client = await auth.getClient();
      const token = await client.getAccessToken();
      return token?.token || null;
    } catch (err) {
      logger.warn(`[index-status-monitor] auth failed: ${err.message}`);
      return null;
    }
  }

  async _persist(url, result) {
    const updates = {
      inspection_checked_at: new Date(),
      coverage_state: result.coverage_state,
      indexing_state: result.indexing_state,
      canonical_url: result.canonical_url,
      canonical_matches: result.canonical_matches,
      verdict: result.verdict,
      raw_inspection: JSON.stringify(result.raw || {}),
      inspection_error: null,
      updated_at: new Date(),
    };
    const existing = await db('content_index_status').where('url', url).first();
    if (existing) {
      await db('content_index_status').where('url', url).update(updates);
    } else {
      await db('content_index_status').insert({ url, ...updates });
    }
  }
}

// ── pure helper (test-friendly) ──────────────────────────────────────

function parseInspection(url, data) {
  const inspection = data?.inspectionResult?.indexStatusResult;
  if (!inspection) return { ok: false, error: 'no_inspection_result', raw: data };
  // Compare Google's canonical to the PAGE's declared canonical, not
  // the requested URL. Otherwise inspecting a slash/no-slash variant
  // or an alternate entry URL false-alarms as canonical-mismatch.
  const declaredCanonical = inspection.userCanonical || url;
  const googleCanonical = inspection.googleCanonical || null;
  return {
    ok: true,
    coverage_state: inspection.coverageState || null,
    indexing_state: inspection.indexingState || null,
    canonical_url: googleCanonical,
    canonical_matches: googleCanonical ? canonicalsMatch(googleCanonical, declaredCanonical) : true,
    verdict: inspection.verdict || null,
    raw: inspection,
  };
}

function canonicalsMatch(a, b) {
  if (!a || !b) return false;
  return normalizeCanonical(a) === normalizeCanonical(b);
}

function normalizeCanonical(url) {
  return String(url)
    .toLowerCase()
    .replace(/\?.*$/, '')
    .replace(/\/$/, '')
    .replace(/^https?:\/\/(www\.)?/, '');
}

module.exports = new IndexStatusMonitor();
module.exports.IndexStatusMonitor = IndexStatusMonitor;
module.exports._internals = {
  parseInspection,
  canonicalsMatch,
  normalizeCanonical,
  INSPECTION_ENDPOINT,
  SITE_URL,
};
