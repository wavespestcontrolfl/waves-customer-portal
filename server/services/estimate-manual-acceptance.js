const db = require('../models/db');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');
const EstimateConverter = require('./estimate-converter');
const { selectedTermiteAnnualPlanRows } = require('./estimate-termite-program-rows');
const AcceptEffects = require('./estimate-accept-effects');
const { markLinkedLeadEstimateAccepted } = require('./lead-estimate-link');
const { normalizeProposal } = require('./estimate-proposal');
const proposalWin = require('./proposal-win');
const {
  estimateDataHasUnresolvedManagerApproval,
  commercialRiskTypeReviewNeeded,
} = require('./estimate-delivery-options');
const { customerPreservesMonthlyMembership } = require('./billing-cadence');

// A grouped fixed bid's token may stay viewable past its own date (the
// delivered entry link outlives the group's longest hold), so acceptance —
// public and manual alike — enforces the property's OWN fixed deadline
// independently of expires_at (pre-push codex P1 on #4309). SQL twin of
// proposalExpiry: the full Eastern calendar day of validThrough.
const { proposalExpiry, FIXED_BID_VALIDITY_ABSENT_SQL } = require('./proposal-bid');
const FIXED_BID_STILL_VALID_SQL = `(${FIXED_BID_VALIDITY_ABSENT_SQL} OR (((estimate_data->'proposal'->>'validThrough')::date + 1)::timestamp AT TIME ZONE 'America/New_York') > NOW())`;
const MANUAL_ACCEPT_ACTIVE_SQL = `(expires_at IS NULL OR expires_at >= NOW()) AND ${FIXED_BID_STILL_VALID_SQL}`;
const fixedBidDeadlinePassed = (estimate, now = new Date()) => { const at = proposalExpiry(estimate); return Boolean(at && at < now); };

const MANUAL_ACCEPTABLE_STATUSES = new Set(['sent', 'viewed']);

function asMoneyOrNull(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeManualBillingTerm(value) {
  return value === 'prepay_annual' ? 'prepay_annual' : 'standard';
}

function resolveAnnualPrepayAmount(estimate = {}) {
  const annual = asMoneyOrNull(estimate.annual_total);
  if (annual) return Math.round(annual * 100) / 100;
  const monthly = asMoneyOrNull(estimate.monthly_total);
  return monthly ? Math.round(monthly * 12 * 100) / 100 : null;
}

function parseEstimateData(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' ? value : {};
}

// Frozen at estimate save/reprice time (estimate-membership-context.js,
// computeMembershipContext) from the customer's live qualifying recurring
// rows — true whenever the linked customer already has ANY active service
// (monthly_membership OR per_application billing alike), independent of the
// NEW estimate's own service mix. Shared by prepayBookingEligibility and
// markEstimateManuallyAccepted so an add-on estimate can't be prepaid.
function estimateDataMembershipSnapshotIsExistingCustomer(estimate = {}) {
  const data = parseEstimateData(estimate.estimate_data || estimate.estimateData);
  return !!(data.membershipSnapshot && data.membershipSnapshot.isExistingCustomer);
}

// STRICT live-plan evidence (codex round-2 P1): customerPreservesMonthlyMembership
// deliberately answers false for every explicit NON-monthly lane (billing-
// cadence.js) — including per_application, the exact lane an on-site rodent
// switch or a standard per-visit accept leaves a customer on. A per_application
// customer with a live recurring series therefore sailed past the
// membership-only guard whenever the estimate had no membershipSnapshot (or a
// stale false one from before the plan activated): the add-on prepay term
// still gets created, and on payment stampAnnualPrepayBillingMode flips the
// WHOLE account to annual_prepay regardless of what lane it silently killed.
// This checks the one thing that actually matters here — does the customer
// have ANY live recurring plan row, in ANY billing lane — not billing_mode
// classification. Excludes rows sourced from THIS estimate (a normal accept
// links source_estimate_id at booking) — BUT the prepay-on-book flow books
// its own appointment(s) BEFORE calling accept with source_estimate_id left
// NULL (admin-schedule.js only links them after acceptance succeeds), so
// that exclusion alone does not catch them; a brand-new customer's own
// just-booked appointment would otherwise read back as "an existing live
// plan" (codex round-2 P1). excludeRowIds — the accept's own
// bookedAppointmentIds — excludes those specific rows by id instead.
async function customerHasLiveRecurringPlan(database, customerId, excludeEstimateId = null, excludeRowIds = []) {
  if (!customerId) return false;
  const { TERMINAL_STATUSES } = require('./waveguard-existing-services');
  let query = database('scheduled_services')
    .where({ customer_id: customerId, is_recurring: true })
    .whereNotIn('status', TERMINAL_STATUSES)
    .where((builder) => {
      builder.whereNull('source_estimate_id');
      if (excludeEstimateId) builder.orWhereNot('source_estimate_id', excludeEstimateId);
    });
  if (Array.isArray(excludeRowIds) && excludeRowIds.length > 0) {
    query = query.whereNotIn('id', excludeRowIds);
  }
  const row = await query.first('id');
  return !!row;
}

function hasManualAnnualPrepayRecurringRows(estimate = {}) {
  const data = parseEstimateData(estimate.estimate_data || estimate.estimateData);
  const explicitRecurringLists = [
    data.recurring?.services,
    data.result?.recurring?.services,
    data.result?.results?.recurring?.services,
  ];
  if (explicitRecurringLists.some((list) => Array.isArray(list) && list.length > 0)) {
    return true;
  }
  if (Array.isArray(data.services)
    && data.services.some((svc) => svc?.recurring || svc?.frequency)) {
    return true;
  }
  // Engine-backed estimates (quote wizard / IB drafts) persist recurring rows
  // only under estimate_data.engineResult.lineItems — the converter accepts
  // them (via the same engine-aware extractor), so the prepay gates must not
  // reject them on the legacy shapes above.
  try {
    const { acceptanceServiceLists } = require('../routes/estimate-public');
    return (acceptanceServiceLists(data).recurringSvcList || []).length > 0;
  } catch {
    return false;
  }
}

function isManualAnnualPrepayEligibleServiceMix(estimate = {}) {
  const data = parseEstimateData(estimate.estimate_data || estimate.estimateData);
  const {
    acceptanceServiceLists,
    isAnnualPrepayEligibleServiceMix,
  } = require('../routes/estimate-public');
  const { recurringSvcList, oneTimeList } = acceptanceServiceLists(data);
  return isAnnualPrepayEligibleServiceMix(recurringSvcList, oneTimeList);
}

function isCommercialProposalEstimate(estimate = {}) {
  return parseEstimateData(estimate.estimate_data || estimate.estimateData)?.proposal?.enabled === true;
}

// The amount actually INVOICED when this estimate is accepted as annual prepay:
// the undiscounted recurring annual run through the converter's shared resolver,
// which applies the prepay discount (non-membership-fee mixes) and the
// non-discountable floor — PLUS, for commercial recurring quotes, the same
// blended commercial sales tax the converter passes to InvoiceService.create
// (the customer is marked property_type='commercial' on accept, so the minted
// invoice is tax-inclusive). Same resolvers the accept path uses, so a
// Schedule-modal preview matches the invoice the booking mints (no
// pre-discount-vs-invoice and no pre-tax-vs-invoice drift). Null when there's
// no recurring annual.
async function annualPrepayInvoiceTotalForEstimate(estimate = {}) {
  const baseAnnual = resolveAnnualPrepayAmount(estimate);
  if (!baseAnnual) return null;
  const data = parseEstimateData(estimate.estimate_data || estimate.estimateData);
  const { acceptanceServiceLists } = require('../routes/estimate-public');
  const { recurringSvcList } = acceptanceServiceLists(data);
  const resolved = EstimateConverter.resolveAnnualPrepayInvoiceTotal({
    baseAnnual,
    recurringServices: recurringSvcList,
    estimateData: data,
  });
  if (resolved?.amount == null) return null;
  // The frozen bait-station setup rides the prepay invoice as its own
  // (taxed) line — the operator preview must equal the minted invoice
  // (codex #3591 r24 P1).
  const frozenSetupForPreview = Number(EstimateConverter.frozenRodentBaitSetupAmount(data)) || 0;
  const amount = Math.round((Number(resolved.amount) + frozenSetupForPreview) * 100) / 100;
  // Same commercial detection as the converter (recurringServiceKey prefix) —
  // non-commercial prepay stays residential-exempt, so no tax leg at all.
  const hasCommercialRecurring = (recurringSvcList || []).some(
    (svc) => String(EstimateConverter.recurringServiceKey(svc) || '').startsWith('commercial_')
  );
  let total = amount;
  if (hasCommercialRecurring) {
    // Effective (exemption/county-aware) base rate for this customer, blended
    // by the taxable pest share of the plan — mirrors the converter's
    // prepayTaxRate. Fails soft to the FL default inside the resolver, like
    // the accept path. Tax dollars round to cents exactly as InvoiceService
    // does (rate * after-discount subtotal), so preview == minted total.
    const baseRate = await EstimateConverter.resolveCommercialPrepayBaseRate(
      estimate.customer_id || estimate.customerId || null, {}
    );
    const taxRate = EstimateConverter.resolveCommercialPrepayTaxRate(recurringSvcList, {
      prepayDiscountApplied: Number(resolved.discount) > 0,
      baseRate,
      // The taxable setup joins BOTH sides of the converter's blend
      // (estimate-converter prepayTaxRate, r55 P1) — omitting it here taxed
      // the setup at only the recurring blended rate for a commercial mix of
      // taxable bait + non-taxable lawn/tree, so the minted invoice exceeded
      // this preview (codex #3591 r62 P1).
      taxableOneTimeAmount: frozenSetupForPreview,
    });
    const taxDollars = Math.round(amount * taxRate * 100) / 100;
    total = Math.round((amount + taxDollars) * 100) / 100;
  }
  // Deposit credit: convertEstimate applies any pending estimate deposit to
  // the minted invoice (InvoiceService caps it against the after-tax total),
  // so the operator-facing preview nets it out the same way. Fail-SOFT to the
  // gross total on a read error — this is display copy; the accept path
  // re-reads the ledger fail-CLOSED inside its transaction.
  let depositCredit = 0;
  if (estimate.id) {
    try {
      const { pendingDepositCredit } = require('./estimate-deposits');
      const credit = await pendingDepositCredit(estimate.id);
      depositCredit = credit ? Math.max(0, Number(credit.amount) || 0) : 0;
    } catch { depositCredit = 0; }
  }
  return Math.round(Math.max(0, total - depositCredit) * 100) / 100;
}

// True when the quote carries a one-time charge (listed or residual) that a
// prepay_annual accept would silently drop: the converter mints ONLY the
// recurring annual prepay invoice, and manual/one-step accepts run with
// skipAutoSchedule, so a billable one-time line ends up neither scheduled nor
// invoiced while the whole estimate is marked accepted — sold work dropped.
// isNonBillableOneTimeRow (NOT isBillableOneTimeInvoiceItem) is the predicate:
// a POSITIVE one_time_adjustment row is a real residual charge and must block,
// while discounts/inspections and the WaveGuard setup prepay waives don't.
// Fail-closed throughout: a positive one-time total whose rows can't be parsed
// (or don't account for it) is not proven non-billable (money). Shared by the
// booking/modal preflight (prepayBookingEligibility) AND the accept
// transaction itself, so a quote edit racing the preflight — or a caller that
// never preflights — can't slip a billable one-time line through.
function isRodentBaitSetupRow(row = {}) {
  return String(row?.service || '').toLowerCase() === 'rodent_bait_setup'
    || /bait station setup/i.test(String(row?.name || row?.label || ''));
}

function isTermiteAnnualSetupRow(row = {}, { requireKind = true } = {}) {
  return String(row?.service || '').toLowerCase() === 'termite_bait_installation'
    && (!requireKind || String(row?.kind || '').toLowerCase() === 'setup');
}

function manualPrepayBlockingOneTimeCharge(estimate = {}) {
  const data = parseEstimateData(estimate.estimate_data || estimate.estimateData);
  try {
    const {
      acceptanceServiceLists,
      isNonBillableOneTimeRow,
      normalizeOneTimeBreakdown,
    } = require('../routes/estimate-public');
    // The rodent bait-station setup is INVOICED by the annual-prepay
    // converter (its own line on the prepay invoice — codex #3591 r4/r24),
    // so it is never a dropped charge; only a genuinely uninvoiced one-time
    // line blocks the manual lane.
    // The termite annual plan's own Station Setup is invoiced the same way
    // (codex #4819 r7 P1): a sign-before-pay accept parks, and activation
    // bills the setup row selectedTermiteAnnualPlanRows returns on the
    // plan's single invoice. Exempt only when this IS such an accept AND
    // that selection carries the setup — the exact row the converter bills.
    // Resolved lazily — only a quote that carries such a row ever asks.
    let termiteAnnualSetupInvoiced;
    const termiteAnnualSetupExempt = (row) => {
      if (!isTermiteAnnualSetupRow(row, { requireKind: false })) return false;
      if (termiteAnnualSetupInvoiced === undefined) {
        termiteAnnualSetupInvoiced = EstimateConverter
          .isTermiteAnnualSignBeforePayAccept(estimate, data, 'prepay_annual')
          && selectedTermiteAnnualPlanRows(data).some((r) => isTermiteAnnualSetupRow(r));
      }
      return termiteAnnualSetupInvoiced;
    };
    const blocksPrepay = (row) => !isNonBillableOneTimeRow(row) && !isRodentBaitSetupRow(row)
      && !termiteAnnualSetupExempt(row);
    const oneTimeRows = acceptanceServiceLists(data).oneTimeList || [];
    if (oneTimeRows.some(blocksPrepay)) return true;
    // The raw-rows list masks the residual: when ANY raw one-time row exists,
    // acceptanceServiceLists never consults normalizeOneTimeBreakdown, which
    // is what synthesizes the positive one_time_adjustment for
    // oneTime.total − rows. A nonbillable raw row plus a positive residual
    // would pass the check above — re-check the normalized breakdown too.
    const normalizedRows = normalizeOneTimeBreakdown(data)?.items || [];
    if (normalizedRows.some(blocksPrepay)) return true;
    // normalizeOneTimeBreakdown reads only WRAPPED shapes (result /
    // engineResult); for legacy top-level estData.oneTime it returns NO items,
    // so the synthetic residual row the check above depends on never exists —
    // while acceptanceServiceLists DOES surface the raw top-level rows, whose
    // nonzero length also skips the no-rows total guard below. Recompute the
    // residual for the unwrapped shape: an explicit one-time total the
    // parseable raw rows (plus the prepay-waived membership fee, which the
    // wrapped path accounts for via its synthesized waveguard_setup row) don't
    // fully cover is an unproven billable charge.
    const wrapped = (data?.result && typeof data.result === 'object')
      || (data?.engineResult && typeof data.engineResult === 'object');
    if (!wrapped && oneTimeRows.length) {
      const oneTime = data?.oneTime && typeof data.oneTime === 'object' ? data.oneTime : {};
      const nestedOneTime = data?.results?.oneTime && typeof data.results.oneTime === 'object'
        ? data.results.oneTime
        : {};
      const explicitTotal = [oneTime.total, nestedOneTime.total, estimate.onetime_total]
        .map((value) => Number(value))
        .find((value) => Number.isFinite(value));
      if (Number.isFinite(explicitTotal)) {
        let accounted = 0;
        for (const row of oneTimeRows) {
          const amount = Number(row?.priceAfterDiscount ?? row?.totalAfterDiscount
            ?? row?.price ?? row?.amount ?? row?.total);
          if (!Number.isFinite(amount)) return true;
          accounted += amount;
        }
        const membershipFee = Number(oneTime.membershipFee ?? nestedOneTime.membershipFee);
        if (Number.isFinite(membershipFee) && membershipFee > 0) accounted += membershipFee;
        if (explicitTotal - accounted > 0.01) return true;
      }
    }
    if (!oneTimeRows.length && !normalizedRows.length && asMoneyOrNull(estimate.onetime_total)) return true;
    return false;
  } catch {
    return true;
  }
}

// Can this estimate be accepted as annual prepay WHILE booking (the Schedule
// modal's one-step prepay), and may the modal offer it? Mirrors every guard
// markEstimateManuallyAccepted enforces for billingTerm='prepay_annual' — so
// the modal never offers what the server would reject — PLUS the converter's
// single-recurring-unit rule (one coverage_service_type per term; the shared
// annualPrepayRecurringUnitCount also counts a supplemental companion a solo
// primary absorbs, mirroring the converter's multi-service 422).
// Returns { eligible, invoiceTotal, reason }. Async because the eligible-path
// invoiceTotal resolves the customer's effective commercial tax rate.
// prospectiveCustomerId (codex round-2 P2): the prepay-on-book flow calls
// this BEFORE the estimate is attached to the selected customer — an
// unowned quote (customer_id NULL, matched only by captured contact) would
// otherwise skip the live-customer check entirely here while admin-schedule
// still books the appointment and links the estimate to that customer right
// after, so a rejection at markEstimateManuallyAccepted (which DOES see the
// now-linked customer_id) leaves a booked-but-unlinked appointment. Ignored
// once estimate.customer_id is set (that value always wins).
async function prepayBookingEligibility(estimate = {}, database = db, prospectiveCustomerId = null) {
  const ineligible = (reason) => ({ eligible: false, invoiceTotal: null, reason });
  const baseAnnual = resolveAnnualPrepayAmount(estimate);
  if (!baseAnnual) return ineligible('no_recurring_annual');
  if (isCommercialProposalEstimate(estimate)) return ineligible('commercial_proposal');
  if (estimate.bill_by_invoice) return ineligible('invoice_mode');
  if (estimate.show_one_time_option) return ineligible('one_time_option');
  // Existing customers are pay-per-application (or already on their own
  // monthly membership) only — never annual prepay for an add-on quote. The
  // public accept refuses this exact shape (estimate-public.js: "annual
  // prepay is not available for existing customers"); mirrored here so none
  // of the three admin lanes (Estimates page, Pipeline, prepay-on-book) ever
  // OFFERS what markEstimateManuallyAccepted's own guard below would reject.
  // Without this, an add-on prepay preserves the existing plan's billing_mode
  // at accept but the term's payment-time stamp still rewrites it to
  // 'annual_prepay', silently killing the other plan's dues for the term.
  if (estimateDataMembershipSnapshotIsExistingCustomer(estimate)) return ineligible('existing_customer');
  // Same LIVE-row predicate markEstimateManuallyAccepted's guard checks
  // (codex P2): an older estimate has no frozen membershipSnapshot at all,
  // or the customer became a member AFTER the snapshot froze — either way
  // the snapshot check above says nothing, this preflight said "eligible",
  // and the schedule-modal one-step flow then BOOKED the appointment before
  // the accept guard (which reads the live row) rejected it — leaving a
  // booked-but-unlinked appointment behind. Read-only preflight, so a lookup
  // failure here just falls through to the ordinary eligibility checks below
  // rather than blocking the whole preview on a transient DB error.
  const liveCheckCustomerId = estimate.customer_id || prospectiveCustomerId || null;
  if (liveCheckCustomerId) {
    // Two INDEPENDENT lookups, each fault-isolated: a failure in one must
    // never mask an already-successful positive read from the other — a
    // definitive "yes" from either short-circuits immediately, before the
    // other lookup even runs.
    let preservesMembership = false;
    try {
      const linkedCustomer = await database('customers').where({ id: liveCheckCustomerId }).first();
      preservesMembership = !!(linkedCustomer && customerPreservesMonthlyMembership(linkedCustomer));
    } catch (e) {
      logger.warn(`[estimate-manual-acceptance] prepayBookingEligibility: live-customer membership lookup failed for estimate ${estimate.id}: ${e.message}`);
    }
    if (preservesMembership) return ineligible('existing_customer');
    // STRICT live-plan evidence (codex round-2 P1), not only the monthly-
    // preservation predicate — see customerHasLiveRecurringPlan.
    let hasLivePlan = false;
    try {
      hasLivePlan = await customerHasLiveRecurringPlan(database, liveCheckCustomerId, estimate.id || null);
    } catch (e) {
      // FAIL CLOSED (codex round-3 P2): reached only when the membership
      // check above did NOT already resolve the shape (preservesMembership
      // was false, or itself failed) — a transient read error here used to
      // fall through as hasLivePlan=false — reporting "eligible" while the
      // customer might genuinely have a live plan. The schedule-modal
      // one-step flow then books the appointment on that false "eligible"
      // and the accept guard (which retries the same lookup) rejects it,
      // leaving a booked-but-unlinked appointment — the exact failure mode
      // this whole preflight exists to prevent. Unknown is treated as a
      // blocker, not a pass: the schedule flow downgrades to a standard
      // accept before booking instead of committing on unverifiable data.
      logger.warn(`[estimate-manual-acceptance] prepayBookingEligibility: live-plan-row lookup failed for estimate ${estimate.id}: ${e.message}`);
      return ineligible('live_plan_unknown');
    }
    if (hasLivePlan) return ineligible('existing_customer');
  }
  // Mirror the accept transaction's own blockers (status window, expiry,
  // manager approval, commercial risk-type review): the schedule POST books
  // the visit BEFORE calling markEstimateManuallyAccepted, so anything the
  // accept would reject must make the one-step option ineligible up front —
  // fail closed pre-booking, not a booked visit whose promised prepay accept
  // then errors. The customer-link guard is deliberately NOT mirrored: the
  // route attaches lead quotes to the customer on book, before accepting.
  if (!MANUAL_ACCEPTABLE_STATUSES.has(estimate.status)) return ineligible('status_not_acceptable');
  if (estimate.expires_at && new Date(estimate.expires_at) < new Date()) return ineligible('expired');
  if (fixedBidDeadlinePassed(estimate)) return ineligible('expired');
  if (estimateDataHasUnresolvedManagerApproval(estimate.estimate_data || estimate.estimateData)) return ineligible('manager_approval_pending');
  if (commercialRiskTypeReviewNeeded(estimate.estimate_data || estimate.estimateData)) return ineligible('commercial_risk_review');
  if (!hasManualAnnualPrepayRecurringRows(estimate)) return ineligible('no_recurring_rows');
  if (!isManualAnnualPrepayEligibleServiceMix(estimate)) return ineligible('ineligible_mix');
  const data = parseEstimateData(estimate.estimate_data || estimate.estimateData);
  if (manualPrepayBlockingOneTimeCharge(estimate)) return ineligible('one_time_items');
  const units = EstimateConverter.annualPrepayRecurringUnitCount(data);
  if (units !== 1) return ineligible(units > 1 ? 'multi_service' : 'no_recurring_rows');
  return { eligible: true, invoiceTotal: await annualPrepayInvoiceTotalForEstimate(estimate), reason: null };
}

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function throwRefusal(refusal) {
  if (refusal) throw Object.assign(httpError(refusal.message, refusal.statusCode), refusal.code ? { code: refusal.code } : {});
}

const refusal = (message, statusCode, code) => (code ? { message, statusCode, code } : { message, statusCode });

// The estimate-row refusals of a manual Mark accepted, as { message,
// statusCode } or null. markEstimateManuallyAccepted throws them at their
// own points in the accept (below); the Intelligence Bar's accept_estimate
// card (services/intelligence-bar/estimate-accept-tools.js) reads the same
// three so the bar refuses with the page's own words before any card.
//
// One-tap purchase drafts are INTERNAL flow state (Codex #3395 r12 P2):
// accepting one here flips it to 'accepted' outside the purchase saga — the
// open ledger row is stranded (confirm rejects, neither cleanup sweep
// reclaims a non-draft/expired row) and the purchase's own accept path is
// the only one carrying its consent artifact.
function oneTapPurchaseRefusal(estimate) {
  return estimate.source === 'one_tap_purchase'
    ? refusal('This is an internal one-tap purchase draft — the customer completes it in the portal.', 400)
    : null;
}

// Checked after the already-accepted return, on the row as first read.
function manualAcceptRowRefusal(estimate, { billingTerm = 'standard' } = {}) {
  if (!MANUAL_ACCEPTABLE_STATUSES.has(estimate.status)) {
    return refusal(`Only sent or viewed estimates can be manually marked accepted. Current status: ${estimate.status}.`, 400);
  }
  if (estimate.expires_at && new Date(estimate.expires_at) < new Date()) {
    return refusal('Estimate is no longer active.', 409);
  }
  if (fixedBidDeadlinePassed(estimate)) {
    return refusal('The bid validity date has passed. Update Valid through in the proposal builder before marking it won.', 409);
  }
  if (estimateDataHasUnresolvedManagerApproval(estimate.estimate_data || estimate.estimateData)) {
    return refusal('Manager approval is required before this estimate can be manually accepted.', 400);
  }
  // Gated add-ons and a recurring accept that would drop a sold area add-on
  // (the same rule the public accept route and the schedule preflight use).
  const addOnRefusal = persistedAddOnRefusal(estimate, { action: 'accepting', billingTerm });
  if (addOnRefusal) return refusal(addOnRefusal.message, 409, addOnRefusal.code);
  if (commercialRiskTypeReviewNeeded(estimate.estimate_data || estimate.estimateData)) {
    return refusal('Set the commercial business type before accepting — it sets the pest/rodent service cadence.', 400);
  }
  return null;
}

// Checked after the accept re-reads estimate_data under its row lock.
function manualAcceptLockedRowRefusal(estimate) {
  // Retired T&S cadence (4x/quarterly, retired 2026-09-24): same gate as
  // the customer PUT /accept (codex P1 r9). Already-accepted estimates
  // returned above, so pre-retirement plans are unaffected.
  {
    const { recurringTreeShrubRowAtRetiredCadence } = require('../routes/estimate-public');
    if (recurringTreeShrubRowAtRetiredCadence(parseEstimateData(estimate.estimate_data || estimate.estimateData))) {
      return refusal('This estimate’s tree & shrub plan uses a retired schedule. Requote it with the 6x or 9x program before accepting.', 409);
    }
  }

  const isCommercialProposal = isCommercialProposalEstimate(estimate);

  // Invoice-mode: a normal estimate's due-immediately invoice is built by
  // EstimateConverter via the customer link, so manual accept still rejects
  // it. A commercial proposal instead builds its own first invoice from the
  // proposal line items below (#1917 invoice-mode win), so it passes here.
  if (estimate.bill_by_invoice && !isCommercialProposal) {
    return refusal('Invoice-mode estimates must be accepted through the customer link so the due-immediately invoice is created correctly.', 400);
  }

  // No linked customer: a normal estimate must be linked first (the converter
  // needs a customer). A commercial proposal win auto-creates and promotes
  // the customer from the proposal/contact details (#1917 lead-win).
  if (!estimate.customer_id && !isCommercialProposal) {
    return refusal('Manual acceptance requires the estimate to be linked to a customer first.', 400);
  }

  if (estimate.show_one_time_option) {
    return refusal('Estimates with a one-time option must be accepted through the customer link so recurring vs one-time is recorded.', 400);
  }
  return null;
}

// The Intelligence Bar accept_estimate card's pins
// (services/intelligence-bar/estimate-accept-tools.js), re-checked under this
// accept's own locks: anything that changed since the operator saw the card
// refuses before a write. The estimate page sends none.
const versionText = (v) => (v == null ? null : (v instanceof Date ? v.toISOString() : String(v)));

function cardChanged() {
  const err = httpError('The estimate, the customer or the bill changed after the card was shown. Nothing was changed.', 409);
  err.code = 'preview_changed';
  return err;
}

// Visits linked to an estimate: the rows the converter's reservation path
// starts from (estimate-converter.js reservation lookup — any status).
function estimateLinkedVisitsQuery(conn, estimateId) {
  return conn('scheduled_services').where({ source_estimate_id: estimateId })
    .whereNotNull('customer_id').whereNull('reservation_expires_at');
}

// The customer billing fields the accept reads and rewrites; the converter
// changes them without moving updated_at, so the card pins them directly.
const CUSTOMER_BILLING_PIN_FIELDS = ['billing_mode', 'per_application_fee', 'waveguard_tier', 'pipeline_stage', 'property_type'];
function customerBillingPin(customer = {}) {
  return CUSTOMER_BILLING_PIN_FIELDS.map((k) => (customer[k] == null ? '' : String(customer[k]))).join('|');
}

// Each pin the card may send, checked by one loop (checkCardPins). A phase
// reads its locked row once: 'estimate' right after the customer-comms lock
// (before the already-accepted return), 'customer' after the call-linkage
// locks, in the annual-prepay guard's property-preferences advisory then
// customer row order. A pin the card did not send is skipped.
const CARD_PIN_READS = {
  estimate: async (trx, { estimateId }) => {
    const row = await trx('estimates').where({ id: estimateId }).forUpdate().first('updated_at', 'status', 'customer_id');
    return row && { row };
  },
  customer: async (trx, { estimate }) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', ['property-preferences', String(estimate.customer_id)]);
    const customer = await trx('customers').where({ id: estimate.customer_id }).forUpdate()
      .first('updated_at', 'monthly_rate', ...CUSTOMER_BILLING_PIN_FIELDS);
    return customer && { customer };
  },
};

const CARD_PIN_CHECKS = [
  {
    phase: 'estimate',
    key: 'estimateVersion',
    holds: ({ row, expected }) => versionText(row.updated_at) === expected.estimateVersion
      && row.status === expected.estimateStatus && String(row.customer_id || '') === String(expected.customerId || ''),
  },
  { phase: 'customer', key: 'customerVersion', holds: ({ customer, expected }) => versionText(customer.updated_at) === expected.customerVersion },
  { phase: 'customer', key: 'customerBilling', holds: ({ customer, expected }) => customerBillingPin(customer) === expected.customerBilling },
  {
    phase: 'customer',
    key: 'ledgerPin',
    holds: async ({ trx, customer, estimate, expected }) => {
      const { loadComponents } = require('./plan-rate-ledger');
      const { ledgerPin } = require('./intelligence-bar/rate-change');
      return ledgerPin(await loadComponents(trx, estimate.customer_id), customer.monthly_rate) === expected.ledgerPin;
    },
  },
  // The add-on classifier's evidence (the customer's other live plan rows).
  {
    phase: 'customer',
    key: 'planRows',
    holds: async ({ trx, estimate, expected }) => (await EstimateConverter.otherPlanRowsPin(trx, {
      customerId: estimate.customer_id, estimateId: estimate.id,
    })) === expected.planRows,
  },
  {
    phase: 'customer',
    key: 'lawnProfile',
    holds: async ({ trx, estimate, expected }) => (await lawnProfilePin(trx, estimate.customer_id)) === expected.lawnProfile,
  },
  // Still no visit linked to the estimate (the reservation path the card cannot show).
  { phase: 'customer', key: 'noLinkedVisits', holds: async ({ trx, estimate }) => !(await estimateLinkedVisitsQuery(trx, estimate.id).first('id')) },
];

// The lawn profile values the accept's lawn writes read (customer_turf_profiles
// grass type and lawn size, the primary property's size), as one string.
// Exported for the Intelligence Bar card, which pins it.
async function lawnProfilePin(conn, customerId) {
  const turf = await conn('customer_turf_profiles').where({ customer_id: customerId }).first('grass_type', 'lawn_sqft');
  const primary = await conn('customer_properties').where({ customer_id: customerId, is_primary: true, active: true }).first('id', 'property_sqft');
  return [turf?.grass_type, turf?.lawn_sqft, primary?.id, primary?.property_sqft].map((v) => (v == null ? '' : String(v))).join('|');
}

async function checkCardPins(trx, phase, ctx) {
  const { expected } = ctx;
  const checks = expected
    ? CARD_PIN_CHECKS.filter((c) => c.phase === phase && expected[c.key] != null && expected[c.key] !== false)
    : [];
  if (!checks.length) return;
  const read = await CARD_PIN_READS[phase](trx, ctx);
  if (!read) throw cardChanged();
  for (const check of checks) {
    if (!(await check.holds({ trx, ...ctx, ...read }))) throw cardChanged();
  }
}

async function logManualAcceptance(database, {
  estimate,
  updatedEstimate,
  adminUserId,
  source,
  billingTerm,
}) {
  try {
    await database('activity_log').insert({
      admin_user_id: adminUserId || null,
      customer_id: updatedEstimate.customer_id || null,
      estimate_id: updatedEstimate.id,
      action: 'estimate_manual_accept',
      description: `Estimate manually marked accepted (${source || 'verbal_yes'}).`,
      metadata: JSON.stringify({
        source: source || 'verbal_yes',
        billingTerm: billingTerm || 'standard',
        previousStatus: estimate.status,
        previousAcceptedAt: estimate.accepted_at || null,
      }),
    });
  } catch (err) {
    logger.warn(`[estimate-manual-acceptance] activity_log insert failed for estimate ${updatedEstimate.id}: ${err.message}`);
  }
}

// A sold area add-on is booked and billed only by the one-time accept. Marking
// a RECURRING estimate that carries one as won converts the plan and has no
// step that books the add-on, so it would be dropped while the estimate reads
// accepted (the public accept's AREA_ADDONS_ONE_TIME_ACCEPT_ONLY rule). True
// when this accept would do that; the caller refuses before any write.
const AREA_ADDON_RECURRING_MARK_WON_MESSAGE = 'This estimate carries an area add-on treatment alongside a recurring plan. Marking it won would convert the plan and drop the add-on. Remove the add-on from this estimate and sell it on its own one-time estimate, then mark this one won.';
function recurringAcceptWouldDropAreaAddOns(estimate = {}, billingTerm = 'standard') {
  const estimateData = parseEstimateData(estimate.estimate_data || estimate.estimateData);
  if (!require('./pricing-engine/v1-legacy-mapper').estimateDataCarriesAreaAddOns(estimateData, { pricingAuthority: estimate.pricing_authority })) return false;
  return !EstimateConverter.shouldSuppressRecurringConversion({
    billingTerm,
    monthlyRate: parseFloat(estimate.monthly_total || 0),
    annualTotal: estimate.annual_total,
    oneTimeTotal: estimate.onetime_total,
    recurringServices: [],
    estimateData,
  });
}

// Why a stored estimate cannot be accepted, or booked from, because of the add-ons it carries:
// a gated add-on whose gate is off, or (checkRecurring) an area add-on a recurring accept would
// drop. { code, message } or null. The one rule for Mark Won and the schedule's booking preflight.
function persistedAddOnRefusal(estimate = {}, { action, billingTerm = 'standard', checkRecurring = true } = {}) {
  const mapper = require('./pricing-engine/v1-legacy-mapper');
  const gated = mapper.gatedAddOnStaffRefusal(estimate.estimate_data || estimate.estimateData, action, { pricingAuthority: estimate.pricing_authority });
  if (gated) return gated;
  return checkRecurring && recurringAcceptWouldDropAreaAddOns(estimate, billingTerm)
    ? { code: mapper.AREA_ADDONS_ONE_TIME_ONLY_CODE, message: AREA_ADDON_RECURRING_MARK_WON_MESSAGE } : null;
}

// The refusals a stored estimate's add-ons give an acceptance, thrown as the 409 the staff see: a gated add-on whose gate
// is off, and a recurring accept that would drop a sold area add-on.
function assertAddOnRefusalsClear(estimate, billingTerm) {
  const addOnRefusal = persistedAddOnRefusal(estimate, { action: 'accepting', billingTerm });
  if (addOnRefusal) throw Object.assign(httpError(addOnRefusal.message, 409), { code: addOnRefusal.code });
}

// Every add-on decision of an acceptance, on the estimate row the transaction holds locked: the refusals above, and the
// yearly-limit recheck (an add-on whose limit is now reached, or whose history cannot be read, is not marked won either).
// The visits this call books (the staff booking's own rows) ARE this acceptance: left out of the count, and their day is the
// day judged. Any other booking of the estimate counts. A customer the check finds for itself (an unowned estimate's group
// owner or linked appointment) is fenced like the public accept's, without waiting: the estimate's own customer is already
// locked and so is the estimate row.
async function assertAddOnsAcceptable(trx, estimate, { billingTerm, bookedAppointmentIds }) {
  assertAddOnRefusalsClear(estimate, billingTerm);
  const addOnLimits = require('./area-addon-limits');
  await addOnLimits.assertAreaAddOnLimitsOpen(trx, {
    estimate, staff: true, excludeVisitIds: bookedAppointmentIds, fenceCustomer: (id) => addOnLimits.fenceCustomerBookings(trx, id),
  });
}

// ── The accept, as named steps ────────────────────────────────────────────
//
// markEstimateManuallyAccepted runs these inside ONE transaction, in this
// order. Each step records the effects it has (ctx.effects, estimate-accept-
// effects.js) when the log is on; the log is on for a dry run and for a
// carded accept (expected.effectsKey). Without it the steps behave exactly as
// the estimate page's Mark accepted always did.

const alreadyAcceptedOutcome = (row) => ({ acceptedEstimate: row, alreadyAccepted: true, shouldRunDownstream: false, previousEstimate: row });

// A dry run rolls the transaction back by throwing; anything else returns.
function finishAccept(ctx, outcome) {
  if (ctx.dryRun) throw new AcceptEffects.DryRunRollback({ ...outcome, effects: ctx.effects.list() });
  return outcome;
}

// Rung 6 BEFORE the estimate row lock below (Codex #3109 r32): the merge-undo
// takes customer-comms and THEN locks journaled estimates — acquiring comms
// only later (inside convertEstimate, after the status-flip UPDATE row-locked
// this estimate) was an AB-BA that deadlock-aborted the operator's Mark Won or
// the undo. r44: LOOP the acquire to a fixpoint — the wait can sit behind the
// very undo repointing this estimate; re-read after each acquire until the
// owner is one whose key this transaction already holds, so every later check
// uses the post-undo row.
async function lockCommsOwner(trx, estimateId, estimate) {
  const { lockCustomerComms } = require('../utils/customer-comms-lock');
  const heldOwners = new Set();
  let current = estimate;
  while (current.customer_id && !heldOwners.has(String(current.customer_id))) {
    await lockCustomerComms(trx, current.customer_id);
    heldOwners.add(String(current.customer_id));
    const fresh = await trx('estimates').where({ id: estimateId }).first();
    if (!fresh) throw httpError('Estimate not found', 404);
    current = fresh;
  }
  return current;
}

// Step 1: the estimate, read and locked in the right order. One-tap purchase
// drafts are INTERNAL flow state (Codex #3395 r12 P2): accepting one here
// flips it to 'accepted' outside the purchase saga.
async function loadLockedEstimate(trx, ctx) {
  const { estimateId, expected } = ctx;
  const first = await trx('estimates').where({ id: estimateId }).first();
  if (!first) throw httpError('Estimate not found', 404);
  throwRefusal(oneTapPurchaseRefusal(first));
  const estimate = await lockCommsOwner(trx, estimateId, first);
  await checkCardPins(trx, 'estimate', { estimateId, expected });
  return estimate;
}

function lockedEstimateData(row) {
  const raw = row?.estimate_data;
  if (!raw) return null;
  try {
    const d = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return d && typeof d === 'object' ? d : null;
  } catch { return null; }
}

// A clarify re-price hold on the LOCKED row: the dollars or address are known
// stale, so a verbal yes must not mint the money-bearing terminal at them
// either (codex r11 sweep on #3804). An engine draft pulled by a call-linkage
// invalidation (archived or marker-bearing) is quarantined: money must not
// move on it.
async function assertNotQuarantined(trx, freshLinkRow, data) {
  const eng = data?.estimatorEngine;
  const { repricePendingActive } = require('./estimate-clarify-asks');
  if (repricePendingActive(eng)) {
    throw httpError('This estimate is held for a re-price (a customer clarify reply). Revise it with the answered unit before accepting.', 409);
  }
  if (!eng?.callLogId) return;
  const quarantined = httpError('This estimate is quarantined by a call-linkage correction and cannot be accepted. Rebuild it from the corrected call.', 409);
  if (freshLinkRow?.archived_at || eng.linkage_invalidated_at || eng.invalidation_pending_at) throw quarantined;
  if (data?.lead_id && ['sid', 'stamp'].includes(data?.lead_linkage)) {
    await trx('leads').where({ id: String(data.lead_id) }).forUpdate().first('id');
  }
  const { staleCallLinkageReason } = require('./admin-estimate-persistence');
  // The LOCKED row's status (codex #4815 r8 P2): a queued row-scoped verdict
  // judges a terminal row by it; omitted = fail closed.
  if (await staleCallLinkageReason(trx, data, { lockCallRow: true, estimateStatus: freshLinkRow?.status })) throw quarantined;
  const { callSideBlockForEstimateData } = require('../utils/estimate-claim-sql');
  if (await callSideBlockForEstimateData(trx, data, { estimateStatus: freshLinkRow?.status })) throw quarantined;
}

// Step 2: SERIALIZED with call-linkage corrections, mirroring the public
// accept protocol (pre-push P0, PR #3304). One lock order everywhere:
// estimates → leads → call_log. The estimate row is locked FOR UPDATE and
// re-read fresh; the locked row is propagated back onto `estimate` (codex P1)
// so every check below reads it. Every add-on decision of this acceptance
// reads the LOCKED row.
async function revalidateLockedRow(trx, ctx, estimate) {
  const freshLinkRow = await trx('estimates').where({ id: ctx.estimateId }).forUpdate().first();
  const locked = freshLinkRow ? { ...estimate, ...freshLinkRow } : estimate;
  await assertAddOnsAcceptable(trx, locked, { billingTerm: ctx.billingTerm, bookedAppointmentIds: ctx.bookedAppointmentIds });
  await assertNotQuarantined(trx, freshLinkRow, lockedEstimateData(freshLinkRow));
  return locked;
}

// An add-on estimate for a customer who already has a live plan must not open
// an annual-prepay term (the public accept refuses it too): convertEstimate
// PRESERVES the existing plan's billing_mode, but the pending term suppresses
// the monthly dues cron and the term's payment-time stamp rewrites
// billing_mode to 'annual_prepay' — silently killing the OTHER plan's
// billing. Checked three ways: the frozen membershipSnapshot, the LIVE row
// via customerPreservesMonthlyMembership, and strict live-plan evidence
// (codex round-2 P1: that predicate answers false for every explicit
// non-monthly lane).
async function assertNoExistingPlanForPrepay(trx, ctx, estimate) {
  let livePreservesMembership = false;
  let hasLivePlan = false;
  if (estimate.customer_id) {
    // LOCKED, not a bare read (codex pre-push P0): same order convertEstimate
    // itself uses ahead of its customer lock (property-preferences advisory
    // BEFORE the row lock — codex #3565 gh-r39). Re-acquisition later on this
    // transaction is a no-op.
    await trx.raw(
      'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
      ['property-preferences', String(estimate.customer_id)],
    );
    const linkedCustomer = await trx('customers').where({ id: estimate.customer_id }).forUpdate().first();
    livePreservesMembership = !!(linkedCustomer && customerPreservesMonthlyMembership(linkedCustomer));
    hasLivePlan = await customerHasLiveRecurringPlan(trx, estimate.customer_id, estimate.id || null, ctx.bookedAppointmentIds);
  }
  if (estimateDataMembershipSnapshotIsExistingCustomer(estimate) || livePreservesMembership || hasLivePlan) {
    throw httpError('Annual prepay is not available for an existing customer’s add-on — accept it as pay-at-visit (or per-application) so the customer’s existing plan keeps billing.', 400);
  }
}

// Step 3: what an annual-prepay request needs. Returns the prepay amount, or
// null for a standard accept. A commercial proposal's pricing lives in
// estimate_data.proposal, which EstimateConverter does not read, so prepay
// would silently produce nothing there (#1917).
async function assertAnnualPrepayAllowed(trx, ctx, estimate, isCommercialProposal) {
  if (!ctx.annualPrepaySelected) return null;
  if (isCommercialProposal) {
    throw httpError(
      'Annual prepay is not available for a commercial proposal. Mark it accepted as a standard win and bill it through the proposal invoice flow.',
      400,
    );
  }
  const amount = resolveAnnualPrepayAmount(estimate);
  if (!amount) throw httpError('Annual prepay requires a recurring estimate with a monthly or annual total.', 400);
  if (!hasManualAnnualPrepayRecurringRows(estimate)) throw httpError('Annual prepay requires recurring service rows on the estimate.', 400);
  if (!isManualAnnualPrepayEligibleServiceMix(estimate)) throw httpError('Annual prepay is not available for this estimate service mix.', 400);
  await assertNoExistingPlanForPrepay(trx, ctx, estimate);
  return amount;
}

// The status flip. Served-disclosure evidence rides a manual (verbal)
// acceptance too (codex local max-effort review on #5434). Price is frozen
// atomically with the flip.
function acceptedRowUpdates(trx, estimate) {
  const now = trx.fn.now();
  const promoteRateReviewEvidence = require('./estimate-proposal-billing').rateReviewTermsServedIsCurrent(estimate.estimate_data);
  const updates = {
    status: 'accepted',
    accepted_at: estimate.accepted_at || now,
    declined_at: null,
    decline_reason: null,
    updated_at: now,
    price_locked_at: now,
    price_locked_by: 'manual_accept',
    pricing_authority: 'LOCKED',
    // Durable at-lock evidence for the pricing-authority gate (#3750).
    estimate_data: trx.raw(promoteRateReviewEvidence
      ? "jsonb_set(jsonb_set(COALESCE(estimate_data, '{}'::jsonb), '{pricingAuthorityAtLock}', to_jsonb(UPPER(COALESCE(pricing_authority, 'NULL')))), '{rateReviewDisclosedAtAccept}', 'true'::jsonb)"
      : "jsonb_set(COALESCE(estimate_data, '{}'::jsonb), '{pricingAuthorityAtLock}', to_jsonb(UPPER(COALESCE(pricing_authority, 'NULL'))))"),
  };
  if (!estimate.sent_at) updates.sent_at = now;
  return updates;
}

// Step 4: claim the row. The whereNull(price_locked_at) guard means a claimed
// row is always unlocked and stops a second accept from re-pricing; the
// marker/archive predicates refuse outright if any invalidation state is on
// the row (pre-push P0, PR #3304). Returns { updatedEstimate } for the winner,
// or { outcome } when the estimate was already accepted.
async function claimEstimateRow(trx, ctx, estimate) {
  const [updatedEstimate] = await trx('estimates')
    .where({ id: ctx.estimateId })
    .whereIn('status', Array.from(MANUAL_ACCEPTABLE_STATUSES))
    .whereNull('price_locked_at')
    .whereRaw(MANUAL_ACCEPT_ACTIVE_SQL)
    .where(function engineDraftNotQuarantined() {
      this.whereRaw("COALESCE(estimate_data #>> '{estimatorEngine,callLogId}', '') = ''")
        .orWhere(function notQuarantined() {
          this.whereNull('archived_at')
            .whereRaw("COALESCE(estimate_data->'estimatorEngine'->>'linkage_invalidated_at', '') = ''")
            .whereRaw("COALESCE(estimate_data->'estimatorEngine'->>'invalidation_pending_at', '') = ''");
        });
    })
    .update(acceptedRowUpdates(trx, estimate))
    .returning('*');
  if (updatedEstimate) {
    ctx.effects.add({ kind: 'estimate', action: 'mark_accepted', from_status: estimate.status, locks_price: true });
    return { updatedEstimate };
  }
  const latest = await trx('estimates').where({ id: ctx.estimateId }).first();
  if (latest?.status === 'accepted') return { outcome: alreadyAcceptedOutcome(latest) };
  if (latest?.price_locked_at) {
    throw httpError(
      'This estimate was already accepted and its price locked — accepting it again would duplicate the conversion and invoicing. Review the linked customer/invoices instead.',
      409,
    );
  }
  throw httpError('Estimate is no longer active.', 409);
}

// A commercial proposal's customer: created or linked now (only the flip
// winner reaches here, so a concurrent accept can't orphan a duplicate).
async function attachProposalCustomer(trx, updatedEstimate) {
  if (updatedEstimate.customer_id) {
    // Pre-linked customer: proposals skip EstimateConverter (which normally
    // promotes the linked customer), so promote/reactivate here.
    await proposalWin.promoteLinkedCustomerForProposalWin({ trx, customerId: updatedEstimate.customer_id });
    return null;
  }
  const proposalCustomer = await proposalWin.ensureCustomerForProposalWin({
    trx,
    estimate: updatedEstimate,
    proposal: normalizeProposal(updatedEstimate),
  });
  await trx('estimates')
    .where({ id: updatedEstimate.id })
    .update({ customer_id: proposalCustomer.customerId, updated_at: trx.fn.now() });
  updatedEstimate.customer_id = proposalCustomer.customerId;
  return proposalCustomer;
}

// Invoice-mode win: the first invoice built from the proposal line items.
async function createProposalWinInvoice(trx, updatedEstimate) {
  let proposalInvoice;
  try {
    proposalInvoice = await proposalWin.createProposalAcceptanceInvoice({
      trx,
      estimate: updatedEstimate,
      proposal: normalizeProposal(updatedEstimate),
      customerId: updatedEstimate.customer_id,
    });
  } catch (err) {
    logger.warn(`[estimate-manual-acceptance] proposal invoice failed for estimate ${updatedEstimate.id}: ${err.message}`);
    // Expected validation conflicts (4xx, e.g. the payer-term mismatch 409)
    // carry an actionable operator message (codex #3297 r2e).
    if (Number.isInteger(err?.statusCode) && err.statusCode >= 400 && err.statusCode < 500) {
      throw httpError(err.message, err.statusCode);
    }
    throw httpError('Proposal invoice could not be created; estimate was not marked accepted.', 500);
  }
  // Invoice mode promises a first invoice; with no billable lines the trx
  // rolls back rather than record a win with no invoice.
  if (!proposalInvoice) {
    throw httpError(
      'This invoice-mode proposal has no billable line items to invoice. Add priced lines or turn off invoice mode before winning it.',
      400,
    );
  }
  return proposalInvoice;
}

// Step 5 (commercial proposal): record the win. A proposal's pricing lives in
// estimate_data.proposal.buildings, which EstimateConverter does not read, so
// the proposal records the win (status + linked-lead) and, in invoice mode,
// builds its first invoice from the proposal lines (#1917).
async function winCommercialProposal(trx, updatedEstimate) {
  const proposalCustomer = await attachProposalCustomer(trx, updatedEstimate);
  // Flag the customer commercial for a TAXABLE proposal even when no first
  // invoice is built now. Idempotent.
  await proposalWin.flagProposalCustomerCommercialIfTaxable({
    trx,
    customerId: updatedEstimate.customer_id,
    proposal: normalizeProposal(updatedEstimate),
  });
  // A NON-invoice-mode win with authored structured payment terms has no path
  // that consumes them (codex #3297 r4).
  if (!updatedEstimate.bill_by_invoice && normalizeProposal(updatedEstimate).commercialTerms?.paymentTerms) {
    throw httpError(
      'This proposal promises structured payment terms, which only invoice-mode billing enforces. Turn on Bill by invoice, or move the payment language to Additional terms, then mark won again.',
      409,
    );
  }
  const proposalInvoice = updatedEstimate.bill_by_invoice ? await createProposalWinInvoice(trx, updatedEstimate) : null;
  return { proposalCustomer, proposalInvoice };
}

// What the bar card's pins ask of the conversion itself. With "no linked
// visit" pinned, the converter's own reservation read refuses a row linked
// since (booking.js links outside this accept's locks). A carded accept (the
// dry run or an `expected`) also fails closed when the add-on classifier
// cannot read its evidence, and hands the converter the effect log to fill.
function cardConvertOptions(ctx) {
  const { expected, dryRun } = ctx;
  if (!dryRun && !expected) return {};
  return {
    strictAddOnClassification: true,
    ...(dryRun || expected.noLinkedVisits === true ? { refuseLinkedVisits: true } : {}),
    ...(ctx.effects.enabled ? { effectLog: ctx.convertLog } : {}),
  };
}

// ATOMIC overlap guard: the SAME per-customer advisory lock the Customer 360
// prepay endpoints use, re-asserted INSIDE this transaction so a double-click,
// two admins, or an accept racing a Customer 360 prepay can't mint duplicate
// prepay invoices/terms.
async function applyAnnualPrepayOptions(trx, ctx, updatedEstimate, annualPrepayAmount, convertOptions) {
  const { annualPrepayTermStart, annualPrepayCoverage } = ctx;
  // Re-run the one-time guard on the row THIS transaction claimed: an edit
  // landing after the booking preflight must not drop a billable one-time
  // charge the prepay invoice would not carry.
  if (manualPrepayBlockingOneTimeCharge(updatedEstimate)) {
    const oneTimeErr = httpError(
      'This quote includes a billable one-time charge that an annual-prepay accept would not invoice. Remove the one-time line or convert the estimate normally first.',
      422,
    );
    oneTimeErr.isOperational = true;
    throw oneTimeErr;
  }
  convertOptions.billingTerm = 'prepay_annual';
  convertOptions.prepayInvoiceAmount = annualPrepayAmount;
  convertOptions.autoSendInvoice = false;
  if (annualPrepayTermStart) convertOptions.annualPrepayTermStart = annualPrepayTermStart;
  if (annualPrepayCoverage && annualPrepayCoverage.coverageServiceType) {
    // Fail CLOSED on a coverage cadence the renewal/stamping math doesn't
    // support: callers pass a pre-normalized value; this guards future callers.
    if (annualPrepayCoverage.coverageCadence != null) {
      const { normalizeCoverageCadence } = require('./annual-prepay-renewals')._private;
      if (!normalizeCoverageCadence(annualPrepayCoverage.coverageCadence)) {
        // isOperational: the conversion catch passes operational 422s through verbatim.
        const cadenceErr = httpError(`Unsupported annual-prepay coverage cadence: ${annualPrepayCoverage.coverageCadence}`, 422);
        cadenceErr.isOperational = true;
        throw cadenceErr;
      }
    }
    convertOptions.coverageServiceType = annualPrepayCoverage.coverageServiceType;
    convertOptions.coverageVisitCount = annualPrepayCoverage.coverageVisitCount;
    convertOptions.coverageCadence = annualPrepayCoverage.coverageCadence;
  }
  const { lockAndAssertNoAnnualPrepayOverlap } = require('../routes/admin-customers')._private;
  await lockAndAssertNoAnnualPrepayOverlap(
    trx,
    updatedEstimate.customer_id,
    annualPrepayTermStart || etDateString(),
    false,
    'Customer already has an annual prepay term through',
    updatedEstimate.id,
  );
}

// Manual Mark Won keeps scheduling under operator control. Standard verbal
// wins also skip the setup invoice; annual-prepay verbal wins create the
// annual draft invoice + pending term. The Mark Won / Annual Prepay confirm
// dialogs promise the customer is NOT texted (and, for annual prepay, NOT
// emailed), so welcome SMS and the membership email are skipped here and run
// post-commit from the plan. The commercial-schedule admin notification
// writes through the GLOBAL pool — deferred so a rolled-back Mark Won can't
// page staff about an unaccepted estimate.
async function runConversion(trx, ctx, updatedEstimate, annualPrepayAmount) {
  const convertOptions = {
    database: trx,
    skipAutoSchedule: true,
    bookedAppointmentIds: ctx.bookedAppointmentIds,
    skipMembershipEmail: true,
    skipWelcomeSms: true,
    skipSetupInvoice: !ctx.annualPrepaySelected,
    deferCommercialScheduleNotification: true,
    ...cardConvertOptions(ctx),
  };
  if (ctx.annualPrepaySelected) await applyAnnualPrepayOptions(trx, ctx, updatedEstimate, annualPrepayAmount, convertOptions);
  const conversion = await ctx.estimateConverter.convertEstimate(updatedEstimate.id, convertOptions);
  // Sign-before-pay (slice 3a): a termite annual-plan manual accept
  // intentionally defers its invoice + prepay term until the customer e-signs,
  // so a missing draftInvoiceId is EXPECTED then. ANY truthy
  // annualPlanActivationStatus is a park outcome (fallback P1).
  if (ctx.annualPrepaySelected && !conversion?.draftInvoiceId && !conversion?.annualPlanActivationStatus) {
    throw new Error('Annual prepay invoice was not created');
  }
  return conversion;
}

// The conversion's failure as the error the caller sees. Every operational
// 4xx keeps its status and code (GH codex P1 on #3751); the atomic overlap
// guard keeps its tag so the booking route can degrade to a standard booking;
// anything else is a generic 500. The trx rolls back either way.
function conversionFailure(err, updatedEstimate) {
  logger.warn(`[estimate-manual-acceptance] EstimateConverter failed for estimate ${updatedEstimate.id}: ${err.message}`);
  if (err && err.isOperational && Number(err.statusCode) >= 400 && Number(err.statusCode) < 500) {
    const operational = httpError(err.message, Number(err.statusCode));
    if (err.code) operational.code = err.code;
    return operational;
  }
  if (err && err.annualPrepayOverlap) {
    const overlapErr = httpError(err.message, 409);
    overlapErr.annualPrepayOverlap = err.annualPrepayOverlap;
    return overlapErr;
  }
  return httpError('Customer conversion did not complete; estimate was not marked accepted.', 500);
}

// Step 5 (everything else): the converter, for a recurring monthly total or an
// annual prepay.
async function convertAcceptedEstimate(trx, ctx, updatedEstimate, annualPrepayAmount) {
  if (!(asMoneyOrNull(updatedEstimate.monthly_total) || ctx.annualPrepaySelected)) return null;
  try {
    return await runConversion(trx, ctx, updatedEstimate, annualPrepayAmount);
  } catch (err) {
    throw conversionFailure(err, updatedEstimate);
  }
}

// Step 6: commercial identity for a manual one-time win (codex #3594 r3 P1).
// The converter's one-way stamp runs only for a monthly total or annual
// prepay, so a one-time-only scoped commercial estimate marked won would
// leave a residential-coded customer residential. Same one-way rule, same
// transaction; idempotent beside the converter's stamp.
async function stampCommercialOneTime(trx, updatedEstimate) {
  if (!updatedEstimate.customer_id
    || !EstimateConverter.estimateHasCommercialOneTime(parseEstimateData(updatedEstimate.estimate_data))) return;
  await trx('customers')
    .where({ id: updatedEstimate.customer_id })
    .whereRaw("coalesce(property_type, '') <> 'commercial'")
    .update({ property_type: 'commercial' });
}

// ── Effects: recorded in the transaction, compared under the locks ──

// The customer rows the conversion writes, before it runs (log on only).
async function captureStateBefore(trx, ctx, updatedEstimate) {
  if (!ctx.effects.enabled || !updatedEstimate.customer_id) return null;
  return AcceptEffects.snapshotAcceptState(trx, updatedEstimate.customer_id);
}

// What the conversion and the follow-on stamps changed, read back through the
// same transaction, plus what the converter itself reported (the add-on
// classification it used and whether the ledger split the bill).
async function recordConversionEffects(trx, ctx, updatedEstimate, before, conversion) {
  if (!before) return;
  for (const entry of ctx.convertLog) ctx.effects.add(entry);
  const after = await AcceptEffects.snapshotAcceptState(trx, updatedEstimate.customer_id);
  for (const effect of AcceptEffects.stateDiffEffects(before, after)) ctx.effects.add(effect);
  if (conversion) ctx.effects.add(AcceptEffects.conversionEffect(conversion));
}

// The post-commit plan, evaluated on the committed-state inputs (the accepted
// row, the conversion, the recipient facts read here). The real run executes
// this same plan.
async function planPostCommitSteps(trx, ctx, outcome) {
  const { acceptedEstimate, conversion, proposalCustomer } = outcome;
  const collecting = ctx.effects.enabled;
  const emailInputs = collecting && conversion?.membershipEmail && acceptedEstimate.customer_id && ctx.billingTerm !== 'prepay_annual'
    ? await AcceptEffects.readEmailInputs(trx, acceptedEstimate.customer_id)
    : null;
  let termiteProgram = null;
  if (collecting) {
    try {
      termiteProgram = require('./termite-program-agreement').collectTermiteFacts(parseEstimateData(acceptedEstimate.estimate_data))?.hasProgram === true;
    } catch { termiteProgram = null; }
  }
  return AcceptEffects.planPostCommit({
    billingTerm: ctx.billingTerm, acceptedEstimate, conversion, proposalCustomer, emailInputs, termiteProgram,
  });
}

// The end of the transaction: list the one-time lines and the post-commit
// plan; a carded accept compares its whole list with the approved one (the
// card's pinned effects) and refuses as preview_changed when they differ.
async function settleEffects(trx, ctx, outcome, isCommercialProposal) {
  const plan = await planPostCommitSteps(trx, ctx, outcome);
  if (ctx.effects.enabled) {
    if (!isCommercialProposal) for (const line of AcceptEffects.oneTimeLineEffects(outcome.acceptedEstimate, ctx.estimateConverter)) ctx.effects.add(line);
    ctx.effects.add({ kind: 'post_commit', plan });
    if (ctx.expected?.effectsKey && AcceptEffects.effectsFingerprint(ctx.effects.list()) !== ctx.expected.effectsKey) throw cardChanged();
  }
  return { ...outcome, postCommitPlan: plan };
}

// The accept's transaction: the steps in order.
async function acceptInTransaction(trx, ctx) {
  const row = await loadLockedEstimate(trx, ctx);
  if (row.status === 'accepted') return finishAccept(ctx, alreadyAcceptedOutcome(row));
  throwRefusal(manualAcceptRowRefusal(row, { billingTerm: ctx.billingTerm }));
  const estimate = await revalidateLockedRow(trx, ctx, row);
  throwRefusal(manualAcceptLockedRowRefusal(estimate));
  await checkCardPins(trx, 'customer', { estimate, expected: ctx.expected });

  const isCommercialProposal = isCommercialProposalEstimate(estimate);
  const annualPrepayAmount = await assertAnnualPrepayAllowed(trx, ctx, estimate, isCommercialProposal);
  const claimed = await claimEstimateRow(trx, ctx, estimate);
  if (claimed.outcome) return finishAccept(ctx, claimed.outcome);
  const { updatedEstimate } = claimed;
  // Race guard: re-derive proposal mode from the CLAIMED row; a toggle that
  // committed between the read and the guarded UPDATE would mis-route the
  // conversion.
  if (isCommercialProposalEstimate(updatedEstimate) !== isCommercialProposal) {
    throw httpError('This estimate changed while it was being accepted. Refresh and try again.', 409);
  }

  let win = { proposalCustomer: null, proposalInvoice: null, conversion: null };
  const before = isCommercialProposal ? null : await captureStateBefore(trx, ctx, updatedEstimate);
  if (isCommercialProposal) win = { ...win, ...(await winCommercialProposal(trx, updatedEstimate)) };
  else win.conversion = await convertAcceptedEstimate(trx, ctx, updatedEstimate, annualPrepayAmount);
  await stampCommercialOneTime(trx, updatedEstimate);
  await recordConversionEffects(trx, ctx, updatedEstimate, before, win.conversion);
  // Audit the win AFTER the customer is created/linked so a newly-created
  // no-customer proposal customer gets the acceptance event in its timeline.
  await logManualAcceptance(trx, {
    estimate, updatedEstimate, adminUserId: ctx.adminUserId, source: ctx.source, billingTerm: ctx.billingTerm,
  });
  const outcome = await settleEffects(trx, ctx, {
    acceptedEstimate: updatedEstimate,
    alreadyAccepted: false,
    shouldRunDownstream: true,
    previousEstimate: estimate,
    ...win,
  }, isCommercialProposal);
  return finishAccept(ctx, outcome);
}

async function runAcceptTransaction(database, ctx) {
  try {
    return await database.transaction((trx) => acceptInTransaction(trx, ctx));
  } catch (err) {
    if (err instanceof AcceptEffects.DryRunRollback) return err.result;
    throw err;
  }
}

// After the commit: run the plan the transaction settled (the same plan the
// dry run listed). The approved email decision rides through delivery.
async function runPostCommitWork(claim, ctx, { leadLinkService, warnings }) {
  const plan = claim.postCommitPlan || AcceptEffects.planPostCommit({
    billingTerm: ctx.billingTerm, acceptedEstimate: claim.acceptedEstimate, conversion: claim.conversion, proposalCustomer: claim.proposalCustomer,
  });
  await AcceptEffects.runPostCommit(plan, {
    acceptedEstimate: claim.acceptedEstimate,
    conversion: claim.conversion,
    proposalCustomer: claim.proposalCustomer,
    billingTerm: ctx.billingTerm,
    agreementStartDate: ctx.agreementStartDate,
    leadLinkService,
    asMoneyOrNull,
    warnings,
    approvedEmail: ctx.expected?.membershipEmail || null,
  });
}

function acceptResponse(claim, billingTerm, warnings) {
  const { proposalInvoice, proposalCustomer } = claim;
  return {
    estimate: claim.acceptedEstimate,
    alreadyAccepted: claim.alreadyAccepted,
    conversion: claim.conversion,
    billingTerm,
    warnings,
    // #1917 proposal win surfaces: the auto-built invoice + whether a new
    // customer was created, so the admin UI can link to them.
    proposalInvoice: proposalInvoice
      ? { id: proposalInvoice.id, invoiceNumber: proposalInvoice.invoice_number, token: proposalInvoice.token, total: proposalInvoice.total }
      : null,
    createdCustomer: proposalCustomer?.created ? { id: proposalCustomer.customerId } : null,
  };
}

async function markEstimateManuallyAccepted({
  estimateId,
  adminUserId,
  source = 'verbal_yes',
  billingTerm = 'standard',
  // Booked first-visit date (YYYY-MM-DD) for an annual-prepay accept made WHILE
  // scheduling — anchors the renewal term to the actual first service instead
  // of today. Ignored for standard accepts and when not supplied.
  annualPrepayTermStart = null,
  // Coverage config for an annual-prepay accept made WHILE scheduling
  // ({ coverageServiceType, coverageVisitCount, coverageCadence }), so the term
  // stamps the operator's just-booked visit series prepaid on payment instead
  // of seeding a duplicate one. coverageServiceType MUST be the booked
  // service_type so the coverage match (serviceMatchesCoverage) finds the
  // booked rows. Ignored for standard accepts and when not supplied.
  annualPrepayCoverage = null,
  // Booked first TERMITE visit date (YYYY-MM-DD) when acceptance happens
  // inside the scheduling flow — the created rows aren't linked to the
  // estimate yet at downstream time, so the program-agreement start date
  // must be handed in rather than looked up. Null = lookup/fallback.
  agreementStartDate = null,
  // Accept-on-book links these same-customer rows after conversion commits.
  bookedAppointmentIds = [],
  // The Intelligence Bar card's pins ({ estimateVersion, estimateStatus,
  // customerId, customerVersion, customerBilling, ledgerPin, planRows,
  // noLinkedVisits, effectsKey, membershipEmail }); null for every other
  // caller. effectsKey is the fingerprint of the approved effect list: the
  // accept builds its own list under the locks and refuses (preview_changed)
  // when it differs. membershipEmail ('send' | 'skip') is the approved email
  // decision and rides through delivery.
  expected,
  // Run every step in the accept's own transaction, collect the effects, roll
  // back and return them. Nothing commits and nothing is sent.
  dryRun = false,
  database = db,
  leadLinkService = { markLinkedLeadEstimateAccepted },
  estimateConverter = EstimateConverter,
} = {}) {
  if (!estimateId) throw httpError('estimateId is required', 400);
  const normalizedBillingTerm = normalizeManualBillingTerm(billingTerm);
  const ctx = {
    estimateId, adminUserId, source, billingTerm: normalizedBillingTerm,
    annualPrepaySelected: normalizedBillingTerm === 'prepay_annual',
    annualPrepayTermStart, annualPrepayCoverage, agreementStartDate, bookedAppointmentIds,
    expected, dryRun: dryRun === true, estimateConverter,
    effects: AcceptEffects.createEffectLog(dryRun === true || !!expected?.effectsKey),
    convertLog: [],
  };

  const claim = await runAcceptTransaction(database, ctx);
  if (ctx.dryRun) return { dryRun: true, alreadyAccepted: claim.alreadyAccepted, billingTerm: normalizedBillingTerm, effects: claim.effects };

  const warnings = [];
  if (claim.shouldRunDownstream) await runPostCommitWork(claim, ctx, { leadLinkService, warnings });
  return acceptResponse(claim, normalizedBillingTerm, warnings);
}

module.exports = { MANUAL_ACCEPT_ACTIVE_SQL,
  MANUAL_ACCEPTABLE_STATUSES,
  markEstimateManuallyAccepted,
  estimateLinkedVisitsQuery,
  customerBillingPin,
  lawnProfilePin,
  oneTapPurchaseRefusal,
  manualAcceptRowRefusal,
  manualAcceptLockedRowRefusal,
  persistedAddOnRefusal,
  recurringAcceptWouldDropAreaAddOns,
  AREA_ADDON_RECURRING_MARK_WON_MESSAGE,
  normalizeManualBillingTerm,
  resolveAnnualPrepayAmount,
  annualPrepayInvoiceTotalForEstimate,
  prepayBookingEligibility,
  hasManualAnnualPrepayRecurringRows,
  isManualAnnualPrepayEligibleServiceMix,
  isCommercialProposalEstimate,
  _private: { manualPrepayBlockingOneTimeCharge },
};
