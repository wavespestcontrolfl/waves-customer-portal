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
const { parseETDateTime } = require('../utils/datetime-et');
const { dateOnlyString } = require('../utils/date-only');

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

// The day-only fields of a send's metadata: the marker the no-show reader turns into level 'day' (promise_level), the
// no-slot flag (window_unknown) and the occurrence guard (guard_slot_ms, promised_date; NOT promises, see
// appointment-reminders.js dayGuardMeta). Anything that stores a notice's body to send it LATER (the 8 AM replay of a
// held contact, the no-show reader's fallback record) must carry exactly these with the body, or the later send records
// an unknown-window promise, which the readers count as an hour.
const PROMISE_META_KEYS = Object.freeze(['promise_level', 'window_unknown', 'guard_slot_ms', 'promised_date']);

/** The day-only fields present on a send's metadata, or {} for a window send (and for anything that is not a day promise). */
function promiseMetaOf(meta) {
  if (!meta || meta.promise_level !== 'day') return {};
  const out = {};
  for (const key of PROMISE_META_KEYS) if (meta[key] !== undefined && meta[key] !== null) out[key] = meta[key];
  return out;
}

/** `meta` with the day-only fields saved from an earlier send re-applied (nothing added for a window send). */
function withPromiseMeta(meta, saved) {
  return { ...meta, ...promiseMetaOf(saved) };
}

// The email templates a day-only send uses (services/appointment-email.js; seeded by the B1 migration). A stored copy of
// one of these is a DAY promise that was true when it was written.
const DAY_EMAIL_TEMPLATE_KEYS = Object.freeze(['appointment.confirmation_day', 'appointment.reminder_72h_day']);

/** Is this stored email message a day-only appointment email? (Both stored-copy email rails ask this before a re-send.) */
function isDayOnlyEmail(message) {
  return DAY_EMAIL_TEMPLATE_KEYS.includes(String(message?.template_key || ''));
}

const DAY_KEY_DATE = /^day-(\d{4}-\d{2}-\d{2})$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The ET date a stored day-only email promised, read from its idempotency key (appointment-email.js emailKey): `day-<date>`
 * in the slot position of a per-service or coalesced key (`<event>:<visit>:day-<date>:...`), or the occurrence date segment
 * of a grouped key (`<event>:visit:<stop>:<effect>:<date>:day:...`). Null when the key carries no parseable date.
 */
function promisedDateFromEmailKey(key) {
  const parts = String(key || '').split(':');
  if (parts[1] === 'visit') return ISO_DATE.test(parts[4] || '') && parts[5] === 'day' ? parts[4] : null;
  const match = DAY_KEY_DATE.exec(parts[2] || '');
  return match ? match[1] : null;
}

/** Is the visit still on the date a stored day-only email promised? A mismatch, an unparseable key or an unreadable visit: no. */
async function storedDateStillHolds(message, scheduledServiceId) {
  const promised = promisedDateFromEmailKey(message.idempotency_key);
  if (!promised) return false;
  const visit = await require('../models/db')('scheduled_services').where({ id: scheduledServiceId }).first('scheduled_date');
  return dateOnlyString(visit?.scheduled_date) === promised;
}

/**
 * Must a stored day-only email NOT be re-sent from its stored copy? The email twin of the text replay: both email replay
 * boundaries (transactional-email-provider-retry.js retryOne, email-bounce-recovery.js runRecoveryFlow) ask this before
 * any re-send or update, and a day-only copy goes only when the delayed-send chokepoint (appointment-reminders.js
 * revalidateDelayedDaySend) still says 'day'. Otherwise (a newer promise such as the delivered 24-hour window, the gate
 * rolled back, the 24-hour reminder switched off, inside the cutoff, or anything unreadable) the stored HTML is not sent: it
 * cannot be re-rendered safely from a stored copy, and the 24-hour reminder still gives the window to every customer who will
 * get it. A window email (any other template) is never affected: false, no read.
 */
async function dayOnlyStoredCopyStale(message) {
  if (!isDayOnlyEmail(message)) return false;
  try {
    const scheduledServiceId = String(message.trigger_event_id || '').split(':')[1] || null;
    const customerId = message.recipient_type === 'customer' ? message.recipient_id || null : null;
    if (!customerId || !scheduledServiceId) return true; // nothing to prove the promise against
    // The stored HTML names a DAY: it is still true only while the visit is on that same ET calendar date. A silent move to
    // another eligible date must not let it go, and no promise is read for a mismatch.
    if (!(await storedDateStillHolds(message, scheduledServiceId))) return true;
    const verdict = await require('./appointment-reminders').revalidateDelayedDaySend({ customerId, scheduledServiceId });
    return verdict !== 'day';
  } catch {
    return true;
  }
}

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

// ── Who may be promised only the day (part B1: the booking confirmation and the 72-hour reminder; part B2 and the
// screens reuse the same rule) ──

// appointment_reminders.source values of a FIRST or one-time visit the OFFICE booked (the customer did not pick the
// hour, so the office may promise only the day). Where each comes from:
//   admin_manual      routes/admin-schedule.js create, the new-caller visit, the outbound review-confirm booking
//   admin_ib          services/intelligence-bar/tools.js (the Intelligence Bar books for the office)
//   estimate_followup services/estimate-converter.js (the office converts an accepted estimate into a visit)
//   health_alert_comp services/health-alerts.js (the office-approved comp visit)
//   ops_manual        ops scripts that book a visit by hand
//   admin             legacy admin bookings
const OFFICE_BOOKING_SOURCES = Object.freeze(['admin_manual', 'admin_ib', 'estimate_followup', 'health_alert_comp', 'ops_manual', 'admin']);

// Every OTHER registerAppointment source. None of them can be promised only the day: the customer picked the hour
// (online booking), the AI call agent committed one, the origin is unknown, or the visit is a recurring child
// (a child is judged by its move history instead, never by its source). A future booking path must be put in one of
// the two lists on purpose; server/tests/day-only-promise-b1-sources.test.js fails until it is.
//   booking_new, booking_followup   routes/booking.js, services/availability.js, completion-followup-booking.js
//   estimate_accept_slot            routes/estimate-public.js, services/one-tap-purchase.js (the customer picked a slot)
//   call_recording                  services/call-recording-processor.js (the AI call agent's committed time)
//   cron_selfheal                   appointment-reminders.js backfill of a missing reminder row (origin unknown)
//   recurring_auto_extend, recurring_cancel_reseed, recurring_alert_action
//                                   routes/admin-schedule.js spawned recurring children (judged by move history)
const CUSTOMER_OR_UNKNOWN_SOURCES = Object.freeze([
  'booking_new', 'booking_followup', 'estimate_accept_slot', 'call_recording', 'cron_selfheal',
  'recurring_auto_extend', 'recurring_cancel_reseed', 'recurring_alert_action',
]);

// Statuses that end a visit: a member in one of them is no longer part of the stop the customer hears about.
const ENDED_STATUSES = ['cancelled', 'completed', 'skipped'];

const MEMBER_COLUMNS = ['id', 'visit_id', 'status', 'scheduled_date', 'is_recurring', 'recurring_parent_id',
  'date_exception', 'date_exception_source', 'date_exception_at', 'customer_asked_time'];

/** The live members of each requested row's stop: Map<requested id, member rows[]>. A row with no stop is its own
 *  member; an ended (cancelled, completed, skipped) row has none. Throws on a failed read. */
async function loadStopFacts(conn, ids) {
  const own = await conn('scheduled_services').whereIn('id', ids.map(String)).select(MEMBER_COLUMNS);
  const visitIds = [...new Set(own.map((r) => r.visit_id).filter((v) => v != null).map(String))];
  const mates = visitIds.length
    ? await conn('scheduled_services').whereIn('visit_id', visitIds).whereNotIn('status', ENDED_STATUSES).select(MEMBER_COLUMNS)
    : [];
  const membersOfVisit = new Map();
  for (const m of mates) {
    const key = String(m.visit_id);
    if (!membersOfVisit.has(key)) membersOfVisit.set(key, []);
    membersOfVisit.get(key).push(m);
  }
  return new Map(own.map((r) => {
    if (ENDED_STATUSES.includes(String(r.status || ''))) return [String(r.id), []];
    return [String(r.id), r.visit_id != null ? membersOfVisit.get(String(r.visit_id)) || [r] : [r]];
  }));
}

/** Map<service id, appointment_reminders.source> of the newest live reminder row of each. Throws on a failed read. */
async function loadBookingSources(conn, memberIds) {
  if (!memberIds.length) return new Map();
  const rows = await conn('appointment_reminders').whereIn('scheduled_service_id', memberIds).where('cancelled', false)
    .orderBy('created_at', 'desc').select('scheduled_service_id', 'source');
  const sources = new Map();
  for (const r of rows) if (!sources.has(String(r.scheduled_service_id))) sources.set(String(r.scheduled_service_id), r.source);
  return sources;
}

const isRecurringChild = (m) => m.is_recurring === true && m.recurring_parent_id != null;

/** May this ONE member be promised only the day? `customer_asked_time` is the explicit intent for the current slot:
 *  true = a set time (never), false = the day only was chosen (skip the source and customer-pick rules), NULL = infer.
 *  Inferred: a recurring child unless the customer picked its slot; a first or one-time visit only from an office source AND
 *  only while the customer has not since picked its slot (a self-service reschedule keeps the office source, but the hour is
 *  now the customer's own). The customer-pick read fails closed (picked). */
async function memberEligible(conn, member, source) {
  if (member.customer_asked_time === true) return false;
  if (member.customer_asked_time === false) return true;
  if (!isRecurringChild(member) && !OFFICE_BOOKING_SOURCES.includes(source)) return false; // no move-history read
  // Lazy: auto-dispatch/eligibility pulls the route optimizer, which reads the feature gates at load time.
  return !(await require('./auto-dispatch/eligibility').isCustomerPickedVisit(member, conn)).picked;
}

/**
 * Which visits may be promised only the DAY? Map<id, { eligible, level, failed? }>, one bulk read per fact, stop-wide: every live
 * member of a visit's stop must be eligible, else none is. `level` comes from loadPromiseLevels; a level of 'hour' is
 * never eligible (the customer already has an hour). Any read failure: not eligible, level 'hour', failed true (fail
 * closed: the customer keeps today's window copy; `failed` is the only way to tell it from a real 'hour' verdict). A recurring child is judged by who placed its slot (isCustomerPickedVisit, one read
 * per child of the stop). A first or one-time visit needs an office booking source (OFFICE_BOOKING_SOURCES; any other source
 * is rejected without a read) AND the same customer-pick check, since a customer's self-service reschedule leaves the office
 * source in place.
 */
async function dayOnlyEligibility(conn, ids, now = new Date()) {
  const result = new Map();
  if (!ids || ids.length === 0) return result;
  try {
    const levels = await loadPromiseLevels(conn, ids, now);
    const facts = await loadStopFacts(conn, ids);
    const memberIds = [...new Set([...facts.values()].flat().map((m) => String(m.id)))];
    const sources = await loadBookingSources(conn, memberIds);
    for (const id of ids) {
      const level = levels.get(id) || 'hour';
      const members = facts.get(String(id)) || [];
      let eligible = level !== 'hour' && members.length > 0;
      for (const member of eligible ? members : []) {
        if (!(await memberEligible(conn, member, sources.get(String(member.id))))) { eligible = false; break; }
      }
      result.set(id, { eligible, level });
    }
  } catch {
    // failed: true marks a READ FAILURE (as opposed to a real "customer was told an hour" verdict, which has the same
    // eligible/level). A screen ignores it and keeps showing the hour; an AI context (day-only-ai-context.js) says only the day.
    for (const id of ids) result.set(id, { eligible: false, level: 'hour', failed: true });
  }
  return result;
}

/**
 * The per-send decision for the booking confirmation and the 72-hour reminder (and part B2's move notices): should this
 * send promise only the day? { dayOnly, level, eligible }. `id` is one visit, or `ids` every member of a stop (all must
 * be eligible). The cheap checks (gate, cutoff, the customer's 24-hour reminder) run first, so a gate-off send, an
 * inside-the-cutoff send and a 24-hour-reminder-off customer read nothing from the database.
 */
async function dayOnlySendDecision(conn, { id = null, ids = null, startAt, now = new Date(), reminder24hEnabled } = {}) {
  const wanted = (ids && ids.length ? ids : [id]).filter((v) => v != null);
  const no = { dayOnly: false, level: null, eligible: false };
  if (!wanted.length) return no;
  if (!shouldPromiseDayOnly({ startAt, now, reminder24hEnabled, customerPicked: false, level: 'none' })) return no;
  const verdicts = await dayOnlyEligibility(conn, wanted, now);
  // A stop is judged as a whole: every requested member must be eligible, and no member's latest promise may be an hour.
  const all = wanted.map((w) => verdicts.get(w) || { eligible: false, level: 'hour' });
  const eligible = all.every((a) => a.eligible);
  const levels = all.map((a) => a.level);
  const level = levels.includes('hour') ? 'hour' : levels.includes('day') ? 'day' : 'none';
  const dayOnly = shouldPromiseDayOnly({ startAt, now, reminder24hEnabled, customerPicked: !eligible, level });
  return { dayOnly, level, eligible };
}

/** The visit's start time from its ET date and window start, or null. */
function composeStartAt(row) {
  const date = dateOnlyString(row && row.scheduled_date);
  const time = row && row.window_start ? String(row.window_start).slice(0, 8) : null;
  if (!date || !time) return null;
  const at = parseETDateTime(`${date}T${time}`);
  return at instanceof Date && !Number.isNaN(at.getTime()) ? at : null;
}

/**
 * Should a customer screen show the HOUR for each of these visits? Map<id, { showHour, level, eligible, failed? }>. Rows carry at
 * least id, scheduled_date and window_start. Gate off: showHour true for every row and NO database read. Gate on:
 * showHour = !eligible || the start is missing/invalid || it is within DAY_PROMISE_CUTOFF_HOURS. One bulk eligibility
 * read for all rows. A failed read: showHour true for every row (the safe side for a screen: the customer keeps seeing
 * the hour they may have been told) and `failed: true` on each, so an AI context can choose the other safe side.
 */
async function loadTimeDisplay(conn, rows, now = new Date()) {
  const out = new Map();
  const list = Array.isArray(rows) ? rows.filter((r) => r && r.id != null) : [];
  if (!dayOnlyPromiseOn()) {
    for (const r of list) out.set(r.id, { showHour: true, level: null, eligible: false });
    return out;
  }
  const verdicts = await dayOnlyEligibility(conn, list.map((r) => r.id), now);
  for (const r of list) {
    const { eligible, level, failed } = verdicts.get(r.id) || { eligible: false, level: 'hour' };
    const hours = hoursUntil(composeStartAt(r), now);
    out.set(r.id, {
      showHour: !eligible || !Number.isFinite(hours) || hours <= DAY_PROMISE_CUTOFF_HOURS,
      level,
      eligible,
      // Only on a failed eligibility read; every other row keeps its shape. Callers that ignore it behave as before.
      ...(failed === true ? { failed: true } : {}),
    });
  }
  return out;
}

module.exports = {
  DAY_EMAIL_TEMPLATE_KEYS,
  isDayOnlyEmail,
  promisedDateFromEmailKey,
  dayOnlyStoredCopyStale,
  PROMISE_META_KEYS,
  promiseMetaOf,
  withPromiseMeta,
  OFFICE_BOOKING_SOURCES,
  CUSTOMER_OR_UNKNOWN_SOURCES,
  dayOnlyEligibility,
  dayOnlySendDecision,
  loadTimeDisplay,
  DAY_PROMISE_CUTOFF_HOURS,
  DAY_PROMISE_META,
  dayOnlyPromiseOn,
  shouldPromiseDayOnly,
  showHourFor,
  // Re-exported so later parts read the visit's promise level from one place.
  loadPromiseLevels,
};
