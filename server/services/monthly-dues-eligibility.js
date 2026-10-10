/**
 * Who the monthly dues run (billing-cron.js processMonthlyBilling) will charge.
 *
 * ONE definition, shared by the cron and by the Intelligence Bar's billing
 * type card (intelligence-bar/billing-mode-change.js), so a card never
 * promises "the dues run charges the monthly rate" for a customer the run
 * skips. The cron calls the same cohort filter and the same three guards, in
 * the same order, and logs the same autopay events; nothing here changes what
 * the cron charges.
 *
 *   cohort    active, monthly_rate > 0, not service-paused after failed
 *             payments, not deleted                        (applyDuesCohort)
 *   GUARD 1/2 Auto Pay off, or paused through today        (autopayGuard)
 *   GUARD 3b/3c billing lane is not monthly membership     (laneGuard)
 *   GUARD 4/5 annual prepay covers today / invoice pending (prepayGuard)
 *   charge()  a default, enabled, valid saved Stripe method (customerOnAutopay,
 *             which mirrors StripeService.charge's own method walk)
 *
 * The billing-day match (GUARD 3) is timing, not eligibility, and stays in the
 * cron.
 */
const { isPaused, customerOnAutopay } = require('./autopay-eligibility');
const { resolveBillingLane } = require('./billing-lane');
const { etDateString } = require('../utils/datetime-et');

// Columns the cron selects for each cohort customer (plus ach_status, which
// only the saved-method check needs).
const DUES_COHORT_COLUMNS = [
  'id', 'first_name', 'last_name', 'phone', 'monthly_rate', 'waveguard_tier',
  'autopay_enabled', 'autopay_paused_until', 'autopay_payment_method_id',
  'billing_day', 'billing_mode',
];

// The cron's customer selection, as a function of the query so the cron and
// the card build the identical SQL. Returns the builder.
function applyDuesCohort(q) {
  return q
    .where({ active: true })
    .where('monthly_rate', '>', 0)
    .whereNull('service_paused_at')
    .whereNull('deleted_at');
}

// GUARD 1 + GUARD 2. Returns { event, details? } (the autopay_log event the
// cron writes) or null.
function autopayGuard(customer, now = new Date()) {
  if (customer.autopay_enabled === false) return { event: 'skipped_disabled' };
  if (isPaused(customer, now)) {
    return { event: 'skipped_paused', details: { paused_until: customer.autopay_paused_until } };
  }
  return null;
}

// GUARD 3b + GUARD 3c: this run bills the monthly membership lane only.
function laneGuard(customer) {
  if (['per_application', 'annual_prepay', 'per_visit', 'one_time'].includes(customer.billing_mode)) {
    return { event: 'skipped_billing_mode', details: { billing_mode: customer.billing_mode } };
  }
  const resolvedLane = resolveBillingLane(customer);
  if (resolvedLane.mode !== 'monthly_membership') {
    return {
      event: 'skipped_unclassified_lane',
      details: { resolved_mode: resolvedLane.mode, waveguard_tier: customer.waveguard_tier || null },
    };
  }
  return null;
}

// GUARD 4 + GUARD 5, over the run's covered / pending id sets.
function prepayGuard(customer, coveredIds, pendingIds) {
  if (coveredIds.has(String(customer.id))) return { event: 'skipped_annual_prepay' };
  if (pendingIds.has(String(customer.id))) return { event: 'skipped_annual_prepay_pending' };
  return null;
}

const PLAIN = {
  customer_missing: 'No customer matches that id.',
  customer_not_in_cohort: 'The monthly dues run skips this customer (inactive, no monthly rate, or service paused after failed payments).',
  skipped_disabled: 'Auto Pay is off, so the monthly dues run skips this customer.',
  skipped_paused: 'Auto Pay is paused, so the monthly dues run skips this customer.',
  skipped_billing_mode: 'The monthly dues run does not bill this billing type.',
  skipped_unclassified_lane: 'The monthly dues run does not bill this customer as a monthly member.',
  skipped_annual_prepay: 'An annual prepay term covers today, so the monthly dues run skips this customer.',
  skipped_annual_prepay_pending: 'An annual prepay invoice is still unpaid, so the monthly dues run skips this customer.',
  no_chargeable_method: 'This customer has no saved payment method the monthly dues run can charge (it needs a default Auto Pay card or bank account that is valid today).',
  unreadable: 'Could not confirm whether the monthly dues run would charge this customer.',
};

/**
 * Would the dues run charge this customer today, under `overrides` (the fields
 * a pending edit would write, e.g. { billing_mode })? Reads on `dbh` (a
 * transaction at commit). Fails closed: a read error is "not eligible".
 *
 * @returns {Promise<{eligible:boolean, reason:string|null, message:string|null}>}
 */
async function monthlyDuesVerdict(dbh, customerId, { overrides = {}, now = new Date() } = {}) {
  const no = (reason, extra = '') => ({ eligible: false, reason, message: `${PLAIN[reason]}${extra}` });
  try {
    const row = await applyDuesCohort(dbh('customers').where('id', customerId))
      .first([...DUES_COHORT_COLUMNS, 'ach_status']);
    if (!row) {
      const exists = await dbh('customers').where('id', customerId).whereNull('deleted_at').first('id');
      return no(exists ? 'customer_not_in_cohort' : 'customer_missing');
    }
    const customer = { ...row, ...overrides };
    const guard = autopayGuard(customer, now) || laneGuard(customer);
    if (guard) return no(guard.event);
    const AnnualPrepayRenewals = require('./annual-prepay-renewals');
    const today = etDateString(now);
    const [covered, pending] = await Promise.all([
      AnnualPrepayRenewals.getActivelyCoveredCustomerIds(today, dbh),
      AnnualPrepayRenewals.getPaymentPendingCustomerIds(today, dbh, { throwOnError: true }),
    ]);
    const prepay = prepayGuard(customer, covered, pending);
    if (prepay) return no(prepay.event);
    if (!(await customerOnAutopay(customer, { db: dbh, failClosed: true, now }))) return no('no_chargeable_method');
    return { eligible: true, reason: null, message: null };
  } catch {
    return no('unreadable');
  }
}

module.exports = {
  DUES_COHORT_COLUMNS,
  applyDuesCohort,
  autopayGuard,
  laneGuard,
  prepayGuard,
  monthlyDuesVerdict,
};
