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

const { isAlwaysFreeServiceType } = require('./no-cost-visit-types');

// Mirror of AnnualPrepayRenewals.ANNUAL_PREPAY_PREPAID_METHOD — duplicated
// as a literal so this module stays db-free for pure unit tests; the
// annual-prepay service is the source of truth.
const ANNUAL_PREPAY_PREPAID_METHOD = 'annual_prepay_invoice';

const BILLING_MODES = [
  'monthly_membership', // dues on the 1st cover recurring plan visits
  'per_visit', // invoice-on-complete for each visit
  'per_application', // acceptance-stamped fee auto-collected per application
  'annual_prepay', // paid up front; coverage terms suppress visit billing
  'one_time', // single job, no recurring billing relationship
];

// Tier sentinels that mean "NOT a member" even though the column is
// non-empty ('Commercial', 'One-Time', 'N/A', …). Lockstep with
// NON_MEMBERSHIP_TIER_KEYS in project-completion.js /
// waveguard-existing-services.js / admin-customers.js — duplicated as a
// literal so this module stays db-free for pure unit tests.
const NON_MEMBERSHIP_TIER_KEYS = new Set(['none', 'onetime', 'na', 'no', 'notset', 'commercial']);
function isMembershipTier(value) {
  const key = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  return !!key && !NON_MEMBERSHIP_TIER_KEYS.has(key);
}

// Explicit mode wins; NULL infers the legacy split: a REAL WaveGuard tier +
// a positive monthly rate has always meant "the 8AM cron bills the dues and
// visits are covered" — everything else bills per visit at completion.
// Sentinel tiers (Commercial / One-Time / None…) are non-membership values
// that merely live in the tier column; treating them as members would
// suppress price stamps and dues-bill legacy commercial/one-time customers
// who happen to carry a monthly_rate (Codex r5).
function resolveBillingLane(customer) {
  const mode = customer?.billing_mode || null;
  if (mode && BILLING_MODES.includes(mode)) return { mode, source: 'explicit' };
  const inferredMember = isMembershipTier(customer?.waveguard_tier) && Number(customer?.monthly_rate || 0) > 0;
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
// The tier requirement uses the same sentinel filter as resolveBillingLane
// (Codex r6): a 'Commercial'/'One-Time' tier must not dues-cover a visit the
// lane resolver classifies per_visit — one classifier everywhere. Prod
// verified 2026-07-17: zero NULL-mode customers carry a sentinel tier with a
// positive rate, so this alignment changes no live customer's billing.
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
    && (explicitMember || isMembershipTier(waveguardTier))
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
  billingMode,
}) {
  if (estimatedPrice != null && Number(estimatedPrice) > 0) return Number(estimatedPrice);
  if (isCallback) return 0;
  if (perApplicationBilling) {
    return Number(perApplicationFee) > 0 ? Number(perApplicationFee) : 0;
  }
  // The customer-level monthly_rate is the MEMBERSHIP dues number. An
  // explicit non-monthly lane must never fall back to it as a per-visit
  // price: a member reclassified to per_visit/one_time keeps lingering
  // tier/rate fields, and invoicing the old dues amount on every unpriced
  // visit would over-bill (Codex r4). Unpriced explicit-lane visits
  // complete unbilled and the caller flags them for manual invoicing.
  if (billingMode && billingMode !== 'monthly_membership') return 0;
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
  serviceType,
  payerBilled,
  prepaidAmount,
  prepaidMethod,
  annualCoverageValidated,
  billingMode,
}) {
  const hasVisitPrice = estimatedPrice != null && Number(estimatedPrice) > 0;
  const none = { kind: 'no_charge', amount: 0, conflictStampedPrice: false };
  if (payerBilled) return { kind: 'payer', amount: hasVisitPrice ? Number(estimatedPrice) : null, conflictStampedPrice: false };
  // Completion's numeric prepaid fallback covers ONLY out-of-band methods
  // (cash/Zelle) — an annual_prepay_invoice stamp is governed exclusively
  // by the term-validated gate, so a STALE annual stamp's amount must not
  // read as prepaid here either or the card says "no new charge" for a
  // visit completion will invoice (Codex r7; mirrors admin-dispatch
  // prepaidCovered).
  const prepaid = prepaidMethod === ANNUAL_PREPAY_PREPAID_METHOD
    ? 0
    : (prepaidAmount != null ? Number(prepaidAmount) : 0);
  // The completion gate for explicit per-visit lanes bills PERFORMED
  // applications only — never a callback/re-treat or an always-free type,
  // even with a stale price on the row. Mirror that here or the sheet
  // promises an invoice completion will not cut (Codex r7).
  if ((billingMode === 'per_visit' || billingMode === 'one_time')
    && (isCallback || isAlwaysFreeServiceType(serviceType))) {
    return none;
  }
  if (lane === 'annual_prepay') {
    // Coverage is the TERM-VALIDATED per-visit stamp (prepaid_method
    // 'annual_prepay_invoice'), never the amount — discounted plans stamp
    // visits below list. Without the stamp, completion mirrors: an
    // explicitly priced uncovered visit (separately scheduled add-on)
    // bills normally; an unpriced uncovered visit is owned by the renewal
    // flow and bills nothing here (Codex r1+r2).
    // When the caller validated the stamp against the live term (the same
    // annualPrepayCoversVisit authority completion uses), that verdict wins
    // — a stale stamp after a refund/void/expired term must not read as
    // covered (Codex r3). Null = validation unavailable; fall back to the
    // stamp.
    const stampCovered = annualCoverageValidated != null
      ? annualCoverageValidated === true
      : prepaidMethod === ANNUAL_PREPAY_PREPAID_METHOD;
    if (stampCovered) {
      return { kind: 'covered_annual', amount: null, conflictStampedPrice: false };
    }
    if (!hasVisitPrice) return none;
    const amount = Number(estimatedPrice);
    if (prepaid >= amount) return { kind: 'prepaid', amount: prepaid, conflictStampedPrice: false };
    return { kind: 'invoice', amount: Math.max(0, amount - prepaid), conflictStampedPrice: false };
  }
  if (lane === 'per_application') {
    // Mirrors the completion gate: per-application bills performed
    // applications only — never a callback or an always-free type
    // (estimate / re-service / follow-up), even when a fee is on file
    // (Codex r1).
    if (isCallback || isAlwaysFreeServiceType(serviceType)) return none;
    const amount = completionInvoiceAmount({
      estimatedPrice, isCallback, perApplicationBilling: true, perApplicationFee, monthlyRate, billingMode,
    });
    if (!(amount > 0)) return none;
    // Completion only suppresses when the prepayment covers the WHOLE
    // amount; a partial prepay is applied as credit and the remainder
    // still collects (Codex r1).
    if (prepaid >= amount) return { kind: 'prepaid', amount: prepaid, conflictStampedPrice: false };
    const due = Math.max(0, amount - prepaid);
    return { kind: autopayActive ? 'auto_charge' : 'invoice', amount: due, conflictStampedPrice: false };
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
    estimatedPrice, isCallback, perApplicationBilling: false, perApplicationFee, monthlyRate, billingMode,
  });
  if (!(amount > 0)) return none;
  if (prepaid >= amount) return { kind: 'prepaid', amount: prepaid, conflictStampedPrice: false };
  return { kind: 'invoice', amount: Math.max(0, amount - prepaid), conflictStampedPrice: false };
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
