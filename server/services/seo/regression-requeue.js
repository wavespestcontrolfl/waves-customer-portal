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
 * A paused bucket needs no check here: autonomous-runner consults pausedBuckets
 * at claim time, so a seeded row for a paused bucket simply never runs.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { addETDays } = require('../../utils/datetime-et');

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
function pendingRegressions(database, { limit = MAX_PER_RUN } = {}) {
  return database('content_optimization_impact')
    .where('verdict', 'regressed')
    .whereNotNull('checked_21d_at')
    .whereNull('requeued_at')
    .whereNotNull('page_url')
    .orderBy('checked_21d_at', 'asc')
    .limit(limit)
    .select('id', 'page_url', 'bucket', 'estimated_lift_position', 'checked_21d_at');
}

// Has this page been re-queued inside the cooldown? Keyed on page_url as
// stored: impact rows for one page carry the run's published_url, which is
// stable across refreshes of that page.
async function inCooldown(database, pageUrl, since) {
  const row = await database('content_optimization_impact')
    .where('page_url', pageUrl)
    .whereNotNull('requeued_at')
    .where('requeued_at', '>=', since)
    .first('id');
  return Boolean(row);
}

async function stamp(database, id, status) {
  try {
    await database('content_optimization_impact')
      .where('id', id)
      .update({ requeued_at: new Date(), requeue_status: String(status).slice(0, 40), updated_at: new Date() });
  } catch (err) {
    logger.error(`[regression-requeue] failed to stamp impact ${id}: ${err.message}`);
  }
}

/**
 * Daily sweep. Chained after the impact tracker so it reads verdicts the sweep
 * just wrote. `opts.db` and `opts.refreshAudit` are injectable for tests.
 */
async function requeueRegressedPages(opts = {}) {
  const database = opts.db || db;
  const refreshAudit = opts.refreshAudit || require('./refresh-audit');
  const limit = opts.limit || MAX_PER_RUN;

  let rows;
  try {
    rows = await pendingRegressions(database, { limit });
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
      if (await inCooldown(database, row.page_url, cooldownSince)) {
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
        // Transient (DB blip, unexpected throw): leave it unstamped so the next
        // sweep retries rather than burning the page's one attempt.
        logger.error(`[regression-requeue] ${row.page_url} failed transiently: ${err.message}`);
        results.push({ id: row.id, page_url: row.page_url, status: 'error' });
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
  _internals: { pendingRegressions, inCooldown },
  THRESHOLDS: { COOLDOWN_DAYS, MAX_PER_RUN },
};
