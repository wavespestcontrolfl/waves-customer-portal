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
 *   - the visit's own UNDELIVERED draft invoices whose service_date still equals
 *     the booked day take the work day, so the invoice, the record and the
 *     visit share one service date. A delivered, sent or settled invoice is
 *     never re-dated: the customer already holds a PDF carrying its date. The
 *     project's own invoice is instead CREATED with the work day
 *     (earlyCloseoutInvoiceDate, called by resolveOrCreateProjectInvoice), so
 *     it is right before it is delivered.
 *
 * Never moved: a late completion (work day after the booked day: the visit
 * keeps its booked day on purpose), a completion dated after today, a visit
 * that was not completed by this closeout, a legacy `rescheduled` row, and a
 * visit grouped with live partners (a stop's members share one date).
 *
 * Gate off = this module writes nothing.
 */
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');
const { completionMovesDateLive } = require('../config/feature-gates');
// A grouped partner in a terminal or replaced status no longer shares the stop.
const { JOIN_INELIGIBLE_STATUSES } = require('./visit-context/statuses');

const MOVE_SOURCE = 'completion_early';

function dayKey(value) {
  if (value == null || value === '') return null;
  const text = String(value instanceof Date ? value.toISOString() : value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

/**
 * Pure decision: does a closeout dated `workDate` move a visit booked for
 * `bookedDate`? Only a work day strictly BEFORE the booked day, and not in the
 * future, moves it.
 */
function planCompletionDateMove({ bookedDate, workDate, previousStatus, today = etDateString() } = {}) {
  const from = dayKey(bookedDate);
  const to = dayKey(workDate);
  if (!from || !to) return { move: false, reason: 'no_date' };
  if (String(previousStatus || '').toLowerCase() === 'rescheduled') return { move: false, reason: 'rescheduled_row' };
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
    .whereNotIn('status', JOIN_INELIGIBLE_STATUSES)
    .first('id');
  return !!partner;
}

/**
 * The service date a project's invoice must carry when it is created BEFORE
 * the visit closes out early: the project's work day, only when the closeout
 * will then move the visit to that day (same plan, same exclusions). The
 * invoice is normally delivered before closeout, so it has to be dated right
 * at creation; the closeout never re-dates a delivered invoice.
 * Returns the YYYY-MM-DD work day, or null (gate off, no early move, or no visit).
 */
async function earlyCloseoutInvoiceDate(runner, { project, scheduledServiceId, today = etDateString() } = {}) {
  if (!completionMovesDateLive()) return null;
  if (!scheduledServiceId) return null;
  const workDate = dayKey(project?.project_date);
  if (!workDate) return null;
  const visit = await runner('scheduled_services').where({ id: scheduledServiceId }).first();
  if (!visit) return null;
  const plan = planCompletionDateMove({
    bookedDate: visit.scheduled_date, workDate, previousStatus: visit.status, today,
  });
  if (!plan.move) return null;
  if (await hasLiveGroupPartner(runner, visit)) return null;
  return plan.to;
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
 * @returns {Promise<{moved:boolean, reason?:string, from?:string, to?:string, invoicesDated?:number}>}
 */
async function moveCompletedVisitToWorkDay(trx, {
  scheduledServiceId,
  serviceRecord,
  workDate = null,
  previousStatus,
  scheduledServiceCols = null,
  today = etDateString(),
} = {}) {
  if (!completionMovesDateLive()) return { moved: false, reason: 'gate_off' };
  if (!scheduledServiceId || !serviceRecord) return { moved: false, reason: 'no_record' };

  const cols = scheduledServiceCols || await trx('scheduled_services').columnInfo();
  // Without the column the booked day cannot be kept: move nothing.
  if (!cols.original_scheduled_date) return { moved: false, reason: 'column_missing' };

  const locked = await trx('scheduled_services').where({ id: scheduledServiceId }).forUpdate().first();
  if (!locked) return { moved: false, reason: 'visit_missing' };
  if (String(locked.status || '').toLowerCase() !== 'completed') return { moved: false, reason: 'not_completed' };

  const plan = planCompletionDateMove({
    bookedDate: locked.scheduled_date,
    workDate: dayKey(workDate) || serviceRecord.service_date,
    previousStatus,
    today,
  });
  if (!plan.move) return { moved: false, reason: plan.reason };

  if (cols.visit_id && await hasLiveGroupPartner(trx, locked)) return { moved: false, reason: 'grouped_visit' };

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

  // A reused service record can still carry the booked day: give it the work
  // day too, under the same copy-only rule as the invoices below.
  let recordDated = 0;
  if (serviceRecord.id) {
    recordDated = await trx('service_records')
      .where({ id: serviceRecord.id })
      .whereRaw('service_date = ?::date', [plan.from])
      .update({ service_date: plan.to });
  }

  // The visit's own invoices: only a service date that still equals the booked
  // day is a copy of it, so a deliberately different date is never overwritten,
  // and only a draft nobody has received: a sent, delivered, viewed or settled
  // invoice keeps the date on the PDF the customer holds.
  const invoiceMatch = (builder) => {
    builder.where({ scheduled_service_id: locked.id });
    if (serviceRecord.id) builder.orWhere({ service_record_id: serviceRecord.id });
  };
  const invoicesDated = await trx('invoices')
    .where(invoiceMatch)
    .where({ status: 'draft' })
    .whereNull('sent_at')
    .whereNull('sms_sent_at')
    .whereNull('email_sent_at')
    .whereRaw('service_date = ?::date', [plan.from])
    .update({ service_date: plan.to, updated_at: trx.fn.now() });

  logger.info(`[completion-visit-date] visit ${locked.id} completed early: moved ${plan.from} -> ${plan.to}${locked.is_recurring === true ? ' (recurring: series slot kept)' : ''}; ${invoicesDated} invoice(s) re-dated, ${recordDated} record(s) re-dated`);
  return { moved: true, from: plan.from, to: plan.to, invoicesDated, recordDated };
}

module.exports = {
  MOVE_SOURCE,
  planCompletionDateMove,
  earlyCloseoutInvoiceDate,
  moveCompletedVisitToWorkDay,
};
