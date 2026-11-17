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
    .whereRaw('s.scheduled_date >= ?::date AND s.scheduled_date <= (?::date + ?::int)', [day, day, FOLD_DAYS])
    .modify((qb) => applyCoverageScope(qb, 's', scope))
    .orderBy('s.scheduled_date', 'asc')
    .orderByRaw('s.window_start ASC NULLS LAST')
    .limit(25)
    .select('s.id', 's.scheduled_date', 's.window_start', 's.window_end', 's.service_type', 's.technician_id',
      's.customer_request', 's.notes', 's.visit_id', 'sv.category');
  for (const row of rows) {
    if (laneForCoverageRow({ category: row.category, serviceType: row.service_type }) !== lane) continue;
    // A grouped stop (two or more open members) moves as one visit: it is not a plan visit this fold moves alone.
    if (row.visit_id
      && (await require('./visit-groups').openMembers(conn, row.visit_id)).length >= 2) continue;
    return {
      id: row.id,
      scheduled_date: dateOnlyString(row.scheduled_date),
      window_start: row.window_start,
      window_end: row.window_end,
      service_type: row.service_type,
      technician_id: row.technician_id,
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

// After the move committed: the office's words go to the moved visit so the technician knows the problem. One guarded
// update of two text columns; no column here fires a text, a reminder or a sync trigger.
async function carryOfficeWords(conn, target, { customerRequest, notes, date }) {
  const patch = {};
  if (customerRequest?.text && !target.customer_request) {
    patch.customer_request = customerRequest.text;
    patch.customer_request_source = customerRequest.source;
  }
  if (notes) {
    patch.notes = [target.notes, `[Re-service folded in, ${foldDateLabel(date)}] ${notes}`].filter(Boolean).join('\n');
  }
  if (!Object.keys(patch).length) return;
  await conn('scheduled_services').where({ id: target.id }).update(patch);
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
async function foldAnswer({ conn, target, newDate, windowStart, out, failure, customerRequest, notes }) {
  const warnings = [foldOfficeNotice(target, newDate, windowStart), ...(Array.isArray(out?.body?.warnings) ? out.body.warnings : [])];
  if (failure) warnings.push(`The move reported an error after it saved (${failure}). Check the visit.`);
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
      notificationSent: out?.body?.notificationSent === true,
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
async function moveFoldTarget({ conn = db, target, date, windowStart, technicianId, notifyCustomer, actor, customerRequest, notes }) {
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
    body: technicianId ? { technicianId } : {},
    actor,
    sourceSurface: FOLD_SOURCE_SURFACE,
    seriesPolicy: 'single',
  });
  // A planner refusal wrote nothing: no re-read.
  if (!planned.plan) return refused(planned.body?.error || 'the move was refused');
  const { out, failure } = await runFoldMove({ planned, target, newDate, notifyCustomer, actor });
  // The move started: a row already on the asked slot saved, and a re-service booked now would double up.
  if (failure && !(await movedAnyway(conn, target, newDate, windowStart))) return refused(failure);
  return { moved: true, answer: await foldAnswer({ conn, target, newDate, windowStart, out, failure, customerRequest, notes }) };
}

module.exports = {
  FOLD_DAYS,
  foldLaneForServiceKey,
  findFoldTarget,
  foldOfficeNotice,
  moveFoldTarget,
};
