const crypto = require('crypto');
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
  return estimateOfferVersion({ ...estimate, estimate_data: offerData });
}

function annualPlanHasDeliveredOffer(estimate) {
  const fingerprint = annualPlanOfferFingerprint(estimate);
  const data = parseEstimateData(estimate?.estimate_data || estimate?.estimateData);
  return !!fingerprint && !!data?.deliveryState?.firstDeliveredAt
    && data.deliveryState.annualPlanOfferFingerprint === fingerprint;
}

// An issued annual offer remains viewable/acceptable after either switch is
// closed. A changed or never-delivered annual offer cannot borrow the stored
// pricing stamp (or a prior quarterly handoff) to reach those public paths.
function annualPlanPublicReplayBlocked(estimate) {
  if (termiteAnnualPlanSelectionEnabled() || ['accepted', 'declined'].includes(estimate?.status)) return false;
  const data = parseEstimateData(estimate?.estimate_data || estimate?.estimateData);
  return selectedTermiteAnnualPlanRows(data).length > 0 && !annualPlanHasDeliveredOffer(estimate);
}

module.exports = { estimateOfferVersion, annualPlanOfferFingerprint, annualPlanHasDeliveredOffer, annualPlanPublicReplayBlocked };
