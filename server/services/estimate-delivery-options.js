const { isCommercialRiskType } = require('./pricing-engine/commercial-risk-type');

function validateEstimateDeliveryOptions({
  showOneTimeOption,
  billByInvoice,
  onetimeTotal,
  monthlyTotal,
  annualTotal,
  estimateData,
}) {
  const oneTimeAmount = Number(onetimeTotal || 0);
  const recurringAmount = Math.max(Number(monthlyTotal || 0), Number(annualTotal || 0));
  if (showOneTimeOption) {
    const nonPestRecurring = nonPestRecurringServicesForOneTimeOption(estimateData);
    if (nonPestRecurring.length > 0) {
      const names = nonPestRecurring.slice(0, 3).join(', ');
      const suffix = nonPestRecurring.length > 3 ? ', and other recurring services' : '';
      return `Offer one-time option is only supported for pest-only recurring estimates. Remove ${names}${suffix} or turn off the one-time choice.`;
    }
    if (estimateData && !hasPestRecurringServiceForOneTimeOption(estimateData)) {
      return 'Offer one-time option requires recurring pest pricing on the estimate.';
    }
    if (estimateData && !hasDerivableOneTimePestChoicePricing(estimateData) && !hasGeneralOneTimePestChoicePricing(estimateData)) {
      return 'Offer one-time option requires recurring pest per-application pricing or a priced one-time pest row on the estimate.';
    }
    if (!estimateData && oneTimeAmount <= 0) {
      return 'Offer one-time option requires a one-time total on the estimate.';
    }
  }
  if (billByInvoice && oneTimeAmount <= 0 && recurringAmount <= 0
    && !hasBillableCommercialProposal(estimateData)) {
    // A commercial proposal carries its pricing in estimate_data.proposal
    // (the top-level totals stay 0), and its first invoice is built from the
    // proposal lines on win (#1917) — so a billable proposal satisfies the
    // "billable total" requirement here.
    return 'Bill by invoice requires a billable recurring or one-time total.';
  }
  return null;
}

// True when the estimate carries an enabled commercial proposal with at least
// one positively-priced line item — the billable basis for invoice-mode even
// though the legacy top-level totals are 0.
function hasBillableCommercialProposal(estimateData) {
  const data = parseEstimateData(estimateData);
  const proposal = data && data.proposal;
  if (!proposal || proposal.enabled !== true || !Array.isArray(proposal.buildings)) return false;
  return proposal.buildings.some((building) =>
    Array.isArray(building?.lineItems) && building.lineItems.some((li) => {
      const qty = Number(li?.quantity ?? 1) || 0;
      const price = Number(li?.unitPrice ?? li?.unit_price ?? li?.price ?? 0) || 0;
      return qty > 0 && price > 0;
    }),
  );
}

function parseEstimateData(estimateData) {
  if (!estimateData) return null;
  if (typeof estimateData === 'string') {
    try {
      return JSON.parse(estimateData);
    } catch {
      return null;
    }
  }
  return typeof estimateData === 'object' ? estimateData : null;
}

function containsQuoteRequirement(value, depth = 0) {
  if (!value || depth > 12) return false;
  if (Array.isArray(value)) {
    return value.some((item) => containsQuoteRequirement(item, depth + 1));
  }
  if (typeof value !== 'object') return false;
  if (value.quoteRequired === true || value.requiresCustomQuote === true) {
    return true;
  }
  return Object.values(value).some((item) => containsQuoteRequirement(item, depth + 1));
}

function estimateDataHasQuoteRequirement(estimateData) {
  return containsQuoteRequirement(parseEstimateData(estimateData));
}

function approvalInputsSatisfied(root = {}) {
  if (hasApprovalInputFields(root?.inputs)) {
    return !!trustedApprovalStateFromInputs(root.inputs);
  }
  return !!trustedApprovalStateFromInputs(root?.result?.inputs);
}

function hasApprovalInputFields(inputs) {
  if (!inputs || typeof inputs !== 'object') return false;
  return [
    'dethatchingManagerApproved',
    'managerApproved',
    'dethatchingManagerApprovalReason',
    'managerApprovalReason',
    'dethatchingManagerApprovalTrusted',
    'managerApprovalTrusted',
  ].some((key) => Object.prototype.hasOwnProperty.call(inputs, key));
}

function trustedApprovalStateFromInputs(inputs) {
  if (!inputs || typeof inputs !== 'object') return null;
  const approved = inputs.dethatchingManagerApproved === true || inputs.managerApproved === true;
  const trusted = inputs.dethatchingManagerApprovalTrusted === true ||
    inputs.managerApprovalTrusted === true;
  const reason = normalizeDethatchingApprovalReason(
    inputs.dethatchingManagerApprovalReason || inputs.managerApprovalReason
  );
  if (!approved || !trusted || reason.length === 0) return null;
  return {
    reason,
    approvedBy: inputs.dethatchingManagerApprovedBy || inputs.managerApprovedBy || null,
    approvedByRole: inputs.dethatchingManagerApprovedByRole || inputs.managerApprovedByRole || null,
    approvedAt: inputs.dethatchingManagerApprovedAt || inputs.managerApprovedAt || null,
  };
}

function looksLikeDethatchingApprovalItem(value = {}) {
  const service = String(value.service || value.key || '').toLowerCase();
  const label = String(value.name || value.label || value.displayName || '').toLowerCase();
  return service.includes('dethatch') ||
    label.includes('dethatch') ||
    value.cleanupLevel !== undefined ||
    value.probeMeasurements !== undefined ||
    value.thatchDepthInches !== undefined;
}

function itemHasStAugustineApprovalReason(value = {}) {
  const reasons = Array.isArray(value.manualReviewReasons) ? value.manualReviewReasons : [];
  const hasManagerReason = isDethatchingManagerApprovalReviewReason(value.managerApprovalReason);
  const hasManualReviewReason = reasons.some((reason) => isDethatchingManagerApprovalReviewReason(reason));
  return hasManagerReason ||
    (hasManualReviewReason && looksLikeDethatchingApprovalItem(value));
}

function itemManagerApprovalSatisfied(value = {}, root = {}) {
  return approvalInputsSatisfied(root);
}

function booleanInputTrue(value) {
  return value === true || value === 'true' || value === 'TRUE' || value === 'YES' || value === 'yes' || value === 1 || value === '1';
}

function booleanInputFalse(value) {
  return value === false || value === 'false' || value === 'FALSE' || value === 'NO' || value === 'no' || value === 0 || value === '0';
}

function normalizeApprovalToken(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function isStAugustineLike(value) {
  const raw = normalizeApprovalToken(value);
  const compact = String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return ['a', 'b', 'st_augustine', 'staugustine', 'staug', 'floratam'].includes(raw) ||
    compact.includes('staugustine') ||
    compact.includes('floratam');
}

function rootInputObjects(root = {}) {
  return [
    root?.inputs,
    root?.result?.inputs,
    root?.engineInputs,
    root?.result?.engineInputs,
  ].filter((item) => item && typeof item === 'object');
}

function inputRequestsDethatching(value) {
  if (booleanInputTrue(value)) return true;
  if (booleanInputFalse(value)) return false;
  if (!value || typeof value !== 'object') return false;

  const explicitState = [
    value.selected,
    value.enabled,
    value.active,
    value.requested,
  ].filter((item) => item !== undefined);
  if (explicitState.some((item) => booleanInputTrue(item))) return true;
  if (explicitState.some((item) => booleanInputFalse(item))) return false;
  return true;
}

function rootRequestsDethatching(root = {}) {
  return rootInputObjects(root).some((inputs) => (
    inputRequestsDethatching(inputs.svcDethatch) ||
    inputRequestsDethatching(inputs.dethatching) ||
    inputRequestsDethatching(inputs.services?.dethatching)
  ));
}

function rootHasStAugustineGrass(root = {}) {
  return rootInputObjects(root).some((inputs) => (
    isStAugustineLike(inputs.grassType) ||
    isStAugustineLike(inputs.track) ||
    isStAugustineLike(inputs.turfTrack) ||
    isStAugustineLike(inputs.grassTrack)
  ));
}

function rootRequiresLegacyStAugustineDethatchingApproval(root = {}) {
  return rootRequestsDethatching(root) && rootHasStAugustineGrass(root) && !approvalInputsSatisfied(root);
}

function containsUnresolvedManagerApproval(value, root, depth = 0) {
  if (!value || depth > 12) return false;
  if (Array.isArray(value)) {
    return value.some((item) => containsUnresolvedManagerApproval(item, root, depth + 1));
  }
  if (typeof value !== 'object') return false;
  const legacyRootRequiresApproval = rootRequiresLegacyStAugustineDethatchingApproval(root);
  const requiresManagerApproval = value.requiresManagerApproval === true ||
    itemHasStAugustineApprovalReason(value) ||
    (legacyRootRequiresApproval && looksLikeDethatchingApprovalItem(value));
  if (requiresManagerApproval && !itemManagerApprovalSatisfied(value, root)) return true;
  return Object.values(value).some((item) => containsUnresolvedManagerApproval(item, root, depth + 1));
}

function estimateDataHasUnresolvedManagerApproval(estimateData) {
  const data = parseEstimateData(estimateData);
  return containsUnresolvedManagerApproval(data, data) ||
    rootRequiresLegacyStAugustineDethatchingApproval(data);
}

// Commercial risk-type (business-type) review gate. The risk type drives the
// commercial pest/rodent cadence, so an estimate that has a commercial pest or
// rodent line must be classified before it can be sent/accepted — a NULL default
// would silently under/over-cadence restaurants/hotels vs offices (owner-locked
// risk-type lane, decision 1). Only cadence-relevant lines gate: a commercial
// lawn/tree/mosquito/termite-only estimate does not need a risk type.
const CADENCE_COMMERCIAL_SERVICES = new Set(['commercial_pest', 'commercial_rodent_bait']);
const RECURRING_PEST_RODENT_SELECTIONS = new Set(['PEST', 'RODENT_BAIT']);

// An engine-PRICED commercial pest/rodent recurring line — the only line whose
// cadence the risk type drives. Detected by a positive `annual` with no
// `quoteRequired`, which holds for BOTH the raw pricer shape AND the legacy
// mapped save shape (v1-legacy-mapper's commAdd drops commercialPricingMode but
// keeps service + annual, and is only emitted for priced recurring lines). A
// manual quote (quoteRequired / null annual) and one-time items (no `annual`) are
// excluded — the quote-required gate handles those.
function containsAutoPricedCadenceLine(value, depth = 0) {
  if (!value || depth > 12) return false;
  if (Array.isArray(value)) return value.some((item) => containsAutoPricedCadenceLine(item, depth + 1));
  if (typeof value !== 'object') return false;
  if (
    typeof value.service === 'string'
    && CADENCE_COMMERCIAL_SERVICES.has(value.service)
    && value.quoteRequired !== true
    && Number(value.annual) > 0
  ) return true;
  return Object.values(value).some((item) => containsAutoPricedCadenceLine(item, depth + 1));
}

// Any materialized commercial pest/rodent line (regardless of pricing mode). When
// one exists, the pricing mode decides the gate (auto → gate; manual → the
// quote-required gate handles it) and the raw selectedServices fallback is NOT
// consulted — a saved manual/one-time estimate still carries selectedServices.
function containsCommercialCadenceServiceLine(value, depth = 0) {
  if (!value || depth > 12) return false;
  if (Array.isArray(value)) return value.some((item) => containsCommercialCadenceServiceLine(item, depth + 1));
  if (typeof value !== 'object') return false;
  if (typeof value.service === 'string' && CADENCE_COMMERCIAL_SERVICES.has(value.service)) return true;
  return Object.values(value).some((item) => containsCommercialCadenceServiceLine(item, depth + 1));
}

// A recurring pest / rodent-bait selection — true for either the uppercase
// selectedServices tokens (admin engineRequest) OR a v1 `services` map that
// selects pest / rodentBait (engineInputs snapshot). A services selection is a
// config object or boolean `true`, NOT a results.pest[] stat array, so this does
// not collide with priced-result stats.
function isServiceSelection(v) {
  return v === true || (!!v && typeof v === 'object' && !Array.isArray(v));
}
function selectsRecurringPestOrRodent(value, depth = 0) {
  if (!value || depth > 12) return false;
  if (Array.isArray(value)) {
    if (value.some((v) => RECURRING_PEST_RODENT_SELECTIONS.has(v))) return true;
    return value.some((item) => selectsRecurringPestOrRodent(item, depth + 1));
  }
  if (typeof value !== 'object') return false;
  if (isServiceSelection(value.pest) || isServiceSelection(value.rodentBait)) return true;
  return Object.values(value).some((item) => selectsRecurringPestOrRodent(item, depth + 1));
}

function isCommercialEstimateData(value, depth = 0) {
  if (!value || depth > 12) return false;
  if (Array.isArray(value)) return value.some((item) => isCommercialEstimateData(item, depth + 1));
  if (typeof value !== 'object') return false;
  if (value.commercialEstimatedPricing === true || value.isCommercial === true) return true;
  if (typeof value.propertyType === 'string' && value.propertyType.toLowerCase() === 'commercial') return true;
  if (typeof value.category === 'string' && value.category.toLowerCase() === 'commercial') return true;
  if (typeof value.commercialSubtype === 'string' && value.commercialSubtype.trim()) return true;
  if (typeof value.service === 'string' && value.service.startsWith('commercial_')) return true;
  return Object.values(value).some((item) => isCommercialEstimateData(item, depth + 1));
}

function firstCommercialRiskType(value, depth = 0) {
  if (!value || depth > 12) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstCommercialRiskType(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  if (typeof value.commercialRiskType === 'string' && value.commercialRiskType.trim()) {
    return value.commercialRiskType.trim();
  }
  for (const item of Object.values(value)) {
    const found = firstCommercialRiskType(item, depth + 1);
    if (found) return found;
  }
  return null;
}

function commercialRiskTypeReviewNeeded(estimateData) {
  const data = parseEstimateData(estimateData);
  if (!data) return false;
  // Authored commercial proposals are hand-priced (the line items ARE the quote);
  // their cadence is not engine-risk-type driven, so they are NEVER risk-type
  // gated — even if a stale riskTypeNeedsReview flag is still on the row (an
  // operator can resolve the flag by authoring the proposal). Checked first.
  if (data.proposal && data.proposal.enabled === true) return false;
  // Explicit flag — the public "Other / skipped" business-type path sets this
  // (Phase 3) so a defaulted-but-unconfirmed bucket still surfaces for review.
  if (data.riskTypeNeedsReview === true) return true;
  // A materialized commercial pest/rodent line decides on its own pricing mode:
  // gate only an AUTO-priced one (a manual quote is handled by the quote-required
  // gate, not this one). Only when NO such line is materialized do we fall back to
  // the raw selectedServices (engineInputs-only rows) so a saved manual estimate
  // that still carries selectedServices is not spuriously gated.
  const cadenceRelevant = containsCommercialCadenceServiceLine(data)
    ? containsAutoPricedCadenceLine(data)
    : (isCommercialEstimateData(data) && selectsRecurringPestOrRodent(data));
  if (!cadenceRelevant) return false;
  return !isCommercialRiskType(firstCommercialRiskType(data));
}

// Low-confidence commercial price RANGE (owner-locked risk-type lane, decision 7).
// A commercial auto-priced recurring line whose driving area is estimated/large
// carries pricingConfidence 'LOW'; it contributes a ±20% band to the customer
// range, while MEDIUM lines stay exact. When the aggregate band is too wide
// (> $300/mo swing) a range is useless — the estimate must be site-confirmed (a
// manual quote). Reads the persisted commercial recurring lines (the
// v1-legacy-mapper commAdd shape: service + annual + pricingConfidence).
const COMMERCIAL_LOW_CONFIDENCE_RANGE_PCT = 0.20;
const COMMERCIAL_LOW_CONFIDENCE_MAX_MONTHLY_SWING = 300;

function commercialLineMonthly(svc) {
  const monthly = Number(svc.monthly ?? svc.mo);
  if (Number.isFinite(monthly) && monthly > 0) return monthly;
  const annual = Number(svc.annual);
  return Number.isFinite(annual) && annual > 0 ? annual / 12 : 0;
}

function commercialLowConfidenceRange(estimateData) {
  const data = parseEstimateData(estimateData);
  const services = Array.isArray(data?.result?.recurring?.services)
    ? data.result.recurring.services
    : (Array.isArray(data?.recurring?.services) ? data.recurring.services : []);
  let lowMonthly = 0;
  let highMonthly = 0;
  let hasLowConfidence = false;
  for (const svc of services) {
    if (!svc || typeof svc !== 'object') continue;
    if (typeof svc.service !== 'string' || !svc.service.startsWith('commercial_')) continue;
    if (svc.quoteRequired === true) continue; // manual lines handled by the quote gate
    const monthly = commercialLineMonthly(svc);
    if (monthly <= 0) continue;
    if (String(svc.pricingConfidence || '').toUpperCase() === 'LOW') {
      hasLowConfidence = true;
      lowMonthly += monthly * (1 - COMMERCIAL_LOW_CONFIDENCE_RANGE_PCT);
      highMonthly += monthly * (1 + COMMERCIAL_LOW_CONFIDENCE_RANGE_PCT);
    } else {
      lowMonthly += monthly;
      highMonthly += monthly;
    }
  }
  if (!hasLowConfidence) return { hasLowConfidence: false };
  const round = (n) => Math.round(n * 100) / 100;
  const rangeLowMonthly = round(lowMonthly);
  const rangeHighMonthly = round(highMonthly);
  const monthlySwing = round(rangeHighMonthly - rangeLowMonthly);
  return {
    hasLowConfidence: true,
    rangeLowMonthly,
    rangeHighMonthly,
    monthlySwing,
    forceSiteQuote: monthlySwing > COMMERCIAL_LOW_CONFIDENCE_MAX_MONTHLY_SWING,
  };
}

function commercialLowConfidenceRequiresSiteQuote(estimateData) {
  return commercialLowConfidenceRange(estimateData).forceSiteQuote === true;
}

function cloneEstimateData(data) {
  if (!data || typeof data !== 'object') return data;
  return JSON.parse(JSON.stringify(data));
}

const DETHATCHING_MANAGER_APPROVAL_REVIEW_REASONS = new Set([
  'st_augustine_dethatching',
  'st_augustine_dethatching_manager_approval_required',
  'st_augustine_dethatching_manager_approval_reason_missing',
]);

function isDethatchingManagerApprovalReviewReason(value) {
  return DETHATCHING_MANAGER_APPROVAL_REVIEW_REASONS.has(normalizeApprovalToken(value));
}

const DETHATCHING_MANAGER_APPROVAL_REASONS = new Set([
  'verified_thatch_probe',
  'customer_requested_after_warning',
  'bermuda_or_zoysia_confirmed',
  'manager_override',
]);

function normalizeDethatchingApprovalReason(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return DETHATCHING_MANAGER_APPROVAL_REASONS.has(normalized) ? normalized : '';
}

function normalizeMoneyValue(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function uniqueStringList(values = []) {
  const list = Array.isArray(values) ? values : [values];
  return [...new Set(list.filter(Boolean).map((value) => String(value)))];
}

function normalizeDethatchingApprovalDerivedFields(value, {
  trustedApproval,
  reason,
} = {}) {
  const estimatedPrice = normalizeMoneyValue(value.estimatedPrice)
    ?? normalizeMoneyValue(value.baseEstimatePrice)
    ?? normalizeMoneyValue(value.price);
  if (estimatedPrice !== null) {
    value.estimatedPrice = estimatedPrice;
    value.baseEstimatePrice = value.baseEstimatePrice ?? estimatedPrice;
  }

  const reviewReasons = uniqueStringList(value.manualReviewReasons)
    .filter((item) => !isDethatchingManagerApprovalReviewReason(item));
  if (!trustedApproval) {
    reviewReasons.push('st_augustine_dethatching_manager_approval_required');
  }
  if (trustedApproval && estimatedPrice === null) {
    reviewReasons.push('dethatching_price_not_recorded');
  }
  value.manualReviewReasons = uniqueStringList(reviewReasons);

  const quoteRequired = value.manualReviewReasons.length > 0;
  value.requiresManualReview = quoteRequired;
  value.quoteRequired = quoteRequired;
  value.requiresCustomQuote = quoteRequired;
  value.autoQuoteRequiresAdminApproval = quoteRequired;
  value.price = quoteRequired ? null : (estimatedPrice !== null ? estimatedPrice : value.price);

  if (quoteRequired) {
    const approvalReason = !trustedApproval
      ? 'Manager approval is required before St. Augustine / Floratam dethatching can be quoted.'
      : null;
    const reviewReason = value.manualReviewReasons.length > 0
      ? `Dethatching requires admin review: ${value.manualReviewReasons.join(', ')}.`
      : null;
    value.customQuoteReason = approvalReason || reviewReason;
    value.reason = value.customQuoteReason;
  } else {
    value.customQuoteReason = null;
    value.reason = null;
  }

  if (trustedApproval && reason) {
    value.managerApprovalOverrideReason = reason;
  }
}

function containsChildQuoteRequirement(value, depth = 0) {
  if (!value || depth > 12) return false;
  if (Array.isArray(value)) {
    return value.some((item) => containsQuoteRequirement(item, depth + 1));
  }
  if (typeof value !== 'object') return false;
  return Object.values(value).some((item) => containsQuoteRequirement(item, depth + 1));
}

function reconcileAggregateQuoteState(value, depth = 0) {
  if (!value || depth > 12) return;
  if (Array.isArray(value)) {
    value.forEach((item) => reconcileAggregateQuoteState(item, depth + 1));
    return;
  }
  if (typeof value !== 'object') return;

  Object.values(value).forEach((item) => reconcileAggregateQuoteState(item, depth + 1));

  if (Array.isArray(value.quoteRequiredItems)) {
    value.quoteRequiredItems = value.quoteRequiredItems.filter((item) => containsQuoteRequirement(item));
  }

  const isAggregateQuoteContainer = Array.isArray(value.quoteRequiredItems) ||
    value.oneTime !== undefined ||
    value.recurring !== undefined ||
    value.results !== undefined ||
    value.pricingMetadata !== undefined;
  if (!isAggregateQuoteContainer) return;

  const hasQuoteRequirement = containsChildQuoteRequirement({
    quoteRequiredItems: value.quoteRequiredItems || [],
    oneTime: value.oneTime,
    recurring: value.recurring,
    specItems: value.specItems,
    lineItems: value.lineItems,
    items: value.items,
  });
  if (!hasQuoteRequirement) {
    if (Object.prototype.hasOwnProperty.call(value, 'quoteRequired')) value.quoteRequired = false;
    if (Object.prototype.hasOwnProperty.call(value, 'requiresCustomQuote')) value.requiresCustomQuote = false;
    if (Object.prototype.hasOwnProperty.call(value, 'autoQuoteRequiresAdminApproval')) value.autoQuoteRequiresAdminApproval = false;
    if (Object.prototype.hasOwnProperty.call(value, 'quoteRequiredReason')) value.quoteRequiredReason = null;
    if (Object.prototype.hasOwnProperty.call(value, 'customQuoteReason')) value.customQuoteReason = null;
    if (Object.prototype.hasOwnProperty.call(value, 'reason')) value.reason = null;
  }
}

function normalizeEstimateDethatchingManagerApproval(estimateData, {
  technician,
  technicianId,
  now = () => new Date(),
} = {}) {
  const parsed = parseEstimateData(estimateData);
  if (!parsed || typeof parsed !== 'object') return estimateData;

  const data = cloneEstimateData(parsed);
  const inputs = data.inputs && typeof data.inputs === 'object'
    ? data.inputs
    : (data.inputs = {});
  const requestedApproved = inputs.dethatchingManagerApproved === true || inputs.managerApproved === true;
  const requestedReason = normalizeDethatchingApprovalReason(
    inputs.dethatchingManagerApprovalReason || inputs.managerApprovalReason
  );
  const isAdmin = String(technician?.role || '').toLowerCase() === 'admin';
  const hasTopLevelApprovalFields = hasApprovalInputFields(inputs);
  const topLevelTrustedApproval = isAdmin ? trustedApprovalStateFromInputs(inputs) : null;
  const reusableTopLevelApproval = topLevelTrustedApproval && (
    topLevelTrustedApproval.approvedBy ||
    topLevelTrustedApproval.approvedByRole ||
    topLevelTrustedApproval.approvedAt
  )
    ? topLevelTrustedApproval
    : null;
  const requestedTrustedApproval = !reusableTopLevelApproval &&
    requestedApproved && requestedReason.length > 0 && isAdmin
    ? {
      reason: requestedReason,
      approvedBy: technicianId || technician?.id || null,
      approvedByRole: technician?.role || 'admin',
      approvedAt: now().toISOString(),
    }
    : null;
  const existingTrustedApproval = isAdmin
    ? (!hasTopLevelApprovalFields ? trustedApprovalStateFromInputs(data.result?.inputs) : null)
    : null;
  const approval = reusableTopLevelApproval || requestedTrustedApproval || existingTrustedApproval;
  const trustedApproval = !!approval;
  const reason = approval?.reason || requestedReason;

  function applyApprovalToEngineInputs(engineInputs) {
    if (!engineInputs || typeof engineInputs !== 'object') return;
    engineInputs.dethatchingManagerApprovalTrusted = trustedApproval;
    engineInputs.dethatchingManagerApproved = trustedApproval;
    engineInputs.dethatchingManagerApprovalReason = trustedApproval ? reason : '';
    delete engineInputs.managerApproved;
    delete engineInputs.managerApprovalReason;

    const selected = inputRequestsDethatching(engineInputs.services?.dethatching);
    if (!selected) return;
    if (!engineInputs.services || typeof engineInputs.services !== 'object') {
      engineInputs.services = {};
    }
    if (!engineInputs.services.dethatching || typeof engineInputs.services.dethatching !== 'object') {
      engineInputs.services.dethatching = { selected: true };
    }
    engineInputs.services.dethatching.managerApproved = trustedApproval;
    engineInputs.services.dethatching.managerApprovalReason = trustedApproval ? reason : '';
  }

  inputs.dethatchingManagerApprovalTrusted = trustedApproval;
  inputs.dethatchingManagerApproved = trustedApproval;
  inputs.dethatchingManagerApprovalReason = trustedApproval ? reason : '';
  delete inputs.managerApproved;
  delete inputs.managerApprovalReason;
  if (trustedApproval) {
    inputs.dethatchingManagerApprovedBy = approval.approvedBy;
    inputs.dethatchingManagerApprovedByRole = approval.approvedByRole;
    inputs.dethatchingManagerApprovedAt = approval.approvedAt;
  } else {
    delete inputs.dethatchingManagerApprovedBy;
    delete inputs.dethatchingManagerApprovedByRole;
    delete inputs.dethatchingManagerApprovedAt;
  }
  applyApprovalToEngineInputs(inputs);
  applyApprovalToEngineInputs(data.result?.inputs);
  applyApprovalToEngineInputs(data.engineInputs);
  applyApprovalToEngineInputs(data.result?.engineInputs);

  function applyTrustedApproval(value, depth = 0) {
    if (!value || depth > 12) return;
    if (Array.isArray(value)) {
      value.forEach((item) => applyTrustedApproval(item, depth + 1));
      return;
    }
    if (typeof value !== 'object') return;
    if (looksLikeDethatchingApprovalItem(value) && (
      value.requiresManagerApproval === true ||
      itemHasStAugustineApprovalReason(value)
    )) {
      value.managerApproved = trustedApproval;
      value.managerApprovalSatisfied = trustedApproval;
      value.managerApprovalOverrideReason = trustedApproval ? reason : null;
      normalizeDethatchingApprovalDerivedFields(value, { trustedApproval, reason });
      if (trustedApproval) {
        value.managerApprovalApprovedBy = inputs.dethatchingManagerApprovedBy;
        value.managerApprovalApprovedByRole = inputs.dethatchingManagerApprovedByRole;
        value.managerApprovalApprovedAt = inputs.dethatchingManagerApprovedAt;
      } else {
        delete value.managerApprovalApprovedBy;
        delete value.managerApprovalApprovedByRole;
        delete value.managerApprovalApprovedAt;
      }
    }
    Object.values(value).forEach((item) => applyTrustedApproval(item, depth + 1));
  }

  applyTrustedApproval(data);
  reconcileAggregateQuoteState(data);
  return data;
}

function recurringServiceRowsFromEstimateData(estimateData) {
  const data = parseEstimateData(estimateData);
  const result = data?.result && typeof data.result === 'object'
    ? data.result
    : (data && typeof data === 'object' ? data : {});
  const nestedRecurring = result.results?.recurring && typeof result.results.recurring === 'object'
    ? result.results.recurring
    : {};
  const resultCandidates = [
    result,
    data?.engineResult,
    result?.engineResult,
  ].filter((item) => item && typeof item === 'object');
  const engineRecurringRows = resultCandidates.flatMap((candidate) => {
    const services = Array.isArray(candidate.recurring?.services) ? candidate.recurring.services : [];
    const lineItems = Array.isArray(candidate.lineItems)
      ? candidate.lineItems.filter(rowLooksRecurringEngineLineItem)
      : [];
    return [...services, ...lineItems];
  });
  return [
    ...(Array.isArray(result.recurring?.services) ? result.recurring.services : []),
    ...(Array.isArray(nestedRecurring.services) ? nestedRecurring.services : []),
    ...engineRecurringRows,
  ].filter((row) => row && typeof row === 'object');
}

function recurringServiceLabel(row) {
  return String(row?.displayName || row?.name || row?.label || row?.service || '').trim();
}

function isPestRecurringService(row) {
  const label = recurringServiceLabel(row).toLowerCase();
  const service = String(row?.service || '').toLowerCase();
  return label.includes('pest') || service.includes('pest');
}

function firstPositiveNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function rowLooksRecurringEngineLineItem(row = {}) {
  return firstPositiveNumber(
    row.monthly,
    row.monthlyAfterDiscount,
    row.monthlyTotal,
    row.annual,
    row.annualAfterDiscount,
    row.annualAfterCredits,
    row.annualTotal,
  ) > 0;
}

function recurringServiceHasPositivePricing(row = {}) {
  return firstPositiveNumber(
    row.mo,
    row.monthly,
    row.monthlyAfterDiscount,
    row.monthlyTotal,
    row.ann,
    row.annual,
    row.annualAfterDiscount,
    row.annualAfterCredits,
    row.annualTotal,
    row.perTreatment,
    row.perApp,
    row.perVisit,
    row.pa,
    row.basePrice,
    row.price,
    row.amount,
  ) > 0;
}

function pestTierRowsFromEstimateData(estimateData) {
  const data = parseEstimateData(estimateData);
  const result = data?.result && typeof data.result === 'object'
    ? data.result
    : (data && typeof data === 'object' ? data : {});
  const innerResults = result.results && typeof result.results === 'object'
    ? result.results
    : {};
  return [
    ...(Array.isArray(innerResults.pestTiers) ? innerResults.pestTiers : []),
    ...(Array.isArray(result.pestTiers) ? result.pestTiers : []),
  ].filter((row) => row && typeof row === 'object');
}

function pestTierHasPositivePricing(row = {}) {
  return firstPositiveNumber(
    row.mo,
    row.monthly,
    row.monthlyAfterDiscount,
    row.ann,
    row.annual,
    row.annualAfterDiscount,
    row.annualAfterCredits,
    row.pa,
    row.perApp,
    row.perVisit,
    row.perTreatment,
    row.basePrice,
  ) > 0;
}

function rowHasDerivableOneTimePestChoicePricing(row = {}) {
  if (firstPositiveNumber(row.pa, row.perApp, row.perVisit, row.perTreatment, row.basePrice)) {
    return true;
  }
  const visits = firstPositiveNumber(row.apps, row.v, row.visitsPerYear, row.visits, row.frequency);
  const recurringAmount = firstPositiveNumber(
    row.mo,
    row.monthly,
    row.monthlyAfterDiscount,
    row.monthlyTotal,
    row.ann,
    row.annual,
    row.annualAfterDiscount,
    row.annualAfterCredits,
    row.annualTotal,
  );
  return visits > 0 && recurringAmount > 0;
}

function oneTimeRowsFromEstimateData(estimateData) {
  const data = parseEstimateData(estimateData);
  const result = data?.result && typeof data.result === 'object'
    ? data.result
    : (data && typeof data === 'object' ? data : {});
  const nestedOneTime = result.results?.oneTime && typeof result.results.oneTime === 'object'
    ? result.results.oneTime
    : {};
  const engineResult = data?.engineResult || result?.engineResult || {};
  return [
    ...(Array.isArray(result.oneTime?.items) ? result.oneTime.items : []),
    ...(Array.isArray(result.oneTime?.specItems) ? result.oneTime.specItems : []),
    ...(Array.isArray(nestedOneTime.items) ? nestedOneTime.items : []),
    ...(Array.isArray(nestedOneTime.specItems) ? nestedOneTime.specItems : []),
    ...(Array.isArray(result.specItems) ? result.specItems : []),
    ...(Array.isArray(result.lineItems) ? result.lineItems : []),
    ...(Array.isArray(engineResult.oneTime?.items) ? engineResult.oneTime.items : []),
    ...(Array.isArray(engineResult.oneTime?.specItems) ? engineResult.oneTime.specItems : []),
    ...(Array.isArray(engineResult.specItems) ? engineResult.specItems : []),
    ...(Array.isArray(engineResult.lineItems) ? engineResult.lineItems : []),
  ].filter((row) => row && typeof row === 'object');
}

function isGeneralOneTimePestChoiceRow(row = {}) {
  const service = String(row.service || row.key || '').toLowerCase();
  const text = String([
    service,
    row.name,
    row.label,
    row.displayName,
  ].filter(Boolean).join(' ')).toLowerCase().replace(/[_-]+/g, ' ');
  if (text.includes('pest initial') || /\binitial\b.*\broach\b/.test(text)) return false;
  return service === 'one_time_pest' ||
    text.includes('one time pest') ||
    text.includes('one-time pest') ||
    text.includes('onetime pest');
}

function rowHasPositiveOneTimeAmount(row = {}) {
  return firstPositiveNumber(
    row.priceAfterDiscount,
    row.totalAfterDiscount,
    row.price,
    row.amount,
    row.total,
  ) > 0;
}

function hasGeneralOneTimePestChoicePricing(estimateData) {
  return oneTimeRowsFromEstimateData(estimateData)
    .some((row) => isGeneralOneTimePestChoiceRow(row) && rowHasPositiveOneTimeAmount(row));
}

function engineInputsRequestPest(estimateData) {
  const data = parseEstimateData(estimateData);
  const candidates = [
    data?.engineInputs,
    data?.result?.engineInputs,
    data?.inputs,
    data?.result?.inputs,
  ].filter((item) => item && typeof item === 'object');
  return candidates.some((inputs) => (
    inputs.svcPest === true ||
    inputs.services?.pest === true ||
    (inputs.services?.pest && typeof inputs.services.pest === 'object')
  ));
}

function hasPositiveEngineRecurringTotal(estimateData) {
  const data = parseEstimateData(estimateData);
  const candidates = [
    data?.engineResult,
    data?.result?.engineResult,
    data?.result,
    data,
  ].filter((item) => item && typeof item === 'object');
  return candidates.some((result) => firstPositiveNumber(
    result.monthlyTotal,
    result.annualTotal,
    result.summary?.recurringMonthlyAfterDiscount,
    result.summary?.recurringAnnualAfterDiscount,
  ) > 0);
}

function hasPestRecurringServiceForOneTimeOption(estimateData) {
  return recurringServiceRowsFromEstimateData(estimateData)
    .some((row) => isPestRecurringService(row) && recurringServiceHasPositivePricing(row))
    || pestTierRowsFromEstimateData(estimateData).some(pestTierHasPositivePricing)
    || (engineInputsRequestPest(estimateData) && hasPositiveEngineRecurringTotal(estimateData));
}

function hasDerivableOneTimePestChoicePricing(estimateData) {
  return recurringServiceRowsFromEstimateData(estimateData)
    .some((row) => isPestRecurringService(row) && rowHasDerivableOneTimePestChoicePricing(row))
    || pestTierRowsFromEstimateData(estimateData).some(rowHasDerivableOneTimePestChoicePricing);
}

function nonPestRecurringServicesForOneTimeOption(estimateData) {
  const seen = new Set();
  return recurringServiceRowsFromEstimateData(estimateData)
    .filter((row) => !isPestRecurringService(row))
    .map((row) => recurringServiceLabel(row) || 'Unnamed recurring service')
    .filter((label) => {
      const key = label.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

module.exports = {
  estimateDataHasQuoteRequirement,
  estimateDataHasUnresolvedManagerApproval,
  commercialRiskTypeReviewNeeded,
  commercialLowConfidenceRange,
  commercialLowConfidenceRequiresSiteQuote,
  hasDerivableOneTimePestChoicePricing,
  hasPestRecurringServiceForOneTimeOption,
  normalizeEstimateDethatchingManagerApproval,
  nonPestRecurringServicesForOneTimeOption,
  validateEstimateDeliveryOptions,
};
