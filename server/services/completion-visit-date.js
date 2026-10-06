/**
 * Completed-visit date (GATE_COMPLETION_MOVES_DATE, owner "go" 2026-10-06).
 *
 * A visit closed out BEFORE its booked day (today only the certificate /
 * project closeout can do that: the tech form and the admin Complete button
 * refuse a future-dated visit with 409 future_scheduled_date) used to keep the
 * booked scheduled_date while its service record carried the real work day. The
 * visit, the record and the invoice then disagreed, and anything that looks a
 * visit up by its date (the job-costing soft join, the invoice service date)
 * missed it.
 *
 * With the gate on, this module moves the scheduled_services row to the work
 * day, in the closeout's own transaction and AFTER the status flip (a time edit
 * on a terminal row is ignored by the reminder trigger, so no reminder wakes):
 *   - scheduled_date = the work day (the service record's service_date)
 *   - original_scheduled_date = the booked day (fill-if-absent: a second move
 *     keeps the first booked day)
 *   - a RECURRING visit is stamped exactly like a "this visit only" move
 *     (rebooker.dateExceptionStamp): date_exception_cadence_date keeps the
 *     series slot, and every extension / top-up / collective move anchors on
 *     that slot, not on the moved date, so the NEXT visit does not shift. A
 *     series root with no stored nth / weekday also gets them frozen from the
 *     booked day, because the extension derives them from the root's date.
 *   - invoices are NEVER re-dated. A project invoice minted with the gate on
 *     is created with the work day (earlyCloseoutInvoiceDate), so it is right
 *     before it is delivered. At closeout the visit moves only when every
 *     non-void invoice of the visit already carries the work day; an invoice
 *     on any other date (delivered on the booked day, project date edited after
 *     delivery, set by hand) keeps the visit where it is (invoice_date_mismatch / record_date_mismatch),
 *     so the closeout never creates a date disagreement.
 *
 * Never moved: a late completion (work day after the booked day: the visit
 * keeps its booked day on purpose), a completion dated after today, a visit
 * that was not completed by this closeout, a legacy `rescheduled` row, and a
 * visit grouped with live partners (a stop's members share one date).
 *
 * Gate off = this module writes nothing.
 */
const logger = require('./logger');
const { etDateString, validCalendarDate } = require('../utils/datetime-et');
const { dateOnlyString } = require('../utils/date-only');
const { completionMovesDateLive } = require('../config/feature-gates');
// A grouped partner in a terminal or replaced status no longer shares the stop.
const { JOIN_INELIGIBLE_STATUSES } = require('./visit-context/statuses');

const MOVE_SOURCE = 'completion_early';
const CLOSED_STATUSES = new Set(['completed', 'cancelled', 'skipped', 'no_show']);

// The shared date-only reader, plus a real-calendar check (it accepts any
// 'YYYY-MM-DD' prefix, so '2026-02-31' needs rejecting here).
const dayKey = (value) => validCalendarDate(dateOnlyString(value));

/**
 * Pure decision: does a closeout dated `workDate` move a visit booked for
 * `bookedDate`? Only a work day strictly BEFORE the booked day, and not in the
 * future, moves it.
 */
function planCompletionDateMove({ bookedDate, workDate, previousStatus, today = etDateString() } = {}) {
  const from = dayKey(bookedDate);
  const to = dayKey(workDate);
  if (!from || !to) return { move: false, reason: 'no_date' };
  const status = String(previousStatus || '').toLowerCase();
  if (status === 'rescheduled') return { move: false, reason: 'rescheduled_row' };
  // A closeout moves only a visit it is performing: one already completed,
  // cancelled, skipped or no-show is never moved (and gets no early invoice date).
  if (CLOSED_STATUSES.has(status)) return { move: false, reason: 'visit_closed' };
  if (to === from) return { move: false, reason: 'same_day' };
  if (to > from) return { move: false, reason: 'late_completion' };
  if (to > today) return { move: false, reason: 'work_day_in_future' };
  return { move: true, from, to };
}

// A recurring visit keeps its series slot: same stamp as a "this visit only"
// move, so the cadence math and the nightly top-up keep their anchor and the
// next visit does not shift. Empty for a one-time visit.
function seriesSlotUpdate(locked, bookedDay, cols) {
  if (locked.is_recurring !== true || !cols.date_exception) return {};
  const { dateExceptionStamp } = require('./rebooker');
  const out = {};
  for (const [key, value] of Object.entries(dateExceptionStamp({ ...locked, scheduled_date: bookedDay }, MOVE_SOURCE))) {
    if (cols[key]) out[key] = value;
  }
  // The extension reads nth / weekday off the series ROOT's own date when they
  // are not stored. Freeze them from the booked day so moving the root cannot
  // change the pattern.
  if (!locked.recurring_parent_id) {
    // The shared ET ordinal rule every other series path stamps a root with.
    const { recurrenceOrdinalOptions } = require('./rebooker');
    const ordinal = recurrenceOrdinalOptions(bookedDay);
    if (cols.recurring_nth && (locked.recurring_nth == null || locked.recurring_nth === '')) out.recurring_nth = ordinal.nth;
    if (cols.recurring_weekday && (locked.recurring_weekday == null || locked.recurring_weekday === '')) out.recurring_weekday = ordinal.weekday;
  }
  return out;
}

// A grouped partner in a live status shares the stop's date: such a visit never moves.
async function hasLiveGroupPartner(runner, row) {
  if (!row.visit_id) return false;
  const partner = await runner('scheduled_services')
    .where({ visit_id: row.visit_id })
    .whereNot({ id: row.id })
    // A NULL status is live: SQL's NOT IN drops NULL rows (as visit-groups.js does).
    .where((builder) => builder.whereNotIn('status', JOIN_INELIGIBLE_STATUSES).orWhereNull('status'))
    .first('id');
  return !!partner;
}

/**
 * The ONE eligibility rule, shared by the mover and the creation-time invoice
 * dater: does a closeout dated `workDate` move this visit? `previousStatus` is
 * the visit's status BEFORE the closeout flips it (default: its current one).
 * Checks, in order: gate, the
 * `original_scheduled_date` column (the booked day cannot be kept without it),
 * the visit row, its status (when `requireStatus` is given), the date plan,
 * and a live grouped partner.
 * Resolves to { move:false, reason } or { move:true, from, to, visit, cols }.
 */
async function planEarlyMove(runner, {
  scheduledServiceId, workDate, previousStatus, cols = null, today, lock = false, requireStatus = null,
}) {
  if (!completionMovesDateLive()) return { move: false, reason: 'gate_off' };
  const columns = cols || await runner('scheduled_services').columnInfo();
  if (!columns.original_scheduled_date) return { move: false, reason: 'column_missing' };
  const query = runner('scheduled_services').where({ id: scheduledServiceId });
  const visit = await (lock ? query.forUpdate() : query).first();
  const status = String(visit?.status || '').toLowerCase();
  const refusal = (!visit && 'visit_missing') || (requireStatus && status !== requireStatus && `not_${requireStatus}`);
  if (refusal) return { move: false, reason: refusal };
  const plan = planCompletionDateMove({
    bookedDate: visit.scheduled_date, workDate, previousStatus: previousStatus ?? visit.status, today,
  });
  const grouped = plan.move && columns.visit_id && await hasLiveGroupPartner(runner, visit);
  return grouped ? { move: false, reason: 'grouped_visit' } : { ...plan, visit, cols: columns };
}

/**
 * The service date a NEWLY minted project invoice carries when the closeout
 * will then move the visit early: the project's work day, or null (gate off,
 * column missing, visit not movable, no early move). Same eligibility as the
 * closeout. An invoice is never re-dated after creation: the closeout moves
 * the visit only when every invoice and the record already agree (dateDisagreement).
 */
async function earlyCloseoutInvoiceDate(runner, { project, scheduledServiceId, today = etDateString() } = {}) {
  if (!scheduledServiceId) return null;
  const plan = await planEarlyMove(runner, { scheduledServiceId, workDate: project?.project_date, today });
  return plan.move ? plan.to : null;
}

// Closeout guard: the visit's non-void invoices (by visit or by this record)
// and the visit's service record must all carry the booked day or the work day
// (an invoice: the work day only) already. One that carries anything else (the
// booked day on a delivered or reused invoice, a project date edited after
// delivery, a date set or corrected by hand) keeps the visit where it is, so
// the closeout never creates a visit / invoice / record date disagreement. No
// date = no disagreement; a NULL invoice status counts as non-void.
// Resolves to the refusal reason, or null when everything agrees.
async function dateDisagreement(trx, { visitId, recordId, from, to }) {
  const strayInvoice = await trx('invoices')
    .where((builder) => {
      builder.where({ scheduled_service_id: visitId });
      if (recordId) builder.orWhere({ service_record_id: recordId });
    })
    .whereRaw("status IS DISTINCT FROM 'void'")
    .whereNotNull('service_date')
    .whereRaw('service_date <> ?::date', [to])
    .first('id');
  if (strayInvoice) return 'invoice_date_mismatch';
  const strayRecord = recordId && await trx('service_records')
    .where({ id: recordId })
    .whereNotNull('service_date')
    .whereRaw('service_date NOT IN (?::date, ?::date)', [from, to])
    .first('id');
  return strayRecord ? 'record_date_mismatch' : null;
}

/**
 * Move a just-completed visit to its work day. Call inside the closeout's
 * transaction, after the visit's status is `completed`.
 *
 * @param trx            knex transaction (the closeout's own)
 * @param scheduledServiceId
 * @param serviceRecord  the visit's service record
 * @param workDate       the closeout's own work day (the project's project_date).
 *                       Wins over serviceRecord.service_date: a REUSED record
 *                       is never re-dated by the closeout, so its date can
 *                       still be the booked day. Falls back to the record.
 * @param previousStatus the visit's status BEFORE this closeout flipped it
 * @param scheduledServiceCols  knex columnInfo() of scheduled_services (column guards)
 * @returns {Promise<{moved:boolean, reason?:string, from?:string, to?:string, recordDated?:number}>}
 */
async function moveCompletedVisitToWorkDay(trx, {
  scheduledServiceId,
  serviceRecord,
  workDate = null,
  previousStatus = '',
  scheduledServiceCols = null,
  today = etDateString(),
} = {}) {
  if (!scheduledServiceId || !serviceRecord) return { moved: false, reason: 'no_record' };

  const plan = await planEarlyMove(trx, {
    scheduledServiceId,
    workDate: dayKey(workDate) || serviceRecord.service_date,
    previousStatus,
    cols: scheduledServiceCols,
    today,
    lock: true,
    requireStatus: 'completed',
  });
  if (!plan.move) return { moved: false, reason: plan.reason };
  const { visit: locked, cols } = plan;
  const disagreement = await dateDisagreement(trx, { visitId: locked.id, recordId: serviceRecord.id, from: plan.from, to: plan.to });
  if (disagreement) {
    logger.warn(`[completion-visit-date] visit ${locked.id} stays on ${plan.from}: ${disagreement} (an invoice or the service record carries a date other than the work day ${plan.to})`);
    return { moved: false, reason: disagreement };
  }

  const update = {
    scheduled_date: plan.to,
    original_scheduled_date: dayKey(locked.original_scheduled_date) || plan.from,
  };
  if (cols.updated_at) update.updated_at = trx.fn.now();

  Object.assign(update, seriesSlotUpdate(locked, plan.from, cols));

  // Optimistic on the booked day: the row is locked, so a mismatch means the
  // locked read and the write disagree: move nothing rather than guess.
  const changed = await trx('scheduled_services')
    .where({ id: locked.id })
    .whereRaw('scheduled_date = ?::date', [plan.from])
    .update(update);
  if (!changed) return { moved: false, reason: 'row_changed' };

  // A reused service record (internal, never customer-held) can still carry
  // the booked day: it follows the visit, only because the move proceeded.
  const recordDated = serviceRecord.id
    ? await trx('service_records')
      .where({ id: serviceRecord.id })
      .whereRaw('service_date = ?::date', [plan.from])
      .update({ service_date: plan.to })
    : 0;

  logger.info(`[completion-visit-date] visit ${locked.id} completed early: moved ${plan.from} -> ${plan.to}${locked.is_recurring === true ? ' (recurring: series slot kept)' : ''}; ${recordDated} record(s) re-dated`);
  return { moved: true, from: plan.from, to: plan.to, recordDated };
}

/**
 * The closeout's one call: the move inside its own savepoint, never throwing.
 * A failure logs and leaves the closeout (and the visit's date) as it was.
 * Gate off = returns before any statement.
 */
async function moveCompletedVisitToWorkDaySafe(trx, args = {}) {
  if (!completionMovesDateLive()) return { moved: false, reason: 'gate_off' };
  try {
    return await trx.transaction((savepoint) => moveCompletedVisitToWorkDay(savepoint, args));
  } catch (err) {
    logger.warn(`[completion-visit-date] visit date move failed for ${args.scheduledServiceId}: ${err.message}`);
    return { moved: false, reason: 'error' };
  }
}

/**
 * After the closeout commits: the status flip's deferred dispatch:job_update was
 * built from the OLD (booked) date, so send the visit's CURRENT row to the board
 * (board_visible, address and pin included, so an open board can add the moved
 * stop) through the shared dispatch emitter, which also refreshes route quality
 * for BOTH the vacated booked day and the work day. No-op unless the visit
 * moved. Best-effort: the closeout has already committed, so this never throws.
 */
async function publishVisitDateMove(move, { jobId, actorId } = {}) {
  if (!move?.moved || !jobId) return null;
  try {
    return await require('./dispatch-assignment').emitDispatchJobUpdate({ jobId, actorId: actorId || null, previousDate: move.from });
  } catch (err) {
    logger.warn(`[completion-visit-date] dispatch update after the date move failed for ${jobId}: ${err.message}`);
    return null;
  }
}

module.exports = {
  MOVE_SOURCE,
  planCompletionDateMove,
  earlyCloseoutInvoiceDate,
  moveCompletedVisitToWorkDay,
  moveCompletedVisitToWorkDaySafe,
  publishVisitDateMove,
};
