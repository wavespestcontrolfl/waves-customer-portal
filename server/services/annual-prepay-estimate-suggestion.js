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
// clicks Accept), so eligibility can't be accepted-only. Draft, declined,
// expired, and archived estimates never suggest.
const SUGGESTION_STATUSES = { accepted: 3, viewed: 2, sent: 1 };

function suggestionActivityStamp(estimate = {}) {
  return estimate.accepted_at || estimate.viewed_at || estimate.sent_at || estimate.created_at || 0;
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
      // The expiration sweep isn't the boundary: a still-`sent`/`viewed` row
      // whose expires_at has passed is a stale quote (public helpers reject it
      // the same way). Accepted estimates don't expire.
      && !(String(e.status) !== 'accepted' && e.expires_at
        && new Date(e.expires_at).getTime() < now));
  ranked.sort((a, b) => (
    (new Date(suggestionActivityStamp(b)) - new Date(suggestionActivityStamp(a)))
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

function buildAnnualPrepayEstimateSuggestion(estimates = [], { excludeEstimateIds = [] } = {}) {
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

  const annualTotal = Number(estimate.annual_total || 0);
  const monthlyTotal = Number(estimate.monthly_total || 0);
  const baseAnnual = annualTotal > 0
    ? annualTotal
    : (monthlyTotal > 0 ? Math.round(monthlyTotal * 12 * 100) / 100 : 0);
  if (!(baseAnnual > 0)) return blocked('estimate has no recurring total');

  const { resolveAnnualPrepayInvoiceTotal } = require('./estimate-converter');
  const resolved = resolveAnnualPrepayInvoiceTotal({
    baseAnnual,
    recurringServices: recurring,
    estimateData: estData,
  });
  if (!(resolved.amount > 0)) return blocked('estimate prepay total resolved to zero');

  const line = recurring[0] || {};
  return {
    ...base,
    amount: resolved.amount,
    baseAnnual,
    discount: resolved.discount,
    serviceLabel: String(line.name || line.service || '').trim(),
  };
}

module.exports = {
  buildAnnualPrepayEstimateSuggestion,
  pickAnnualPrepayEstimate,
  shortEstimateRef,
};
