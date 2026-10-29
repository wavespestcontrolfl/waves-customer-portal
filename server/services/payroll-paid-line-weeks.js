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

module.exports = { paidLineCoveringWeeks };
