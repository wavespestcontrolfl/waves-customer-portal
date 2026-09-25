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
// A cancel only removes a visit from the plan when the row it left was one
// that still counted (Codex #4814 P1): a 'rescheduled' placeholder flipped
// to 'cancelled' removed nothing, so it earns no replacement.
const COUNTING_SOURCE_STATUSES = Object.freeze(['pending', 'confirmed', 'en_route', 'on_site']);
// A legacy row can carry status NULL (transitionJobStatus documents the null
// fromStatus); countTermVisits counts it (null is not non-counting), so the
// audit row it leaves must count too (Codex #4814 r2 P1).
function isCountingSourceStatus(status) {
  return status == null || COUNTING_SOURCE_STATUSES.includes(String(status));
}
// Upcoming plan rows: the statuses the visit-count reconciler treats as live.
const UPCOMING_STATUSES = Object.freeze(['pending', 'confirmed']);

// Booster months are deliberately non-recurring rows hanging off a
// recurring root (is_recurring === false + recurring_parent_id): paid
// extras, never part of the accepted cadence (Codex #4814 P1 — counting one
// let 8 base visits + 1 booster read as a whole 9). The contract is an
// EXPLICIT false, same as recurring-schedule-audit.js#isBoosterVisit: a
// legacy child whose flag is NULL is still a plan visit.
function isBoosterRow(row) {
  return !!row && row.is_recurring === false && !!row.recurring_parent_id;
}

// A row the plan counts: the recurring root or a child (explicitly recurring
// OR legacy null-flagged) — never an explicit booster (Codex #4814 P1: the
// is_recurring column is nullable and legacy children were dropped by an
// `=== true` test before the root could be inspected).
function isPlanSeriesRow(row) {
  if (!row || isBoosterRow(row)) return false;
  if (row.is_recurring === true) return true;
  return row.is_recurring == null && !!row.recurring_parent_id;
}

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
// Compared against the CLAMPED anniversary addYears produces (Codex #4814
// P2): a Feb 29 root's anniversary in a non-leap year is Feb 28, and Feb 28
// must land in the NEW term — a month/day compare against the raw root
// (28 < 29) put it in the previous term, whose end-exclusive window did not
// even contain it.
function wholeYearsBetween(rootStr, dateStr) {
  const [ry] = String(rootStr).split('-').map(Number);
  const [dy] = String(dateStr).split('-').map(Number);
  let years = dy - ry;
  if (years > 0 && String(dateStr) < addYears(rootStr, years)) years -= 1;
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
  // Scheduler-only spellings the normalizer does not know: an nth-weekday
  // monthly series is a monthly cadence, twelve a year (Codex #4814 r2 P1 —
  // the count helper's default of 4 let eleven remaining visits read as
  // whole).
  if (pattern === 'monthly_nth_weekday') return 12;
  if (pattern === 'custom') {
    const interval = Number(parent.recurring_interval_days);
    // Cadence positions before the next anniversary — a CEILING (Codex r4
    // P1): a 150-day cadence has visits at days 0, 150 and 300, three, where
    // nearest-integer rounding said two and let a cancel go unreplaced.
    return Number.isFinite(interval) && interval > 0 ? Math.max(1, Math.ceil(365 / interval)) : null;
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

// The term at a known index — for a cancelled row an earlier reseed added:
// its stamp says which term it served, and that term (not the one its
// end-of-series date falls in) is the one now short (fallback auditor P1
// on 4a67afdc15).
function termWindowAtIndex(rootDateStr, index) {
  const root = dateOnly(rootDateStr);
  if (!root || !Number.isInteger(index) || index < 0 || Number.isNaN(Date.parse(`${root}T00:00:00Z`))) return null;
  return { index, start: addYears(root, index), end: addYears(root, index + 1) };
}

// The date a row occupies in its PLAN — a one-occurrence exception keeps
// its cadence position (date_exception_cadence_date) even when the actual
// appointment moved across the root anniversary (Codex #4814 r2 P1; the
// same rule recurring-schedule-audit.js's spacing check applies).
function planPositionDate(row) {
  if (!row) return null;
  if (row.date_exception === true && row.date_exception_cadence_date) return dateOnly(row.date_exception_cadence_date);
  return dateOnly(row.scheduled_date);
}

// Rows (root + children) that still count toward the term: plan rows only
// (no boosters), not cancelled/rescheduled/skipped/no_show, whose PLAN
// position falls inside [start, end). `termOverrides` (Map of row id →
// term index) pins a row to the term it REPLACES a visit in: a re-added
// visit lands at the end of the series — by date usually the NEXT term —
// and counting it there would let that term read as whole after one of its
// own visits is cancelled (fallback auditor P1 on 81e8083efd). The stamp
// each reseed writes records the term it served.
function countTermVisits(rows, window, termOverrides = null) {
  if (!window) return 0;
  return (rows || []).filter((row) => {
    if (isBoosterRow(row) || NON_COUNTING_STATUSES.includes(String(row.status))) return false;
    if (termOverrides && termOverrides.has(String(row.id))) return termOverrides.get(String(row.id)) === window.index;
    const d = planPositionDate(row);
    return d && d >= window.start && d < window.end;
  }).length;
}

// Does the plan still have an upcoming row after the cancel? Read from the
// series rows themselves (plan rows incl. legacy null-flagged children —
// Codex #4814 r2 P1: liveUpcomingSeriesVisits filters is_recurring = true
// and refused every legacy series as 'no_live_visits').
// "Live" = every counting active state (pending/confirmed/en_route/on_site
// and a legacy NULL status — Codex r4 P1), the same set the source-status
// rule and the term count treat as counting; terminal rows never qualify.
function hasUpcomingPlanRow(rows, todayStr) {
  return (rows || []).some((row) => isPlanSeriesRow(row)
    && isCountingSourceStatus(row.status)
    && dateOnly(row.scheduled_date) >= todayStr);
}

// `serviceId` for the single-visit surfaces; `serviceIds` for the bulk
// cancel, which hands over the whole batch so the writer can group by
// series and treat several cancels of one plan as the plan reduction it is.
async function runPostCancelSeriesReseed({ db, serviceId, serviceIds, source = 'cancel' } = {}) {
  const ids = [...new Set([...(serviceIds || []), serviceId].filter(Boolean).map(String))];
  if (!db || !ids.length) return;
  try {
    const { cancelReseedsRecurringLive } = require('../config/feature-gates');
    if (!cancelReseedsRecurringLive()) return;
    const { reseedRecurringSeriesAfterCancelBatch } = require('../routes/admin-schedule');
    if (typeof reseedRecurringSeriesAfterCancelBatch !== 'function') {
      logger.warn('[recurring-series-cancel-reseed] reseedRecurringSeriesAfterCancelBatch export missing — skipping');
      return;
    }
    const { results } = await reseedRecurringSeriesAfterCancelBatch(db, ids, { source });
    for (const result of results || []) {
      if (result?.skipped) {
        logger.info(`[recurring-series-cancel-reseed] no reseed (${source}, parent=${result.parentId || '?'}): ${result.skipped}`);
      }
    }
  } catch (e) {
    logger.error(`[recurring-series-cancel-reseed] post-cancel series reseed failed (${source}, services=${ids.join(',')}): ${e.message}`);
  }
}

module.exports = {
  runPostCancelSeriesReseed,
  plannedVisitsPerYearForSeries,
  termWindowContaining,
  termWindowAtIndex,
  countTermVisits,
  isBoosterRow,
  isPlanSeriesRow,
  isCountingSourceStatus,
  planPositionDate,
  hasUpcomingPlanRow,
  NON_COUNTING_STATUSES,
  COUNTING_SOURCE_STATUSES,
  UPCOMING_STATUSES,
};
