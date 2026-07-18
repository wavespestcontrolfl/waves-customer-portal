const db = require('../models/db');
const { etDateString } = require('../utils/datetime-et');
const { resolveBillingLane } = require('./billing-lane');

// The same "still cancellable" allowlist the admin series-cancel path and the
// customer portal's upcoming-visits query use. Deliberately excludes terminal
// history (completed / cancelled / skipped / no_show — never rewritten) and
// in-progress work (en_route / on_site — a tech already rolling is an office
// decision). Owned here so the eligibility gate and the processor's sweep can
// never drift; cancellation-processor re-exports for its existing consumers.
const CANCELLABLE_STATUSES = ['pending', 'confirmed', 'rescheduled'];
// track_state values that mean a tech is actively working the visit right now.
// The tracker can LEAD the legacy status: track-transitions flips track_state
// first and syncs `status` best-effort (a sync failure only logs), so a live
// visit can still read status=pending/confirmed.
const LIVE_TRACK_STATES = ['en_route', 'on_property'];

/**
 * Does this account have anything a cancellation request would actually act
 * on? ONE definition, shared by the POST /api/requests eligibility gate and
 * the /api/schedule payload the Plan tab's Account Options render from —
 * piecemeal client mirrors of this predicate drifted three times in review
 * (rescheduled date-exemption, armed next_charge_date, dispatch-owned
 * pending rows), so the client now consumes this verdict instead of
 * approximating it.
 *
 * True when any of:
 *  - an ongoing recurring series (the processor stops recurrence),
 *  - an upcoming cancellable visit: status in CANCELLABLE_STATUSES, ET-date
 *    upcoming OR a date-exempt 'rescheduled' rebook intent, and — mirroring
 *    the sweep — not a row whose customer-visible track layer says the work
 *    is LIVE or DONE (the sweep never auto-cancels those, so for an
 *    otherwise-empty account they are nothing-to-cancel),
 *  - live billing: a positive monthly rate or an armed next_charge_date.
 */
async function hasCancellableWork(customerId) {
  if (!customerId) return false;
  const [recurringRow, upcomingRow, billingRow] = await Promise.all([
    db('scheduled_services')
      .where({ customer_id: customerId, recurring_ongoing: true })
      .first('id'),
    db('scheduled_services')
      .where({ customer_id: customerId })
      .whereIn('status', CANCELLABLE_STATUSES)
      .where(function () {
        this.where('scheduled_date', '>=', etDateString()).orWhere('status', 'rescheduled');
      })
      .whereRaw("(track_state IS NULL OR track_state NOT IN ('complete', 'en_route', 'on_property'))")
      .first('id'),
    db('customers')
      .where({ id: customerId })
      .first('monthly_rate', 'next_charge_date', 'billing_mode', 'waveguard_tier'),
  ]);
  // monthly_rate is the MEMBERSHIP dues number: explicit non-monthly lanes
  // (per_visit / one_time / per_application / annual_prepay) retain
  // lingering tier/rate fields that are NOT live dues (billing-lane.js), so
  // resolve the lane with the same classifier billing uses before counting
  // the rate. next_charge_date is likewise only meaningful on the ONE lane
  // whose billing machinery consumes it — the monthly dues cron (the
  // annual-prepay renewal reads term state, never this column, and the
  // cron skips that lane entirely; annual members are covered by their
  // recurring series / upcoming-visit legs). The column is not cleared by
  // an Auto Pay disable, so on any other lane a lingering date is
  // decoration, not something to cancel. The membership armed-date leg
  // still covers an unpriced member (NULL rate = manual quote pending):
  // an explicit monthly_membership lane IS a plan to cancel.
  const lane = billingRow ? resolveBillingLane(billingRow) : null;
  const liveDues = lane?.mode === 'monthly_membership'
    && Number(billingRow?.monthly_rate) > 0;
  const armedCharge = billingRow?.next_charge_date != null
    && lane?.mode === 'monthly_membership';
  return !!recurringRow
    || !!upcomingRow
    || liveDues
    || armedCharge;
}

module.exports = { CANCELLABLE_STATUSES, LIVE_TRACK_STATES, hasCancellableWork };
