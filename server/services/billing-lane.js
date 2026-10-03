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
// invoiceAmountDue is pure (no DB, no Stripe/Twilio — see that module's own
// header) so it's safe to require at the top alongside isAlwaysFreeServiceType,
// unlike the CANCELLED_SERVICE_RESOLVED_STATUSES / estimate-first-application-invoice
// requires below, which stay lazy/in-function on purpose.
const { invoiceAmountDue, invoiceWithdrawnFromCustomer, isInvoiceCollectibleStatus } = require('./invoice-helpers');
// GATE_STAMPED_ZERO_FREE (owner ruling 2026-09-28) — the canonical call-time
// reader, so a flip needs no redeploy. Widens hasAuthoritativeZeroPrice
// below; the other readers in this change call it through this module.
const stampedZeroFreeLive = () => require('../config/feature-gates').stampedZeroFreeLive();

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

// SQL mirror of isMembershipTier ALONE (no billing-mode arm): a REAL
// (non-empty, non-sentinel) WaveGuard tier. For MEMBERSHIP audiences —
// pricing/upsell economics where per-application and annual-prepay members
// still count — as opposed to MONTHLY_LANE_SQL's dues audience (Codex #3669
// r7: the money-model core stage must not drop prepay members). Same
// normalization and sentinel list as isMembershipTier / MONTHLY_LANE_SQL
// above (and MEMBERSHIP_SQL in admin-automations.js).
const MEMBERSHIP_TIER_SQL = `
  (regexp_replace(lower(coalesce(waveguard_tier, '')), '[^a-z0-9]+', '', 'g') <> ''
   AND regexp_replace(lower(coalesce(waveguard_tier, '')), '[^a-z0-9]+', '', 'g')
     NOT IN ('none', 'onetime', 'na', 'no', 'notset', 'commercial'))`;

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

// Codex pre-push P1 (round 3): a stamped 0 estimated_price is NOT always
// "unpriced" — completion-pricing's discount engine (services/completion-pricing.js
// discountedVisit) freezes a fully-discounted application at a genuine $0 net
// by patching BOTH primary_line_price (the pre-discount gross base) and
// estimated_price (the post-discount net) together, and that supported shape
// is pinned by completion-pricing.postgres.test.js and
// discount-stack-pricing-provenance-postgres.test.js. A bare 0 with NO
// primary_line_price on the row is a genuinely different, indistinguishable-
// from-null shape: the sibling-covered same-trip PROMOTED row
// (estimate-converter.js reservedAcceptPerVisitSplit) leaves BOTH columns
// null, never 0-with-a-base. `primaryLinePrice` is the provenance signal —
// every "does this visit have its own price" gate below shares this ONE
// predicate so the two can never be told apart in one spot and conflated in
// another.
//
// GATE_STAMPED_ZERO_FREE (owner ruling 2026-09-28, waves-billing skill
// invariant #8 — "Unpriced = NULL, never $0. $0 means charge nothing."):
// with the gate ON, ANY stamped 0 is this visit's own authoritative price,
// in every billing lane — `primaryLinePrice` no longer matters. This
// supersedes invariant #6's note that a bare $0/NULL row on the legacy
// monthly/null lane falls through to monthly_rate/WaveGuard-tier billing —
// while the gate is on, a STAMPED $0 (unlike a genuinely blank row) no
// longer falls through anywhere. With the gate OFF, behavior is
// byte-identical to before: only the discount-engine provenance shape (a
// stamped 0 alongside a positive primary_line_price base — completion-
// pricing.js's discountedVisit, pinned by completion-pricing.postgres.test.js
// and discount-stack-pricing-provenance-postgres.test.js) reads as
// authoritative; a bare stamped 0 with no primary_line_price stays
// indistinguishable from null and keeps falling through to the fee/rate
// fallback, exactly as documented below. This one function is EVERY
// caller's "does this visit have its own price" fact — completionInvoiceAmount
// and everything already routed through it inherit the widened gate-on
// reading with no per-caller change; a handful of sites that compute a
// visit's charge WITHOUT going through the resolver call this directly too
// (guarded by stampedZeroFreeLive() at each of those call sites, since they
// never consulted this predicate at all before and must stay byte-identical
// off).
function hasAuthoritativeZeroPrice(estimatedPrice, primaryLinePrice) {
  // Codex round 4 P1: estimatedPrice must be an ACTUAL stamped zero, not
  // absent — Number(null) === 0 and Number('') === 0, so without this guard
  // a never-priced row (null/'') with a positive primary_line_price on file
  // was misread as a deliberately free visit and skipped its fee fallback.
  const isStampedZero = estimatedPrice != null && estimatedPrice !== '' && Number(estimatedPrice) === 0;
  if (!isStampedZero) return false;
  if (stampedZeroFreeLive()) return true;
  return primaryLinePrice != null && Number(primaryLinePrice) > 0;
}

// Per-application customers bill the explicit visit price, else the
// acceptance-stamped per_application_fee — NEVER the customer-level
// monthly_rate: a multi-service accept intentionally leaves both the fee and
// each row's estimated_price NULL (whole-plan fee on every row = overbill),
// and monthly_rate IS that same whole-plan number. A per-application row with
// no amount returns 0, the auto-invoice gate declines it, and the visit is
// billed manually. Legacy (non-per-app) rows keep the monthly_rate fallback
// the WaveGuard-membership flows depend on.
//
// `primaryLinePrice` (optional — every EXISTING caller keeps working
// byte-identically without it): a provenance-backed $0 (see
// hasAuthoritativeZeroPrice above) returns 0 here directly, never the fee/
// rate fallback — a fully-discounted application must stay free.
function completionInvoiceAmount({
  estimatedPrice,
  isCallback,
  perApplicationBilling,
  perApplicationFee,
  monthlyRate,
  billingMode,
  primaryLinePrice = null,
}) {
  if (estimatedPrice != null && Number(estimatedPrice) > 0) return Number(estimatedPrice);
  if (hasAuthoritativeZeroPrice(estimatedPrice, primaryLinePrice)) return 0;
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
 *
 * `amount` is the FINAL figure for a consumer that stacks nothing on top of
 * it (completion itself, the schedule sheet's own preview). For 'prepaid' /
 * 'invoice' / 'auto_charge' out of the per_application and self-pay lanes,
 * `grossAmount` also rides along — the fee/rate BEFORE the recorded
 * prepayment was netted out — for the one consumer that DOES stack more on
 * top (Charge Now checkout adding extra line items): it must total those
 * extras against the gross fee, then net the prepayment ONCE against
 * fee+extras combined, never against the already-net `amount` (codex
 * pre-push P1: netting the same prepayment twice hid a real remaining
 * balance, or dropped credit still owed once extras made the total larger
 * than what `amount` alone had already absorbed).
 */
// codex pre-push P2 (round 13): predictCompletionBilling split below the
// complexity-20 lint limit, per-lane, with identical behavior — every
// existing predictCompletionBilling test still drives the SAME public
// function and asserts the SAME results; these are its private pieces, not
// a new contract. Split lines: payer, annual_prepay, per_application,
// membership/self-pay, and the authoritative-zero/prepayment tail the last
// two lanes share verbatim (see predictionFromResolvedAmount's own header
// for why annual_prepay and payer do NOT share it — each has a genuinely
// different shape, not just fewer lines).

// The payer lane: a payer says WHO owes, not HOW MUCH — the amount still
// comes from the canonical precedence, never from estimatedPrice alone.
// Reading only the stamp made a payer visit that bills a monthly rate or an
// acceptance fee look amountless (Codex P1, round 5).
function predictCompletionBillingPayer({
  lane, isCallback, serviceType, estimatedPrice, perApplicationFee, monthlyRate, billingMode,
  primaryLinePrice, hasVisitPrice, noCharge,
}) {
  const payerFreeReason = isCallback
    ? 'callback'
    : (isAlwaysFreeServiceType(serviceType) ? 'always_free_service_type' : null);
  const payerAmount = completionInvoiceAmount({
    estimatedPrice,
    isCallback,
    perApplicationBilling: lane === 'per_application' || billingMode === 'per_application',
    perApplicationFee,
    monthlyRate,
    billingMode,
    primaryLinePrice,
  });
  const resolvedPayerAmount = payerAmount > 0
    ? payerAmount
    : (hasVisitPrice ? Number(estimatedPrice) : null);
  // Free-by-design payer work with NO amount bills nobody, so it reads as
  // the ordinary "nothing bills" line instead of promising an AP invoice
  // (Codex P1, round 13). A PRICED one is different: completion's mint gate
  // takes the create_invoice_on_complete stamp BEFORE its callback /
  // always-free exclusions (admin-dispatch.js:16155-16157), so that visit
  // really does invoice the payer. Calling it free was a regression this
  // branch introduced (Codex P1, round 17) — origin/main predicted
  // 'payer' with the amount here, and was right.
  if (payerFreeReason && !(Number(resolvedPayerAmount) > 0)) return noCharge(payerFreeReason);
  // codex round-7 P2: a provenance-backed $0 (hasAuthoritativeZeroPrice —
  // estimatedPrice stamped 0 alongside a positive primaryLinePrice, e.g.
  // a fully-discounted application) is a deliberately free visit even
  // with a payer on the account — mirrors the per_application / self-pay
  // lanes' own 'fully_discounted' exemption. Without this check,
  // resolvedPayerAmount fell back to Number(estimatedPrice) (0) and this
  // returned { kind: 'payer', amount: 0 }, which unbilledCompletionGap
  // reads as a genuine 'no_amount_on_file' money-gap alert for a visit
  // that was never supposed to bill anyone.
  if (hasAuthoritativeZeroPrice(estimatedPrice, primaryLinePrice)) {
    return { kind: 'no_charge', amount: 0, conflictStampedPrice: false, reason: 'fully_discounted' };
  }
  return {
    kind: 'payer',
    amount: resolvedPayerAmount,
    conflictStampedPrice: false,
  };
}

// Shared tail for the per_application and membership/self-pay lanes ONLY —
// annual_prepay and payer each have a genuinely different shape (annual_prepay
// owns its own "no data" reason before `amount` is even computed and has no
// authoritative-zero step at all; payer resolves its own amount precedence
// entirely), not just fewer lines, so they are NOT routed through this.
// Once a lane has resolved its base `amount` (completionInvoiceAmount) and
// run its OWN callback/always-free exclusion (each lane's placement of that
// check differs and must stay exactly where it was — see each caller),
// authoritative-zero, out-of-band-prepayment coverage, and the
// invoice/auto_charge choice are the SAME decision for both. `autoChargeEligible`
// carries each lane's own exact auto-charge condition (they differ — per_application
// is bare `autopayActive`; membership also gates on the completion-autopay-charge
// gate, isCallback and always-free-type) so this helper never re-derives it
// and risks the two diverging.
function predictionFromResolvedAmount({
  amount, estimatedPrice, primaryLinePrice, prepaid, autoChargeEligible, noCharge,
}) {
  if (!(amount > 0)) {
    // A provenance-backed $0 (see hasAuthoritativeZeroPrice) is a
    // deliberately free visit, never a money gap — 'fully_discounted' is
    // NOT in UNBILLED_MONEY_GAP_REASONS, and 'no_charge' (never
    // 'invoice'/'auto_charge') keeps unbilledCompletionGap's willMint===false
    // path from reading it as a stalled mint either.
    if (hasAuthoritativeZeroPrice(estimatedPrice, primaryLinePrice)) {
      return { kind: 'no_charge', amount: 0, conflictStampedPrice: false, reason: 'fully_discounted' };
    }
    // A POSITIVE out-of-band prepayment (cash/Zelle stamped through
    // /:id/prepaid) on an unpriced visit is what completion calls covered
    // — prepaid_amount > 0 AND >= the $0 amount — so it is paid, not a
    // money gap.
    if (prepaid > 0) return { kind: 'prepaid', amount: prepaid, grossAmount: amount, conflictStampedPrice: false };
    return noCharge('no_amount_on_file');
  }
  // Completion only suppresses when the prepayment covers the WHOLE
  // amount; a partial prepay is applied as credit and the remainder
  // still collects.
  if (prepaid >= amount) return { kind: 'prepaid', amount: prepaid, grossAmount: amount, conflictStampedPrice: false };
  // grossAmount is the fee/rate BEFORE prepaid netting — a schedule-sheet
  // consumer that lets the office stack extra line items on top of this
  // visit (Charge Now checkout) must total those extras against the GROSS
  // figure, then net the recorded prepayment ONCE against fee+extras
  // combined, or crediting prepaidAmount separately against the
  // ALREADY-NET `amount` here would apply the same prepayment twice.
  // `amount` itself stays the final net figure for every consumer that
  // doesn't stack anything on top (completion preview, detail sheet,
  // sidebar).
  return {
    kind: autoChargeEligible ? 'auto_charge' : 'invoice',
    amount: Math.max(0, amount - prepaid),
    grossAmount: amount,
    conflictStampedPrice: false,
  };
}

// Coverage is the TERM-VALIDATED per-visit stamp (prepaid_method
// 'annual_prepay_invoice'), never the amount — discounted plans stamp
// visits below list. Without the stamp, completion mirrors: an explicitly
// priced uncovered visit (separately scheduled add-on) bills normally; an
// unpriced uncovered visit is owned by the renewal flow and bills nothing
// here (Codex r1+r2).
function predictCompletionBillingAnnualPrepay({
  annualCoverageValidated, prepaidMethod, hasVisitPrice, estimatedPrice, prepaid,
  autopayActive, completionAutopayChargeEnabled, isCallback, serviceType, noCharge,
}) {
  // When the caller validated the stamp against the live term (the same
  // annualPrepayCoversVisit authority completion uses), that verdict wins —
  // a stale stamp after a refund/void/expired term must not read as
  // covered (Codex r3). Null = validation unavailable; fall back to the
  // stamp.
  const stampCovered = annualCoverageValidated != null
    ? annualCoverageValidated === true
    : prepaidMethod === ANNUAL_PREPAY_PREPAID_METHOD;
  if (stampCovered) {
    return { kind: 'covered_annual', amount: null, conflictStampedPrice: false };
  }
  // Owned by the renewal flow, not a data gap — bills nothing BY DESIGN.
  if (!hasVisitPrice) return noCharge('annual_renewal_owned');
  const amount = Number(estimatedPrice);
  // GATE_STAMPED_ZERO_FREE: a stamped $0 is a free visit, not "prepaid" —
  // same label every other lane gives it (parallel review P2 on #5256).
  if (!(amount > 0) && stampedZeroFreeLive()) {
    return { kind: 'no_charge', amount: 0, conflictStampedPrice: false, reason: 'fully_discounted' };
  }
  // grossAmount (codex round-9 P2): this lane can reach hasVisitPrice via
  // hasAuthoritativeZeroPrice too (a stamped $0 with a positive
  // primaryLinePrice), which the CLIENT reads as UNPRICED — the same gap
  // the per_application/self-pay lanes close with their own
  // `grossAmount: amount`. Without it here, MobileCheckoutSheet's
  // missing-gross guard (priceNeedsRefresh) misread this prediction as a
  // stale/legacy payload and permanently disabled Charge Now for it.
  // Always ride it alongside `amount` — a consumer that doesn't stack
  // extras on top (completion, the other three schedule surfaces) never
  // reads it, exactly like the other two lanes.
  if (prepaid >= amount) return { kind: 'prepaid', amount: prepaid, grossAmount: amount, conflictStampedPrice: false };
  return {
    // No-cost exclusions mirror the charge lane (manual-audit P1): a
    // callback/always-free visit never auto-charges, so never promise it.
    kind: (autopayActive && completionAutopayChargeEnabled
      && !isCallback && !isAlwaysFreeServiceType(serviceType)) ? 'auto_charge' : 'invoice',
    amount: Math.max(0, amount - prepaid),
    grossAmount: amount,
    conflictStampedPrice: false,
  };
}

// Mirrors the completion gate: per-application bills performed applications
// only — never a callback or an always-free type (estimate / re-service /
// follow-up), even when a fee is on file (Codex r1). This exclusion runs
// UNCONDITIONALLY, before `amount` is even computed — unlike the
// membership/self-pay lane below, which only checks it once `amount` is
// NOT positive (an explicit price still wins over isCallback there). Do
// not "simplify" the two lanes onto the same placement; that would change
// which one a priced callback bills.
function predictCompletionBillingPerApplication({
  isCallback, serviceType, estimatedPrice, perApplicationFee, monthlyRate, billingMode,
  primaryLinePrice, prepaid, autopayActive, noCharge,
}) {
  if (isCallback || isAlwaysFreeServiceType(serviceType)) {
    return noCharge(isCallback ? 'callback' : 'always_free_service_type');
  }
  const amount = completionInvoiceAmount({
    estimatedPrice, isCallback, perApplicationBilling: true, perApplicationFee, monthlyRate, billingMode,
    primaryLinePrice,
  });
  return predictionFromResolvedAmount({
    amount, estimatedPrice, primaryLinePrice, prepaid, autoChargeEligible: autopayActive, noCharge,
  });
}

// The membership/self-pay default lane (monthly_membership, per_visit,
// one_time, or no lane at all). The 2026-08-31 shape this lane must catch:
// self-pay, visit performed, and NO number anywhere — no stamped visit
// price, no monthly rate. Nothing bills, and nothing about the visit says
// it should be free, so (unlike per_application/annual_prepay) a genuine
// gap here is a money-gap reason, not an exemption.
function predictCompletionBillingMembership({
  lane, isCallback, serviceType, estimatedPrice, perApplicationFee, monthlyRate, billingMode,
  primaryLinePrice, hasVisitPrice, isRecurring, autopayActive, duesCollectedThisMonth,
  prepaid, completionAutopayChargeEnabled, noCharge,
}) {
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
  // Computed BEFORE the covered check (not just after it) so a covered
  // visit's grossAmount is still the monthlyRate Charge Now's own resolver
  // (resolveScheduledServiceCharge, admin-schedule.js) would use as ITS
  // base — that resolver has no "dues cover it" concept at all, so a
  // covered member who gets an ad hoc extra added at checkout still bills
  // monthlyRate+extra on the mint, never just the extra alone (codex
  // pre-push P1: previewing $0 base + extra understated what Charge Now
  // actually mints for this customer).
  const amount = completionInvoiceAmount({
    estimatedPrice, isCallback, perApplicationBilling: false, perApplicationFee, monthlyRate, billingMode,
    primaryLinePrice,
  });
  if (covered) {
    return { kind: 'covered_membership', amount: null, grossAmount: amount, conflictStampedPrice: hasVisitPrice };
  }
  // Checked ONLY once `amount` is not positive — an explicit price still
  // wins over isCallback here (completionInvoiceAmount's own precedence),
  // unlike the per_application lane above, which excludes it unconditionally
  // before `amount` is ever computed.
  if (!(amount > 0) && (isCallback || isAlwaysFreeServiceType(serviceType))) {
    return noCharge(isCallback ? 'callback' : 'always_free_service_type');
  }
  return predictionFromResolvedAmount({
    amount,
    estimatedPrice,
    primaryLinePrice,
    prepaid,
    // Same no-cost exclusion as the annual branch (manual-audit P1).
    autoChargeEligible: autopayActive && completionAutopayChargeEnabled
      && !isCallback && !isAlwaysFreeServiceType(serviceType),
    noCharge,
  });
}

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
  // Provenance signal for a genuine $0 (see hasAuthoritativeZeroPrice above)
  // — optional, every existing caller keeps its current prediction without
  // it.
  primaryLinePrice = null,
  duesCollectedThisMonth = false,
  // GATE_COMPLETION_AUTOPAY_CHARGE (owner ruling 2026-08-26/27): with the
  // gate on, ANY autopay customer's collectible self-pay completion invoice
  // auto-charges, so the sheet's 'invoice' predictions become 'auto_charge'
  // for autopay-active customers. Callers pass the live gate value; the
  // default keeps this function's predictions byte-identical when off.
  completionAutopayChargeEnabled = false,
}) {
  // A callback's stamped 0 is free via the isCallback exclusions below, not
  // via GATE_STAMPED_ZERO_FREE — a callback is routinely stamped 0 by
  // convention, so letting the gate's widened zero reading count it as "has
  // its own price" here would flip a non-recurring member's callback from
  // 'covered_membership' to 'no_charge'/'callback' as a pure gate side
  // effect (a label change the office reads, with no billing-amount
  // difference — completionInvoiceAmount returns 0 for a callback either
  // way). So a callback keeps ONLY the narrow, gate-independent
  // discount-engine-provenance reading (hasAuthoritativeZeroPrice's own
  // off-state formula) here, whatever the gate says; every other call site
  // in this file has no such pre-existing isCallback-driven label to
  // protect and takes the (possibly widened) predicate directly.
  const hasVisitPrice = (estimatedPrice != null && Number(estimatedPrice) > 0)
    || (isCallback
      ? (estimatedPrice != null && estimatedPrice !== '' && Number(estimatedPrice) === 0
        && primaryLinePrice != null && Number(primaryLinePrice) > 0)
      : hasAuthoritativeZeroPrice(estimatedPrice, primaryLinePrice));
  // no_charge is two different worlds and the office must be able to tell
  // them apart. A callback / always-free type / renewal-owned visit is
  // SUPPOSED to bill nothing. An unpriced self-pay visit bills nothing only
  // because nobody put a number on the account — that one is a money gap
  // (2026-08-31: a hand-booked customer took four recurring visits at
  // monthly_rate 0 and the sheet said only "nothing bills"). Same kind, same
  // amount, different `reason` — see UNBILLED_MONEY_GAP_REASONS.
  const noCharge = (reason) => ({ kind: 'no_charge', amount: 0, conflictStampedPrice: false, reason });
  if (payerBilled) {
    return predictCompletionBillingPayer({
      lane, isCallback, serviceType, estimatedPrice, perApplicationFee, monthlyRate, billingMode,
      primaryLinePrice, hasVisitPrice, noCharge,
    });
  }
  // GATE_PAF_PREPAY: an UNSTAMPED visit validated as covered can only be a
  // visit held by a deferred annual prepay (annualCoverageVerdictForPrediction
  // returns null for every other unstamped visit). Completion suppresses it in
  // whatever lane the customer sits — a deferred customer stays
  // per_application until the year is paid — so predict the same here.
  if (annualCoverageValidated === true && prepaidMethod !== ANNUAL_PREPAY_PREPAID_METHOD) {
    return { kind: 'covered_annual', amount: null, conflictStampedPrice: false };
  }
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
    return noCharge(isCallback ? 'callback' : 'always_free_service_type');
  }
  if (lane === 'annual_prepay') {
    return predictCompletionBillingAnnualPrepay({
      annualCoverageValidated, prepaidMethod, hasVisitPrice, estimatedPrice, prepaid,
      autopayActive, completionAutopayChargeEnabled, isCallback, serviceType, noCharge,
    });
  }
  if (lane === 'per_application') {
    return predictCompletionBillingPerApplication({
      isCallback, serviceType, estimatedPrice, perApplicationFee, monthlyRate, billingMode,
      primaryLinePrice, prepaid, autopayActive, noCharge,
    });
  }
  return predictCompletionBillingMembership({
    lane, isCallback, serviceType, estimatedPrice, perApplicationFee, monthlyRate, billingMode,
    primaryLinePrice, hasVisitPrice, isRecurring, autopayActive, duesCollectedThisMonth,
    prepaid, completionAutopayChargeEnabled, noCharge,
  });
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
    // An ALREADY-APPLIED prepayment (completion netted invoice.total and
    // booked the scheduled_service_prepaid payment marker) leaves the
    // stamp populated — the residual is legitimately chargeable
    // (manual-audit P1: an unconditional refusal would permanently
    // disable Auto Pay on every partial-prepay visit). Only an
    // unapplied/racing prepayment refuses; unreadable state refuses.
    try {
      const appliedMarker = await dbConn('payments')
        .where({ customer_id: lockedSvc.customer_id, status: 'paid' })
        .whereRaw("metadata::jsonb ->> 'source' = ?", ['scheduled_service_prepaid'])
        .whereRaw("metadata::jsonb ->> 'invoice_id' = ?", [String(lockedInvoice.id)])
        .whereRaw("metadata::jsonb ->> 'scheduled_service_id' = ?", [String(lockedSvc.id)])
        .first('id');
      if (!appliedMarker) return { ok: false, reason: 'out_of_band_prepayment' };
    } catch {
      return { ok: false, reason: 'out_of_band_prepayment' };
    }
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
  // GATE_STAMPED_ZERO_FREE: a stamped $0 anchors at nothing, exactly like
  // resolveExtendedLane — so a charge admitted before a $0 stamp landed
  // refuses here, under the lock (parallel review P2 on #5256).
  if (stampedZeroFreeLive() && hasAuthoritativeZeroPrice(lockedSvc.estimated_price, lockedSvc.primary_line_price)) {
    return { ok: false, reason: 'anchor_exceeded' };
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
  prepaidAmount = null,
  prepaidApplied = false,
  annualCoverageValidated = null,
  perApplicationFee = null,
  // Provenance signal for a genuine $0 (see hasAuthoritativeZeroPrice above)
  // — optional, every existing caller keeps its current prediction without
  // it.
  primaryLinePrice = null,
}) {
  if (isCallback || isAlwaysFreeServiceType(serviceType)) return false;
  // An UNAPPLIED out-of-band (cash/Zelle) prepayment demotes (GitHub r3
  // P2) — completion nets it first; once the netting marker exists
  // (prepaidApplied, the same scheduled_service_prepaid detection the
  // sheets already run) the residual legitimately auto-charges.
  if (String(prepaidMethod || '') !== ANNUAL_PREPAY_PREPAID_METHOD
    && Number(prepaidAmount) > 0 && !prepaidApplied) return false;
  // A stamped annual-prepay visit demotes unless the stamp was VALIDATED
  // stale (pre-push P1 round 8) — completion settles/voids the covered
  // invoice, and an unverifiable stamp refuses the charge anyway.
  if (String(prepaidMethod || '') === ANNUAL_PREPAY_PREPAID_METHOD
    && annualCoverageValidated !== false) return false;
  if (billingMode === 'per_application') {
    // The per-application rail is ALSO capped (GitHub r4 P2): an
    // admin-edited invoice above the accepted per-visit amount routes to
    // office review at completion, so the sheet must not promise the
    // charge. Anchor mirrors the rail (visit price, else the acceptance
    // fee); a setup-fee line on the invoice extends the cap by that line
    // (approximation of the rail's bounded allowance — its authorization
    // predicates aren't cheaply readable here, and over-allowing only
    // risks a promise the rail then routes to review, never a charge).
    // GATE_STAMPED_ZERO_FREE (owner ruling 2026-09-28): a stamped 0 anchors
    // at $0, never the acceptance fee — same predicate every other
    // completion-time cap in this file uses. Guarded explicitly by the live
    // gate (not just the predicate's own internal check) because this
    // anchor calculation never consulted the predicate at all before, so
    // it must stay byte-identical while the gate is off.
    const perAppAnchor = estimatedPrice != null && Number(estimatedPrice) > 0
      ? Number(estimatedPrice)
      : (stampedZeroFreeLive() && hasAuthoritativeZeroPrice(estimatedPrice, primaryLinePrice) ? 0
        : (perApplicationFee != null && Number(perApplicationFee) > 0 ? Number(perApplicationFee) : null));
    if (perAppAnchor == null) return false;
    let setupLineAmount = 0;
    try {
      const rawLines = invoice?.line_items;
      const lines = typeof rawLines === 'string' ? JSON.parse(rawLines) : (rawLines || []);
      const setupLine = (Array.isArray(lines) ? lines : []).find((li) => (
        /one-time setup fee/i.test(String(li?.description || ''))
      ));
      if (setupLine) {
        setupLineAmount = Number(setupLine.amount
          ?? ((Number(setupLine.quantity) || 1) * (Number(setupLine.unit_price) || 0))) || 0;
      }
    } catch { /* unreadable lines -> no allowance */ }
    const perAppSub = invoice?.subtotal != null ? Number(invoice.subtotal) : Number(invoice?.total || 0);
    const perAppNet = perAppSub - Math.max(0, Number(invoice?.discount_amount) || 0);
    return perAppNet <= perAppAnchor + Math.max(0, setupLineAmount) + 0.005;
  }
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
  // GATE_STAMPED_ZERO_FREE: a stamped $0 anchors at nothing (completion's
  // resolveExtendedLane refuses it), so never promise the auto-charge.
  if (stampedZeroFreeLive() && hasAuthoritativeZeroPrice(estimatedPrice, primaryLinePrice)) return false;
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

// Line-item key the completion mint stamps on the PRIMARY line of a dues
// invoice (an unpriced membership plan visit billed at customers.monthly_rate
// because autopay could not collect): the value is the ET month key
// (YYYY-MM) of the visit the obligation belongs to. It is the only durable
// provenance of "this invoice is that month's dues" — the line description
// is just the service type — so monthlyDuesCollected reads it. Invoices
// minted before the stamp carry none and are never recognized (a guess from
// amount + visit shape could silently skip a real bill). Editable line JSON
// is provenance only: dropping it can only re-bill, never hide a bill.
const MEMBERSHIP_DUES_LINE_KEY = 'membership_dues_month';

// True when customers.monthly_rate is what put the number on this visit's
// completion invoice: the same resolver, with and without the rate. A priced
// visit (own stamp, authoritative $0), a callback, a per-application fee and
// every explicit non-monthly lane all resolve identically either way, so
// they are never a dues visit.
function completionInvoiceIsMembershipDues(args) {
  return completionInvoiceAmount(args) > 0
    && completionInvoiceAmount({ ...args, monthlyRate: 0 }) === 0;
}

// The membership-dues lane, read off a customer row: an explicit
// monthly_membership, or NULL mode with a real tier (the lane resolver's own
// inference, minus the rate test).
function isMembershipDuesLane(customer) {
  return !!customer && (customer.billing_mode === 'monthly_membership'
    || (!customer.billing_mode && isMembershipTier(customer.waveguard_tier)));
}

// VISIT side of "is this a dues visit": unpriced (no own price, no authoritative
// $0) and not a callback — whatever the customer's rate is. Judged on the
// locked visit row. A priced visit is a genuine reprice / non-dues visit.
function isUnpricedPlanVisit(visit) {
  return !!visit && completionInvoiceIsMembershipDues({
    estimatedPrice: visit.estimated_price,
    isCallback: !!visit.is_callback,
    perApplicationBilling: false,
    perApplicationFee: null,
    monthlyRate: 1, // any positive rate: only the visit side is being asked
    billingMode: 'monthly_membership',
    primaryLinePrice: visit.primary_line_price ?? null,
  });
}

// An invoice amount that IS a member's monthly dues for an unpriced plan
// visit (member lane, unpriced non-callback visit, amount == monthly_rate):
// what Charge now's pre-mint requests a dues stamp for.
function isMembershipDuesShapedVisit({
  estimatedPrice, primaryLinePrice = null, isCallback, monthlyRate, billingMode, waveguardTier, amount,
}) {
  return isMembershipDuesLane({ billing_mode: billingMode, waveguard_tier: waveguardTier })
    && isUnpricedPlanVisit({ estimated_price: estimatedPrice, primary_line_price: primaryLinePrice, is_callback: isCallback })
    && Number(monthlyRate) > 0
    && Math.round(Number(amount) * 100) === Math.round(Number(monthlyRate) * 100);
}

// Does a dues invoice about to be written still earn its stamp? Judged by the
// caller from the rows it holds LOCKED for THAT mint (the visit, the
// customer) and the amount of the line actually being written — never from
// the completion's earlier decision: a visit repriced between the decision
// and the lock (the SCHEDULED_PRICE_MOVED retry re-mints at the new price)
// is no longer a dues visit, and a stamp on it would hide the month's real
// dues from every later plan visit. Same predicate as the decision
// (completionInvoiceIsMembershipDues) plus the membership lane and "the
// line IS monthly_rate".
function membershipDuesProvenanceHolds({ visit, customer, lineAmount }) {
  if (!visit || !customer) return false;
  const member = customer.billing_mode === 'monthly_membership'
    || (!customer.billing_mode && isMembershipTier(customer.waveguard_tier));
  if (!member) return false;
  const cents = (v) => Math.round(Number(v) * 100);
  return completionInvoiceIsMembershipDues({
    estimatedPrice: visit.estimated_price,
    isCallback: !!visit.is_callback,
    perApplicationBilling: false,
    perApplicationFee: null,
    monthlyRate: customer.monthly_rate,
    billingMode: customer.billing_mode,
    primaryLinePrice: visit.primary_line_price ?? null,
  }) && cents(lineAmount) === cents(customer.monthly_rate);
}

// Serializes the "is this month's dues covered? then mint" decision per
// customer + ET month. House pattern: transaction-scoped two-key advisory
// lock, dotted namespace + id text, held to the end of the taking transaction.
//
// THE LOCK RULE (one rule for every taker; B08 pre-push audit, deadlock between
// a mint and a credit-applied void). A transaction may WAIT (this blocking form)
// on the dues-month lock only if it holds NO other lock yet: it is the FIRST
// lock of the transaction. Takers: voidInvoice and the cancelled-visit void
// (lockMembershipDuesMonthOfInvoice), the stamped-invoice edit, the
// completion's early confirmation transaction, and the prepaid-marker POST
// (recordPrepaidUnderDuesLock: month lock, coverage re-read, then the visit-row
// UPDATE); each then goes on to take invoice / statement / customer / visit
// rows while holding it. A
// transaction that ALREADY holds a customer, visit, mint-advisory or invoice
// lock must NEVER wait on it, because the holder may be queued behind that very
// lock (a void holds the month, then wants the customer FOR UPDATE that a mint's
// FOR SHARE blocks): it uses the try form (completion's commit-time
// confirmation; un-voiding, which takes its customer / visit / invoice rows
// first and the month last; the full-refund transition of a stamped invoice,
// which runs inside the webhook's / admin refund's transaction that already
// holds the invoice row) or the bounded poll below (the mint), and a miss is
// the same retryable refusal, never a wait. The void / cancelled-visit void
// additionally TRY the customer collection claim right after the month lock
// (month, then claim: the order the mint and un-void take them in), so a
// collector (the monthly cron, its retry sweep, charge-now) mid-collection is
// never raced by a coverage-removing void. So the lock graph has no edge from
// a row/advisory lock into a blocking month wait, and no cycle can close.
async function acquireMembershipDuesMonthLock(trx, customerId, month) {
  await trx.raw(
    'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
    ['membership.dues_month', `${customerId}:${month}`],
  );
}

// Non-blocking sibling for an OFFICE action that must not wait (un-voiding a
// stamped dues invoice): true when this transaction now holds the lock.
async function tryAcquireMembershipDuesMonthLock(trx, customerId, month) {
  const res = await trx.raw(
    'SELECT pg_try_advisory_xact_lock(hashtext(?), hashtext(?::text)) AS acquired',
    ['membership.dues_month', `${customerId}:${month}`],
  );
  return res?.rows?.[0]?.acquired === true;
}

// The mint's take (it holds the customer FOR SHARE, the visit row and the visit's
// mint lock, so by THE LOCK RULE above it never waits): poll the try form for a
// short, bounded time so two sibling mints still serialize in the normal case
// (the first commits in milliseconds, the second then re-reads coverage), and
// give up with false, never a wait, when a long holder (a void or edit queued
// behind this mint's customer lock, a packet closeout) has it. The caller
// refuses retryably on false, which rolls the mint back and frees its locks.
const DUES_MONTH_MINT_WAIT_MS = 2000;
const DUES_MONTH_MINT_POLL_MS = 40;
async function acquireMembershipDuesMonthLockBounded(trx, customerId, month, {
  timeoutMs = Number(process.env.MEMBERSHIP_DUES_MINT_WAIT_MS) || DUES_MONTH_MINT_WAIT_MS,
  intervalMs = DUES_MONTH_MINT_POLL_MS,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await tryAcquireMembershipDuesMonthLock(trx, customerId, month)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// Is THIS ET month's membership dues covered? Mirrors the monthly cron's
// already-charged check: the metadata.billed_month stamp on a paid /
// processing payment is authoritative (month-of-obligation attribution — a
// July decline recovered Aug 1 counts for July, not August); legacy rows
// without the stamp match on payment month + the canonical "WaveGuard
// Monthly" description marker.
//
// Dues are owed ONCE per month, however many plan visits the month holds:
// a dues invoice a completion already minted for the month
// (MEMBERSHIP_DUES_LINE_KEY, keyed on the VISIT's month like the payment
// stamp) covers every other visit that month while it is live — paid,
// processing, or still open (an unpaid one is the month's bill; dunning
// collects it). A void / refunded / canceled one covers nothing. Pass
// `openInvoiceCovers: false` for a "was it actually paid" indicator.
// `excludeScheduledServiceId`: the asking visit's OWN dues invoice never
// covers that visit (completion resume, the visit's own preview/closeout).
async function monthlyDuesCollected(dbConn, customerId, now = new Date(), {
  excludeScheduledServiceId = null,
  openInvoiceCovers = true,
} = {}) {
  const { etDateString } = require('../utils/datetime-et');
  const monthKey = etDateString(now).slice(0, 7);
  if (await findCollectedDuesPayment(dbConn, customerId, monthKey)) return true;
  return !!(await findLiveStampedDuesInvoice(dbConn, customerId, monthKey, { excludeScheduledServiceId, openInvoiceCovers }));
}

// The paid / processing payment the cron (or Charge now / a retry rung)
// collected for this ET month — billed_month stamp first, payment month +
// the canonical "WaveGuard Monthly" description as the legacy fallback.
async function findCollectedDuesPayment(dbConn, customerId, monthKey) {
  return (await dbConn('payments')
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
    .first('id')) || null;
}

// The live completion-minted dues invoice for a customer + ET month, or null
// (row: id, status, scheduled_service_id, invoice_number). The ONE definition every collector
// shares — completion, the monthly cron, the retry sweep's classifier — so a
// month a stamped invoice already bills is never charged a second time.
// `openInvoiceCovers: false` keeps only invoices that are paid / prepaid /
// processing.
async function findLiveStampedDuesInvoice(dbConn, customerId, monthKey, {
  excludeScheduledServiceId = null,
  excludeInvoiceId = null,
  openInvoiceCovers = true,
} = {}) {
  // Lazy, like the status vocabulary below: invoice.js requires this module.
  const { CANCELLED_SERVICE_RESOLVED_STATUSES } = require('./invoice');
  const invoiceQuery = dbConn('invoices')
    .where({ customer_id: customerId })
    .whereRaw('line_items::jsonb @> ?::jsonb', [JSON.stringify([{ [MEMBERSHIP_DUES_LINE_KEY]: monthKey }])]);
  // Raw status predicate (not whereNotIn/whereIn): the collectors' unit-test
  // doubles model a thinner builder, and the vocabulary is a fixed literal.
  const placeholders = (list) => list.map(() => '?').join(', ');
  if (openInvoiceCovers) {
    invoiceQuery.whereRaw(`status NOT IN (${placeholders(CANCELLED_SERVICE_RESOLVED_STATUSES)})`, CANCELLED_SERVICE_RESOLVED_STATUSES);
  } else {
    const paid = ['paid', 'prepaid', 'processing'];
    invoiceQuery.whereRaw(`status IN (${placeholders(paid)})`, paid);
  }
  if (excludeScheduledServiceId) {
    invoiceQuery.where(function otherVisits() {
      this.whereNull('scheduled_service_id').orWhereNot('scheduled_service_id', excludeScheduledServiceId);
    });
  }
  if (excludeInvoiceId) invoiceQuery.whereNot({ id: excludeInvoiceId });
  return (await invoiceQuery.first('id', 'status', 'scheduled_service_id', 'invoice_number')) || null;
}

// Reasons a no_charge prediction is a MONEY GAP rather than a deliberately
// free visit: nothing bills only because no number is on the account.
// 'callback' / 'always_free_service_type' / 'annual_renewal_owned' are the
// by-design half and never appear here.
const UNBILLED_MONEY_GAP_REASONS = new Set(['no_amount_on_file', 'no_invoice_will_mint']);

/**
 * Per-service breakdown of a combined first-application invoice: each
 * same-day, same-estimate, non-recurring-child sibling's OWN anchored
 * per-visit split — recurring_template_overrides.anchored_split_per_visit,
 * stamped on the PARENT row by recurring-appointment-seeder.js
 * markParentRecurring from estimate-converter.js
 * reservedAcceptPerVisitSplit's per-line amounts, falling back to the row's
 * own estimated_price when it carries no anchored marker (the reserved row
 * keeps its stamped price rather than a template override).
 *
 * Returns the breakdown array ONLY when it fully reconciles to the
 * invoice's own APPLICATION-LINE subtotal (cent-exact) and names more than
 * one service — a partial or stale split must never relabel money that
 * doesn't add up. Returns null otherwise (including on any lookup error),
 * so callers can leave their prediction exactly as it was.
 *
 * Reconciles against `invoiceLineItems` (the invoice's own `line_items`,
 * summed excluding any one-time setup fee line — see
 * attachedInvoiceAutoChargeLikely above for the same pattern), never the
 * raw `invoiceTotal` (codex round-9 P2): total folds in tax and, on a
 * combined acceptance invoice, the one-time setup fee line — neither of
 * which the anchored per-visit splits (or a row's plain estimated_price)
 * ever included. Comparing a genuinely correct split against the taxed,
 * fee-inclusive total rejected it outright whenever the invoice also
 * carried a setup fee and/or a nonzero tax rate. Falls back to
 * `invoiceTotal` only when the line items can't be read at all (a caller
 * that didn't pass them, or an unparseable value) — a stale/legacy payload
 * stays exactly as safe as before, never both compared at once.
 */
async function sameTripFirstApplicationBreakdown({ svc, invoiceTotal, invoiceLineItems, dbConn } = {}) {
  if (!svc?.source_estimate_id || !svc?.customer_id || !svc?.scheduled_date || !dbConn) return null;
  try {
    const members = await dbConn('scheduled_services')
      .where({
        customer_id: svc.customer_id,
        source_estimate_id: svc.source_estimate_id,
        scheduled_date: svc.scheduled_date,
      })
      .whereNull('recurring_parent_id')
      .select('id', 'service_type', 'estimated_price', 'recurring_template_overrides');
    if (members.length < 2) return null;
    const amountFor = (row) => {
      let overrides = row.recurring_template_overrides;
      if (typeof overrides === 'string') {
        try { overrides = JSON.parse(overrides); } catch { overrides = null; }
      }
      const anchored = Number(overrides?.anchored_split_per_visit);
      if (Number.isFinite(anchored) && anchored > 0) return Math.round(anchored * 100) / 100;
      return row.estimated_price != null && Number(row.estimated_price) > 0 ? Number(row.estimated_price) : null;
    };
    const breakdown = members.map((row) => ({ id: row.id, serviceType: row.service_type, amount: amountFor(row) }));
    const sum = breakdown.reduce((acc, item) => (acc === null || item.amount == null ? null : acc + item.amount), 0);
    let target = Number(invoiceTotal);
    try {
      const rawLines = invoiceLineItems;
      const lines = typeof rawLines === 'string' ? JSON.parse(rawLines) : rawLines;
      if (Array.isArray(lines) && lines.length) {
        target = lines.reduce((acc, li) => {
          if (/one-time setup fee/i.test(String(li?.description || ''))) return acc;
          const lineAmount = Number(li?.amount ?? ((Number(li?.quantity) || 1) * (Number(li?.unit_price) || 0)));
          return Number.isFinite(lineAmount) ? acc + lineAmount : acc;
        }, 0);
      }
    } catch { /* unreadable line items — reconcile against invoiceTotal instead */ }
    if (sum != null && Number.isFinite(target) && Math.round(sum * 100) === Math.round(target * 100)) {
      return breakdown;
    }
    return null;
  } catch {
    return null;
  }
}

// The shared lookup, validated: a match only counts as "covering" this visit
// when it names a DIFFERENT visit (a sibling, never svc's own row — that
// case is already handled by the attached-invoice prediction) and is not
// one of the resolved/dead statuses closeout-status.js itself treats as a
// manual-billing alert rather than a settled cover.
//
// THIS is the one sibling-coverage determination every caller should share —
// the schedule sheet's prediction (siblingCoverageForSchedule below),
// Charge Now / the prepaid receipt's own resolver (resolveScheduledServiceCharge,
// admin-schedule.js), and completion itself (complete-scheduled-service.js
// re-checks findFirstApplicationInvoiceForEstimateService directly) all
// resolve "is a sibling's invoice already covering this trip?" through this
// function (or the raw lookup it wraps) so they cannot disagree. A future
// split-provenance exemption (e.g. a marker that some visits are NOT subject
// to sibling coverage) belongs HERE, gating the `inv` match below, so every
// caller inherits the exemption in one place instead of drifting.
//
// Returns a verdict, never a bare invoice-or-null — a MINT decision (the
// resolver below) must tell "definitely nothing to worry about" apart from
// "couldn't tell" (codex pre-push P0, x2): collapsing a lookup FAILURE, or a
// terminal/refunded match completion itself parks for a human
// (findFirstApplicationInvoiceForEstimateService deliberately surfaces a
// refunded match ahead of any live replacement — see its own header, and
// `liveBeside` here), into a bare null let a mint decision treat either the
// same as "no sibling, bill normally" and double-charge. completion's own
// mint refuses (throws, retryable) on exactly these two cases
// (invoiceLookupFailed / the terminal-invoice branch) rather than mint —
// this verdict lets other write callers refuse the same way.
//   { status: 'covered', invoice }                             — a live sibling invoice covers this trip
//   { status: 'needs_review', invoice, liveBeside }            — a terminal/refunded match only a human can reconcile
//   { status: 'needs_review', invoice: null, canceledSetupFee } — a canceled acceptance invoice carried the
//                                                                  one-time setup fee with NO live replacement;
//                                                                  completion parks this rather than remint the
//                                                                  visit charge alone and silently drop the fee
//   { status: 'needs_review', invoice, reason: 'combined_invoice_voided' } — the estimate's recognized
//                                                                  first-application invoice has gone terminal
//                                                                  (void/refunded/canceled/cancelled) with no live
//                                                                  recognized one replacing it — owner ruling, REFUSE
//                                                                  AFTER A VOID; see combinedInvoiceVoidedWithoutLiveReplacement
//   { status: 'error' }                                        — the lookup itself failed
//   { status: 'none' }                                         — no relevant match at all
//
// The ONE shape predicate every sibling-coverage caller shares (codex P1):
// "could a same-estimate, same-day sibling's invoice be covering THIS
// visit?" is a question about the VISIT'S OWN shape — unpriced, tied to an
// estimate, not a callback, not an always-free type — never about the
// customer's CURRENT billing lane. A customer can accept per_application,
// get a combined first-application invoice on a sibling that leaves this
// row deliberately unpriced (estimate-converter.js
// reservedAcceptPerVisitSplit), and later move to monthly/legacy-null dues
// — the old acceptance invoice still covers this trip regardless. Schedule
// enrichment (siblingCoverageForSchedule's caller,
// admin-schedule.js enrichBillingLaneWithWalletGap) and completion itself
// (complete-scheduled-service.js, findFirstApplicationInvoiceForEstimateService)
// already ask this question unconditionally, keyed on the SAME shape; the
// mint resolver below (resolveScheduledServiceCharge) is the one caller
// this predicate exists to fix — gating it on `billingMode === 'per_application'`
// let a lane-changed customer's Charge Now fall through to monthly_rate and
// mint a second collectible base charge beside the sibling's live invoice.
// Takes the caller's OWN resolved shape (not a raw DB row) so it agrees
// byte-for-byte with whatever `estimatedPrice`/`isCallback`/`serviceType`
// values that caller already derived (e.g. resolveScheduledServiceCharge's
// provenance-aware `hasOwnPrice`, which also credits hasAuthoritativeZeroPrice)
// — never a second, independent re-read of svc's columns that could drift
// from them. `sourceEstimateId` missing (a pure unit-test fixture with no
// svc at all) reads as ineligible, never as a false positive.
// `isPricedCoveredMember` (Codex r21 P1 on PR #5021, deferred to this
// follow-up): a NON-ANCHOR row whose first_application_invoice_id is
// stamped to an invoice whose OWN scheduled_service_id (its anchor) is a
// DIFFERENT row is coverage-eligible even though it carries its own price —
// staff pricing a covered sibling after its trip's combined invoice already
// existed must never make Charge Now/completion blind to that invoice.
// Computed ASYNC, DB-backed (estimate-first-application-invoice.js's
// isPricedCoveredMemberVisit — the anchor identity lives on the INVOICE row,
// not svc) by the few callers that have a dbConn; every other caller omits
// it (default false), which keeps this predicate's OWN `!hasOwnPrice` gate
// byte-identical for them — including the anchor's own priced mint, which
// must never reach the sibling-coverage checks this gate exists to keep it
// out of (an anchor's own refunded/voided invoice is its OWN terminal-invoice
// case, not a sibling "needs review").
function isSiblingCoverageEligibleVisit({
  sourceEstimateId, hasOwnPrice, isCallback, serviceType, isPricedCoveredMember = false,
}) {
  if (!sourceEstimateId) return false;
  if (isCallback) return false;
  if (isAlwaysFreeServiceType(serviceType)) return false;
  if (hasOwnPrice) return !!isPricedCoveredMember;
  return true;
}

// Owner ruling — REFUSE AFTER A VOID (replaces the round-9/round-10 guards
// — sameTripSiblingHasUnrecognizedLiveInvoice, isPricedSiblingCoverageEligibleVisit,
// pricedSiblingCoverageVerdict — with ONE rule, never new notes text or
// replacement-recognition machinery): findFirstApplicationInvoiceForEstimateService
// only recognizes an invoice as "the" first-application invoice when it
// carries the acceptance flow's own provenance notes
// (isAutoGeneratedPayPerApplicationInvoice), and its own query EXCLUDES
// 'void' entirely so a voided combined invoice is completely invisible to
// it — reported as a bare `invoice: null`, indistinguishable from "nothing
// was ever minted for this trip." A CANCELED recognized invoice with no
// setup-fee line falls through that lookup's own canceledSetupFee check
// the same way. This asks the precise question instead: across EVERY
// invoice attached to ANY member of this estimate + date + customer group
// (never limited to svc's own row — the combined invoice typically sits on
// the RESERVED sibling; for a STAMPED visit the group is the stamped
// invoice and its anchor row, whatever day they sit on), is there a RECOGNIZED first-application invoice
// in a terminal state (void/refunded/canceled/cancelled) with NO live
// recognized one replacing it? Returns that terminal invoice row, or null.
//
// Filters every candidate row to the recognized set FIRST, before ever
// deciding live-vs-terminal or picking one to report — never limits/orders
// down to a single row before applying the recognition filter (the exact
// bug an earlier version of this fix had: ordering by recency and taking
// only the newest row let an unrelated newer invoice on the same row mask
// an older recognized invoice that had actually died). Only the
// ALREADY-recognized-terminal subset is sorted by recency, for a
// deterministic pick when more than one exists.
async function combinedInvoiceVoidedWithoutLiveReplacement(svc, dbConn, { lockRows = false, noWait = false } = {}) {
  if (!svc?.source_estimate_id || !svc?.customer_id) return null;
  const {
    isAutoGeneratedPayPerApplicationInvoice, firstApplicationCandidateQuery, readFirstApplicationStamp, dateOnly,
  } = require('./estimate-first-application-invoice');
  // ONE candidate-row query, shared with findFirstApplicationInvoiceForEstimateService
  // (PR #5021, Codex pre-push on d1ce0fd165): unstamped visits keep the exact
  // customer + estimate + current-date scope this guard always had; a visit
  // carrying first_application_invoice_id ALSO sees the stamped invoice
  // itself and every invoice on its anchor row, whatever day the anchor or
  // this sibling now sits on. Before this the lookup followed the stamp but
  // this fallback did not, so voiding the combined invoice AFTER a covered
  // sibling moved made both checks report "nothing minted" and completion /
  // Charge Now minted a second charge instead of holding. The ONE difference
  // from the lookup's own use of the helper: this never excludes 'void',
  // since detecting a voided combined invoice is the whole point.
  const stampedInvoiceId = await readFirstApplicationStamp(svc, dbConn);
  const scheduledDate = dateOnly(svc.scheduled_date);
  if (!scheduledDate && !stampedInvoiceId) return null;
  let query = firstApplicationCandidateQuery(dbConn, {
    customerId: svc.customer_id, sourceEstimateId: svc.source_estimate_id, scheduledDate, stampedInvoiceId,
  }).select('i.*');
  if (lockRows) query = noWait ? query.forUpdate('i').noWait() : query.forUpdate('i');
  const rows = await query;
  // Recognition: the acceptance flow's own provenance text, OR the stamped
  // row itself (the stamp is stronger evidence than editable title/notes).
  // A LIVE invoice on the anchor that is NOT recognized (a renamed
  // replacement, a hand invoice, a repair) deliberately does NOT count as a
  // live replacement: it is never coverage and never "none" — the hold
  // stands and the office resolves it by hand (Codex r15 P1 on PR #5021:
  // fail closed instead of classifying a replacement from editable copy).
  const recognized = (rows || []).filter((row) => isAutoGeneratedPayPerApplicationInvoice(row)
    || (stampedInvoiceId && String(row.id) === String(stampedInvoiceId)));
  if (!recognized.length) return null;
  const TERMINAL_STATUSES = ['void', 'refunded', 'canceled', 'cancelled'];
  const hasLiveRecognized = recognized.some((row) => !TERMINAL_STATUSES.includes(String(row.status)));
  if (hasLiveRecognized) return null;
  const terminal = recognized.filter((row) => TERMINAL_STATUSES.includes(String(row.status)));
  if (!terminal.length) return null;
  terminal.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return terminal[0];
}

// Shared helper — owner ruling (round 13, codex pre-push P2): "propagate
// the new void hold to billing projections". Completion's REFUSE AFTER A
// VOID guard (combinedInvoiceVoidedWithoutLiveReplacement above) already
// holds Charge Now for an unpriced, estimate-linked per_application visit
// whose combined invoice died with no live replacement — but two OTHER
// billing projections had no idea: closeout-status.js's deriveBillingExpectation
// (predictCompletionBilling itself has no sibling-coverage awareness at
// all — it only ever sees the visit's own fields) and
// annual-prepay-renewals.js's card-expiry warning projection (its own
// direct findFirstApplicationInvoiceForEstimateService call reports the
// SAME invisible-void as an ordinary "nothing found — none", since that
// lookup's own query excludes 'void' entirely). Both kept projecting a
// positive invoice/auto_charge amount — the latter a live card-expiry
// warning — for a charge completion actually holds for manual review. ONE
// shared check here, called from both, so they can never drift from each
// other or from the Charge Now guard's own verdict.
//
// Read-only/advisory (never a MINT decision — see siblingCoverageForSchedule
// below for the display verdict) — a lookup FAILURE fails toward null (the caller's ordinary
// prediction stands), never toward inventing a hold; only a mint decision
// fails closed the other way. Returns the voided invoice row when this
// exact shape is held, null otherwise (every priced visit, a callback, a
// visit with no estimate link at all — isSiblingCoverageEligibleVisit
// gates it the SAME way the Charge Now resolver's own guard does).
//
// Deliberately NOT gated on the customer's CURRENT billing_mode (Codex r12
// P2): completion's own REFUSE AFTER A VOID park
// (complete-scheduled-service.js, the isSiblingCoverageEligibleVisit +
// combinedInvoiceVoidedWithoutLiveReplacement pair) checks only the
// VISIT's shape — the lane is mutable, and a customer switched from
// per_application to monthly, legacy-null or any other lane after the
// void still gets parked at completion. An earlier `billingMode !==
// 'per_application'` early return here let both projections (closeout
// status, card-expiry warning) show a charge completion never makes for
// exactly that customer. Same lane-independent predicate as completion.
async function perApplicationCompletionVoidHold({
  isCallback, serviceType, svc, dbConn,
}) {
  const hasOwnPrice = (svc?.estimated_price != null && Number(svc.estimated_price) > 0)
    || hasAuthoritativeZeroPrice(svc?.estimated_price, svc?.primary_line_price);
  // Cheap shape check FIRST, price-blind (every other exclusion — no
  // estimate link, callback, always-free type — needs no DB at all): only
  // when the visit already looks eligible apart from price do we spend the
  // one extra DB round trip deciding isPricedCoveredMember (see
  // isSiblingCoverageEligibleVisit's own header) — never for a visit this
  // predicate would refuse anyway.
  if (!isSiblingCoverageEligibleVisit({
    sourceEstimateId: svc?.source_estimate_id, hasOwnPrice: false, isCallback: !!isCallback, serviceType,
  })) return null;
  const isPricedCoveredMember = hasOwnPrice
    ? await require('./estimate-first-application-invoice').isPricedCoveredMemberVisit(svc, dbConn)
    : false;
  if (!isSiblingCoverageEligibleVisit({
    sourceEstimateId: svc?.source_estimate_id, hasOwnPrice, isCallback: !!isCallback, serviceType, isPricedCoveredMember,
  })) return null;
  try {
    return await combinedInvoiceVoidedWithoutLiveReplacement(svc, dbConn);
  } catch {
    return null;
  }
}

// `lockRows` (codex pre-push P1, round 3): a transactional MINT recheck
// passes this so the underlying lookup's FOR UPDATE OF i (see
// findFirstApplicationInvoiceForEstimateService) holds the matched invoice
// row(s) to commit — the read-only schedule prediction and every
// non-transactional caller leave it false (unchanged, a plain snapshot
// read; passing it there would take a lock this function never releases
// outside a transaction).
async function siblingInvoiceCoverageVerdict(svc, dbConn, { lockRows = false, noWait = false } = {}) {
  let result;
  try {
    const { findFirstApplicationInvoiceForEstimateService } = require('./estimate-first-application-invoice');
    // Every existing (non-transactional) caller keeps the exact byte-identical
    // 2-arg call — only a `lockRows: true` recheck passes the 3rd argument at
    // all, so a call-shape assertion in an existing test never has to know
    // about this option. `noWait` (codex round-6 P1) rides along ONLY when
    // the caller itself already took the estimate ledger lock first (the
    // schedule mint's own recheck) — see findFirstApplicationInvoiceForEstimateService's
    // header for why that ordering needs it. A NOWAIT lock-busy failure
    // lands in the catch below exactly like any other lookup failure.
    result = lockRows
      ? await findFirstApplicationInvoiceForEstimateService(svc, dbConn, { lockRows: true, noWait })
      : await findFirstApplicationInvoiceForEstimateService(svc, dbConn);
  } catch {
    return { status: 'error' };
  }
  const inv = result?.invoice;
  if (!inv) {
    // codex pre-push P0: a null invoice is NOT always "no relevant match" —
    // the lookup also returns a canceled acceptance invoice that carried
    // the one-time setup fee (canceledSetupFee) with no live replacement.
    // Losing that signal here let the resolver mint only the per-visit/
    // per-application charge and silently drop the fee completion would
    // otherwise park for manual billing (splitTerminalCompletionInvoice /
    // completionTerminalIncludedSetupFee in complete-scheduled-service.js).
    if (result?.canceledSetupFee) {
      return { status: 'needs_review', invoice: null, canceledSetupFee: result.canceledSetupFee };
    }
    // Owner ruling — REFUSE AFTER A VOID: a null invoice ALSO isn't always
    // "no relevant match" when the estimate's recognized first-application
    // invoice has gone terminal (void/refunded/canceled/cancelled) with no
    // live recognized replacement (combinedInvoiceVoidedWithoutLiveReplacement's
    // own header) — most commonly the original combined invoice was voided
    // and, whatever Charge Now reminted afterward on the reserved sibling,
    // it carries no recognized provenance. A lookup failure here fails the
    // SAME way the raw lookup's own failure does, never silently as "no
    // voided invoice".
    let voidedInvoice;
    try {
      voidedInvoice = await combinedInvoiceVoidedWithoutLiveReplacement(svc, dbConn, { lockRows, noWait });
    } catch {
      return { status: 'error' };
    }
    if (voidedInvoice) {
      return { status: 'needs_review', invoice: voidedInvoice, reason: 'combined_invoice_voided' };
    }
    return { status: 'none' };
  }
  // A terminal/refunded match is handled BEFORE the own-visit exclusion
  // below (codex round-2 P0): the shared lookup deliberately returns a
  // refunded match ahead of any live replacement regardless of WHOSE row
  // it sits on (no reliable refund-event clock — see that lookup's own
  // header), with the live replacement riding along as `liveBeside`. The
  // own-visit check below means "this exact row, not a sibling" — but
  // discarding a REFUNDED own-visit match as "just my own row, nothing to
  // see" also discards a live SIBLING invoice riding beside it as
  // liveBeside, letting this resolver fall through to 'none' and mint the
  // acceptance fee for a trip that sibling's live invoice already covers.
  const { CANCELLED_SERVICE_RESOLVED_STATUSES } = require('./invoice');
  if (CANCELLED_SERVICE_RESOLVED_STATUSES.includes(String(inv.status))) {
    return { status: 'needs_review', invoice: inv, liveBeside: result?.liveBeside || null };
  }
  if (!inv.scheduled_service_id || String(inv.scheduled_service_id) === String(svc.id)) return { status: 'none' };
  return { status: 'covered', invoice: inv };
}

// The ONE canonical per-visit collection verdict (owner decision — narrow +
// fail closed, after 8 Codex rounds of the schedule preview, Charge Now,
// completion and six client surfaces each re-deriving "is this visit
// covered by another invoice?" separately and drifting). Built ONLY from
// existing server gates: the shared sibling-invoice lookup
// (siblingInvoiceCoverageVerdict — the SAME lookup completion
// (findFirstApplicationInvoiceForEstimateService) and the Charge Now mint
// resolver (resolveScheduledServiceCharge) both consult) plus
// invoice-helpers' own collectibility checks — invoiceWithdrawnFromCustomer,
// payer ownership (payer_id), and credit fully covering the total
// (amountDue <= 0). A terminal status on the matched invoice is 'review'
// regardless of WHOSE row it sits on (siblingInvoiceCoverageVerdict's own
// header: the shared lookup returns a terminal/refunded match ahead of any
// live replacement, own-visit or sibling, before its own-visit exclusion)
// — this is also how a visit whose OWN attached first-application invoice
// is refunded/canceled reads 'review' (round-8 P2), with no special case
// needed here.
//
// Returns { state: 'none' | 'settled' | 'collect_on_combined_invoice' | 'review',
//   invoiceId, invoiceNumber, amountDue, reason }.
//
// Every schedule surface renders THIS field for its collect/settled/review
// copy — client/src/lib/siblingInvoiceCoverage.js is pure copy formatting
// of it, never its own classifier.
const NO_SIBLING_COVERAGE = Object.freeze({ state: 'none', invoiceId: null, invoiceNumber: null, amountDue: null, reason: null });

// The 'error'/'needs_review' half of the schedule-sheet verdict (Codex round-14
// complexity cleanup — extracted verbatim from siblingCoverageForSchedule,
// same branches, same reason precedence, no behavior change). An 'error'
// verdict (lookup failed) and a 'needs_review' verdict (terminal/refunded
// match, or a canceled acceptance invoice that carried the setup fee with no
// live replacement) both render the sheet's review card — see this module's
// header on siblingInvoiceCoverageVerdict for why they're never told apart
// from "covered". A needs_review verdict that carries its own explicit
// `reason` (combinedInvoiceVoidedWithoutLiveReplacement's
// 'combined_invoice_voided' — owner ruling, REFUSE AFTER A VOID) always
// wins, even when `invoice` is also set (the voided invoice itself, for the
// review card's link) — never silently overridden by the generic
// 'terminal_invoice' label. Falls back to the shape-based derivation only
// for verdicts that never set `reason` themselves (the own-visit/sibling
// terminal-match branch, and the canceledSetupFee shape).
function siblingReviewCoverage(verdict) {
  const inv = verdict.invoice || null;
  const reason = verdict.status === 'error'
    ? 'lookup_failed'
    : (verdict.reason || (inv ? 'terminal_invoice' : 'canceled_setup_fee'));
  const coverage = {
    state: 'review',
    invoiceId: inv?.id || null,
    invoiceNumber: inv?.invoice_number || null,
    amountDue: null,
    reason,
  };
  return {
    coverage,
    prediction: {
      kind: 'sibling_needs_review',
      amount: null,
      conflictStampedPrice: false,
      invoiceId: coverage.invoiceId,
      invoiceNumber: coverage.invoiceNumber,
    },
  };
}

// The collection-state half of a 'covered' verdict (Codex round-14 complexity
// cleanup — extracted verbatim, same branches/order/reasons, no behavior
// change): invoice-helpers' own collectibility checks —
// invoiceWithdrawnFromCustomer, payer ownership (payer_id), the invoice's own
// collectible-status set, and credit fully covering the total (amountDue <=
// 0) — never a second classifier. Returns only the `coverage` shape;
// `prediction` is built alongside it by the caller.
function collectionStateForCoveredInvoice(inv, amountDue) {
  // codex round-8 P1: a draft/sent sibling invoice with payer_id set, or
  // withdrawn from the homeowner via the `payer_billed:` stamp, is not
  // collectible from THIS customer at all — the payment paths reject it
  // (invoiceWithdrawnFromCustomer, payer ownership,
  // server/services/invoice-helpers.js) — so it reads settled here (nothing
  // for a technician to collect from the homeowner), never "collect on
  // that invoice."
  if (invoiceWithdrawnFromCustomer(inv)) {
    return { state: 'settled', invoiceId: inv.id, invoiceNumber: inv.invoice_number || null, amountDue: 0, reason: 'withdrawn_from_customer' };
  }
  if (inv.payer_id) {
    return { state: 'settled', invoiceId: inv.id, invoiceNumber: inv.invoice_number || null, amountDue: 0, reason: 'payer_billed' };
  }
  if (!isInvoiceCollectibleStatus(inv.status)) {
    // paid / prepaid / processing — a technician never collects any of
    // these (there's nothing left for THEM to charge), but 'processing' is
    // NOT the same fact as paid/prepaid: it's a payment still in flight
    // (e.g. a pending ACH debit) that can still fail to settle. codex
    // round-9 P2: lumping it into the same 'invoice_settled' reason read as
    // fully paid to every consumer that branches on `reason` — the
    // schedule sheet's CompletionPanel previewed an immediate review
    // request for it, while complete-scheduled-service.js's own
    // invoiceBlocksReview holds the ask for every status except literal
    // 'paid'/'prepaid'. Keep the reason distinct (state stays 'settled' —
    // a technician still collects nothing either way) so a consumer that
    // needs the finer distinction (review timing) can ask for it, without
    // reclassifying what a technician does at the door.
    return {
      state: 'settled',
      invoiceId: inv.id,
      invoiceNumber: inv.invoice_number || null,
      amountDue: 0,
      reason: String(inv.status) === 'processing' ? 'invoice_processing' : 'invoice_settled',
    };
  }
  if (!(amountDue > 0)) {
    // A draft/sent/... invoice fully covered by account credit.
    return { state: 'settled', invoiceId: inv.id, invoiceNumber: inv.invoice_number || null, amountDue: 0, reason: 'credit_applied' };
  }
  return { state: 'collect_on_combined_invoice', invoiceId: inv.id, invoiceNumber: inv.invoice_number || null, amountDue, reason: null };
}

// The covered-invoice prediction enrichment (Codex round-14 complexity
// cleanup — extracted verbatim, same lookups/order, no behavior change):
// the sibling's own service-type label plus the same-trip per-visit
// breakdown (sameTripFirstApplicationBreakdown) when the anchored per-visit
// splits reconcile to the invoice total. Read-only/advisory — a lookup
// failure leaves the coverage verdict standing exactly as it already does.
// Mutates and returns the passed-in `prediction` object.
async function enrichCoveredSiblingPrediction(prediction, svc, inv, dbConn) {
  try {
    const siblingVisit = await dbConn('scheduled_services').where({ id: inv.scheduled_service_id }).first('id', 'service_type');
    if (siblingVisit?.service_type) prediction.siblingServiceType = siblingVisit.service_type;
  } catch { /* no service-type label — the coverage verdict still stands */ }
  try {
    const breakdown = await sameTripFirstApplicationBreakdown({
      svc, invoiceTotal: inv.total, invoiceLineItems: inv.line_items, dbConn,
    });
    if (breakdown) prediction.breakdown = breakdown;
  } catch { /* no breakdown — the coverage verdict still stands */ }
  return prediction;
}

// Eligibility gate for the schedule-sheet's sibling-coverage lookup (Codex
// round-14 complexity cleanup — extracted verbatim, same shape/order, no
// behavior change). Owner ruling — REFUSE AFTER A VOID: the priced row is
// never refused — completing or charging it bills the combined amount once,
// which is correct — so this prediction stays exclusively for UNPRICED,
// sibling-eligible visits. The visit's own provenance-aware price shape
// (hasAuthoritativeZeroPrice credited the same way completion's own guard
// credits it) feeds the SAME isSiblingCoverageEligibleVisit shape predicate
// every other sibling-coverage caller gates on, plus the DB/estimate/date
// fields this lookup itself needs in order to run at all.
async function scheduleSiblingCoverageEligible(svc, dbConn) {
  const hasBaseFields = !!(svc?.source_estimate_id && svc?.customer_id && svc?.scheduled_date && dbConn);
  if (!hasBaseFields) return { eligible: false, isPricedCoveredMember: false };
  const hasOwnPrice = (svc?.estimated_price != null && Number(svc.estimated_price) > 0)
    || hasAuthoritativeZeroPrice(svc?.estimated_price, svc?.primary_line_price ?? null);
  // Priced-covered-member widening (see isSiblingCoverageEligibleVisit's own
  // header) — the same shape the Charge Now resolver and completion's void
  // guard ask, so this sheet prediction can never disagree with either.
  // Feed cost (Codex r4 P2 on #5237): the day/week feeds call this per visit,
  // so the DB-backed member check runs only for a priced visit whose SHAPE
  // could be covered and whose feed row carries a stamp. A NULL on the
  // feed's own fresh row is trusted here: this is a read-only prediction,
  // so a stamp landing mid-render changes only what the sheet shows until
  // the next refresh; every charge path re-reads under its own lock
  // (refuseCoveredMemberMintInTrx, siblingCoverageRecheckInTrx).
  const couldBeMember = hasOwnPrice
    && svc?.first_application_invoice_id !== null
    && isSiblingCoverageEligibleVisit({
      sourceEstimateId: svc?.source_estimate_id, hasOwnPrice: false, isCallback: !!svc?.is_callback, serviceType: svc?.service_type,
    });
  const isPricedCoveredMember = couldBeMember
    ? await require('./estimate-first-application-invoice').isPricedCoveredMemberVisit(svc, dbConn)
    : false;
  const eligible = isSiblingCoverageEligibleVisit({
    sourceEstimateId: svc?.source_estimate_id, hasOwnPrice, isCallback: !!svc?.is_callback, serviceType: svc?.service_type, isPricedCoveredMember,
  });
  // isPricedCoveredMember rides back to the caller (#5237 review r2 P2):
  // only when it's true does the caller need to ALSO ask
  // pricedCoveredMemberOwnRefundHold before trusting a 'covered' verdict —
  // recomputing it there would be a second, redundant DB round trip.
  return { eligible, isPricedCoveredMember };
}

/**
 * Schedule-payload builder: resolves the canonical sibling-coverage verdict
 * above AND (only when it is non-'none') the matching `billingLane.prediction`
 * override — the same shape earlier rounds called `covered_sibling_invoice`
 * / `sibling_needs_review`, still amount: null (nothing mints a second
 * invoice for this visit either way), enriched with the sibling's own
 * service type and a same-trip breakdown when the anchored per-visit splits
 * reconcile to the invoice total (see sameTripFirstApplicationBreakdown).
 *
 * Read-only and advisory, like predictCompletionBilling: it never mints,
 * voids, or changes what completion or Charge Now charge — only what the
 * sheet SHOWS. Resolved for EVERY sibling-coverage-ELIGIBLE visit
 * (isSiblingCoverageEligibleVisit — unpriced, estimate-linked, not a
 * callback, not an always-free type) regardless of what this visit's own
 * naive prediction already says — the SAME shape gate the Charge Now mint
 * resolver gates on, so the preview and the mint can never disagree about
 * whether a sibling COULD be covering this trip.
 *
 * `dbConn` is caller-owned (day/week schedule feeds pass their `db`), kept
 * as an explicit param so this module stays DB-free for pure unit tests
 * except where a caller opts in, same as monthlyDuesCollected above.
 */
async function siblingCoverageForSchedule({ svc, dbConn } = {}) {
  const { eligible, isPricedCoveredMember } = await scheduleSiblingCoverageEligible(svc, dbConn);
  if (!eligible) {
    return { coverage: NO_SIBLING_COVERAGE, prediction: null };
  }
  let verdict;
  try {
    // Own-row refund precedence (#5237 review r2 P2) — see
    // resolveScheduledServiceCharge's own header (admin-schedule.js) for
    // why: reuses the SAME pricedCoveredMemberOwnRefundHold so the sheet
    // can never disagree with Charge Now or completion for this input.
    const ownRefund = isPricedCoveredMember
      ? await require('./estimate-first-application-invoice').pricedCoveredMemberOwnRefundHold(svc, dbConn)
      : null;
    verdict = ownRefund ? { status: 'needs_review', invoice: ownRefund } : await siblingInvoiceCoverageVerdict(svc, dbConn);
  } catch {
    verdict = { status: 'error' };
  }
  if (verdict.status === 'error' || verdict.status === 'needs_review') {
    return siblingReviewCoverage(verdict);
  }
  if (verdict.status !== 'covered') return { coverage: NO_SIBLING_COVERAGE, prediction: null };

  const inv = verdict.invoice;
  const amountDue = invoiceAmountDue(inv);
  const coverage = collectionStateForCoveredInvoice(inv, amountDue);
  const prediction = {
    kind: 'covered_sibling_invoice',
    amount: null,
    conflictStampedPrice: false,
    invoiceId: coverage.invoiceId,
    invoiceNumber: coverage.invoiceNumber,
  };
  await enrichCoveredSiblingPrediction(prediction, svc, inv, dbConn);
  return { coverage, prediction };
}

/**
 * Does completing this visit leave money on the table? Reads the SAME
 * prediction the sheet renders and the completion path mirrors — no second
 * classifier (the 2026-07 double-billing incident came from exactly that).
 *
 * `hasChargeableMethod` is advisory context, NOT part of the gap test: a
 * per-visit customer with a real price and no card still gets a payable
 * invoice, which is normal and must not warn (that case is already the
 * no_card_on_file alert's job). The wallet only sharpens the message when
 * the visit is billing nothing anyway. Same vocabulary as
 * noCardOnFileAlert — a non-expired card, or usable bank method — not a
 * bare payment_methods row.
 *
 * Returns null when there is no gap, else { reason, noPaymentMethod }.
 */
function unbilledCompletionGap({ prediction, hasChargeableMethod = null, willMint = null }) {
  if (!prediction) return null;
  // A prediction of 'invoice' answers "what would this bill", not "will an
  // invoice exist". They diverge: a priced visit with
  // create_invoice_on_complete false, a null billing mode, no membership
  // tier and GATE_AUTOINVOICE_PRICED_VISITS off predicts an invoice that
  // shouldAutoInvoiceCompletion then declines to mint
  // (admin-dispatch.js:16155-16157). The booking gate already asks the real
  // decision; the warning must too, or the sheet stays silent on the one
  // shape it exists to surface. `willMint` null = the caller could not ask —
  // never treated as a gap.
  // A PRICED payer prediction is judged the same way: it can carry an amount
  // and still lack every mint trigger, in which case completion creates no AP
  // invoice at all and the warning must not stay silent (Codex P1). The
  // service customer's wallet is irrelevant to it, so no wallet verdict is
  // reported — offering to text THIS customer a card link would be wrong.
  const payerWithAmount = prediction.kind === 'payer' && Number(prediction.amount) > 0;
  if (willMint === false && (['invoice', 'auto_charge'].includes(prediction.kind) || payerWithAmount)) {
    return {
      reason: 'no_invoice_will_mint',
      noPaymentMethod: payerWithAmount || hasChargeableMethod == null
        ? null
        : hasChargeableMethod === false,
      ...(payerWithAmount ? { payerBilled: true } : {}),
    };
  }
  // A payer says WHO owes, never HOW MUCH. Completion still derives the
  // amount from the visit price / rate alone and categorically refuses to
  // mint at <= 0, so an UNPRICED payer-billed visit bills nobody — the
  // customer or the payer (Codex P0). A priced one carries its amount here
  // and is not a gap.
  // Free-by-design payer work (callback / always-free type) carries a reason
  // and is never a gap — only a payer visit with no amount from ANY source is
  // (Codex P1).
  const payerWithoutAmount = prediction.kind === 'payer'
    && !(Number(prediction.amount) > 0)
    && !prediction.reason;
  if (!payerWithoutAmount) {
    if (prediction.kind !== 'no_charge') return null;
    if (!UNBILLED_MONEY_GAP_REASONS.has(prediction.reason)) return null;
  }
  return {
    reason: payerWithoutAmount ? 'no_amount_on_file' : prediction.reason,
    // Whose wallet the visit is: a third-party payer owns the invoice, so the
    // SERVICE customer's saved cards say nothing about it and must never be
    // reported as "no card on file" — the sheet turns that into an offer to
    // text THIS customer a card link for someone else's bill (Codex P1).
    ...(payerWithoutAmount ? { payerBilled: true } : {}),
    // null = unknown (caller could not read the wallet); only `true` asserts
    // it, so an unreadable wallet never invents "no card on file".
    noPaymentMethod: payerWithoutAmount || hasChargeableMethod == null
      ? null
      : hasChargeableMethod === false,
  };
}

module.exports = {
  stampedZeroFreeLive,
  BILLING_MODES,
  hasAuthoritativeZeroPrice,
  UNBILLED_MONEY_GAP_REASONS,
  unbilledCompletionGap,
  MONTHLY_LANE_SQL,
  MEMBERSHIP_TIER_SQL,
  isMembershipTier,
  impliedMonthlyStampForWrite,
  resolveBillingLane,
  membershipDuesCoverVisit,
  completionInvoiceAmount,
  completionInvoiceIsMembershipDues,
  membershipDuesProvenanceHolds,
  isMembershipDuesLane,
  isUnpricedPlanVisit,
  isMembershipDuesShapedVisit,
  acquireMembershipDuesMonthLock,
  MEMBERSHIP_DUES_LINE_KEY,
  predictCompletionBilling,
  monthlyDuesCollected,
  findLiveStampedDuesInvoice,
  findCollectedDuesPayment,
  tryAcquireMembershipDuesMonthLock,
  acquireMembershipDuesMonthLockBounded,
  siblingCoverageForSchedule,
  collectionStateForCoveredInvoice,
  siblingInvoiceCoverageVerdict,
  combinedInvoiceVoidedWithoutLiveReplacement,
  perApplicationCompletionVoidHold,
  isSiblingCoverageEligibleVisit,
  sameTripFirstApplicationBreakdown,
  verifyExtendedCompletionAnchor,
  attachedInvoiceAutoChargeLikely,
};
