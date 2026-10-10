'use strict';

// Customer move limits for the public reschedule page (owner rulings
// 2026-10-09, GATE_RESCHEDULE_MOVE_LIMITS, dark):
//
//  1. Late-move limit. A plan visit may be moved online to a date no later
//     than its DUE DATE plus an allowance set by the plan: quarterly 21 days,
//     every other month 14, every 6 weeks 10, monthly 7. Earlier dates are
//     never limited. There is no count limit and no customer quota.
//  2. First visit. A customer with no completed visit gets 2 online moves of
//     a visit; the third goes to the office ("text us").
//  3. No rule may empty the picker: the late-move limit is not applied when
//     fewer than MIN_CHOICES times remain inside it.
//
// The due date and the move count come from reschedule_log. The series mover
// logs only the visit the customer moved, so the visit's rows are its own
// history. The history starts again when:
//   - Waves moves the visit (a slot-changing row from any other initiator:
//     staff, weather, dispatch, the phone or text agent);
//   - the visit is not where the customer's last move put it, or a move does
//     not start where the move before it ended (the staff edit screen writes
//     the row with no log row). Known limit: a staff edit that moves the
//     visit away and back to the customer's exact slot leaves no trace, so
//     the history stands; the effect is a hand-off to the office;
//   - the customer rebooks a MISSED visit (a rebook, not a move: that row
//     sets the appointment, and its date is the new due date).
//
// A missed visit being rebooked now has no limit.
//
// Fail open: an unreadable history applies no limit. A limit only hands the
// customer to the office, so a missed limit costs less than a wrong refusal.

const { gateEnvValue } = require('../../config/feature-gates');
const { etDateString, addETDays, parseETDateTime } = require('../../utils/datetime-et');
const { intervalDaysForPattern, normalizeRecurringPattern } = require('../recurring-appointment-seeder');
const { visitTimeElapsed } = require('../reschedule-eligibility');

// Allowance by the plan's nominal gap in days (intervalDaysForPattern, the
// shared reading of a stored cadence): monthly and monthly_nth_weekday 30,
// every_6_weeks 42, bimonthly 60, quarterly 90, and a 'custom' plan by its
// own interval, so a 42-day custom plan gets the 6-week allowance. Shorter
// and longer gaps (weekly, semiannual, annual), the Feb-Oct season and
// one-time visits have no late limit: the owner ruled these four only.
const ALLOWANCE_BY_GAP_DAYS = Object.freeze([
  { from: 28, to: 35, days: 7 },
  { from: 36, to: 49, days: 10 },
  { from: 50, to: 75, days: 14 },
  { from: 76, to: 100, days: 21 },
]);
const FIRST_VISIT_ONLINE_MOVES = 2;
// A second pick inside this window corrects the first; it is one move.
const CORRECTION_MINUTES = 15;
const MIN_CHOICES = 3;
const SOON_DAYS = 7;
const SELF_SERVE_INITIATOR = 'customer_self_serve';

// Read at call time: unset = kill, no redeploy.
function moveLimitsEnabled() {
  return gateEnvValue('GATE_RESCHEDULE_MOVE_LIMITS');
}

function dateOnly(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function addDays(dateStr, days) {
  return etDateString(addETDays(parseETDateTime(`${dateStr}T12:00`), days));
}

// True when the row moved the visit to another date or start: the slot the
// customer sees (the arrival window comes from the start; the end is the
// job's length). Clock values are compared to the minute: writers log
// '09:00' and '09:00:00' for one time. A row that only re-assigned the
// technician or corrected the duration is not a move.
function slotChanged(row) {
  if (dateOnly(row.original_date) !== dateOnly(row.new_date)) return true;
  return windowParts(row.original_window).start !== windowParts(row.new_window).start;
}

// Legacy plan rows store 'custom' or no pattern, with no interval; their
// cadence is the catalog's (services.frequency, read as `catalog_frequency`).
// The same reading as rate-review's CADENCE_SQL, for the four ruled plans.
const CATALOG_CADENCES = new Set(['monthly', 'every_6_weeks', 'bimonthly', 'quarterly']);

function catalogCadence(svc) {
  const stored = svc.recurring_pattern || null;
  if (stored && stored !== 'custom') return null;
  if (Number.parseInt(svc.recurring_interval_days, 10) > 0) return null;
  const frequency = normalizeRecurringPattern(svc.catalog_frequency) || svc.catalog_frequency || null;
  return CATALOG_CADENCES.has(frequency) ? frequency : null;
}

// A plan visit: the recurring root or one of its occurrences. The admin
// creator can store a cadence on a one-time visit; that visit has no plan.
function isPlanVisit(svc) {
  return svc.is_recurring === true || svc.recurring_parent_id != null;
}

function allowanceDays(svc) {
  if (!isPlanVisit(svc)) return null;
  // Legacy rows store aliases ('bi-monthly'); the shared normalizer reads
  // them. A value it does not place (monthly_nth_weekday) is passed as stored.
  const stored = svc.recurring_pattern || null;
  const pattern = catalogCadence(svc) || (stored && normalizeRecurringPattern(stored)) || stored;
  const gap = intervalDaysForPattern(pattern, svc.recurring_interval_days);
  if (!gap) return null;
  return ALLOWANCE_BY_GAP_DAYS.find((band) => gap >= band.from && gap <= band.to)?.days || null;
}

// reschedule_log windows are '<start>-<end>' clock strings.
function windowParts(value) {
  const [start, end] = String(value || '').split('-');
  return { start: start ? start.slice(0, 5) : null, end: end ? end.slice(0, 5) : null };
}

// Same date and same start. A start on one side and none on the other is
// not the same slot: staff can clear a visit's window with no log row, and
// that unplaces it. Two sides with no start compare by date.
function sameSlot(dateA, windowA, dateB, windowB) {
  if (dateOnly(dateA) !== dateOnly(dateB)) return false;
  return windowParts(windowA).start === windowParts(windowB).start;
}

// The customer rebooked a visit whose time had passed: the shared "missed"
// rule, asked at the moment the row was written.
function wasMissedRebook(row) {
  const { start, end } = windowParts(row.original_window);
  return visitTimeElapsed(
    { scheduled_date: dateOnly(row.original_date), window_start: start, window_end: end },
    new Date(row.created_at),
  );
}

// The customer's own picker moves that still stand, oldest first.
//   - Rows up to the last Waves move, and up to and including the last
//     missed rebook, are history that started again.
//   - When the visit is not where the last remaining move put it, Waves
//     placed it since with no log row: nothing stands.
function customerMovesSince(rows, svc) {
  let from = 0;
  rows.forEach((row, idx) => {
    if (!slotChanged(row)) return;
    if (row.initiated_by !== SELF_SERVE_INITIATOR || wasMissedRebook(row)) from = idx + 1;
  });
  // A pick inside CORRECTION_MINUTES of a missed rebook corrects the rebook:
  // it belongs to it, is not a move, and its date is the appointment's date.
  // The window is measured from the rebook itself, not from the last pick,
  // so a chain of picks cannot extend it.
  const rebook = from > 0 && rows[from - 1].initiated_by === SELF_SERVE_INITIATOR ? rows[from - 1] : null;
  while (rebook && from < rows.length
    && rows[from].initiated_by === SELF_SERVE_INITIATOR
    && new Date(rows[from].created_at).getTime() - new Date(rebook.created_at).getTime() <= CORRECTION_MINUTES * 60 * 1000) {
    from += 1;
  }
  let moves = rows.slice(from).filter((row) => row.initiated_by === SELF_SERVE_INITIATOR && slotChanged(row));
  // A move that does not start where the move before it ended: Waves placed
  // the visit between them with no log row. The history starts at that move.
  for (let i = moves.length - 1; i >= 1; i--) {
    if (!sameSlot(moves[i - 1].new_date, moves[i - 1].new_window, moves[i].original_date, moves[i].original_window)) {
      moves = moves.slice(i);
      break;
    }
  }
  if (!moves.length) return moves;
  // The visit is not where the last move put it: Waves placed it since.
  const last = moves[moves.length - 1];
  return sameSlot(last.new_date, last.new_window, svc?.scheduled_date, svc?.window_start) ? moves : [];
}

// The start time (ms) of each move that counts. A pick inside
// CORRECTION_MINUTES of the START of a move is a correction of that move;
// measured from the start, so a chain of picks cannot extend the window.
function moveStarts(moves) {
  const starts = [];
  for (const move of moves) {
    const at = new Date(move.created_at).getTime();
    if (!starts.length || at - starts[starts.length - 1] > CORRECTION_MINUTES * 60 * 1000) starts.push(at);
  }
  return starts;
}

function countedMoves(moves) {
  return moveStarts(moves).length;
}

// { dueDate, lastDate, firstVisitBlocked } for this visit, or null when no
// limit applies (gate off, missed visit, unreadable history).
//   lastDate: the last date the picker offers, or null (no plan allowance).
//   firstVisitBlocked: the page hands the customer to the office.
async function loadMoveLimit(svc, { database, missed = false, now = new Date() } = {}) {
  if (!moveLimitsEnabled() || missed || !svc?.id) return null;
  try {
    const rows = await database('reschedule_log')
      .where({ scheduled_service_id: svc.id })
      .orderBy('created_at', 'asc')
      .select('initiated_by', 'original_date', 'new_date', 'original_window', 'new_window', 'created_at');
    const moves = customerMovesSince(rows, svc);
    const dueDate = moves.length ? dateOnly(moves[0].original_date) : dateOnly(svc.scheduled_date);
    if (!dueDate) return null;

    const allowance = allowanceDays(svc);
    const lastDate = allowance ? addDays(dueDate, allowance) : null;

    let firstVisitBlocked = false;
    const starts = moveStarts(moves);
    if (starts.length >= FIRST_VISIT_ONLINE_MOVES) {
      // The last allowed move may still be corrected, for CORRECTION_MINUTES
      // from its start. A move past the allowance has no such window.
      const correcting = starts.length === FIRST_VISIT_ONLINE_MOVES
        && now.getTime() - starts[starts.length - 1] <= CORRECTION_MINUTES * 60 * 1000;
      if (!correcting) {
        const completed = await database('scheduled_services')
          .where({ customer_id: svc.customer_id, status: 'completed' })
          .first('id');
        firstVisitBlocked = !completed;
      }
    }
    return { dueDate, lastDate, firstVisitBlocked };
  } catch {
    return null;
  }
}

function slotDate(slot) {
  return dateOnly(slot?.date || slot?.day);
}

function choiceCount(availability, lastDate) {
  return (availability?.days || [])
    .filter((day) => !lastDate || dateOnly(day.date) <= lastDate)
    .reduce((n, day) => n + (Array.isArray(day.slots) ? day.slots.length : 0), 0);
}

// True when the late-move limit is applied:
//   - it ends before the booking range does (`rangeTo`). A limit at or past
//     the end of the range drops nothing;
//   - enough times remain inside it.
// `fullAvailability` must cover the page's whole range, so GET, the search
// and the commit reach one answer. Null (not built) applies no limit.
function lateLimitApplies(limit, fullAvailability, rangeTo) {
  if (!limit?.lastDate || !fullAvailability) return false;
  if (rangeTo && limit.lastDate >= dateOnly(rangeTo)) return false;
  return choiceCount(fullAvailability, limit.lastDate) >= MIN_CHOICES;
}

// Drop the days and times after lastDate. Returns a new availability object.
function withinLimit(availability, lastDate) {
  if (!availability || !lastDate) return availability;
  const days = (availability.days || []).filter((day) => dateOnly(day.date) <= lastDate);
  return {
    ...availability,
    days,
    slots: (availability.slots || []).filter((slot) => slotDate(slot) <= lastDate),
    nearby: days.some((day) => day.nearby),
  };
}

// True when no time is open in the next SOON_DAYS days (owner: say "call or
// text the office").
function noTimeSoon(availability, now = new Date()) {
  const horizon = addDays(etDateString(now), SOON_DAYS);
  return !(availability?.days || []).some((day) => dateOnly(day.date) <= horizon
    && Array.isArray(day.slots) && day.slots.length > 0);
}

// The list a surface returns under a limit, and the payload keys that go
// with it. `full` is the whole booking range (it decides whether the limit
// applies); `shown` is the list being returned (the same object for GET, the
// search window for find-slots). No limit: `shown` as built and no key.
// A limit and no whole-range list: the caller found the limit cannot apply
// without building it (its date is not inside the range), so nothing is
// dropped and `noTimeSoon`, which needs that list, is not sent.
function applyLimit(limit, full, shown, { rangeTo, now = new Date() } = {}) {
  if (!limit) return { availability: shown, payload: {} };
  if (!full) return { availability: shown, payload: { moveLimit: { laterByOffice: false } } };
  const applies = lateLimitApplies(limit, full, rangeTo);
  return {
    availability: applies ? withinLimit(shown, limit.lastDate) : shown,
    // No date is sent: the limit's date need not have an open time, and the
    // page must not name a day it cannot offer. `laterByOffice` says only
    // that later days were held back for the office to arrange.
    payload: {
      moveLimit: {
        laterByOffice: applies,
        noTimeSoon: noTimeSoon(applies ? withinLimit(full, limit.lastDate) : full, now),
      },
    },
  };
}

module.exports = {
  ALLOWANCE_BY_GAP_DAYS,
  allowanceDays,
  FIRST_VISIT_ONLINE_MOVES,
  CORRECTION_MINUTES,
  MIN_CHOICES,
  SOON_DAYS,
  moveLimitsEnabled,
  loadMoveLimit,
  lateLimitApplies,
  applyLimit,
  withinLimit,
  noTimeSoon,
  customerMovesSince,
  countedMoves,
};
