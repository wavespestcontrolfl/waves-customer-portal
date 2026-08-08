/**
 * regression-requeue.js — closes the last leg of the optimization loop: a page
 * the impact tracker confirmed we made WORSE gets handed back for a rewrite.
 *
 * Before this, verdict='regressed' was a dead end for the page itself. Its only
 * consumer was pausedBuckets, which stops the whole BUCKET after 3 confirmed
 * regressions — useful (we stop repeating the mistake) but it never touches the
 * page that actually lost ground. A page that went from position 20 to 30 just
 * sat there.
 *
 * The decay lane does not catch these either: content-decay.js requires a >20%
 * click drop AND skips anything with fewer than 5 prior clicks, which is exactly
 * the low-traffic tail the control-adjusted tracker CAN grade. So a confirmed
 * regression on a thin page falls through both nets.
 *
 * This is a TRIGGER SOURCE, not a new mechanism. It resolves the regressed page
 * and calls the existing RefreshAudit.enqueueRefresh() — the same path the admin
 * one-click uses — which seeds opportunity_queue with action_type=
 * refresh_existing_page under all of its existing guards (advisory lock,
 * in-flight arbitration across PAGE_EDITING_ACTIONS, GSC-evidence requirement,
 * city-without-service fail-closed, dedupe_key upsert).
 *
 * Deliberately NOT a revert. Reversal here means "hand the page to the refresh
 * agent, which preserves slug + URL identity" — never a git revert of the
 * change: page titles/meta are owner-owned, and the astro blog-pr flow
 * auto-merges, so rewriting history is not a safe move for this engine.
 *
 * Two loop-breakers, because a refresh can itself regress:
 *   • requeued_at — each impact row is acted on exactly once, ever, whatever
 *     the outcome. requeue_status records WHY when it wasn't queued, so a page
 *     the lane can't act on is visible instead of silently retried nightly.
 *   • COOLDOWN_DAYS — a page re-queued recently is not re-queued again, so a
 *     refresh→regress→refresh oscillation dies after one cycle. The second
 *     regression still shows up as a regressed verdict for a human to read.
 *
 * Paused buckets are honoured HERE, explicitly. It is tempting to assume the
 * runner's own pause guard covers it, but it does not: enqueueRefresh seeds
 * bucket='content_refresh_audit', so a regression originating in a paused
 * bucket would be laundered into an unpaused one and run anyway — defeating
 * the very guard that stopped that lane. Rows from a paused bucket are instead
 * excluded from the scan, so they are neither acted on nor stamped, and they
 * become eligible again by themselves once the bucket is reviewed and clears.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { addETDays } = require('../../utils/datetime-et');
const { runExclusive } = require('../../utils/cron-lock');

// Dark-ship gate. While off, the sweep computes what it WOULD re-queue and
// logs it, and stamps NOTHING — so flipping the gate acts on the real backlog
// instead of a backlog this lane already marked handled while inert.
const requeueEnabled = () => process.env.GATE_REGRESSION_REQUEUE === 'true';

// A page re-queued inside this window is left alone. Long, because the refresh
// itself needs a full measurement cycle (deploy lag + 21d confirmation) before
// a second opinion means anything.
const COOLDOWN_DAYS = 90;
// Bound the nightly fan-out. Each queued row becomes a full agent run; a
// backlog should drain over days, not stampede in one tick.
const MAX_PER_RUN = 5;
// A transient failure does not consume the row's one attempt — but it can't
// retry forever either. Without a cap, MAX_PER_RUN persistently-failing rows
// would occupy every batch and starve every newer regression behind them
// (they sort oldest-first). After this many transient failures the row is
// stamped terminal and leaves the pool.
const MAX_TRANSIENT_ATTEMPTS = 3;

// enqueueRefresh's coded refusals, mapped straight through to requeue_status.
// Anything uncoded is treated as transient and left unstamped for a retry.
const TERMINAL_ERROR_CODES = new Set([
  'NO_GSC_SIGNAL', 'NO_SERVICE', 'NOT_PUBLISHED', 'NOT_FOUND', 'NO_URL', 'BAD_REQUEST',
]);

/**
 * Pure: given a resolution outcome, what goes in requeue_status?
 * Split out so the status vocabulary is testable without a DB or the engine.
 */
function requeueStatusFor({ resolved, enqueue, errorCode }) {
  if (errorCode) return String(errorCode).toLowerCase();
  if (!resolved) return 'unresolved_page';
  if (!enqueue) return 'unknown';
  if (enqueue.queued) return 'queued';
  // enqueueRefresh reports queued=false when a row for this page is already
  // claimed / done / in review — the page is already being handled.
  return `inflight:${enqueue.status || 'unknown'}`.slice(0, 40);
}

// Confirmed regressions nobody has acted on yet, oldest first. checked_21d_at
// (not 14d) is the bar on purpose — the same confirmation pausedBuckets counts,
// so the two halves of the reversal story never disagree.
function pendingRegressions(database, { limit = MAX_PER_RUN, excludeBuckets = [] } = {}) {
  return database('content_optimization_impact')
    .where('verdict', 'regressed')
    .whereNotNull('checked_21d_at')
    .whereNull('requeued_at')
    .whereNotNull('page_url')
    // A regression from a PAUSED bucket is left in place, not skipped-and-
    // stamped: stamping would burn its one attempt while the lane is under
    // review, and leaving it visible-but-unstamped would clog the bounded
    // batch. Excluding it does both jobs — and it becomes eligible again on
    // its own once the bucket clears. NULL bucket is never excluded (SQL
    // NOT IN is NULL for a NULL column, which would silently drop the row).
    .where((b) => {
      if (!excludeBuckets.length) return b.whereRaw('true');
      return b.whereNull('bucket').orWhereNotIn('bucket', excludeBuckets);
    })
    .orderBy('checked_21d_at', 'asc')
    .limit(limit)
    .select('id', 'page_url', 'bucket', 'estimated_lift_position', 'checked_21d_at', 'requeue_attempts');
}

/**
 * Has this page actually been RE-QUEUED inside the cooldown?
 *
 * Keyed on (registrable domain, canonical path) — NOT on the raw page_url
 * string. GSC reports www/non-www and ?utm variants, the hub and spokes share
 * paths, and a later run can record a different representation of the same
 * page; an exact-string match would let those variants slip past the loop
 * breaker and re-queue the same page again. Uses refresh-audit's identity
 * helpers so this lane and the refresh lane agree on what "same page" means.
 *
 * Evidence is restricted to statuses that mean real refresh work exists —
 * 'queued' and 'inflight:*'. requeued_at is stamped on REFUSALS too
 * (unresolved_page, no_gsc_signal, cooldown, …), and counting those would let
 * a page that was never refreshed suppress its own next valid regression, with
 * each successive 'cooldown' stamp rolling the window forward indefinitely.
 */
const COOLDOWN_EVIDENCE_PREFIX = 'inflight:';
const COOLDOWN_EVIDENCE_STATUSES = ['queued'];

async function inCooldown(database, refreshAudit, pageUrl, since) {
  const { canonPathSql, hostRegistrableSql, urlToPath, registrableDomain } = refreshAudit._identity;
  const path = urlToPath(pageUrl);
  const domain = registrableDomain(pageUrl);
  if (!path || !domain) return false;

  const row = await database('content_optimization_impact')
    .whereNotNull('requeued_at')
    .where('requeued_at', '>=', since)
    .where((b) => b
      .whereIn('requeue_status', COOLDOWN_EVIDENCE_STATUSES)
      .orWhere('requeue_status', 'like', `${COOLDOWN_EVIDENCE_PREFIX}%`))
    .whereRaw(`${canonPathSql('page_url')} = ?`, [path])
    .whereRaw(`${hostRegistrableSql('page_url')} = ?`, [domain])
    .first('id');
  return Boolean(row);
}

async function stamp(database, id, status, attempts = null) {
  const patch = { requeued_at: new Date(), requeue_status: String(status).slice(0, 40), updated_at: new Date() };
  if (attempts != null) patch.requeue_attempts = attempts;
  try {
    await database('content_optimization_impact').where('id', id).update(patch);
  } catch (err) {
    logger.error(`[regression-requeue] failed to stamp impact ${id}: ${err.message}`);
  }
}

// Count a transient failure. Once the cap is hit the row is stamped terminal
// so it stops occupying the bounded batch.
async function noteTransientFailure(database, row) {
  const attempts = (Number(row.requeue_attempts) || 0) + 1;
  if (attempts >= MAX_TRANSIENT_ATTEMPTS) {
    await stamp(database, row.id, 'error_exhausted', attempts);
    return 'error_exhausted';
  }
  try {
    await database('content_optimization_impact')
      .where('id', row.id)
      .update({ requeue_attempts: attempts, updated_at: new Date() });
  } catch (err) {
    logger.error(`[regression-requeue] failed to count attempt on impact ${row.id}: ${err.message}`);
  }
  return 'error';
}

/**
 * Daily sweep. Chained after the impact tracker so it reads verdicts the sweep
 * just wrote. `opts.db` and `opts.refreshAudit` are injectable for tests.
 *
 * Serialized with the repo's distributed cron lock: Railway runs overlapping
 * old/new instances during a deploy, and two pods scanning the same unstamped
 * rows would both resolve and enqueue them, then race to overwrite each
 * other's terminal requeue_status. Sequential re-entry after the lock releases
 * is already safe — the scan filters on requeued_at IS NULL, so a second tick
 * simply sees no work.
 */
async function requeueRegressedPages(opts = {}) {
  return runExclusive('regression-requeue', () => requeueRegressedPagesLocked(opts));
}

async function requeueRegressedPagesLocked(opts = {}) {
  const database = opts.db || db;
  const refreshAudit = opts.refreshAudit || require('./refresh-audit');
  const tracker = opts.tracker || require('./impact-tracker');
  const limit = opts.limit || MAX_PER_RUN;

  // Fetch once per sweep, not per row. Fail CLOSED on error: if we cannot tell
  // which buckets are paused, re-queueing could launder work out of a lane
  // that was stopped for repeated losses — the whole point of the pause.
  let excludeBuckets;
  try {
    // strict: pausedBuckets swallows its own query error and returns [] by
    // default, which would read here as "nothing is paused" — the one wrong
    // answer this lane cannot act on.
    excludeBuckets = ((await tracker.pausedBuckets({ db: database, strict: true })) || []).map((p) => p.bucket).filter(Boolean);
  } catch (err) {
    logger.error(`[regression-requeue] pausedBuckets unavailable, standing down this tick: ${err.message}`);
    return { scanned: 0, queued: 0, skipped: 0, results: [] };
  }
  if (excludeBuckets.length) {
    logger.info(`[regression-requeue] excluding paused bucket(s): ${excludeBuckets.join(', ')}`);
  }

  let rows;
  try {
    rows = await pendingRegressions(database, { limit, excludeBuckets });
  } catch (err) {
    logger.error(`[regression-requeue] scan failed: ${err.message}`);
    return { scanned: 0, queued: 0, skipped: 0, results: [] };
  }
  if (!rows.length) return { scanned: 0, queued: 0, skipped: 0, results: [] };

  // Window boundary as a real Date built with the ET helpers — a naive
  // timestamp string in a timestamptz WHERE slides the window 4-5 hours.
  const cooldownSince = addETDays(new Date(), -COOLDOWN_DAYS);

  const results = [];
  let queued = 0;
  let skipped = 0;

  for (const row of rows) {
    let status;
    let post = null;

    try {
      if (await inCooldown(database, refreshAudit, row.page_url, cooldownSince)) {
        status = 'cooldown';
      } else {
        post = await refreshAudit.resolvePublishedPostByUrl(row.page_url);
        if (!post) {
          status = 'unresolved_page';
        } else if (!requeueEnabled()) {
          // Shadow: report the decision, change nothing, stamp nothing.
          logger.info(`[regression-requeue] gated OFF — would re-queue ${row.page_url} (post ${post.id}, bucket ${row.bucket || '—'})`);
          results.push({ id: row.id, page_url: row.page_url, status: 'gated' });
          continue;
        } else {
          const enqueue = await refreshAudit.enqueueRefresh({ blogPostId: post.id });
          status = requeueStatusFor({ resolved: post, enqueue });
        }
      }
    } catch (err) {
      const code = err && err.code;
      if (!TERMINAL_ERROR_CODES.has(code)) {
        // Transient (DB blip, unexpected throw): don't burn the page's one
        // attempt — but DO count it, so a permanently-stuck row can't hold a
        // slot in the bounded batch forever and starve newer regressions.
        logger.error(`[regression-requeue] ${row.page_url} failed transiently: ${err.message}`);
        if (!requeueEnabled()) {
          logger.info(`[regression-requeue] gated OFF — not counting the failed attempt on ${row.page_url}`);
          results.push({ id: row.id, page_url: row.page_url, status: 'gated' });
          continue;
        }
        const outcome = await noteTransientFailure(database, row);
        if (outcome === 'error_exhausted') skipped += 1;
        results.push({ id: row.id, page_url: row.page_url, status: outcome });
        continue;
      }
      status = requeueStatusFor({ resolved: post, errorCode: code });
    }

    // Gate re-checked here too: a refusal computed above (cooldown /
    // unresolved) must not write state while the lane is dark.
    if (!requeueEnabled()) {
      logger.info(`[regression-requeue] gated OFF — ${row.page_url} would be recorded as ${status}`);
      results.push({ id: row.id, page_url: row.page_url, status: 'gated' });
      continue;
    }

    await stamp(database, row.id, status);
    if (status === 'queued') queued += 1; else skipped += 1;
    results.push({ id: row.id, page_url: row.page_url, status });
  }

  logger.info(`[regression-requeue] scanned ${rows.length}, queued ${queued}, skipped ${skipped}`);
  return { scanned: rows.length, queued, skipped, results };
}

module.exports = {
  requeueRegressedPages,
  // exposed for tests / reuse
  requeueStatusFor,
  _internals: { pendingRegressions, inCooldown, noteTransientFailure },
  THRESHOLDS: { COOLDOWN_DAYS, MAX_PER_RUN, MAX_TRANSIENT_ATTEMPTS },
};
