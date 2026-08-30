// Prefill suggestion for the Customer 360 "Record collected annual prepay"
// modal: which of the customer's estimates this prepay most credibly comes
// from, and the exact prepay-year amount that estimate's own accept-as-prepay
// lane would invoice.
//
// Suggestion-only and fail-closed on money: any shape the estimate lanes
// wouldn't price (bundled recurring lines, prepay-ineligible mixes, no
// recurring total) returns the estimate ref with NO amount so the operator
// types the figure — a wrong prefill in a money field is worse than a blank
// one. The amount reuses resolveAnnualPrepayInvoiceTotal so the suggestion
// equals what accepting the estimate as annual prepay would have invoiced
// (non-discountable lines and the lawn program-minimum floor included).

// Cash/verbal accepts leave the estimate at `viewed` (the customer never
// clicks Accept) — that is the shape this prefill exists for. ACCEPTED
// estimates never suggest: their acceptance already ran conversion/billing
// through the estimate lane, so pricing a manual cash record from one risks
// duplicating obligations (that shape belongs to the on-site prepay-switch
// lane and its invoice supersede). Draft, declined, expired, and archived
// estimates never suggest either.
const SUGGESTION_STATUSES = { viewed: 2, sent: 1 };

// Latest of ALL activity timestamps — a resent quote keeps its old viewed_at
// while sent_at refreshes, and ranking by viewed_at first would let an older
// candidate outrank the estimate the operator just re-sent.
function suggestionActivityStamp(estimate = {}) {
  return Math.max(...[estimate.viewed_at, estimate.sent_at, estimate.created_at]
    .map((value) => (value ? new Date(value).getTime() : 0)));
}

// Latest customer activity wins; status ranks only break exact-timestamp
// ties. Recency-primary (not status-primary) because re-quotes happen after
// price changes: an old accepted estimate must not permanently outrank the
// fresh viewed quote the operator just sent. Estimates already consumed by a
// term (source_estimate_id link) are excluded outright — their price belongs
// to a prior year.
function pickAnnualPrepayEstimate(estimates = [], { excludeIds = [] } = {}) {
  const excluded = new Set((excludeIds || []).filter(Boolean).map(String));
  const now = Date.now();
  const ranked = (Array.isArray(estimates) ? estimates : [])
    .filter((e) => e && SUGGESTION_STATUSES[String(e.status)] && !e.archived_at
      && !excluded.has(String(e.id))
      // A locked price is proof money was already committed by a prior
      // accept, whatever the status column says (same rule as the accept
      // claims' whereNull guard).
      && !e.price_locked_at
      // The expiration sweep isn't the boundary: a still-`sent`/`viewed` row
      // whose expires_at has passed is a stale quote (public helpers reject it
      // the same way).
      && !(e.expires_at && new Date(e.expires_at).getTime() < now));
  ranked.sort((a, b) => (
    (suggestionActivityStamp(b) - suggestionActivityStamp(a))
    || (SUGGESTION_STATUSES[String(b.status)] - SUGGESTION_STATUSES[String(a.status)])
  ));
  return ranked[0] || null;
}

// Same display token EstimatesPageV2 renders (last-6 of the UUID, uppercased)
// so the operator can match the hint to the estimates list.
function shortEstimateRef(id) {
  if (!id) return '—';
  return String(id).replace(/[^a-zA-Z0-9]/g, '').slice(-6).toUpperCase();
}

function parseEstimateData(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  return {};
}

async function buildAnnualPrepayEstimateSuggestion(estimates = [], { excludeEstimateIds = [], resolveLineCadence = null, db = null } = {}) {
  const estimate = pickAnnualPrepayEstimate(estimates, { excludeIds: excludeEstimateIds });
  if (!estimate) return null;
  const base = {
    estimateId: estimate.id,
    shortRef: shortEstimateRef(estimate.id),
    status: estimate.status,
  };
  const blocked = (blockReason) => ({ ...base, blocked: true, blockReason });

  // Lazy requires: estimate-public is a route module and estimate-converter is
  // heavy — neither belongs in this module's load graph until a suggestion is
  // actually being built.
  const {
    acceptanceServiceLists,
    annualPrepayEligibleForEstimateData,
    resolveEstimateQuoteRequirement,
  } = require('../routes/estimate-public');

  const estData = parseEstimateData(estimate.estimate_data);

  // Durable call-side quarantine (same gate the manual-acceptance route
  // runs): an engine-drafted estimate whose linked call carries a
  // wrong-identity or rejected-linkage verdict must never drive money.
  // Fail closed when the linkage can't be checked (no connection, read
  // error) — non-engine estimates carry no callLogId and skip this.
  if (estData?.estimatorEngine?.callLogId) {
    if (!db) return blocked('estimate call linkage could not be verified');
    try {
      const { callSideBlockForEstimateData } = require('../utils/estimate-claim-sql');
      const callBlock = await callSideBlockForEstimateData(db, estData);
      if (callBlock) return blocked('estimate is quarantined by a call-linkage correction');
    } catch {
      return blocked('estimate call linkage could not be verified');
    }
  }

  // The canonical one-step prepay guard (same one the prepay-on-book flow
  // runs): status window, expiry, manager approval, commercial risk review,
  // bill-by-invoice and one-time-option modes, recurring-row/mix rules,
  // multi-service unit count — and, critically, BILLABLE ONE-TIME CHARGES:
  // claiming an estimate closed by this cash recording must never silently
  // drop one-time work the quote still owes (that estimate needs its own
  // accept flow, which invoices every line).
  try {
    const { prepayBookingEligibility } = require('./estimate-manual-acceptance');
    const bookingEligibility = await prepayBookingEligibility(estimate);
    if (!bookingEligibility?.eligible) {
      return blocked(`estimate is not one-step prepay eligible (${bookingEligibility?.reason || 'unknown'})`);
    }
  } catch {
    return blocked('estimate prepay eligibility could not be verified');
  }

  // Canonical acceptance blockers the prepay guard doesn't carry: a pending
  // engine reprice means the stored dollars are stale fallbacks, and a
  // persisted bermuda-suppression estimate is only acceptable while its gate
  // is live (acceptance bills stored rows without re-pricing — a
  // save-then-gate-off sequence would charge a disabled add-on).
  try {
    if (require('./estimate-clarify-asks').repricePendingActive(estData?.estimatorEngine)) {
      return blocked('estimate has a pending reprice');
    }
    const { estimateDataCarriesBermudaSuppression } = require('./pricing-engine/v1-legacy-mapper');
    if (estimateDataCarriesBermudaSuppression(estData)
      && !require('../config/feature-gates').gateEnvValue('GATE_BERMUDA_SUPPRESSION')) {
      return blocked('estimate carries a gated add-on');
    }
  } catch {
    return blocked('estimate acceptance blockers could not be verified');
  }

  // An open reservation deposit must be consumed by the estimate's OWN
  // accept flow — closing the quote here would leave paid deposit dollars
  // double-creditable (still refundable/applicable elsewhere). Fail closed
  // whenever the deposit state cannot be checked.
  if (!db) return blocked('estimate deposit state could not be verified');
  try {
    const openDeposit = await db('estimate_deposits')
      .where({ estimate_id: estimate.id })
      .where(function openStates() {
        this.whereIn('status', ['pending', 'received', 'refunding'])
          .orWhereRaw('credited_amount + refunded_amount < amount');
      })
      .first('id');
    if (openDeposit) return blocked('estimate has an open reservation deposit');
  } catch {
    return blocked('estimate deposit state could not be verified');
  }

  // Review-lane pricing never auto-applies (estimator-authority rule): the
  // same quote-requirement guard the public accept path enforces — manager
  // approval, commercial proposal/risk review, low-confidence site quote,
  // retired-cadence and lapsed-membership requotes — blocks the prefill.
  const quoteRequirement = resolveEstimateQuoteRequirement(null, estData);
  if (quoteRequirement?.quoteRequired) return blocked('estimate needs a manual quote');

  const { recurringSvcList } = acceptanceServiceLists(estData);
  const recurring = Array.isArray(recurringSvcList) ? recurringSvcList : [];
  if (recurring.length === 0) return blocked('estimate has no recurring services');
  // An annual_prepay_terms row covers ONE service; a bundle's whole-plan
  // prepay total can't map onto a single term, so bundles get the ref only.
  if (recurring.length > 1) return blocked('estimate bundles multiple recurring services');
  if (!annualPrepayEligibleForEstimateData(estData)) return blocked('estimate is not annual-prepay eligible');

  // The stored annual_total/monthly_total reflect the DEFAULT option; the
  // accept path invoices the selected cadence/tier. When the estimate offers
  // more than one distinct annual price (a cadence ladder or service-cadence
  // combos), a verbal accept may have chosen a non-default option — fail
  // closed to the ref with no amount. A single priced option is authoritative
  // and overrides a stale stored total. Bundle failures also fail closed:
  // an unverifiable option set must never prefill money.
  let optionAnnuals = [];
  let singleOptionKey = null;
  let singleOptionMonthly = null;
  try {
    const { buildPricingBundle } = require('../routes/estimate-public');
    const bundle = await buildPricingBundle(estimate);
    // The finalized bundle's own state is authoritative over the raw estData
    // checks above: finalizePricingBundle can mark an otherwise-eligible mix
    // quote-required or prepay-ineligible (no sellable incentive, tier
    // restrictions) — honor it before deriving any money.
    if (bundle?.quoteRequired === true) return blocked('estimate needs a manual quote');
    if (bundle?.annualPrepayEligible === false) return blocked('estimate is not annual-prepay eligible');
    if ((bundle?.serviceCadenceCombos || []).length > 0) {
      return blocked('estimate offers multiple pricing combinations');
    }
    // Ambiguity is counted in selectable ROWS, not distinct prices: two
    // cadence/tier rows with the same annual are still two different
    // schedules. Exactly one selectable option or no amount.
    const selectableRows = [
      ...(Array.isArray(bundle?.frequencies) ? bundle.frequencies : []),
      ...(Array.isArray(bundle?.hiddenLawnFrequencies) ? bundle.hiddenLawnFrequencies : []),
    ];
    if (selectableRows.length !== 1) {
      return blocked(selectableRows.length === 0
        ? 'estimate has no selectable pricing option'
        : 'estimate offers multiple pricing options');
    }
    const [optionRow] = selectableRows;
    // Per-option eligibility (e.g. the mosquito ladder's seasonal tier): the
    // single option must itself allow prepay.
    if (optionRow?.annualPrepayEligible === false) {
      return blocked('estimate is not annual-prepay eligible');
    }
    singleOptionKey = optionRow?.key || null;
    singleOptionMonthly = Number(optionRow?.monthly) || null;
    // A priced row's annual is the authoritative figure the accept path
    // would invoice for it; an UNPRICED row (legacy/engine-draft shapes)
    // still identifies the schedule, and the estimate's stored totals — the
    // numbers the customer was quoted — price it below.
    const optionAnnualCents = Math.round((Number(optionRow?.annual)
      || (Number(optionRow?.monthly) || 0) * 12) * 100);
    optionAnnuals = optionAnnualCents > 0 ? [optionAnnualCents] : [];
  } catch {
    return blocked('estimate pricing options could not be verified');
  }

  const annualTotal = Number(estimate.annual_total || 0);
  const monthlyTotal = Number(estimate.monthly_total || 0);
  let baseAnnual = optionAnnuals.length === 1
    ? optionAnnuals[0] / 100
    : (annualTotal > 0
      ? annualTotal
      : (monthlyTotal > 0 ? Math.round(monthlyTotal * 12 * 100) / 100 : 0));
  if (!(baseAnnual > 0)) return blocked('estimate has no recurring total');

  // Cents anchoring (same rule AND same guards the accept path applies at
  // estimate-public.js:9482-9487): a candidate annual that is exactly
  // round(monthly) × 12 is a recompute of the DISPLAY monthly, not the
  // engine's true annual — quarterly $392/yr shows $32.67/mo, and
  // 32.67 × 12 = 392.04. Anchor ONLY when the option's monthly equals the
  // engine's default monthly — a non-default cadence/tier's annual is its own
  // quoted figure and must not inherit the default option's residue. An
  // annual that already differs from monthly × 12 is the engine figure —
  // leave it.
  const monthlyForAnchor = singleOptionMonthly || monthlyTotal;
  const anchorRoot = estData?.result && typeof estData.result === 'object' ? estData.result : estData;
  const engineDefaultMonthly = [
    anchorRoot?.totals?.year2mo,
    anchorRoot?.recurring?.grandTotal,
    anchorRoot?.recurring?.monthlyTotal,
  ].map(Number).find((n) => Number.isFinite(n) && n > 0) || null;
  if (monthlyForAnchor > 0
    && engineDefaultMonthly === monthlyForAnchor
    && Math.round(monthlyForAnchor * 12 * 100) / 100 === Math.round(baseAnnual * 100) / 100) {
    const { anchoredAnnualTotal } = require('../routes/estimate-public');
    const anchored = anchoredAnnualTotal(estData, monthlyForAnchor);
    if (anchored > 0) baseAnnual = anchored;
  }

  const { resolveAnnualPrepayInvoiceTotal } = require('./estimate-converter');
  const resolved = resolveAnnualPrepayInvoiceTotal({
    baseAnnual,
    recurringServices: recurring,
    estimateData: estData,
  });
  if (!(resolved.amount > 0)) return blocked('estimate prepay total resolved to zero');

  const line = recurring[0] || {};

  // The quoted annual is only valid for the quoted schedule. Cadence comes
  // from the bundle's single priced option key first (what accept would
  // invoice), else the caller's line-cadence reader (admin-customers'
  // cadenceFromEstimateLine — the full shared frequency vocabulary). Both
  // normalize through prepayCoverageCadenceForPattern, which rejects
  // unsupported schedules (seasonal mosquito, nth-weekday) — no supported
  // cadence, no amount.
  const { prepayCoverageCadenceForPattern, visitsPerYearForCadence } = require('./prepay-cadence');
  const lineCadence = typeof resolveLineCadence === 'function' ? resolveLineCadence(line, null) : null;
  const coverageCadence = prepayCoverageCadenceForPattern(singleOptionKey)
    || prepayCoverageCadenceForPattern(lineCadence);
  const coverageVisitCount = visitsPerYearForCadence(coverageCadence);
  if (!coverageCadence || !coverageVisitCount) {
    return blocked('estimate cadence is not prepay-supported');
  }

  return {
    ...base,
    amount: resolved.amount,
    baseAnnual,
    discount: resolved.discount,
    serviceLabel: String(line.name || line.service || '').trim(),
    coverageCadence,
    coverageVisitCount,
  };
}

module.exports = {
  buildAnnualPrepayEstimateSuggestion,
  pickAnnualPrepayEstimate,
  shortEstimateRef,
};
