/**
 * Re-service fold (GATE_RESERVICE_FOLD, owner 2026-11-17).
 *
 * A pest or lawn re-service booked within FOLD_DAYS before the same customer's next plan visit of the same line books
 * nothing: that one plan visit moves up to the re-service's time instead. Only that visit moves; the plan behind it
 * stays where it is. This module finds the plan visit and runs the move; each booking path decides when to ask.
 * Today the office's New Appointment save asks (routes/admin-schedule.js). The customer re-service link and the AI
 * booking paths join the same gate in later PRs.
 */

const db = require('../models/db');
const logger = require('./logger');
const { dateOnlyString, formatDateOnly } = require('../utils/date-only');
const { laneForCoverageRow, applyCoverageScope } = require('./reservice-scheduler');

// Owner ruling 2026-11-17: "if they are within a certain range, we should book the recurring instead of the re-service"
// and, on the decision page, "move it up automatically". Real data: 6 of the last 37 re-services were 5 to 12 days before
// the next plan visit. The window is inclusive at both ends: the re-service's own date through that date + FOLD_DAYS.
const FOLD_DAYS = 14;

const FOLD_SOURCE_SURFACE = 'office_booking';

// Only the two self-bookable lanes fold. A rodent trapping follow-up is its own specialty and never folds.
function foldLaneForServiceKey(key) {
  if (key === 'pest_re_service') return 'pest';
  if (key === 'lawn_re_service') return 'lawn';
  return null;
}

// Same premise rule as the coverage scope (reservice-scheduler.js applyCoverageScope): the customer's primary or on-file
// premise = rows with no property plus rows on the primary property; a specific non-primary property = only that property.
async function foldCoverageScope(conn, customerId, propertyId) {
  const primary = await conn('customer_properties')
    .where({ customer_id: customerId, is_primary: true, active: true })
    .first('id');
  const primaryId = primary?.id || null;
  if (!propertyId || String(propertyId) === String(primaryId)) return { propertyId: primaryId, includeUnlinked: true };
  return { propertyId, includeUnlinked: false };
}

/**
 * The plan visit a re-service on `date` (YYYY-MM-DD, an ET calendar date) folds into, or null.
 * `propertyId` = the property the re-service books on (null = the primary / on-file premise).
 */
async function findFoldTarget(conn, { customerId, lane, date, propertyId = null } = {}) {
  const day = dateOnlyString(date);
  if (!customerId || !day || !lane) return null;
  const scope = await foldCoverageScope(conn, customerId, propertyId);
  const rows = await conn('scheduled_services as s')
    .leftJoin('services as sv', 's.service_id', 'sv.id')
    .where('s.customer_id', customerId)
    .where('s.is_recurring', true)
    .where((q) => q.whereNull('s.is_callback').orWhere('s.is_callback', false))
    .whereIn('s.status', ['pending', 'confirmed'])
    .whereNull('s.customer_pick_by')
    // A visit already on a shared stop moves with its stop, not alone: only an ungrouped plan visit folds.
    .whereNull('s.visit_id')
    .whereRaw('s.scheduled_date >= ?::date AND s.scheduled_date <= (?::date + ?::int)', [day, day, FOLD_DAYS])
    .modify((qb) => applyCoverageScope(qb, 's', scope))
    .orderBy('s.scheduled_date', 'asc')
    .orderByRaw('s.window_start ASC NULLS LAST')
    .limit(25)
    .select('s.id', 's.customer_id', 's.property_id', 's.service_id', 's.is_callback', 's.scheduled_date', 's.window_start',
      's.window_end', 's.service_type', 's.technician_id', 's.customer_request', 's.notes', 's.status', 'sv.category');
  for (const row of rows) {
    if (laneForCoverageRow({ category: row.category, serviceType: row.service_type }) !== lane) continue;
    return {
      id: row.id,
      customer_id: row.customer_id,
      property_id: row.property_id,
      service_id: row.service_id,
      is_callback: row.is_callback,
      scheduled_date: dateOnlyString(row.scheduled_date),
      window_start: row.window_start,
      window_end: row.window_end,
      service_type: row.service_type,
      technician_id: row.technician_id,
      status: row.status,
      customer_request: row.customer_request,
      notes: row.notes,
    };
  }
  return null;
}

function foldDateLabel(ymd) {
  return formatDateOnly(ymd, { weekday: 'short', month: 'short', day: 'numeric', year: undefined });
}

// The line the office sees after the save: what happened and why. With no start asked, the plan visit only changes day.
function foldOfficeNotice(target, newDate, windowStart) {
  const to = windowStart ? 'this time' : foldDateLabel(newDate);
  return `No re-service booked: the ${target.service_type} on ${foldDateLabel(target.scheduled_date)} moved up to ${to} (within ${FOLD_DAYS} days of the next plan visit).`;
}

// After a refusal that came once the move had started: did the plan visit land on the asked slot anyway?
async function movedAnyway(conn, target, newDate, windowStart) {
  const row = await conn('scheduled_services').where({ id: target.id }).first('scheduled_date', 'window_start', 'status');
  return !!row && dateOnlyString(row.scheduled_date) === newDate
    && !['cancelled', 'completed', 'skipped', 'no_show'].includes(row.status)
    && (!windowStart || String(row.window_start || '').startsWith(windowStart));
}

// After the move committed: the office's words go to the moved visit so the technician knows the problem. The customer's
// words fill customer_request only while it is empty (one guarded UPDATE: a visit that already has words, or got them
// meanwhile, keeps them) and otherwise go into the notes line with their source, so nothing is lost or overwritten. Notes
// are appended in SQL, never rewritten from the lookup snapshot. No column here fires a text, a reminder or a sync trigger.
async function carryOfficeWords(conn, target, { customerRequest, notes, date }) {
  const words = customerRequest?.text || null;
  let wordsToNotes = false;
  if (words) {
    const filled = await conn('scheduled_services').where({ id: target.id })
      .where((q) => q.whereNull('customer_request').orWhere('customer_request', ''))
      .update({ customer_request: words, customer_request_source: customerRequest.source });
    wordsToNotes = filled === 0;
  }
  const line = [wordsToNotes ? `Customer's words (${customerRequest.source}): ${words}.` : '', notes].filter(Boolean).join(' ');
  if (!line) return;
  await conn('scheduled_services').where({ id: target.id })
    .update({ notes: conn.raw("concat_ws(E'\\n', nullif(notes, ''), ?::text)", [`[Re-service folded in, ${foldDateLabel(date)}] ${line}`]) });
}

// Runs the planned move. A 409 comes from the rebooker's own checks, before its single write commits: it is returned as
// `failure`. Any other error is not ours to swallow.
async function runFoldMove({ planned, target, newDate, notifyCustomer, actor }) {
  const { runPlannedVisitMove } = require('../routes/admin-dispatch');
  try {
    const out = await runPlannedVisitMove({
      plan: planned.plan,
      serviceId: target.id,
      newDate,
      reasonCode: 'admin',
      reasonText: `Re-service folded into this plan visit (booked within ${FOLD_DAYS} days before it)`,
      notifyCustomer,
      actor,
    });
    return { out, failure: out.status >= 300 ? (out.body?.error || 'the move was refused') : null };
  } catch (err) {
    if (err?.statusCode !== 409) throw err;
    return { out: null, failure: err.message };
  }
}

// The 200 answer the booking route sends when the plan visit moved. Carrying the office's words never undoes the move.
async function foldAnswer({ conn, target, newDate, windowStart, out, failure, notifyCustomer, customerRequest, notes }) {
  const body = out?.body || {};
  const warnings = [foldOfficeNotice(target, newDate, windowStart), ...(Array.isArray(body.warnings) ? body.warnings : [])];
  if (failure) warnings.push(`The move reported an error after it saved (${failure}). Check the visit.`);
  // The office asked for the "visit moved" text and it did not go (a failed send, or a move that errored before its text
  // step). Same words as the Dispatch board's stop move. A visit already on the slot (notificationSkipped) needs no text.
  if (notifyCustomer !== false && body.notificationSent !== true && !body.notificationSkipped) {
    warnings.push(`The customer was not texted about the move: ${body.notificationError || 'the text could not be sent'}.`);
  }
  try {
    await carryOfficeWords(conn, target, { customerRequest, notes, date: newDate });
  } catch (err) {
    logger.error(`[reservice-fold] moved ${target.id} but could not copy the office words: ${err.message}`);
    warnings.push('The plan visit moved, but the customer\'s words and notes did not copy to it. Add them to the visit.');
  }
  return {
    id: target.id,
    recurringCreated: 0,
    appointments: [],
    warnings,
    reserviceFold: {
      movedServiceId: target.id,
      serviceType: target.service_type,
      fromDate: target.scheduled_date,
      toDate: newDate,
      start: windowStart || null,
      notificationSent: body.notificationSent === true,
    },
  };
}

/**
 * Move the plan visit up to the re-service's date and start (the Dispatch board's single-visit staff move; the customer
 * gets the existing "visit moved" text when `notifyCustomer` is not false).
 * Returns { moved: true, answer } for the 200 the booking route sends, or { moved: false, warning } when the move was
 * refused before anything committed (the caller then books the re-service as before). Any other error propagates.
 * A refusal after the move started re-reads the visit: one already on the asked slot counts as moved, with a warning.
 */
async function moveFoldTarget({ conn = db, target, date, windowStart, technicianId, customerAskedTime, notifyCustomer, actor, customerRequest, notes }) {
  const { planVisitMoveForStaff } = require('../routes/admin-dispatch');
  const newDate = dateOnlyString(date);
  const refused = (why) => ({
    moved: false,
    warning: `The re-service was booked as its own visit: the plan visit on ${foldDateLabel(target.scheduled_date)} could not move up (${why}).`,
  });
  const planned = await planVisitMoveForStaff({
    serviceId: target.id,
    newDate,
    newWindow: windowStart ? { start: windowStart } : null,
    notifyCustomer,
    // The office's "customer asked for this time" rides only when it is exactly true (the planner stamps it when
    // GATE_DAY_ONLY_PROMISE is on), as the edit modal's move builds it.
    body: { ...(technicianId ? { technicianId } : {}), ...(customerAskedTime === true ? { customerAskedTime: true } : {}) },
    actor,
    sourceSurface: FOLD_SOURCE_SURFACE,
    seriesPolicy: 'single',
    // The lookup's picture of the visit is the rebooker's write fence: a visit that left the range, went live, joined a stop,
    // entered a Quick Move hand-off, or changed customer, premise, service, or plan or callback kind since the lookup makes
    // the move miss (a 409), and the re-service books instead.
    allowLive: false,
    expect: {
      customer_id: target.customer_id,
      property_id: target.property_id,
      service_id: target.service_id,
      service_type: target.service_type,
      is_recurring: true,
      is_callback: target.is_callback,
      scheduled_date: target.scheduled_date,
      status: target.status,
      visit_id: null,
      customer_pick_by: null,
    },
  });
  // A planner refusal wrote nothing: no re-read.
  if (!planned.plan) return refused(planned.body?.error || 'the move was refused');
  const { out, failure } = await runFoldMove({ planned, target, newDate, notifyCustomer, actor });
  // The move started: a row already on the asked slot saved, and a re-service booked now would double up.
  if (failure && !(await movedAnyway(conn, target, newDate, windowStart))) return refused(failure);
  return { moved: true, answer: await foldAnswer({ conn, target, newDate, windowStart, out, failure, notifyCustomer, customerRequest, notes }) };
}

module.exports = {
  FOLD_DAYS,
  foldLaneForServiceKey,
  findFoldTarget,
  foldOfficeNotice,
  moveFoldTarget,
};
