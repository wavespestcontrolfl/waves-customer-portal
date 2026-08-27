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

// SQL mirror of the resolver's monthly_membership verdict, for audience /
// eligibility queries that must target exactly the population the monthly
// cron charges (GUARD 3b + 3c): explicit monthly_membership, or NULL mode
// with a REAL (non-empty, non-sentinel) tier. Callers add their own
// monthly_rate > 0 — the cron selects it separately. The key normalization
// and sentinel list must stay byte-lockstep with isMembershipTier above
// (and MEMBERSHIP_SQL in admin-automations.js).
const MONTHLY_LANE_SQL = `
  (billing_mode = 'monthly_membership' OR (
    billing_mode IS NULL
    AND regexp_replace(lower(coalesce(waveguard_tier, '')), '[^a-z0-9]+', '', 'g') <> ''
    AND regexp_replace(lower(coalesce(waveguard_tier, '')), '[^a-z0-9]+', '', 'g')
      NOT IN ('none', 'onetime', 'na', 'no', 'notset', 'commercial')
  ))`;

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

// Guard for admin/IB customer writes: a save that leaves a row with a REAL
// membership tier, a positive monthly_rate, and NO billing_mode mints an
// INFERRED monthly member — the exact ambiguity that dues-charged an
// admin-created duplicate row (#3140 resolution 2026-08-07). When a write
// TRANSITIONS a row into that state (it wasn't inferred-monthly before, and
// the write itself sets no explicit lane), the writer stamps the inference
// explicitly. Billing behavior is unchanged by construction —
// resolveBillingLane already resolves these rows to monthly_membership —
// but the lane becomes visible, auditable, and frozen against later field
// drift, and no new NULL-mode rate-bearing member rows can be minted.
// Returns the mode to stamp, or null when no stamp is needed.
function impliedMonthlyStampForWrite(before = {}, after = {}) {
  const inferredMonthly = (row) => !row?.billing_mode
    && isMembershipTier(row?.waveguard_tier)
    && Number(row?.monthly_rate || 0) > 0;
  return !inferredMonthly(before) && inferredMonthly(after) ? 'monthly_membership' : null;
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
// Dues ALREADY COLLECTED for the visit's month (duesCollectedThisMonth, from
// monthlyDuesCollected) cover the visit exactly like an active autopay
// method does: the cron charged the month's dues on the 1st, so a card that
// expired / was removed / autopay paused mid-month must not turn every
// remaining plan visit into a full monthly_rate invoice on top of the dues
// the customer already paid (2-3x double-billing).
function membershipDuesCoverVisit({
  visitIsPayerBilled,
  perApplicationBilling,
  annualPrepayBilling,
  customerAutopayActive,
  duesCollectedThisMonth = false,
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
    && (!!customerAutopayActive || !!duesCollectedThisMonth)
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
  duesCollectedThisMonth = false,
  // GATE_COMPLETION_AUTOPAY_CHARGE (owner ruling 2026-08-26/27): with the
  // gate on, ANY autopay customer's collectible self-pay completion invoice
  // auto-charges, so the sheet's 'invoice' predictions become 'auto_charge'
  // for autopay-active customers. Callers pass the live gate value; the
  // default keeps this function's predictions byte-identical when off.
  completionAutopayChargeEnabled = false,
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
    return {
      // No-cost exclusions mirror the charge lane (manual-audit P1): a
      // callback/always-free visit never auto-charges, so never promise it.
      kind: (autopayActive && completionAutopayChargeEnabled
        && !isCallback && !isAlwaysFreeServiceType(serviceType)) ? 'auto_charge' : 'invoice',
      amount: Math.max(0, amount - prepaid),
      conflictStampedPrice: false,
    };
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
    duesCollectedThisMonth,
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
  return {
    // Same no-cost exclusion as the annual branch (manual-audit P1).
    kind: (autopayActive && completionAutopayChargeEnabled
      && !isCallback && !isAlwaysFreeServiceType(serviceType)) ? 'auto_charge' : 'invoice',
    amount: Math.max(0, amount - prepaid),
    conflictStampedPrice: false,
  };
}

// Extended-completion cap-AUTHORITY revalidation
// (GATE_COMPLETION_AUTOPAY_CHARGE), run UNDER the caller's already-held
// customer/visit/invoice row locks — the one shared verdict both money
// movers consult (chargeInvoiceWithSavedCard's
// requireExtendedCompletionAnchor guard and applyAccountCreditToInvoice's
// credit-side mirror), so a billing-mode flip, a coverage stamp, dues
// coverage, or a price edit racing either transaction refuses in BOTH.
// Coverage nuance (pre-push P1): only the VALIDATED annual stamp
// (prepaid_method='annual_prepay_invoice') refuses — the annual-prepay LANE
// itself still auto-charges its uncovered, explicitly priced add-ons; an
// unpriced annual visit has no anchor and refuses on that instead. Returns
// { ok: true, anchor } or { ok: false, reason } — pure verdict, callers
// decide throw vs skip. dbConn is the caller's lock transaction (used only
// for the dues-collected read; unreadable dues fail TOWARD coverage, i.e.
// refusal).
async function verifyExtendedCompletionAnchor({ dbConn, lockedCustomer, lockedSvc, lockedInvoice }) {
  if (!lockedCustomer || !lockedSvc || !lockedInvoice) return { ok: false, reason: 'rows_missing' };
  // The visit must still BE completed under the lock (pre-push P0 round
  // 4): a cancel/reschedule committing between the route's preflight and
  // the money transaction leaves an invoice for a visit that no longer
  // happened as billed. (requireCompletedOneTimeVisit can't serve here —
  // this lane legitimately includes recurring visits.)
  if (String(lockedSvc.status || '') !== 'completed') {
    return { ok: false, reason: 'visit_not_completed' };
  }
  // The locked invoice must still be THIS visit's bill (pre-push P0 round
  // 8): a concurrent rebind to another of the customer's visits would
  // otherwise charge (or consume credit against) the wrong invoice under
  // this visit's authorization. Both movers get this through the shared
  // verdict; the charge additionally asserts
  // requireInvoiceScheduledServiceBinding under its own lock.
  if (String(lockedInvoice.scheduled_service_id || '') !== String(lockedSvc.id)) {
    return { ok: false, reason: 'invoice_unbound' };
  }

  // Callbacks / re-treats and always-free service types never auto-charge
  // (manual-audit P0) — revalidated under the lock so a visit re-typed or
  // re-flagged after the route's admission check refuses too.
  if (lockedSvc.is_callback === true || isAlwaysFreeServiceType(lockedSvc.service_type)) {
    return { ok: false, reason: 'no_cost_visit' };
  }
  const lane = resolveBillingLane(lockedCustomer);
  if (lockedCustomer.billing_mode === 'per_application' || lane.mode === 'per_application') {
    return { ok: false, reason: 'per_application_lane' };
  }
  if (String(lockedSvc.prepaid_method || '') === 'annual_prepay_invoice') {
    // Validate the stamp against the LIVE term (pre-push P1 round 3): the
    // stamp survives refunds/voids/expiry, and completion + the schedule
    // sheet both treat a stale one as NOT covered — a priced uncovered
    // add-on must keep its auto-charge. Same authority completion uses
    // (annualPrepayCoversVisit, full row re-read on the lock connection);
    // an unreadable row fails TOWARD refusal.
    // throwOnError (pre-push P0 round 4): coversVisit's own catch returns
    // false for BILLING suppression — the opposite of this caller's
    // fail-closed direction. An unverifiable coverage authority must
    // refuse the charge, never read as a confirmed-stale stamp.
    try {
      const fullSvc = await dbConn('scheduled_services').where({ id: lockedSvc.id }).first();
      if (!fullSvc) return { ok: false, reason: 'annual_prepay_coverage_unverifiable' };
      const stampCovered = (await require('./annual-prepay-renewals')
        .annualPrepayCoversVisit(fullSvc, dbConn, { throwOnError: true })) === true;
      if (stampCovered) return { ok: false, reason: 'annual_prepay_coverage' };
    } catch {
      return { ok: false, reason: 'annual_prepay_coverage_unverifiable' };
    }
  }
  // An ACTIVE payment plan owns this invoice's collection (GitHub review
  // P1): the plan keeps drafting installments against its creation-time
  // snapshot — a completion charge beside it double-collects. Same guard
  // the credit apply has carried; through the shared verdict the CHARGE
  // now refuses too. Read on the caller's lock connection; an unreadable
  // plan state fails TOWARD refusal.
  try {
    const activePlan = await dbConn('payment_plans')
      .where({ invoice_id: lockedInvoice.id, status: 'active' })
      .first('id');
    if (activePlan) return { ok: false, reason: 'active_payment_plan' };
  } catch {
    return { ok: false, reason: 'active_payment_plan_unverifiable' };
  }
  // Out-of-band (cash/Zelle) prepayment on the LOCKED row (GitHub r2 P1):
  // the route's netting decisions used a pre-lock snapshot — a prepayment
  // recorded inside the window would be double-collected by a full charge.
  // Fail closed to office review; legitimate partial-prepay netting
  // happens at mint time, before this lane admits the invoice.
  if (String(lockedSvc.prepaid_method || '') !== ANNUAL_PREPAY_PREPAID_METHOD
    && Number(lockedSvc.prepaid_amount) > 0) {
    return { ok: false, reason: 'out_of_band_prepayment' };
  }
  // The hold rail owns estimate-flow one-time bookings (GitHub r2 P1):
  // a live hold re-checked under the money locks — the admission-side
  // read is an unlocked snapshot a hold insert can outrun. Unreadable
  // state fails toward refusal.
  try {
    const liveHold = await dbConn('estimate_card_holds')
      .where({ scheduled_service_id: lockedSvc.id })
      .whereNotIn('status', ['released', 'cancelled', 'failed'])
      .first('id');
    if (liveHold) return { ok: false, reason: 'estimate_card_hold' };
  } catch {
    return { ok: false, reason: 'estimate_card_hold_unverifiable' };
  }
  const hasVisitPrice = lockedSvc.estimated_price != null && Number(lockedSvc.estimated_price) > 0;
  let duesCollected = true;
  try { duesCollected = await monthlyDuesCollected(dbConn, lockedSvc.customer_id); } catch { duesCollected = true; }
  if (membershipDuesCoverVisit({
    visitIsPayerBilled: false,
    perApplicationBilling: false,
    annualPrepayBilling: lane.mode === 'annual_prepay',
    customerAutopayActive: true,
    duesCollectedThisMonth: duesCollected,
    hasVisitPrice,
    isRecurring: lockedSvc.is_recurring === true,
    waveguardTier: lockedCustomer.waveguard_tier,
    monthlyRate: lockedCustomer.monthly_rate,
    billingMode: lockedCustomer.billing_mode,
  })) {
    return { ok: false, reason: 'dues_covered' };
  }
  const anchor = hasVisitPrice
    ? Number(lockedSvc.estimated_price)
    : Number(completionInvoiceAmount({
      estimatedPrice: null,
      isCallback: !!lockedSvc.is_callback,
      perApplicationBilling: false,
      perApplicationFee: null,
      monthlyRate: lockedCustomer.monthly_rate,
      billingMode: lockedCustomer.billing_mode,
    })) || 0;
  const subtotalCents = Math.round(Number(lockedInvoice.subtotal != null ? lockedInvoice.subtotal : lockedInvoice.total || 0) * 100);
  const discountCents = Math.max(0, Math.round(Number(lockedInvoice.discount_amount || 0) * 100));
  if (!(anchor > 0) || (subtotalCents - discountCents) > Math.round(anchor * 100)) {
    return { ok: false, reason: 'anchor_exceeded' };
  }
  return { ok: true, anchor };
}

// Sync approximation of verifyExtendedCompletionAnchor for the schedule
// sheet's ATTACHED-invoice prediction (pre-push P1): the sheet must not
// promise an auto_charge the completion guard will deterministically
// refuse — dues coverage, a missing anchor, an over-cap subtotal, or a
// no-cost visit. Conservative by construction: an unknown subtotal falls
// back to the tax-inclusive total, which can only DEMOTE a promise to
// 'invoice', never over-promise a charge. Per-application invoices answer
// true — that lane's own rail charges its attached invoices.
function attachedInvoiceAutoChargeLikely({
  invoice,
  autopayActive,
  duesCollectedThisMonth = false,
  estimatedPrice,
  isRecurring,
  isCallback,
  serviceType,
  waveguardTier,
  monthlyRate,
  billingMode,
  prepaidMethod = null,
  annualCoverageValidated = null,
}) {
  if (isCallback || isAlwaysFreeServiceType(serviceType)) return false;
  // A stamped annual-prepay visit demotes unless the stamp was VALIDATED
  // stale (pre-push P1 round 8) — completion settles/voids the covered
  // invoice, and an unverifiable stamp refuses the charge anyway.
  if (String(prepaidMethod || '') === ANNUAL_PREPAY_PREPAID_METHOD
    && annualCoverageValidated !== false) return false;
  if (billingMode === 'per_application') return true;
  const hasVisitPrice = estimatedPrice != null && Number(estimatedPrice) > 0;
  if (membershipDuesCoverVisit({
    visitIsPayerBilled: false,
    perApplicationBilling: false,
    annualPrepayBilling: billingMode === 'annual_prepay',
    customerAutopayActive: autopayActive,
    duesCollectedThisMonth,
    hasVisitPrice,
    isRecurring,
    waveguardTier,
    monthlyRate,
    billingMode,
  })) return false;
  const anchor = hasVisitPrice
    ? Number(estimatedPrice)
    : Number(completionInvoiceAmount({
      estimatedPrice: null,
      isCallback: !!isCallback,
      perApplicationBilling: false,
      perApplicationFee: null,
      monthlyRate,
      billingMode,
    })) || 0;
  if (!(anchor > 0)) return false;
  const sub = invoice?.subtotal != null ? Number(invoice.subtotal) : Number(invoice?.total || 0);
  const net = sub - Math.max(0, Number(invoice?.discount_amount) || 0);
  return net <= anchor + 0.005;
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
  MONTHLY_LANE_SQL,
  isMembershipTier,
  impliedMonthlyStampForWrite,
  resolveBillingLane,
  membershipDuesCoverVisit,
  completionInvoiceAmount,
  predictCompletionBilling,
  monthlyDuesCollected,
  verifyExtendedCompletionAnchor,
  attachedInvoiceAutoChargeLikely,
};
