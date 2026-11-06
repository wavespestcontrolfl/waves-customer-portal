/**
 * GATE_DAY_ONLY_PROMISE (owner 2026-11-05 "D1 a" / "D2 a", 2026-11-06 "office"): what has the customer been told about
 * a visit, and may a sender or a screen still say only the DAY?
 *
 * The rule: until the 24-hour reminder a customer is promised only the DAY of a visit. The 24-hour text gives the
 * 2-hour window and is the cutoff. A night tool never changes what the customer was told (the day, or the time). Online
 * booking and the AI call agent keep the customer's own hour pick (a set time, locked), so they are never day-only.
 *
 * This module is the stable API the later parts call (senders, customer screens, AI context, the office booking box).
 * Nothing in the app calls it yet except tests. It sends nothing and spends nothing. With the gate off every function
 * here answers "today's behavior".
 */

const { loadPromiseLevels } = require('./auto-dispatch/told-visits');

// The 24-hour reminder takes over inside this many hours. It is the same boundary the reminder sender uses:
// appointment-reminders.js reminder72hStillReachable (`> 24.25` hours out) and the cron branches (72-hour `hoursUntil >
// 24.25`, 24-hour `hoursUntil <= 24.25`). A day-only promise is only safe while that 24-hour text will still go out
// and give the window.
const DAY_PROMISE_CUTOFF_HOURS = 24.25;

// The metadata a day-only sender adds to its send (merged into the metadata the sender passes to the messaging audit
// or the email interaction row).
//   window_unknown: true  - appointment-reminders.js safeSendAppointment (and messaging/audit.js persistAudit) then
//                           record NO rendered_slot_ms, so the no-show detector does not read the send as an hour.
//   promise_level: 'day'  - the explicit marker the no-show detector's promise reader turns into level 'day'
//                           (no-show-detector.js loadPromiseEvents). Without it a send with no slot reads as an
//                           unknown window, which counts as an hour (fail closed).
const DAY_PROMISE_META = Object.freeze({ window_unknown: true, promise_level: 'day' });

/** Safe, call-time read of GATE_DAY_ONLY_PROMISE (strict 'true'). An unreadable gate is off. */
function dayOnlyPromiseOn() {
  try {
    const gates = require('../config/feature-gates');
    return typeof gates.dayOnlyPromiseLive === 'function' && gates.dayOnlyPromiseLive() === true;
  } catch {
    return false;
  }
}

/** Hours from `now` to `startAt`, or NaN when `startAt` is missing or not a valid time. */
function hoursUntil(startAt, now) {
  if (startAt == null || startAt === '') return NaN;
  const start = startAt instanceof Date ? startAt.getTime() : new Date(startAt).getTime();
  const at = now instanceof Date ? now.getTime() : new Date(now).getTime();
  return (start - at) / 3600000;
}

/**
 * May a sender promise only the DAY of this visit? Pure. True only when ALL of these hold:
 *  - `gateOn`: GATE_DAY_ONLY_PROMISE is on.
 *  - `startAt` is a valid time more than DAY_PROMISE_CUTOFF_HOURS after `now`: the 24-hour text will still go out and
 *    give the window. A windowless visit (startAt null) is false: today's windowless copy stays.
 *  - `reminder24hEnabled` is not false: the customer will actually get that 24-hour text.
 *  - `customerPicked` is not true: the hour is the customer's own set time (online booking, the AI call agent) or an
 *    office booking marked "customer asked for this time", so it stays an hour.
 *  - `level` is not 'hour': the visit's latest promise is not already an hour ('none' or 'day' are fine).
 */
function shouldPromiseDayOnly({
  startAt, now = new Date(), reminder24hEnabled, customerPicked, level, gateOn = dayOnlyPromiseOn(),
} = {}) {
  if (gateOn !== true) return false;
  const hours = hoursUntil(startAt, now);
  if (!Number.isFinite(hours) || hours <= DAY_PROMISE_CUTOFF_HOURS) return false;
  if (reminder24hEnabled === false) return false;
  if (customerPicked === true) return false;
  return level !== 'hour';
}

/**
 * Should a customer screen show the HOUR for this visit? Pure. True when the gate is off, when `startAt` is null (the
 * screen's own windowless rendering applies), when the customer was told an hour (`level === 'hour'`), or when the
 * visit is inside the cutoff (the 24-hour text has gone or is due: `startAt - now <= DAY_PROMISE_CUTOFF_HOURS`).
 * Otherwise false: show the day plus "Arrival window texted the day before".
 */
function showHourFor({
  level, startAt, now = new Date(), gateOn = dayOnlyPromiseOn(),
} = {}) {
  if (gateOn !== true) return true;
  if (startAt == null || startAt === '') return true;
  if (level === 'hour') return true;
  const hours = hoursUntil(startAt, now);
  if (!Number.isFinite(hours)) return true;
  return hours <= DAY_PROMISE_CUTOFF_HOURS;
}

module.exports = {
  DAY_PROMISE_CUTOFF_HOURS,
  DAY_PROMISE_META,
  dayOnlyPromiseOn,
  shouldPromiseDayOnly,
  showHourFor,
  // Re-exported so later parts read the visit's promise level from one place.
  loadPromiseLevels,
};
