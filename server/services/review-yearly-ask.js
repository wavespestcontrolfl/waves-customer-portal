/**
 * Yearly review ask (Tech Rewards plan D6-R1, owner ruling 2026-11-20).
 *
 * A daily job finds recurring customers whose service anniversary just passed (12+ months
 * since their first completed recurring visit) and who have not reviewed, then enrolls ONE
 * review ask for each through the existing review cadence path (ReviewService
 * .startReviewSequence), so every guard that path already holds still applies at send time:
 * the 30-day cooldown, the 3 asks per 180 days cap, the 72 h spacing, the opt-out and
 * already-reviewed stops, the click stop and the 8 AM to 8 PM send window. This file never
 * sends a text and never builds a second sender.
 *
 * The yearly mark is review_sequences.started_by = 'yearly' (no new column). A customer with
 * any such sequence started in the last 365 days is never picked again, so a re-run on the
 * same day, or a catch-up run on a later day of the window, cannot ask twice.
 *
 * GATE_REVIEW_YEARLY_ASK off (ships off): the job still runs, only COUNTS and logs. It
 * enrolls nothing, texts nothing and writes nothing, so the owner sees the volume before
 * flipping the gate.
 *
 * Fail closed toward NOT texting: any read that fails for a customer skips that customer.
 */
const db = require('../models/db');
const logger = require('./logger');
const { etDateString, addETDays } = require('../utils/datetime-et');

const YEARLY_STARTED_BY = 'yearly';
const YEARLY_DECISION_REASON = 'yearly_anniversary';
// The ask goes within this many days after the anniversary, so a day the job missed catches up.
const ANNIVERSARY_WINDOW_DAYS = 14;
const YEARLY_REPEAT_DAYS = 365;
const COOLDOWN_DAYS = 30;
const ASK_CAP = 3;
// A customer whose latest completed recurring visit is older than this is no longer being served.
const STILL_SERVED_DAYS = 180;
// A flood guard: a run enrolls at most this many. The rest wait for the next day's run (the
// anniversary window is two weeks wide).
const MAX_ENROLL_PER_RUN = 50;

const DAY_MS = 24 * 60 * 60 * 1000;

function parseYmd(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
}

// Days in a month, so a Feb 29 anniversary lands on Feb 28 in a common year.
function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function ymdUtcMs(y, m, d) {
  return Date.UTC(y, m - 1, Math.min(d, daysInMonth(y, m)));
}

/**
 * The anniversary the customer is inside the window of, or null. firstOn is the date of the
 * first completed recurring visit and todayYmd today's ET date (both YYYY-MM-DD). Needs at
 * least one full year of service; matches 0 to windowDays days after the anniversary.
 */
function anniversaryWindow(firstOn, todayYmd, windowDays = ANNIVERSARY_WINDOW_DAYS) {
  const first = parseYmd(firstOn);
  const today = parseYmd(todayYmd);
  if (!first || !today) return null;
  const todayMs = Date.UTC(today.y, today.m - 1, today.d);
  let years = today.y - first.y;
  if (ymdUtcMs(first.y + years, first.m, first.d) > todayMs) years -= 1;
  if (years < 1) return null;
  const anniversaryMs = ymdUtcMs(first.y + years, first.m, first.d);
  const daysSince = Math.round((todayMs - anniversaryMs) / DAY_MS);
  if (daysSince < 0 || daysSince > windowDays) return null;
  return { years, daysSince, anniversaryOn: new Date(anniversaryMs).toISOString().slice(0, 10) };
}

function shiftYmd(todayYmd, days) {
  return etDateString(addETDays(new Date(`${todayYmd}T12:00:00Z`), days));
}

// Customers with a completed recurring visit at least a year old and one in the last 180 days.
// Narrow on purpose: the window and every exclusion run after, on a short list.
async function loadTenuredRecurringCustomers(todayYmd) {
  const result = await db.raw(
    `SELECT cu.id AS customer_id,
            MIN(v.scheduled_date)::text AS first_on
       FROM customers cu
       JOIN scheduled_services v ON v.customer_id = cu.id
      WHERE v.status = 'completed'
        AND v.is_recurring = true
        AND cu.deleted_at IS NULL
        AND cu.active IS DISTINCT FROM false
        AND COALESCE(cu.has_left_google_review, false) = false
      GROUP BY cu.id
     HAVING MIN(v.scheduled_date) <= ?::date
        AND MAX(v.scheduled_date) >= ?::date`,
    [shiftYmd(todayYmd, -365), shiftYmd(todayYmd, -STILL_SERVED_DAYS)],
  );
  return result.rows || [];
}

const defaultReads = {
  async yearlyAskSince(customerId, since) {
    const row = await db('review_sequences')
      .where({ customer_id: customerId, started_by: YEARLY_STARTED_BY })
      .where('started_at', '>', since)
      .whereRaw("stop_reason IS DISTINCT FROM 'start_failed'")
      .first('id');
    return Boolean(row);
  },
  async activeSequence(customerId) {
    const row = await db('review_sequences').where({ customer_id: customerId, status: 'active' }).first('id');
    return Boolean(row);
  },
  async linkedGoogleReview(customerId) {
    const row = await db('google_reviews').where({ customer_id: customerId }).whereNull('missing_since').first('id');
    return Boolean(row);
  },
};

function defaultServices() {
  return {
    ReviewService: require('./review-request'),
    ClickGuard: require('./review-click-guard'),
  };
}

// Why this customer gets no yearly ask, or null when they qualify. Any thrown read is the
// caller's skip: this function never returns null on a failed lookup.
async function exclusionReason(customerId, { now, reads, services }) {
  const { ReviewService, ClickGuard } = services;
  const yearAgo = new Date(now.getTime() - YEARLY_REPEAT_DAYS * DAY_MS);
  if (await reads.yearlyAskSince(customerId, yearAgo)) return 'yearly_ask_in_365_days';
  if (await reads.linkedGoogleReview(customerId)) return 'has_google_review';
  if (await ClickGuard.probableReviewer(customerId)) return 'probable_reviewer';
  const allowed = await ReviewService.reviewSmsAllowedNow(customerId);
  if (!allowed || allowed.allowed !== true) return `not_allowed_${(allowed && allowed.reason) || 'unknown'}`;
  if (await reads.activeSequence(customerId)) return 'active_sequence';
  if (await ClickGuard.tapPauseActive(customerId)) return 'review_link_tap_in_180_days';
  const stats = await ReviewService.getDeliveredAskStats(customerId);
  if (stats.count >= ASK_CAP) return 'ask_cap';
  if (stats.lastAt && now.getTime() - new Date(stats.lastAt).getTime() < COOLDOWN_DAYS * DAY_MS) return 'ask_in_30_days';
  if (await ReviewService.manualReviewAskSentRecently(customerId, { windowDays: COOLDOWN_DAYS, failClosed: true })) {
    return 'manual_ask_in_30_days';
  }
  return null;
}

function gateLive() {
  const gates = require('../config/feature-gates');
  return typeof gates.reviewYearlyAskLive === 'function' && gates.reviewYearlyAskLive() === true;
}

function sequencesLive() {
  const gates = require('../config/feature-gates');
  return typeof gates.isEnabled === 'function' && gates.isEnabled('reviewSequences') === true;
}

// Enroll through the existing review cadence. The cadence's own send-time guards still decide
// whether a text goes out.
async function enrollPicked(picked, { now, services, summary }) {
  const { ReviewService } = services;
  const OUTREACH = require('./review-outreach-templates');
  for (const pick of picked) {
    try {
      const firstTouchAt = ReviewService.__private.nextCadenceTickAt(now);
      const result = await ReviewService.startReviewSequence({
        customerId: pick.customerId,
        plan: OUTREACH.RECURRING_SEQUENCE_PLAN,
        startedBy: YEARLY_STARTED_BY,
        firstTouchAt,
        decision: ReviewService.__private.sequenceDecision({
          reason: YEARLY_DECISION_REASON,
          plannedAt: firstTouchAt,
          nextEvalAt: firstTouchAt,
        }),
      });
      if (result && result.started) summary.enrolled += 1;
      else summary.notStarted += 1;
    } catch (err) {
      summary.notStarted += 1;
      logger.warn(`[review-yearly-ask] enroll failed (customerId=${pick.customerId}): ${err.message}`);
    }
  }
}

// Checked by the cadence runner at dispatch for a started_by 'yearly' sequence: the retire
// reason ('yearly_gate_off', 'tap_pause'), 'lookup_failed' (defer, send nothing) or null.
async function dispatchStopReason(seq, { ClickGuard = require('./review-click-guard') } = {}) {
  if (!gateLive()) return 'yearly_gate_off';
  try {
    return (await ClickGuard.tapPauseActive(seq.customer_id)) ? 'tap_pause' : null;
  } catch (err) {
    logger.warn(`[review-yearly-ask] tap-pause lookup failed (sequenceId=${seq.id}): ${err.message}`);
    return 'lookup_failed';
  }
}

/**
 * One daily pass. Returns the summary it logs. Gate off (or review sequences off, where an
 * enrolled ask would never send): counts only, no writes.
 */
async function runYearlyReviewAsk({ now = new Date(), deps = {} } = {}) {
  const services = deps.services || defaultServices();
  const reads = deps.reads || defaultReads;
  const loadCustomers = deps.loadCustomers || loadTenuredRecurringCustomers;
  const live = deps.live !== undefined ? deps.live : (gateLive() && sequencesLive());
  const todayYmd = etDateString(now);
  const summary = {
    mode: live ? 'enroll' : 'count_only',
    tenured: 0,
    inWindow: 0,
    eligible: 0,
    enrolled: 0,
    notStarted: 0,
    lookupFailed: 0,
    skipped: {},
  };

  let rows;
  try {
    rows = await loadCustomers(todayYmd);
  } catch (err) {
    logger.error(`[review-yearly-ask] candidate read failed, nothing sent: ${err.message}`);
    // Thrown, not returned: inside runExclusive a returned summary records a successful run
    // even though nobody was evaluated.
    throw Object.assign(new Error(`review-yearly-ask candidate read failed: ${err.message}`), { cause: err });
  }
  summary.tenured = rows.length;

  const picked = [];
  for (const row of rows) {
    const window = anniversaryWindow(row.first_on, todayYmd);
    if (!window) continue;
    summary.inWindow += 1;
    try {
      const reason = await exclusionReason(row.customer_id, { now, reads, services });
      if (reason) {
        summary.skipped[reason] = (summary.skipped[reason] || 0) + 1;
        continue;
      }
      picked.push({ customerId: row.customer_id, ...window });
    } catch (err) {
      summary.lookupFailed += 1;
      logger.warn(`[review-yearly-ask] lookup failed (customerId=${row.customer_id}), skipped: ${err.message}`);
    }
  }
  summary.eligible = picked.length;

  if (!live) {
    logger.info(`[review-yearly-ask] dry run, no asks enrolled: ${JSON.stringify(summary)}`);
    return summary;
  }

  await enrollPicked(picked.slice(0, MAX_ENROLL_PER_RUN), { now, services, summary });
  logger.info(`[review-yearly-ask] ${JSON.stringify(summary)}`);
  return summary;
}

module.exports = {
  runYearlyReviewAsk,
  anniversaryWindow,
  exclusionReason,
  dispatchStopReason,
  YEARLY_STARTED_BY,
  ANNIVERSARY_WINDOW_DAYS,
  MAX_ENROLL_PER_RUN,
};
