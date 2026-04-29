/**
 * Pure billing-cron helpers — no DB, no Twilio, no model imports.
 *
 * Lives in its own file so the audit unit tests can pin the daily-cron
 * skip contract without dragging in twilio-side-effect modules.
 */

/**
 * Returns true when the customer's billing_day matches today's
 * calendar day in ET. NULL/0/undefined billing_day defaults to 1 so
 * legacy customers (rows older than the AutopayCard billing-day picker)
 * keep their historical 1st-of-the-month cadence — without this default
 * the daily cron would attempt them every day and the existingCharge
 * idempotency check would catch only the first success of the month.
 */
function isBillingDayMatch(customerBillingDay, todayDay) {
  const effective = customerBillingDay || 1;
  return effective === todayDay;
}

module.exports = { isBillingDayMatch };
