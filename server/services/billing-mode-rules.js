'use strict';

/**
 * Billing type (customers.billing_mode) prerequisites — the ONE copy of the
 * rules PUT /api/admin/customers/:id applies when a save sets an explicit
 * billing type (routes/admin-customers.js, the Customer 360 billing-lane
 * selector). Extracted verbatim from that route so the Intelligence Bar's
 * update_customer (intelligence-bar/billing-mode-change.js) refuses exactly
 * what the customer page refuses. The route's responses are unchanged:
 * same checks, same order, same database reads, same messages.
 *
 * No database handle is required at load: the caller passes its own (the
 * route its `db`, the bar its transaction), and the prerequisite check takes
 * its reads as loaders so it runs only the read the requested lane needs.
 */

const INVALID_BILLING_MODE = 'Invalid billing mode';
const MONTHLY_NEEDS_RATE = 'Set a monthly rate before selecting Monthly membership — dues cannot collect at $0';
const PER_APPLICATION_NEEDS_FEE = 'Set a per-application fee before selecting Per application — visits would complete unbilled';
const ANNUAL_NEEDS_TERM = 'Annual prepay requires a PAID term covering today — the lane stamps automatically when the annual invoice is paid';

// Future pending/confirmed visits with no positive price, which complete
// unbilled in a per-visit lane (completionInvoiceAmount refuses the
// monthly-rate fallback there). Callbacks, always-free service types, and
// prepaid-stamped visits are exempt — they complete without an invoice by
// design in every lane. Errors return [] — fail OPEN (completion logging
// backstops) rather than hard-locking saves.
async function unpricedFutureBillableVisits(dbh, customerId) {
  try {
    const { etDateString } = require('../utils/datetime-et');
    const { isAlwaysFreeServiceType } = require('./no-cost-visit-types');
    const rows = await dbh('scheduled_services')
      .where({ customer_id: customerId })
      .whereIn('status', ['pending', 'confirmed'])
      .where('scheduled_date', '>=', etDateString())
      .where(function unpriced() {
        this.whereNull('estimated_price').orWhere('estimated_price', '<=', 0);
      })
      .where(function notPrepaid() {
        this.whereNull('prepaid_amount').orWhere('prepaid_amount', '<=', 0);
      })
      .select('id', 'service_type', 'is_callback', 'scheduled_date')
      .orderBy('scheduled_date', 'asc')
      .limit(100);
    return rows.filter((r) => !r.is_callback && !isAlwaysFreeServiceType(r.service_type));
  } catch { return []; }
}

// A live annual-prepay term COVERING TODAY, or null. payment_pending
// deliberately does NOT qualify: the annual-prepay service only stamps this
// lane once the prepay invoice is PAID — pending-window visits must keep
// billing per application (Codex r2). The term must also COVER TODAY: an
// expired or future-dated term would park the customer in a lane the cron
// skips while completion coverage stays false — recurring visits would
// complete unbilled until someone noticed (Codex r8 P1). A missing table
// reads as no live term.
async function liveAnnualPrepayTerm(dbh, customerId) {
  try {
    const { etDateString } = require('../utils/datetime-et');
    const todayEt = etDateString();
    return await dbh('annual_prepay_terms')
      .where({ customer_id: customerId })
      .whereIn('status', ['active', 'renewal_pending'])
      .where('term_start', '<=', todayEt)
      .where('term_end', '>=', todayEt)
      .first('id');
  } catch { return null; }
}

function unpricedVisitsRefusal(mode, billable) {
  const laneLabel = mode === 'one_time' ? 'One-time' : 'Per visit';
  const plural = billable.length !== 1;
  return `${laneLabel} bills each visit's own price — ${billable.length} upcoming visit${plural ? 's' : ''} (first ${billable[0].scheduled_date}) ${plural ? 'have' : 'has'} no price and would complete unbilled. Price or cancel ${plural ? 'them' : 'it'} before switching.`;
}

/**
 * The refusal message for moving a customer into `mode`, or null when the
 * lane's prerequisites hold. Lane prerequisites — a save must not move a
 * customer into a lane whose visits then complete unbilled (Codex r1):
 * membership needs a dues rate, per-application needs the acceptance fee,
 * annual prepay needs a live (paid) coverage term, and per-visit / one-time
 * need every upcoming billable visit priced (Codex r6).
 *
 * facts:
 *   requestedMonthlyRate      — a monthly rate set in the SAME save (route
 *                               body monthlyRate), else undefined
 *   requestedPerApplicationFee — a fee set in the same edit (the bar only;
 *                               the route never passes it), else undefined
 *   loadRates()               — the stored { monthly_rate, per_application_fee }
 *   loadLiveAnnualTerm()      — liveAnnualPrepayTerm for this customer
 *   loadUnpricedFutureVisits() — unpricedFutureBillableVisits for this customer
 */
async function billingModeRefusal(mode, facts) {
  // Lazy, like the route's own require before the extraction.
  const { BILLING_MODES } = require('./billing-lane');
  if (!BILLING_MODES.includes(mode)) return INVALID_BILLING_MODE;
  const beforeRow = await facts.loadRates();
  const effectiveRate = facts.requestedMonthlyRate !== undefined
    ? parseFloat(facts.requestedMonthlyRate) || 0
    : parseFloat(beforeRow?.monthly_rate) || 0;
  if (mode === 'monthly_membership' && !(effectiveRate > 0)) return MONTHLY_NEEDS_RATE;
  const effectiveFee = facts.requestedPerApplicationFee !== undefined
    ? facts.requestedPerApplicationFee
    : beforeRow?.per_application_fee;
  if (mode === 'per_application' && !(parseFloat(effectiveFee) > 0)) return PER_APPLICATION_NEEDS_FEE;
  if (mode === 'annual_prepay' && !(await facts.loadLiveAnnualTerm())) return ANNUAL_NEEDS_TERM;
  if (mode === 'per_visit' || mode === 'one_time') {
    const billable = await facts.loadUnpricedFutureVisits();
    if (billable.length > 0) return unpricedVisitsRefusal(mode, billable);
  }
  return null;
}

module.exports = {
  billingModeRefusal,
  unpricedFutureBillableVisits,
  liveAnnualPrepayTerm,
  INVALID_BILLING_MODE,
  MONTHLY_NEEDS_RATE,
  PER_APPLICATION_NEEDS_FEE,
  ANNUAL_NEEDS_TERM,
};
