/**
 * indexnow-submit.js — submits URLs to IndexNow.
 *
 * IndexNow (indexnow.org) is a simple ping protocol: tell participating
 * search engines (Bing, Yandex, Seznam, Naver — Cloudflare Pages also
 * relays) that URLs have been added/updated. Zero auth — just a key
 * file at /{key}.txt on the site root.
 *
 * Per v3.1 plan, this is the ONLY supported indexing submission
 * channel. Google's `urlNotifications.publish` is explicitly out of
 * scope (policy-restricted to JobPosting / BroadcastEvent, unreliable
 * for blog/service content). Google URL Inspection is read-only (see
 * index-status-monitor.js).
 *
 * Idempotent: each URL is submitted at most once per 24 hours unless
 * `force=true`. Refresh actions (page already exists) can force
 * resubmit because the content changed.
 *
 * Operator setup tasks:
 *   1. Generate an IndexNow key: `node server/scripts/generate-indexnow-key.js`
 *   2. Commit `public/<key>.txt` (file contents = the key) to the
 *      Astro repo and deploy.
 *   3. Set INDEXNOW_KEY env var on Railway.
 *   4. (Recommended) Enable Cloudflare Pages' built-in IndexNow auto-
 *      submit in the Pages dashboard for wavespestcontrol-astro —
 *      this module becomes belt-and-suspenders.
 */

const db = require('../../models/db');
const logger = require('../logger');

const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';
const DEFAULT_HOST = process.env.INDEXNOW_HOST || 'www.wavespestcontrol.com';
const RESUBMIT_THROTTLE_MS = 24 * 60 * 60 * 1000;

class IndexNowSubmitter {
  /**
   * Submit one URL. Returns { ok, status, throttled?, error? }.
   * status maps to content_index_status.indexnow_status.
   */
  async submit(url, { force = false, fetchFn = fetch } = {}) {
    if (!url || typeof url !== 'string') return { ok: false, status: 'rejected', error: 'invalid url' };
    // IndexNow requires every submitted URL to share the host of the key file.
    // This submitter only holds the hub host + key, so a spoke URL
    // (sarasotaflpestcontrol.com, …) would 422 ("URLs don't match host") and the
    // spoke has no key file anyway. Skip cleanly — spoke posts are still
    // discovered via their sitemap + normal crawl.
    let urlHost = null;
    try { urlHost = new URL(url).hostname.toLowerCase(); } catch { urlHost = null; }
    if (urlHost && urlHost !== String(DEFAULT_HOST).toLowerCase()) {
      return { ok: true, status: 'skipped', reason: 'host_mismatch', host: urlHost };
    }
    if (!process.env.INDEXNOW_KEY) {
      return { ok: false, status: 'rejected', error: 'INDEXNOW_KEY not set' };
    }

    if (!force) {
      const recent = await this._wasRecentlySubmitted(url);
      if (recent) return { ok: true, status: 'ok', throttled: true, last_submitted_at: recent };
    }

    const body = {
      host: DEFAULT_HOST,
      key: process.env.INDEXNOW_KEY,
      keyLocation: `https://${DEFAULT_HOST}/${process.env.INDEXNOW_KEY}.txt`,
      urlList: [url],
    };

    let result;
    try {
      const res = await fetchFn(INDEXNOW_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body),
      });
      result = classifyResponse(res.status, await res.text().catch(() => ''));
    } catch (err) {
      result = { ok: false, status: 'error', error: err.message };
    }

    await this._record(url, result).catch((err) =>
      logger.warn(`[indexnow] persist failed for ${url}: ${err.message}`)
    );
    return result;
  }

  /**
   * Submit a batch of URLs. IndexNow accepts up to 10,000 per call;
   * we batch by 100 conservatively.
   */
  async submitMany(urls, { force = false, fetchFn = fetch, batchSize = 100 } = {}) {
    if (!Array.isArray(urls) || !urls.length) return { ok: true, submitted: 0, results: [] };
    const out = [];
    for (let i = 0; i < urls.length; i += batchSize) {
      const batch = urls.slice(i, i + batchSize);
      // Per-URL submit so the throttle + per-URL DB record both work.
      // Could batch the network call (IndexNow supports urlList of N),
      // but per-URL idempotency matters more than per-call latency.
      for (const u of batch) out.push({ url: u, result: await this.submit(u, { force, fetchFn }) });
    }
    return {
      ok: out.every((r) => r.result.ok),
      submitted: out.filter((r) => r.result.ok && !r.result.throttled).length,
      throttled: out.filter((r) => r.result.throttled).length,
      failed: out.filter((r) => !r.result.ok).length,
      results: out,
    };
  }

  // ── internals ─────────────────────────────────────────────────────

  async _wasRecentlySubmitted(url) {
    try {
      const row = await db('content_index_status').where('url', url).first();
      if (!row?.indexnow_submitted_at) return null;
      const last = new Date(row.indexnow_submitted_at);
      if (Date.now() - last.getTime() < RESUBMIT_THROTTLE_MS) return last;
      return null;
    } catch {
      return null; // table may not exist yet
    }
  }

  async _record(url, result) {
    try {
      // Only stamp submitted_at on success — _wasRecentlySubmitted
      // dedupes on this timestamp, so recording it for rate_limited /
      // rejected / error responses would silently block retries for
      // 24h on transient 429/5xx and stall indexing recovery. Status,
      // error, and attempt count still record the failed try for ops.
      const updates = {
        ...(result.ok ? { indexnow_submitted_at: new Date() } : {}),
        indexnow_status: result.status,
        indexnow_last_error: result.error || null,
        updated_at: new Date(),
      };
      const existing = await db('content_index_status').where('url', url).first();
      if (existing) {
        await db('content_index_status')
          .where('url', url)
          .update({
            ...updates,
            indexnow_submit_count: (existing.indexnow_submit_count || 0) + 1,
          });
      } else {
        await db('content_index_status').insert({
          url,
          ...updates,
          indexnow_submit_count: 1,
        });
      }
    } catch (err) {
      // 42P01 (missing table) gets caught higher up; rethrow other errors.
      if (err.code !== '42P01') throw err;
    }
  }
}

// ── pure helper (test-friendly) ──────────────────────────────────────

function classifyResponse(status, body) {
  // IndexNow returns:
  //   200 — accepted
  //   202 — accepted (Bing-specific)
  //   400 — bad request (malformed url/key)
  //   403 — key not valid (file not found or doesn't match)
  //   422 — URLs don't match host
  //   429 — too many requests
  if (status === 200 || status === 202) return { ok: true, status: 'ok' };
  if (status === 429) return { ok: false, status: 'rate_limited' };
  if (status === 403 || status === 422 || status === 400) {
    return { ok: false, status: 'rejected', error: `HTTP ${status}: ${body.slice(0, 200)}` };
  }
  return { ok: false, status: 'error', error: `HTTP ${status}: ${body.slice(0, 200)}` };
}

module.exports = new IndexNowSubmitter();
module.exports.IndexNowSubmitter = IndexNowSubmitter;
module.exports._internals = {
  INDEXNOW_ENDPOINT,
  RESUBMIT_THROTTLE_MS,
  classifyResponse,
};
