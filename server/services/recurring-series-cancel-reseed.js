// server/services/recurring-series-cancel-reseed.js
//
// Post-cancel recurring-series reseed bridge (owner ruling 2026-09-24).
//
// A single-visit cancel inside a counted plan — 9 lawn applications a year,
// 4 quarterly pest visits — used to shorten the plan silently: the cancel
// paths never touch the series, the completion-time auto-extend only fires
// when fewer than two visits are upcoming, and the nightly top-up is
// horizon-based. Customer e887e3c6's 6-week lawn plan dropped from 9 to 8
// applications that way (Oct 5 cancelled after the Aug visit was pushed to
// Sep 28) and only the accepted-plan watchdog noticed.
//
// The writer itself lives in routes/admin-schedule.js
// (reseedRecurringSeriesAfterCancel), beside the completion auto-extend and
// the nightly top-up it shares locks, eligibility rules and the
// visit-count reconciler with — duplicating that here would fork those
// rules. This module exposes it to the four single-visit cancel surfaces
// (dispatch board status route, schedule bulk cancel, v1 admin cancel,
// Intelligence Bar cancel tool). Plan-level cancels ('following' /
// 'series' scope, cancel-plan, cancel-signup, offboarding) stop the series
// and never reach this bridge.
//
// The require is lazy (inside the function) to avoid a route-load cycle —
// same pattern and rationale as recurring-series-extend.js.
//
// Failure-isolated BY CONTRACT: this function never throws. A failed reseed
// must never fail a cancel that already committed.
//
// GATE_CANCEL_RESEEDS_RECURRING (feature-gates.js#cancelReseedsRecurringLive):
// ships DARK, off unless exactly 'true'. Off, every call is a no-op.
const logger = require('./logger');

// Visits that still count toward a plan's term (mirrors the accepted-plan
// classifier in recurring-schedule-audit.js): everything but the four
// "this occurrence did not / will not happen" statuses.
const NON_COUNTING_STATUSES = Object.freeze(['cancelled', 'rescheduled', 'skipped', 'no_show']);

function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

// Calendar-year arithmetic (not 365-day blocks — those drift a day every
// leap year). A Feb 29 root lands on Feb 28 in a non-leap year.
function addYears(dateStr, years) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const t = new Date(Date.UTC(y + years, m - 1, d));
  if (t.getUTCMonth() !== m - 1) t.setUTCDate(0);
  return t.toISOString().slice(0, 10);
}

// Whole plan years from the root to `dateStr` (0 for anything before the
// root's first anniversary, clamped at 0 for a date before the root).
function wholeYearsBetween(rootStr, dateStr) {
  const [ry, rm, rd] = String(rootStr).split('-').map(Number);
  const [dy, dm, dd] = String(dateStr).split('-').map(Number);
  let years = dy - ry;
  if (dm < rm || (dm === rm && dd < rd)) years -= 1;
  return Math.max(0, years);
}

// How many visits a year the plan promises, from the series template alone
// (there is no stored planned count on a series — the accepted estimate's
// expectation is derived the same way in recurring-schedule-audit.js).
// `custom` carries its own recurring_interval_days.
function plannedVisitsPerYearForSeries(parent, seeder = require('./recurring-appointment-seeder')) {
  if (!parent) return null;
  const pattern = seeder.normalizeRecurringPattern(parent.recurring_pattern) || parent.recurring_pattern;
  if (!pattern) return null;
  if (pattern === 'custom') {
    const interval = Number(parent.recurring_interval_days);
    return Number.isFinite(interval) && interval > 0 ? Math.max(1, Math.round(365 / interval)) : null;
  }
  const count = seeder.plannedVisitCountForPattern(pattern);
  return Number.isInteger(count) && count > 0 ? count : null;
}

// The one-year plan term that contains `dateStr`, anchored on the series
// root's date: term 0 = [root, root+1y), term 1 = [root+1y, root+2y), …
// Returns null when either date is unusable.
function termWindowContaining(rootDateStr, dateStr) {
  const root = dateOnly(rootDateStr);
  const date = dateOnly(dateStr);
  if (!root || !date || Number.isNaN(Date.parse(`${root}T00:00:00Z`)) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) return null;
  const index = wholeYearsBetween(root, date);
  return { index, start: addYears(root, index), end: addYears(root, index + 1) }; // end exclusive
}

// Rows (root + children) that still count toward the term: not cancelled/
// rescheduled/skipped/no_show, dated inside [start, end).
function countTermVisits(rows, window) {
  if (!window) return 0;
  return (rows || []).filter((row) => {
    const d = dateOnly(row.scheduled_date);
    return d && d >= window.start && d < window.end && !NON_COUNTING_STATUSES.includes(String(row.status));
  }).length;
}

async function runPostCancelSeriesReseed({ db, serviceId, source = 'cancel' } = {}) {
  if (!db || !serviceId) return;
  try {
    const { cancelReseedsRecurringLive } = require('../config/feature-gates');
    if (!cancelReseedsRecurringLive()) return;
    const { reseedRecurringSeriesAfterCancel } = require('../routes/admin-schedule');
    if (typeof reseedRecurringSeriesAfterCancel !== 'function') {
      logger.warn('[recurring-series-cancel-reseed] reseedRecurringSeriesAfterCancel export missing — skipping');
      return;
    }
    const result = await reseedRecurringSeriesAfterCancel(db, serviceId, { source });
    if (result?.skipped) {
      logger.info(`[recurring-series-cancel-reseed] no reseed for ${serviceId} (${source}): ${result.skipped}`);
    }
  } catch (e) {
    logger.error(`[recurring-series-cancel-reseed] post-cancel series reseed failed (${source}, service=${serviceId}): ${e.message}`);
  }
}

module.exports = {
  runPostCancelSeriesReseed,
  plannedVisitsPerYearForSeries,
  termWindowContaining,
  countTermVisits,
  NON_COUNTING_STATUSES,
};
