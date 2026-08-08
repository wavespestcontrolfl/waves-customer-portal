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
 *   • requeued_at — stamped ONLY when corrective work actually exists. A tick
 *     that queued nothing never consumes the regression: an outcome blocked by
 *     another page edit, or a transient failure, just increments
 *     requeue_attempts, which demotes the row in tomorrow's ordering so it
 *     cannot starve fresher regressions. A target this lane structurally
 *     cannot act on is PARKED — requeue_status set, requeued_at left NULL —
 *     so it leaves the batch without being marked handled.
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
// A regression that produced NO corrective work is never consumed — not after
// three tries, not ever. An attempt-capped retirement looked like a tidy way
// to stop stuck rows starving the batch, but it silently discards real work:
// a legitimate pending_review edit can hold a page for well over three days,
// and the regression would be retired exactly when that edit finally clears.
//
// Starvation is solved by ORDERING instead, which costs nothing: rows sort by
// attempt count first, so a repeatedly-blocked row always yields its slot to a
// fresh regression and simply waits for a quieter night. requeue_attempts is
// now a priority input rather than a death clock.
//
// The one status that leaves the pool without being consumed is
// 'unsupported_target' — see UNSUPPORTED_STATUS.
const UNSUPPORTED_STATUS = 'unsupported_target';

// enqueueRefresh's coded refusals, mapped straight through to requeue_status.
// Anything uncoded is treated as transient and left unstamped for a retry.
const TERMINAL_ERROR_CODES = new Set([
  'NO_GSC_SIGNAL', 'NO_SERVICE', 'NOT_PUBLISHED', 'NOT_FOUND', 'NO_URL', 'BAD_REQUEST',
]);

/**
 * Pure: given a resolution outcome, what goes in requeue_status?
 * Split out so the status vocabulary is testable without a DB or the engine.
 *
 * Only 'queued' is terminal-because-successful. queued=false does NOT prove
 * the regression is being corrected, so those outcomes stay actionable — see
 * isRetryableStatus.
 */
function requeueStatusFor({ resolved, enqueue, errorCode }) {
  if (errorCode) return String(errorCode).toLowerCase();
  if (!resolved) return UNSUPPORTED_STATUS;
  if (!enqueue) return 'unknown';
  if (enqueue.queued) return 'queued';
  // `own` means the row enqueueRefresh found carries OUR cycle's dedupe key —
  // i.e. an earlier attempt for THIS regression already created it and only
  // the marker write failed. Recovering that as success is what makes the
  // enqueue/stamp pair safe to retry: without it the retry would read its own
  // work as a foreign in-flight edit and keep re-attempting forever while the
  // corrective refresh already sat in the queue.
  if (enqueue.own) return 'queued';
  return `inflight:${enqueue.status || 'unknown'}`.slice(0, 40);
}

/**
 * Is this outcome worth trying again tomorrow rather than consuming the
 * regression?
 *
 * enqueueRefresh reports queued=false when ANOTHER page-editing action already
 * holds this page — the in-flight query spans all of PAGE_EDITING_ACTIONS, so
 * a pending rewrite_title_meta suppresses our refresh, and that edit is not a
 * fix for this regression. Stamping it terminally would drop the regression
 * forever with no corrective work done, so it is retried under the same
 * attempt counter, which only ever DEMOTES it in the batch ordering — it is
 * never retired, because the edit blocking it will clear eventually and the
 * regression still deserves its fix.
 *
 * A stale status='done' row no longer reaches here: this lane passes a
 * per-regression cycleKey, so its dedupe key is always fresh.
 */
function isRetryableStatus(status) {
  return typeof status === 'string' && status.startsWith('inflight:');
}

// Confirmed regressions nobody has acted on yet. checked_21d_at (not 14d) is
// the bar on purpose — the same confirmation pausedBuckets counts, so the two
// halves of the reversal story never disagree.
function pendingRegressions(database, { limit = MAX_PER_RUN, excludeBuckets = [] } = {}) {
  return database('content_optimization_impact')
    .where('verdict', 'regressed')
    .whereNotNull('checked_21d_at')
    .whereNull('requeued_at')
    .whereNotNull('page_url')
    // Targets this lane structurally cannot act on are parked, NOT consumed:
    // they carry a requeue_status but no requeued_at, so they leave the batch
    // without being marked handled. When a URL-keyed enqueue path lands,
    // clearing this one status makes every parked regression actionable again.
    .where((b) => b.whereNull('requeue_status').orWhere('requeue_status', '<>', UNSUPPORTED_STATUS))
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
    // Fewest attempts first, then oldest. This is what keeps a page blocked by
    // a long-running edit from occupying the bounded batch: it yields to every
    // fresh regression and picks up its slot on a quieter night, instead of
    // being retired to make room.
    .orderBy('requeue_attempts', 'asc')
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
 * Evidence is EXACTLY one status: 'queued'. That is the only outcome that
 * proves a corrective refresh was created, and the cooldown's entire job is to
 * stop a refresh→regress→refresh oscillation — so it must be anchored to a
 * refresh that actually happened.
 *
 * The other statuses that stamp requeued_at — no_gsc_signal, cooldown itself,
 * the other coded refusals — queued nothing. Counting them would let a page
 * that was never refreshed suppress its own next valid regression for 90 days,
 * with each successive stamp rolling the window forward. Blocked retries and
 * parked unsupported targets never reach here at all: both leave requeued_at
 * NULL by design.
 */
const COOLDOWN_EVIDENCE_STATUSES = ['queued'];

async function inCooldown(database, refreshAudit, pageUrl, since) {
  const { canonPathSql, hostRegistrableSql, urlToPath, registrableDomain } = refreshAudit._identity;
  const path = urlToPath(pageUrl);
  const domain = registrableDomain(pageUrl);
  if (!path || !domain) return false;

  const row = await database('content_optimization_impact')
    .whereNotNull('requeued_at')
    .where('requeued_at', '>=', since)
    .whereIn('requeue_status', COOLDOWN_EVIDENCE_STATUSES)
    .whereRaw(`${canonPathSql('page_url')} = ?`, [path])
    .whereRaw(`${hostRegistrableSql('page_url')} = ?`, [domain])
    .first('id');
  return Boolean(row);
}

// Returns whether the marker actually persisted. Callers must NOT report
// success on a false: the exactly-once contract lives in this row, and a
// swallowed failure would report a queued regression as handled while the row
// still says otherwise. Re-processing itself is safe — the cycleKey makes the
// enqueue idempotent and `own` lets the retry recognise its own queue row —
// but it must be reported as unfinished, not as success.
async function stamp(database, id, status, attempts = null) {
  const patch = { requeued_at: new Date(), requeue_status: String(status).slice(0, 40), updated_at: new Date() };
  if (attempts != null) patch.requeue_attempts = attempts;
  try {
    await database('content_optimization_impact').where('id', id).update(patch);
    return true;
  } catch (err) {
    logger.error(`[regression-requeue] failed to stamp impact ${id} (${status}): ${err.message}`);
    return false;
  }
}

// Count an attempt that did NOT consume the regression (a transient failure,
// or an enqueue that queued nothing). The row stays actionable forever; the
// count only demotes it in the batch ordering so it cannot starve fresher
// regressions. Nothing here is ever terminal.
async function noteRetry(database, row, status = 'error') {
  const attempts = (Number(row.requeue_attempts) || 0) + 1;
  try {
    await database('content_optimization_impact')
      .where('id', row.id)
      .update({ requeue_attempts: attempts, updated_at: new Date() });
  } catch (err) {
    logger.error(`[regression-requeue] failed to count attempt on impact ${row.id}: ${err.message}`);
  }
  return status;
}

// Park a target this lane structurally cannot act on: record WHY, but leave
// requeued_at NULL so the regression is not marked handled. The scan skips
// this status, so it costs nothing nightly — and if a URL-keyed enqueue path
// ever lands, clearing the status alone makes every parked row actionable.
async function park(database, id, status) {
  try {
    await database('content_optimization_impact')
      .where('id', id)
      .update({ requeue_status: String(status).slice(0, 40), updated_at: new Date() });
    return true;
  } catch (err) {
    logger.error(`[regression-requeue] failed to park impact ${id} (${status}): ${err.message}`);
    return false;
  }
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
          // Out of this lane's reach, not a transient miss. enqueueRefresh is
          // keyed by blogPostId, so a regressed page with no blog_posts row —
          // a city/service or other non-blog Astro target, which the GSC miner
          // also emits refresh_existing_page work for — cannot be handed to it
          // at all. PARKED, not consumed — requeue_status records it and the
          // scan skips it, but requeued_at stays NULL, so the regression is
          // never marked handled. Covering those targets needs a URL-keyed
          // enqueue path in refresh-audit; when that lands, clearing this one
          // status makes every parked regression actionable again.
          status = UNSUPPORTED_STATUS;
          logger.warn(`[regression-requeue] no published blog_posts row for ${row.page_url} — outside this lane's reach`);
        } else if (!requeueEnabled()) {
          // Shadow: report the decision, change nothing, stamp nothing.
          logger.info(`[regression-requeue] gated OFF — would re-queue ${row.page_url} (post ${post.id}, bucket ${row.bucket || '—'})`);
          results.push({ id: row.id, page_url: row.page_url, status: 'gated' });
          continue;
        } else {
          // cycleKey: this regression is its OWN refresh cycle. Without it the
          // dedupe key is stable per page and the upsert preserves an earlier
          // status='done', so after a page's first completed refresh every
          // later confirmed regression — including ones past the 90-day
          // cooldown — would be told "already handled" and never re-queued.
          // Keying on the impact row also makes a retry idempotent: the same
          // regression always resolves to the same queue row.
          const enqueue = await refreshAudit.enqueueRefresh({ blogPostId: post.id, cycleKey: `reg-${row.id}` });
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
        await noteRetry(database, row, 'error');
        results.push({ id: row.id, page_url: row.page_url, status: 'error' });
        continue;
      }
      status = requeueStatusFor({ resolved: post, errorCode: code });
    }

    // Gate re-checked here too: a refusal computed above (cooldown /
    // unsupported target) must not write state while the lane is dark.
    if (!requeueEnabled()) {
      logger.info(`[regression-requeue] gated OFF — ${row.page_url} would be recorded as ${status}`);
      results.push({ id: row.id, page_url: row.page_url, status: 'gated' });
      continue;
    }

    // queued=false means NO corrective refresh was created — another
    // page-editing action is holding the page. Count the attempt (which only
    // demotes the row in tomorrow's ordering) and leave the regression
    // actionable: that edit will clear, and the fix is still owed.
    if (isRetryableStatus(status)) {
      await noteRetry(database, row, status);
      results.push({ id: row.id, page_url: row.page_url, status });
      continue;
    }

    // Structurally out of reach: park without consuming.
    if (status === UNSUPPORTED_STATUS) {
      await park(database, row.id, status);
      results.push({ id: row.id, page_url: row.page_url, status });
      continue;
    }

    // The marker IS the exactly-once contract. If it did not persist, this row
    // is unfinished — never counted as queued, and left for the next sweep
    // (which is safe to repeat: the cycleKey makes the enqueue idempotent).
    if (!(await stamp(database, row.id, status))) {
      results.push({ id: row.id, page_url: row.page_url, status: 'stamp_failed', intended: status });
      continue;
    }
    if (status === 'queued') queued += 1; else skipped += 1;
    results.push({ id: row.id, page_url: row.page_url, status });
  }

  const unsupported = results.filter((r) => r.status === UNSUPPORTED_STATUS).length;
  const blocked = results.filter((r) => String(r.status).startsWith('inflight:')).length;
  logger.info(`[regression-requeue] scanned ${rows.length}, queued ${queued}, skipped ${skipped}${blocked ? `, blocked-retrying ${blocked}` : ''}${unsupported ? `, parked-unsupported ${unsupported}` : ''}`);
  return { scanned: rows.length, queued, skipped, blocked, unsupported, results };
}

module.exports = {
  requeueRegressedPages,
  // exposed for tests / reuse
  requeueStatusFor,
  _internals: { pendingRegressions, inCooldown, noteRetry, park, isRetryableStatus },
  THRESHOLDS: { COOLDOWN_DAYS, MAX_PER_RUN, UNSUPPORTED_STATUS },
};
