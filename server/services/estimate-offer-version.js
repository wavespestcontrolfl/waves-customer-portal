const crypto = require('crypto');
const { isDeepStrictEqual } = require('node:util');
const { selectedTermiteAnnualPlanRows } = require('./estimate-termite-program-rows');
const { termiteAnnualPlanSelectionEnabled } = require('../config/feature-gates');

function parseEstimateData(estimateData) {
  if (!estimateData) return null;
  if (typeof estimateData === 'string') {
    try { return JSON.parse(estimateData); } catch { return null; }
  }
  return typeof estimateData === 'object' ? estimateData : null;
}

// Contact, property, scope, terms and dollars are part of the offer reviewed
// before sending. Operational delivery stamps are not.
function estimateOfferVersion(row) {
  const data = { ...(parseEstimateData(row.estimate_data) || {}) };
  for (const key of ['sendSnapshot', 'deliveryState', 'manualSendAttempts']) delete data[key];
  if (data.estimatorEngine) {
    data.estimatorEngine = { ...data.estimatorEngine };
    delete data.estimatorEngine.delivering_at;
    delete data.estimatorEngine.delivering_token;
    if (!Object.keys(data.estimatorEngine).length) delete data.estimatorEngine;
  }
  const fields = ['customer_id', 'property_id', 'estimate_group_id', 'customer_name', 'customer_phone', 'customer_email', 'address', 'notes', 'monthly_total', 'annual_total', 'onetime_total', 'show_one_time_option', 'bill_by_invoice'];
  return crypto.createHash('sha256').update(JSON.stringify([fields.map((key) => row[key]), data])).digest('hex');
}

// A real handoff witnesses this exact annual offer, not a prior quarterly
// quote on the same token. Publication, follow-up ownership and first-view
// metadata may change afterward without changing what the customer was sent.
function annualPlanOfferFingerprint(estimate) {
  const data = parseEstimateData(estimate?.estimate_data || estimate?.estimateData);
  if (!data || !selectedTermiteAnnualPlanRows(data).length) return null;
  if (!data.result && !data.engineResult) return null;
  const offerData = { ...data };
  for (const key of ['groupPublishedByEstimateId', 'proposalDelivery', 'leadServiceHandoffAt', 'leadServiceHandoffParkId', 'viewedMonthlyTotal', 'followupOwnershipFrom']) {
    delete offerData[key];
  }
  if (offerData.automation) {
    offerData.automation = { ...offerData.automation };
    delete offerData.automation.autoSend;
    if (!Object.keys(offerData.automation).length) delete offerData.automation;
  }
  // JSONB reorders object keys, and pg returns numeric columns as strings.
  // Witness the persisted value rather than its pre-UPDATE JS representation.
  const canonicalData = JSON.parse(JSON.stringify(offerData, (_key, value) => (
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])) : value
  )));
  const canonicalRow = { ...estimate, estimate_data: canonicalData };
  for (const key of ['monthly_total', 'annual_total', 'onetime_total']) {
    if (canonicalRow[key] != null) canonicalRow[key] = Number(canonicalRow[key]).toFixed(2);
  }
  return estimateOfferVersion(canonicalRow);
}

function annualPlanHasDeliveredOffer(estimate) {
  const fingerprint = annualPlanOfferFingerprint(estimate);
  const data = parseEstimateData(estimate?.estimate_data || estimate?.estimateData);
  const delivery = data?.deliveryState;
  if (!fingerprint || !delivery?.firstDeliveredAt || !delivery.annualPlanOfferFingerprint) return false;
  if (delivery.annualPlanOfferFingerprint === fingerprint) return true;
  const revisions = delivery.annualPlanPublicRevisions;
  if (!Array.isArray(revisions) || !revisions.length || revisions.length > 32) return false;
  return revisions.every((revision, index) => revision?.version === 1
    && PUBLIC_ANNUAL_REVISION_KINDS.includes(revision.kind)
    && revision.sourceFingerprint === delivery.annualPlanOfferFingerprint
    && typeof revision.previousFingerprint === 'string'
    && (index === 0 || revision.previousFingerprint === revisions[index - 1].fingerprint))
    && revisions[revisions.length - 1].fingerprint === fingerprint;
}

const PUBLIC_ANNUAL_REVISION_KINDS = ['select-tier', 'preferences', 'interior-service', 'service-mix'];
const ANNUAL_IDENTITY_FIELDS = ['id', 'token', 'customer_id', 'property_id', 'estimate_group_id',
  'customer_name', 'customer_phone', 'customer_email', 'address', 'notes', 'show_one_time_option', 'bill_by_invoice'];

// Capture before route reconciliation/repricing can mutate a JSONB object in
// place. Only a real handoff (or its already verified public revision) qualifies.
function captureAnnualPlanPublicRevision(estimate) {
  if (!annualPlanHasDeliveredOffer(estimate)) return null;
  return { ...estimate, estimate_data: JSON.parse(JSON.stringify(parseEstimateData(estimate.estimate_data))) };
}

function annualRevisionTerms(estimate) {
  const data = parseEstimateData(estimate.estimate_data);
  // A service-mix recompute upgrades raw-only engine saves to the mapped
  // shape. Compare both through the same mapper before checking sold terms.
  let rows = selectedTermiteAnnualPlanRows(data);
  if (!data?.result?.results?.tmBait && !data?.results?.tmBait) {
    const raw = data?.result?.lineItems ? data.result : data?.engineResult;
    if (raw?.lineItems) {
      const { mapV1ToLegacyShape } = require('./pricing-engine/v1-legacy-mapper');
      rows = selectedTermiteAnnualPlanRows({ result: mapV1ToLegacyShape(raw) });
    }
  }
  return rows.map((row) => {
    const terms = { ...row };
    // Bundle choices can change the earned discount, not the annual tariff,
    // station setup or coverage. These are engine-derived discount outputs.
    for (const key of ['annualAfterDiscount', 'monthlyAfterDiscount', 'perAppAfterDiscount',
      'totalAfterDiscount', 'priceAfterDiscount', 'marginAfterDiscount', 'discountAmount', 'discountPercent']) delete terms[key];
    // Replay changes provenance labels while retaining the quote-time costs.
    delete terms.materialCostSource;
    if (terms.pricingKnobs) {
      terms.pricingKnobs = { ...terms.pricingKnobs };
      delete terms.pricingKnobs.stationCostSource;
    }
    return terms;
  });
}

// Called ONLY with server-computed writes from the allowlisted public routes,
// immediately before their existing guarded UPDATE. Never accepts a browser
// receipt, creates a delivery witness, or refreshes an invalid prior offer.
function stampAnnualPlanPublicRevision(source, writes, kind) {
  if (!source) return writes;
  const data = parseEstimateData(writes.estimate_data ?? source.estimate_data);
  const next = { ...source, ...writes, estimate_data: data };
  if (!PUBLIC_ANNUAL_REVISION_KINDS.includes(kind) || !annualPlanHasDeliveredOffer(source)
    || ANNUAL_IDENTITY_FIELDS.some((key) => !isDeepStrictEqual(source[key], next[key]))
    || !isDeepStrictEqual(annualRevisionTerms(source), annualRevisionTerms(next))) {
    const error = new Error('Annual plan terms changed. Reload the estimate before editing.');
    error.status = 409;
    throw error;
  }
  const fingerprint = annualPlanOfferFingerprint(next);
  const previousFingerprint = annualPlanOfferFingerprint(source);
  if (!fingerprint || fingerprint === previousFingerprint) return writes;
  const delivery = parseEstimateData(source.estimate_data).deliveryState;
  const previous = previousFingerprint === delivery.annualPlanOfferFingerprint
    ? [] : delivery.annualPlanPublicRevisions;
  const revision = {
    version: 1, kind, at: new Date().toISOString(),
    sourceFingerprint: delivery.annualPlanOfferFingerprint,
    previousFingerprint, fingerprint,
  };
  return { ...writes, estimate_data: JSON.stringify({ ...data, deliveryState: {
    ...delivery, annualPlanPublicRevisions: [...previous.slice(-31), revision],
  } }) };
}

// An issued annual offer remains viewable/acceptable after either switch is
// closed. A changed or never-delivered annual offer cannot borrow the stored
// pricing stamp (or a prior quarterly handoff) to reach those public paths.
function annualPlanPublicReplayBlocked(estimate) {
  if (termiteAnnualPlanSelectionEnabled() || ['accepted', 'declined'].includes(estimate?.status)) return false;
  const data = parseEstimateData(estimate?.estimate_data || estimate?.estimateData);
  return selectedTermiteAnnualPlanRows(data).length > 0 && !annualPlanHasDeliveredOffer(estimate);
}

module.exports = { estimateOfferVersion, annualPlanOfferFingerprint, annualPlanHasDeliveredOffer, annualPlanPublicReplayBlocked,
  captureAnnualPlanPublicRevision, stampAnnualPlanPublicRevision };
