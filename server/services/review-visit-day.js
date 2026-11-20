/**
 * The day a drafted review text speaks about (owner 2026-10-27, "FIX"): the
 * day the technician was at the visit.
 *
 * A real completion stamps service_records.service_date with the day the visit
 * CLOSES. A visit worked days earlier and closed late then reads as worked
 * today: on 2026-10-26 a close-out of Oct 3-25 visits sent nine customers
 * "Thanks for having us out today." The drafter takes its "today" / "day
 * after" wording, its "completed N days ago" fact, its history window and its
 * timing check from the date it is given, so that date is the earlier ET
 * calendar day of the record's date and the day the visit was worked.
 *
 * The day the visit was worked, by the service report's own staleness rule
 * (visit-timeline.js, also used by lawn-watering-late-close.js):
 *   1. its arrival stamp, unless the stamp is stale (before the scheduled day,
 *      or with no scheduled day more than 18 hours before the close: an
 *      earlier, aborted attempt);
 *   2. with no kept stamp, its scheduled day (only when the close is on or
 *      after it: an early close of a future visit has none);
 *   3. with neither, the raw arrival stamp.
 *
 * An earlier day is handed over as its ET calendar day ("YYYY-MM-DD"), never
 * an instant: the drafter works in days, and an instant would be misread where
 * a value is cut to its UTC date (review-ask-drafts.js dateOnly: an 8 PM ET
 * arrival is the next UTC day).
 *
 * Only the date handed to the drafter moves. The review_requests row keeps the
 * record's date (rate page, click guard, retry reuse).
 */
const db = require('../models/db');
const { etCalendarDayOf, etCalendarDaysUntil, etDateString } = require('../utils/datetime-et');
const { staleTimestampBounds, isStaleTimestamp } = require('./service-report/visit-timeline');

function instantOf(value) {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * When the visit was worked: an ISO instant (an arrival stamp), a YYYY-MM-DD
 * day (the scheduled day), or null when nothing is known.
 */
function visitWorkedOn({ arrivedAt = null, scheduledDate = null, completedAt = null } = {}) {
  const arrival = instantOf(arrivedAt);
  const bounds = staleTimestampBounds(instantOf(completedAt), scheduledDate);
  if (arrival && !isStaleTimestamp(arrival, bounds)) return arrival;
  if (bounds.scheduledDay) return bounds.scheduledDay;
  return arrival;
}

// A worked-on value's ET calendar day: a YYYY-MM-DD day as written, an instant in ET.
function workedOnDay(workedOn) {
  if (!workedOn) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(workedOn))) return String(workedOn);
  const instant = instantOf(workedOn);
  return instant ? etDateString(new Date(instant)) : null;
}

/**
 * `recordDate` itself unless the visit was worked on an earlier ET day; then
 * that day as "YYYY-MM-DD". With no record date, the worked-on day.
 */
function draftVisitDate(recordDate, workedOn) {
  const day = workedOnDay(workedOn);
  if (!day) return recordDate || null;
  if (!recordDate) return day;
  return day < etCalendarDayOf(recordDate) ? day : recordDate;
}

/**
 * The date to hand the drafter for a touch about this visit. The record's own
 * visit first (record-first, like sendOutreachTouch's visit-context recovery),
 * else the cadence's visit. Any read failure keeps `recordDate` (today's
 * behavior).
 */
async function draftServiceDate({ recordDate = null, serviceRecordId = null, scheduledServiceId = null } = {}, database = db) {
  try {
    const record = serviceRecordId
      ? await database('service_records').where({ id: serviceRecordId }).first('scheduled_service_id', 'created_at')
      : null;
    const visitId = record?.scheduled_service_id || scheduledServiceId || null;
    if (!visitId) return recordDate || null;
    const visit = await database('scheduled_services').where({ id: visitId }).first('arrived_at', 'scheduled_date', 'completed_at');
    if (!visit) return recordDate || null;
    const workedOn = visitWorkedOn({
      arrivedAt: visit.arrived_at,
      scheduledDate: visit.scheduled_date,
      completedAt: visit.completed_at || record?.created_at || null,
    });
    return draftVisitDate(recordDate, workedOn);
  } catch {
    return recordDate || null;
  }
}

/**
 * A late closeout inside the window (owner 2026-11-20, D6 R3): the visit was worked no more than `maxDays` ET
 * calendar days before it was closed. The worked day is the one the drafter uses (visitWorkedOn). A worked day that
 * cannot be read, or that falls after the close, is outside the window: fewer texts.
 */
function closedWithinDaysOfWorkedDay({ arrivedAt = null, scheduledDate = null, closedAt = null, maxDays = 3 } = {}) {
  const closeInstant = instantOf(closedAt);
  if (!closeInstant) return false;
  const workedDay = workedOnDay(visitWorkedOn({ arrivedAt, scheduledDate, completedAt: closeInstant }));
  if (!workedDay) return false;
  // Days from the close to the worked day: 0 the same day, negative before it. After the close (positive) is outside.
  const gap = etCalendarDaysUntil(workedDay, new Date(closeInstant));
  return gap <= 0 && gap >= -maxDays;
}

// The columns the delivery-profile resolver (service-completion-profiles.js lookupServiceForScheduledService) keys on, plus
// the row id it reloads evidence by. A row whose projection lacks one reads undefined = unknown.
const IDENTITY_COLUMNS = ['id', 'service_id', 'service_type', 'service_key_snapshot', 'is_recurring'];
const identityOf = (row) => (row ? IDENTITY_COLUMNS.map((c) => row[c]) : null);

/**
 * THE verdict for the late-close review ask (owner 2026-11-20, D6 R3, GATE_REVIEW_LATE_CLOSE_ASK). The commit
 * (complete-scheduled-service.js, on the locked row) and the panel's send-time preview both call it, so the preview
 * never says true where the commit says false. True only when EVERY input below holds; an input that is unknown, failed
 * to load, or drifted between the pre-lock read and the locked row makes it false (fewer texts). Inputs:
 *   gate                      GATE_REVIEW_LATE_CLOSE_ASK strict 'true'; off = false.
 *   isBackfill                exactly true (an admin backdated closeout); anything else = false.
 *   systemQuietCloseout,
 *   recapReviewOnly,
 *   isInternalOnlyCompletion  each must be exactly false (undefined = unknown = false); these closeouts never ask.
 *   issuedInvoiceCloseout     an invoice-issued closeout never asks.
 *   visitOutcome              must be exactly 'completed' (the preview passes 'completed': the outcome is the panel's, and
 *                             the client lifts its suppression only for 'completed'). Unknown = false.
 *   deliverySuppressed        the delivery posture the commit resolved BEFORE the backfill override (typed internal-only or
 *                             disabled delivery); must be exactly false (true, omitted or non-boolean = false). The preview has no commit posture; it passes false
 *                             and relies on the strict re-resolve below.
 *   visit, preLockVisit       the locked row and the row the pre-lock posture was read from. Either missing, or any identity
 *                             column the resolver keys on (IDENTITY_COLUMNS: id, service_id, service_type, service_key_snapshot,
 *                             is_recurring) unread (undefined) or different between them = drift = false.
 *   visit.arrived_at,
 *   visit.scheduled_date,
 *   closedAt                  the worked ET day within 3 ET calendar days of the close (closedWithinDaysOfWorkedDay); an
 *                             unreadable worked day or close = false.
 *   profile                   resolved STRICT from the locked row inside its own savepoint (a probe or lookup error throws = false and
 *                             never aborts the closeout transaction); a synthesized fallback or a profile without a serviceKey = false; its findingsType,
 *                             completionMode, deliveryMode and category, with env SPECIALTY_REPORT_DELIVERY_DISABLED, go through
 *                             resolveCompletionDeliveryPosture; suppressCustomerComms = false.
 * The caller then adds the ask choice itself (requestReview, reviewAskAllowed, a blocking reviewSuppression), which the
 * panel's own toggle covers.
 */
async function lateCloseAskVerdictOrNull({
  isBackfill, systemQuietCloseout, issuedInvoiceCloseout, visitOutcome, recapReviewOnly, isInternalOnlyCompletion,
  deliverySuppressed = true, visit, preLockVisit, knex = db, closedAt,
} = {}) {
  // Every flag must be an explicit boolean false (an undefined or non-boolean flag is unknown = not kept); the invoice-issued
  // closeout is an object or nothing.
  const clear = [systemQuietCloseout, recapReviewOnly, isInternalOnlyCompletion, deliverySuppressed].every((flag) => flag === false);
  if (isBackfill !== true || visitOutcome !== 'completed' || !clear || issuedInvoiceCloseout) return false;
  if (!require('../config/feature-gates').reviewLateCloseAskLive()) return false;
  const identity = identityOf(visit);
  if (!identity || identity.includes(undefined) || JSON.stringify(identity) !== JSON.stringify(identityOf(preLockVisit))) return false;
  if (!closedWithinDaysOfWorkedDay({ arrivedAt: visit.arrived_at, scheduledDate: visit.scheduled_date, closedAt })) return false;
  try {
    const Profiles = require('./service-completion-profiles');
    // A SQL error inside the closeout transaction only drops the ask: the read runs in its own savepoint.
    const profile = await require('../utils/savepoint-read').savepointScope(knex, (k) => (
      Profiles.resolveCompletionProfileForScheduledService(visit, k, { strict: true })
    ));
    // The resolver answers an ambiguous or missing profile with a synthesized auto-send fallback: that is no verified posture.
    if (!profile || profile.synthesized === true || !profile.serviceKey) return false;
    return !Profiles.resolveCompletionDeliveryPosture({
      typedFindingsType: profile.findingsType || null,
      completionMode: profile.completionMode,
      profileDeliveryMode: profile.deliveryMode,
      specialtyDeliveryDisabled: process.env.SPECIALTY_REPORT_DELIVERY_DISABLED === 'true',
      profileCategory: profile.category,
    }).suppressCustomerComms;
  } catch {
    // The profile read failed: unknown, not a confirmed "no" (the preview tells the panel to ask again).
    return null;
  }
}

// The commit's verdict: true only when confirmed; a failed read is no ask.
async function lateCloseAskVerdict(input) {
  return (await lateCloseAskVerdictOrNull(input)) === true;
}

/**
 * The panel's send-time preview and the first-ask pre-read: the verdict for a backdated closeout of this visit made NOW,
 * as a completed visit (the commit's own verdict on the locked row is what counts). true / false only when confirmed;
 * null when a visit or profile read FAILED (unknown: the panel keeps the ask suppressed and asks again). No such visit is false.
 */
async function lateCloseAskKeptForVisit(serviceId, database = db, now = new Date()) {
  try {
    // Inside a transaction (the first-ask pre-read rides the packet one) a failed read rolls back only its own savepoint.
    const visit = serviceId
      ? await require('../utils/savepoint-read').savepointRead(database, (k) => k('scheduled_services').where({ id: serviceId }).first(...IDENTITY_COLUMNS, 'arrived_at', 'scheduled_date'))
      : null;
    return await lateCloseAskVerdictOrNull({
      isBackfill: true, visitOutcome: 'completed', systemQuietCloseout: false, recapReviewOnly: false, isInternalOnlyCompletion: false,
      deliverySuppressed: false, visit, preLockVisit: visit, knex: database, closedAt: now,
    });
  } catch {
    return null;
  }
}

module.exports = { draftServiceDate, draftVisitDate, visitWorkedOn, closedWithinDaysOfWorkedDay, lateCloseAskVerdict, lateCloseAskVerdictOrNull, lateCloseAskKeptForVisit };
