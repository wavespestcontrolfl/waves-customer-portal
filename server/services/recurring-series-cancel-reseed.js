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

// The status a visit LEFT when its current cancellation began (Codex #4814
// r7 P1). Audit rows newest first; the current episode is the newest
// unbroken run of rows that landed on 'cancelled' — retries append
// cancelled→cancelled rows on top of the real one, and a cancel that was
// later compensated back to a live status (offboarding / cancellation-
// processor write cancelled→live) ends an OLDER episode that must not be
// consulted. Returns the entering row's from_status, or undefined when no
// cancellation episode is current.
function cancelEpisodeSourceStatus(transitionsNewestFirst) {
  let entering;
  for (const row of transitionsNewestFirst || []) {
    if (String(row.to_status) !== 'cancelled') break;
    entering = row;
  }
  // episodeKey identifies THIS cancellation episode (its entering audit
  // row), so a decision recorded against it — the batch plan-reduction
  // decline — never outlives a later un-cancel + re-cancel.
  if (!entering) return undefined;
  const key = entering.id != null ? entering.id : entering.transitioned_at;
  return {
    fromStatus: entering.from_status,
    episodeKey: key == null ? null : String(key instanceof Date ? key.toISOString() : key),
    notes: entering.notes == null ? null : String(entering.notes),
  };
}

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
  // Free re-service callbacks and included follow-ups ride a recurring
  // root but are never purchased applications (Codex #4814 r5 P1) — the
  // same exclusions the accepted-plan classifier applies.
  if (row.is_callback === true || row.followup_included === true) return false;
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
// appointment moved across the root anniversary (Codex #4814 r2 P1), and an
// auto-dispatched row keeps its recurring_dispatch_due_date while
// scheduled_date moved up to three days (Codex r8 P2) — the same order
// recurring-schedule-audit.js's recurringCadenceDate reads.
function planPositionDate(row) {
  if (!row) return null;
  if (row.date_exception === true && row.date_exception_cadence_date) return dateOnly(row.date_exception_cadence_date);
  return dateOnly(row.recurring_dispatch_due_date || row.scheduled_date);
}

// Plan terms by cadence SLOT (Codex #4814 r6 P1): the plan's k-th occurrence
// belongs to term floor(k / expected), k counted over the plan rows (no
// boosters / callbacks) in cadence order — plan position date, then id.
// A date window cannot do this: an ordinal-weekday monthly series puts its
// 13th visit ("first Saturday" of next January) a day BEFORE the root's
// anniversary, and a 6-week or custom cadence never lands on it. Cancelled
// and other non-counting rows keep their slot (they were occurrences); a
// row an earlier reseed added is pinned to the term it served
// (`termOverrides`, from the stamps) instead of taking a slot. Returns a Map
// of row id → term index for every plan row.
function assignPlanTerms(rows, expected, termOverrides = null) {
  const terms = new Map();
  if (!Number.isInteger(expected) || expected < 1) return terms;
  const ordered = (rows || [])
    .filter((row) => isPlanSeriesRow(row) && !(termOverrides && termOverrides.has(String(row.id))))
    .sort((a, b) => (planPositionDate(a) || '').localeCompare(planPositionDate(b) || '') || String(a.id).localeCompare(String(b.id)));
  ordered.forEach((row, k) => terms.set(String(row.id), Math.floor(k / expected)));
  if (termOverrides) for (const [id, index] of termOverrides) terms.set(String(id), index);
  return terms;
}

// Rows that still count toward term `termIndex`: plan rows the slot map puts
// there, not cancelled/rescheduled/skipped/no_show.
function countTermVisits(rows, termIndex, terms) {
  if (!Number.isInteger(termIndex) || !terms) return 0;
  return (rows || []).filter((row) => isPlanSeriesRow(row)
    && terms.get(String(row.id)) === termIndex
    && !NON_COUNTING_STATUSES.includes(String(row.status))).length;
}

// Does the plan still have an upcoming row after the cancel? Read from the
// series rows themselves (plan rows incl. legacy null-flagged children —
// Codex #4814 r2 P1: liveUpcomingSeriesVisits filters is_recurring = true
// and refused every legacy series as 'no_live_visits').
// "Live" = every counting active state (pending/confirmed/en_route/on_site
// and a legacy NULL status — Codex r4 P1), the same set the source-status
// rule and the term count treat as counting; terminal rows never qualify.
function isUpcomingPlanRow(row, todayStr) {
  return isPlanSeriesRow(row) && isCountingSourceStatus(row.status) && dateOnly(row.scheduled_date) >= todayStr;
}
function hasUpcomingPlanRow(rows, todayStr) {
  return (rows || []).some((row) => isUpcomingPlanRow(row, todayStr));
}
// The visit cap's population (Codex r7 P1): the same plan rows.
function countUpcomingPlanRows(rows, todayStr) {
  return (rows || []).filter((row) => isUpcomingPlanRow(row, todayStr)).length;
}

// The reseed's extend anchor: the latest plan row by plan position — the
// series' END, where the added visit is appended. Legacy null-flagged
// children count (the shared latestLiveSeriesVisit reader, is_recurring =
// true only, cannot see them; pre-push audit P1), the cancelled row itself
// counts (cancelling the tail appends past it, never re-books its date), and
// so does every OTHER cancelled occurrence (Codex #4814 r9 P1): a later
// visit that was cancelled without a replacement (the gate was off, or its
// term was still whole) is still an occurrence of the plan, and anchoring
// before it re-books the date that was just cancelled. The exception is a
// cancel that was a deliberate plan REDUCTION (`reductionIds` — the ledger
// or the visit-count trim's own audit note): that shortened the plan, so
// its end moved back and the next cadence slot is where the kept count
// continues. 'rescheduled' placeholders never anchor — the row they moved to
// does. Returned as a cadence-position row for the reconciler's
// cadenceFloorRow.
function reseedAnchorFloor(rows, cancelledId, reductionIds = null) {
  let best = null;
  for (const row of rows || []) {
    if (!isPlanSeriesRow(row)) continue;
    const status = String(row.status);
    if (status === 'rescheduled') continue;
    if (status === 'cancelled' && String(row.id) !== String(cancelledId)
      && reductionIds && reductionIds.has(String(row.id))) continue;
    const pos = planPositionDate(row);
    if (pos && (!best || pos > best)) best = pos;
  }
  return best ? { scheduled_date: best } : null;
}

// The only rows whose reduction status can move that anchor: OTHER cancelled
// plan rows positioned after every slot-holding row and the cancelled row
// itself. The writer reads the reduction ledger for these alone (usually
// none), so the common case costs no extra query.
function laterCancelledPlanRowIds(rows, cancelledId) {
  let floor = '';
  const cancelledRows = [];
  for (const row of rows || []) {
    if (!isPlanSeriesRow(row)) continue;
    const status = String(row.status);
    if (status === 'rescheduled') continue;
    const pos = planPositionDate(row) || '';
    if (status === 'cancelled' && String(row.id) !== String(cancelledId)) cancelledRows.push({ id: String(row.id), pos });
    else if (pos > floor) floor = pos;
  }
  return cancelledRows.filter((row) => row.pos > floor).map((row) => row.id);
}

// The visit-count trim's own audit note (reconcileRecurringSeriesVisitCount
// writes it verbatim on every row it cancels) — recognises a trim made
// before the plan-reduction ledger existed.
const TRIM_TRANSITION_NOTE = /^Recurring plan shortened to \d+ visits? from Edit appointment$/;
function isTrimTransitionNote(notes) {
  return typeof notes === 'string' && TRIM_TRANSITION_NOTE.test(notes);
}

// Plan-reduction INTENT of a bulk cancel request (pre-push audit P1 on
// d3e302202d): the rows the operator selected that are plan rows in a
// counting state, grouped by series root; a root with 2+ of them is a
// deliberate shortening. Read BEFORE the per-row cancel transactions so each
// row's "don't add back" ledger row commits atomically with its own cancel —
// the bulk route commits row by row, so the batch's outcome is not known
// until after the first rows are already visible to a replay. Returns a Map
// of row id → { rootId, groupIds } for the rows in such groups only.
function planReductionGroups(rows) {
  const byRoot = new Map();
  for (const row of rows || []) {
    if (!isPlanSeriesRow(row) || !isCountingSourceStatus(row.status)) continue;
    const rootId = String(row.recurring_parent_id || row.id);
    if (!byRoot.has(rootId)) byRoot.set(rootId, []);
    byRoot.get(rootId).push(String(row.id));
  }
  const out = new Map();
  for (const [rootId, ids] of byRoot) {
    const groupIds = [...new Set(ids)];
    if (groupIds.length < 2) continue;
    for (const id of groupIds) out.set(id, { rootId, groupIds });
  }
  return out;
}

// `serviceId` for the single-visit surfaces; `serviceIds` for the bulk
// cancel, which hands over the whole batch so the writer can group by
// series and treat several cancels of one plan as the plan reduction it is.
async function runPostCancelSeriesReseed({ db, serviceId, serviceIds, retryIds, source = 'cancel' } = {}) {
  const ids = [...new Set([...(serviceIds || []), serviceId].filter(Boolean).map(String))];
  // Rows a retried bulk request carried again that were ALREADY cancelled
  // (pre-push audit P1): their first reseed may have failed or never run, so
  // each is re-evaluated on its own — the stamp, the episode checks and the
  // plan-reduction ledger keep it idempotent — but never counted toward this
  // request's "2+ visits of one plan" reduction test.
  const retries = [...new Set((retryIds || []).filter(Boolean).map(String))].filter((id) => !ids.includes(id));
  if (!db || (!ids.length && !retries.length)) return;
  try {
    const { cancelReseedsRecurringLive } = require('../config/feature-gates');
    if (!cancelReseedsRecurringLive()) return;
    const { reseedRecurringSeriesAfterCancelBatch } = require('../routes/admin-schedule');
    if (typeof reseedRecurringSeriesAfterCancelBatch !== 'function') {
      logger.warn('[recurring-series-cancel-reseed] reseedRecurringSeriesAfterCancelBatch export missing — skipping');
      return;
    }
    const { results } = await reseedRecurringSeriesAfterCancelBatch(db, ids, { source, retryIds: retries });
    for (const result of results || []) {
      if (result?.skipped) {
        logger.info(`[recurring-series-cancel-reseed] no reseed (${source}, parent=${result.parentId || '?'}): ${result.skipped}`);
      }
    }
  } catch (e) {
    logger.error(`[recurring-series-cancel-reseed] post-cancel series reseed failed (${source}, services=${[...ids, ...retries].join(',')}): ${e.message}`);
  }
}

module.exports = {
  runPostCancelSeriesReseed,
  plannedVisitsPerYearForSeries,
  termWindowContaining,
  termWindowAtIndex,
  assignPlanTerms,
  countTermVisits,
  isBoosterRow,
  isPlanSeriesRow,
  isCountingSourceStatus,
  cancelEpisodeSourceStatus,
  planPositionDate,
  reseedAnchorFloor,
  laterCancelledPlanRowIds,
  isTrimTransitionNote,
  planReductionGroups,
  hasUpcomingPlanRow,
  countUpcomingPlanRows,
  NON_COUNTING_STATUSES,
  COUNTING_SOURCE_STATUSES,
  UPCOMING_STATUSES,
};
