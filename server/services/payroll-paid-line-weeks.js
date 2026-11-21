/**
 * Weeks a paid pay line priced (GATE_PAYROLL_PAY_LINES, owner 2026-10-29, D5 part 1).
 *
 * A finalized pay run pays a line's federal regular-rate overtime from the approved
 * hours of every week the line covers: its earned week, or each week of its span
 * (payroll-regular-rate.js). Those hours are closed like a paid week's, even when the
 * week had no check of its own: reopening or editing them would leave the paid line
 * priced on hours that are gone. The timesheet guards ask here (time-tracking.js
 * assertEntryMutable, timesheet-approval.js unlockWeek); voiding the pay run that paid
 * the line reopens it and lifts the guard.
 *
 * Not behind the gate: a paid line keeps its weeks closed if the gate is turned off
 * later. No requires, so time tracking does not load the pay run code.
 *
 * The same guards ask finalRunClosesWeeks: no hours enter a week that has a finalized
 * pay run, also for a W-2 employee who has no check on it.
 */

/**
 * The first paid line of the technician that covers any of the weeks (Monday dates,
 * YYYY-MM-DD), or undefined. A span covers a week when it starts on or before the
 * week's Sunday and ends on or after its Monday.
 */
async function paidLineCoveringWeeks(trx, technicianId, weekStarts) {
  if (!weekStarts.length) return undefined;
  return trx('payroll_pay_lines')
    .where({ technician_id: technicianId, status: 'paid' })
    .where(function coversAnyWeek() {
      for (const week of weekStarts) {
        this.orWhere(function ownWeek() {
          this.whereNull('covers_from').where('earned_week_start', week);
        }).orWhere(function spanWeek() {
          this.whereNotNull('covers_from').whereRaw('covers_from <= ?::date + 6', [week]).where('covers_to', '>=', week);
        });
      }
    })
    .first('id');
}

/**
 * True when a finalized pay run exists for any of the weeks (Monday dates) and the
 * technician is a W-2 employee. One pay run pays a week, so W-2 hours that enter the
 * week after its run is final can never be paid: the run is voided first. The
 * technician needs no check on the run. A run can close a week with no paycheck at
 * all (time off a time-off bank did not pay), or with none for this technician. A
 * contractor's hours are not paid by a pay run and stay open. Time tracking asks for
 * the weeks a new or moved shift enters; the timesheet unlock asks for its week.
 */
async function finalRunClosesWeeks(trx, technicianId, weekStarts) {
  if (!weekStarts.length) return false;
  const found = await trx('payroll_runs as r')
    .where('r.status', 'finalized')
    .whereIn('r.week_start', weekStarts)
    .whereRaw('EXISTS (SELECT 1 FROM technicians AS t WHERE t.id = ? AND t.employment_type = ?)', [technicianId, 'w2'])
    .first('r.id');
  return Boolean(found);
}

module.exports = { paidLineCoveringWeeks, finalRunClosesWeeks };
