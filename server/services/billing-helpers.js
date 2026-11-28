/**
 * Pure billing-cron helpers — no DB, no Twilio, no model imports.
 *
 * Lives in its own file so the audit unit tests can pin the daily-cron
 * skip contract without dragging in twilio-side-effect modules.
 */

/**
 * Calendar day count (28..31) for a 1-indexed year + month.
 */
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Effective billing day for a target month. NULL/0/undefined defaults to 1 so
 * legacy customers keep their historical 1st-of-the-month cadence. Days 29-31
 * clamp to the target month's last day (e.g. Feb 28/29, Apr/Jun/Sep/Nov 30)
 * when `daysInTargetMonth` is supplied so shorter months never silently skip
 * month-end customers.
 */
function effectiveBillingDay(customerBillingDay, daysInTargetMonth = null) {
  const raw = Number(customerBillingDay) || 1;
  const clamped = Math.max(1, Math.min(31, Math.trunc(raw)));
  if (Number.isInteger(daysInTargetMonth) && daysInTargetMonth >= 28 && daysInTargetMonth <= 31) {
    return Math.min(clamped, daysInTargetMonth);
  }
  return clamped;
}

/**
 * Returns true when the customer's billing_day matches today's
 * calendar day in ET, clamping 29/30/31 to the month's last day when
 * `daysInTargetMonth` is provided.
 */
function isBillingDayMatch(customerBillingDay, todayDay, daysInTargetMonth = null) {
  return effectiveBillingDay(customerBillingDay, daysInTargetMonth) === todayDay;
}

module.exports = { isBillingDayMatch, effectiveBillingDay, daysInMonth };
