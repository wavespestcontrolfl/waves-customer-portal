/**
 * protected-pages.js — the do-not-auto-optimize guard. Keeps the autonomous
 * content engine off money pages, high-traffic pages, high-conversion pages,
 * and anything manually protected.
 *
 * Two layers:
 *   1. URL PATTERNS (deterministic, no DB): the pest-control city-hub and
 *      quote-page families are top-of-site money pages and are ALWAYS
 *      protected, even if the facts-bank says they're optimizable. This is the
 *      layer that blocks e.g. /pest-control-sarasota-fl/ (a top-5 site URL)
 *      even though "sarasota + pest-control" passes facts sufficiency.
 *   2. REGISTRY (protected_pages table): data-driven (auto-populated from
 *      high-traffic GSC pages) + manual entries that patterns can't express.
 *
 * The autonomous-runner calls isProtected() as its first pre-gate; protected
 * opportunities are routed to human review, never drafted.
 */

const logger = require('../logger');
const { etDateString, addETDays } = require('../../utils/datetime-et');

// Money-page URL families (matched against the normalized path). The
// quote pattern is checked first so its reason is labelled precisely; both
// resolve to money_page protection.
const MONEY_PAGE_PATTERNS = [
  { re: /^pest-control-quote-[a-z0-9-]+-fl$/, label: 'pest-control quote page' },
  { re: /^pest-control-[a-z0-9-]+-fl$/, label: 'pest-control city hub' },
];

// 28-day impressions → auto high_traffic. Set to 500 (not 5000) because the
// current GSC window is thin: high-traffic service spokes like
// /rodent-control-sarasota-fl/ (~770 imp/28d) must be protected from
// auto-optimization even though they're below the original threshold. Money
// pages are protected by the pattern layer regardless. Tunable via --threshold.
const DEFAULT_IMPRESSION_THRESHOLD = 500;

// Normalize a URL or path to a bare lowercase path: strip protocol+host,
// query/hash, and leading/trailing slashes.
function normalizePath(url) {
  return String(url || '')
    .replace(/^https?:\/\/[^/]+/i, '')
    .replace(/[?#].*$/, '')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase();
}

/**
 * isProtectedByPattern(url) → { protected, reason, detail } | { protected:false }
 * Pure — no DB. Catches the money-page families.
 */
function isProtectedByPattern(url) {
  const path = normalizePath(url);
  if (!path) return { protected: false };
  for (const { re, label } of MONEY_PAGE_PATTERNS) {
    if (re.test(path)) {
      return { protected: true, reason: 'money_page', source: 'pattern', detail: label };
    }
  }
  return { protected: false };
}

/**
 * isProtected(url, { db }) → { protected, reason, source, detail }
 * Pattern check first (no DB), then the registry. Fails CLOSED on a registry
 * read error: if we can't confirm a URL is unprotected, treat it as protected
 * (reason protected_check_error) so a transient DB blip can never expose a
 * manually- or high-traffic-protected page to auto-optimization. The runner
 * routes protected_check_error opportunities to human review.
 */
async function isProtected(url, { db } = {}) {
  const byPattern = isProtectedByPattern(url);
  if (byPattern.protected) return byPattern;

  if (db) {
    const path = normalizePath(url);
    try {
      // NOTE: the host-strip regex uses `https{0,1}`, NOT `https?`. A literal
      // `?` inside a knex whereRaw string is parsed as a positional bind
      // placeholder — alongside the real `?` for `path`, knex saw 2 placeholders
      // for 1 binding and threw ("Expected 1 bindings, saw 2"). This function
      // caught that and fail-closed as protected_check_error for EVERY URL not
      // already matched by the pattern check, silently parking all refresh/edit
      // opportunities for review. `https{0,1}` is the regex-equivalent of
      // `https?` with no literal `?`.
      const row = await db('protected_pages')
        .whereRaw('LOWER(?) = LOWER(regexp_replace(regexp_replace(page_url, \'^https{0,1}://[^/]+\', \'\'), \'^/+|/+$\', \'\', \'g\'))', [path])
        .first();
      if (row) {
        return { protected: true, reason: row.reason, source: 'registry', detail: row.notes || null };
      }
    } catch (err) {
      logger.warn(`[protected-pages] registry check failed for ${url}: ${err.message} — failing closed`);
      return { protected: true, reason: 'protected_check_error', source: 'error', detail: err.message };
    }
  }
  return { protected: false };
}

// ── registry CRUD ───────────────────────────────────────────────────

async function add({ db, pageUrl, reason = 'manual', addedBy = 'manual', notes = null, signalMetadata = {} }) {
  if (!db) throw new Error('protected-pages.add: db required');
  if (!pageUrl) throw new Error('protected-pages.add: pageUrl required');
  const [row] = await db('protected_pages')
    .insert({
      page_url: pageUrl,
      reason,
      added_by: addedBy,
      notes,
      signal_metadata: JSON.stringify(signalMetadata || {}),
      updated_at: new Date(),
    })
    .onConflict('page_url')
    .merge({ reason, notes, added_by: addedBy, signal_metadata: JSON.stringify(signalMetadata || {}), updated_at: new Date() })
    .returning('*');
  return row;
}

async function remove({ db, pageUrl }) {
  if (!db) throw new Error('protected-pages.remove: db required');
  return db('protected_pages').where('page_url', pageUrl).del();
}

async function list({ db, reason = null } = {}) {
  if (!db) throw new Error('protected-pages.list: db required');
  let q = db('protected_pages').orderBy('created_at', 'desc');
  if (reason) q = q.where('reason', reason);
  return q.select('*');
}

/**
 * autoPopulate({ db, impressionThreshold, periodDays }) — scans gsc_pages and
 * adds high-traffic pages to the registry. Money-page families don't need
 * registry entries (the pattern layer covers them) but are added too so they
 * show up in the dashboard list. Returns counts.
 *
 * NOTE: high_conversion auto-population is deferred until per-page conversion
 * attribution exists (the conversion miner currently aggregates by city x
 * service, not per URL).
 */
async function autoPopulate({ db, impressionThreshold = DEFAULT_IMPRESSION_THRESHOLD, periodDays = 28 } = {}) {
  if (!db) throw new Error('protected-pages.autoPopulate: db required');
  const since = etDateString(addETDays(new Date(), -periodDays));

  let added = 0; let skipped = 0;
  let rows = [];
  try {
    rows = await db('gsc_pages')
      .where('date', '>=', since)
      .select('page_url')
      .sum('impressions as impressions')
      .sum('clicks as clicks')
      .groupBy('page_url')
      .havingRaw('SUM(impressions) >= ?', [impressionThreshold]);
  } catch (err) {
    logger.warn(`[protected-pages] autoPopulate gsc_pages read failed: ${err.message}`);
    return { added: 0, skipped: 0, error: err.message };
  }

  for (const r of rows) {
    const impressions = parseInt(r.impressions, 10) || 0;
    const clicks = parseInt(r.clicks, 10) || 0;
    const reason = isProtectedByPattern(r.page_url).protected ? 'money_page' : 'high_traffic';
    try {
      await add({
        db,
        pageUrl: r.page_url,
        reason,
        addedBy: 'system:autoPopulate',
        notes: `auto: ${impressions} impressions / ${clicks} clicks over ${periodDays}d`,
        signalMetadata: { impressions, clicks, period_days: periodDays },
      });
      added += 1;
    } catch (err) {
      skipped += 1;
      logger.warn(`[protected-pages] autoPopulate add failed for ${r.page_url}: ${err.message}`);
    }
  }
  return { added, skipped, scanned: rows.length, impression_threshold: impressionThreshold };
}

module.exports = {
  isProtected,
  isProtectedByPattern,
  normalizePath,
  add,
  remove,
  list,
  autoPopulate,
  MONEY_PAGE_PATTERNS,
  DEFAULT_IMPRESSION_THRESHOLD,
};
