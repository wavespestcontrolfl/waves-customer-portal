/**
 * Billing lane — the single answer to "how does this customer pay?".
 *
 * customers.billing_mode is the explicit, owner-set lane (one setting, one
 * place: the customer profile). NULL rows fall back to the legacy inference
 * so unclassified customers behave exactly as before. Every flow that needs
 * the lane (monthly cron, completion billing, booking price stamping, the
 * schedule payloads) resolves it HERE — never by re-deriving from field
 * combinations, which is how a customer ended up in two lanes at once and
 * got dues-billed AND per-visit invoiced for the same service (2026-07
 * membership double-billing incident).
 */

const BILLING_MODES = [
  'monthly_membership', // dues on the 1st cover recurring plan visits
  'per_visit', // invoice-on-complete for each visit
  'per_application', // acceptance-stamped fee auto-collected per application
  'annual_prepay', // paid up front; coverage terms suppress visit billing
  'one_time', // single job, no recurring billing relationship
];

// Explicit mode wins; NULL infers the legacy split: WaveGuard tier + a
// positive monthly rate has always meant "the 8AM cron bills the dues and
// visits are covered" — everything else bills per visit at completion.
function resolveBillingLane(customer) {
  const mode = customer?.billing_mode || null;
  if (mode && BILLING_MODES.includes(mode)) return { mode, source: 'explicit' };
  const inferredMember = !!customer?.waveguard_tier && Number(customer?.monthly_rate || 0) > 0;
  return { mode: inferredMember ? 'monthly_membership' : 'per_visit', source: 'inferred' };
}

// The MONTHLY-MEMBERSHIP suppression ("the 8AM cron collects the dues, the
// visit itself is free"). Never for a payer-billed visit — the AP invoice must
// still be cut and sent to the payer. Never for a per-application customer:
// their autopay card is HOW the per-visit charge collects, not a reason to
// skip it. Never for annual_prepay — the 8AM cron never bills them, so "dues
// cover the visit" would be a fiction; real coverage is the prepaid stamps.
// An EXPLICIT non-membership billing_mode always defeats coverage: the lane
// setting is authoritative, so a per_visit/one_time customer can never be
// dues-covered no matter what tier/rate fields linger on the row. An explicit
// 'monthly_membership' stands in for the legacy tier requirement (rate and
// active autopay are still required — no dues collected means no coverage).
// Dues cover a RECURRING plan visit even when the booking flow stamped a
// per-visit estimated_price on the row — cadence generators stamp display
// prices routinely, and honoring the stamp double-billed membership
// customers. A priced ONE-OFF visit (isRecurring=false: add-on treatment,
// WDO, special) still bills its price; callback pricing stays with
// completionInvoiceAmount.
function membershipDuesCoverVisit({
  visitIsPayerBilled,
  perApplicationBilling,
  annualPrepayBilling,
  customerAutopayActive,
  hasVisitPrice,
  isRecurring,
  waveguardTier,
  monthlyRate,
  billingMode,
}) {
  if (billingMode && billingMode !== 'monthly_membership') return false;
  const explicitMember = billingMode === 'monthly_membership';
  return !visitIsPayerBilled
    && !perApplicationBilling
    && !annualPrepayBilling
    && !!customerAutopayActive
    && (!hasVisitPrice || !!isRecurring)
    && (explicitMember || !!waveguardTier)
    && Number(monthlyRate || 0) > 0;
}

// Per-application customers bill the explicit visit price, else the
// acceptance-stamped per_application_fee — NEVER the customer-level
// monthly_rate: a multi-service accept intentionally leaves both the fee and
// each row's estimated_price NULL (whole-plan fee on every row = overbill),
// and monthly_rate IS that same whole-plan number. A per-application row with
// no amount returns 0, the auto-invoice gate declines it, and the visit is
// billed manually. Legacy (non-per-app) rows keep the monthly_rate fallback
// the WaveGuard-membership flows depend on.
function completionInvoiceAmount({
  estimatedPrice,
  isCallback,
  perApplicationBilling,
  perApplicationFee,
  monthlyRate,
}) {
  if (estimatedPrice != null && Number(estimatedPrice) > 0) return Number(estimatedPrice);
  if (isCallback) return 0;
  if (perApplicationBilling) {
    return Number(perApplicationFee) > 0 ? Number(perApplicationFee) : 0;
  }
  return monthlyRate && Number(monthlyRate) > 0 ? Number(monthlyRate) : 0;
}

/**
 * Advisory prediction of what completing a visit will do, for the schedule
 * appointment sheet — so the office sees the billing outcome BEFORE the
 * visit runs instead of discovering it in the customer's inbox. Mirrors the
 * completion path's precedence using the same shared predicates above; edge
 * flows the completion path owns (annual-prepay renewal, always-free service
 * types, payer resolution fallbacks) intentionally collapse into the closest
 * honest label rather than being re-implemented here.
 *
 * Returns { kind, amount, conflictStampedPrice } where kind is one of:
 *   'payer'            — invoices the third-party payer, never the customer
 *   'prepaid'          — visit already paid out of band / by stamp
 *   'covered_membership' — dues cover it; NO invoice will be cut
 *   'covered_annual'   — annual-prepay coverage settles it
 *   'auto_charge'      — per-application fee auto-collects from saved method
 *   'invoice'          — an invoice for `amount` goes out on completion
 *   'no_charge'        — nothing bills (callback / no amount on file)
 */
function predictCompletionBilling({
  lane,
  autopayActive,
  estimatedPrice,
  monthlyRate,
  perApplicationFee,
  isRecurring,
  isCallback,
  payerBilled,
  prepaidAmount,
  billingMode,
}) {
  const hasVisitPrice = estimatedPrice != null && Number(estimatedPrice) > 0;
  if (payerBilled) return { kind: 'payer', amount: hasVisitPrice ? Number(estimatedPrice) : null, conflictStampedPrice: false };
  if (prepaidAmount != null && Number(prepaidAmount) > 0) {
    return { kind: 'prepaid', amount: Number(prepaidAmount), conflictStampedPrice: false };
  }
  if (lane === 'annual_prepay') return { kind: 'covered_annual', amount: null, conflictStampedPrice: false };
  if (lane === 'per_application') {
    if (isCallback) return { kind: 'no_charge', amount: 0, conflictStampedPrice: false };
    const amount = completionInvoiceAmount({
      estimatedPrice, isCallback, perApplicationBilling: true, perApplicationFee, monthlyRate,
    });
    if (!(amount > 0)) return { kind: 'no_charge', amount: 0, conflictStampedPrice: false };
    return { kind: autopayActive ? 'auto_charge' : 'invoice', amount, conflictStampedPrice: false };
  }
  const covered = membershipDuesCoverVisit({
    visitIsPayerBilled: false,
    perApplicationBilling: false,
    annualPrepayBilling: false,
    customerAutopayActive: autopayActive,
    hasVisitPrice,
    isRecurring,
    waveguardTier: lane === 'monthly_membership',
    monthlyRate,
    billingMode: billingMode || (lane === 'monthly_membership' ? 'monthly_membership' : null),
  });
  if (covered) {
    return { kind: 'covered_membership', amount: null, conflictStampedPrice: hasVisitPrice };
  }
  const amount = completionInvoiceAmount({
    estimatedPrice, isCallback, perApplicationBilling: false, perApplicationFee, monthlyRate,
  });
  if (!(amount > 0)) return { kind: 'no_charge', amount: 0, conflictStampedPrice: false };
  return { kind: 'invoice', amount, conflictStampedPrice: false };
}

// Has THIS ET month's membership dues payment been collected (paid or
// processing)? Mirrors the monthly cron's already-charged check: the
// metadata.billed_month stamp is authoritative (month-of-obligation
// attribution — a July decline recovered Aug 1 counts for July, not
// August); legacy rows without the stamp match on payment month + the
// canonical "WaveGuard Monthly" description marker.
async function monthlyDuesCollected(dbConn, customerId, now = new Date()) {
  const { etDateString } = require('../utils/datetime-et');
  const monthKey = etDateString(now).slice(0, 7);
  const row = await dbConn('payments')
    .where({ customer_id: customerId })
    .whereIn('status', ['paid', 'processing'])
    .where(function billedThisMonth() {
      this.whereRaw("metadata->>'billed_month' = ?", [monthKey])
        .orWhere(function legacyMarkerMatch() {
          this.whereRaw("(metadata IS NULL OR metadata->>'billed_month' IS NULL)")
            .andWhereRaw("to_char(payment_date, 'YYYY-MM') = ?", [monthKey])
            .andWhere('description', 'like', '%WaveGuard Monthly%');
        });
    })
    .first('id');
  return !!row;
}

module.exports = {
  BILLING_MODES,
  resolveBillingLane,
  membershipDuesCoverVisit,
  completionInvoiceAmount,
  predictCompletionBilling,
  monthlyDuesCollected,
};
