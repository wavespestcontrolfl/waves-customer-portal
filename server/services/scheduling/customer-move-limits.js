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
// history. A move by Waves (staff, weather, dispatch, the phone or text
// agent) and a reschedule link the office sent after a call both start the
// history again: the date Waves put the visit on is the new due date.
//
// A missed visit is being rebooked, not moved: no limit applies to it.
//
// Fail open: an unreadable history applies no limit. A limit only hands the
// customer to the office, so a missed limit costs less than a wrong refusal.

const { gateEnvValue } = require('../../config/feature-gates');
const { etDateString, addETDays, parseETDateTime } = require('../../utils/datetime-et');

const ALLOWANCE_DAYS = Object.freeze({
  quarterly: 21,
  bimonthly: 14,
  every_6_weeks: 10,
  monthly: 7,
});
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

function slotChanged(row) {
  return dateOnly(row.original_date) !== dateOnly(row.new_date)
    || String(row.original_window || '') !== String(row.new_window || '');
}

// The customer's own picker moves since Waves last placed the visit, oldest
// first. `resetAt` is the newest Waves event (a non-customer move, or an
// office-sent reschedule link).
function customerMovesSince(rows, resetAt) {
  let boundary = resetAt ? new Date(resetAt).getTime() : -Infinity;
  for (const row of rows) {
    if (row.initiated_by !== SELF_SERVE_INITIATOR && slotChanged(row)) {
      boundary = Math.max(boundary, new Date(row.created_at).getTime());
    }
  }
  return rows.filter((row) => row.initiated_by === SELF_SERVE_INITIATOR
    && slotChanged(row)
    && new Date(row.created_at).getTime() > boundary);
}

// Moves that count: a pick inside CORRECTION_MINUTES of the one before it is
// the same move.
function countedMoves(moves) {
  let count = 0;
  let last = null;
  for (const move of moves) {
    const at = new Date(move.created_at).getTime();
    if (last === null || at - last > CORRECTION_MINUTES * 60 * 1000) count += 1;
    last = at;
  }
  return count;
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
    const officeLink = await database('outbox_messages')
      .where({ related_scheduled_service_id: svc.id })
      .whereNotNull('commitment_id')
      .whereNotNull('sent_at')
      .max({ at: 'sent_at' })
      .first();
    const moves = customerMovesSince(rows, officeLink?.at || null);
    const dueDate = moves.length ? dateOnly(moves[0].original_date) : dateOnly(svc.scheduled_date);
    if (!dueDate) return null;

    const allowance = ALLOWANCE_DAYS[String(svc.recurring_pattern || '')] || null;
    const lastDate = allowance ? addDays(dueDate, allowance) : null;

    let firstVisitBlocked = false;
    const counted = countedMoves(moves);
    if (counted >= FIRST_VISIT_ONLINE_MOVES) {
      const lastMoveAt = new Date(moves[moves.length - 1].created_at).getTime();
      const correcting = now.getTime() - lastMoveAt <= CORRECTION_MINUTES * 60 * 1000;
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

// True when the late-move limit is applied: enough times remain inside it.
// `fullAvailability` must cover the page's whole range, so GET, the search
// and the commit reach one answer.
function lateLimitApplies(limit, fullAvailability) {
  if (!limit?.lastDate) return false;
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

module.exports = {
  ALLOWANCE_DAYS,
  FIRST_VISIT_ONLINE_MOVES,
  CORRECTION_MINUTES,
  MIN_CHOICES,
  SOON_DAYS,
  moveLimitsEnabled,
  loadMoveLimit,
  lateLimitApplies,
  withinLimit,
  noTimeSoon,
  customerMovesSince,
  countedMoves,
};
