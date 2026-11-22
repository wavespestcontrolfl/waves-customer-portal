'use strict';

/**
 * The plan offer's stamp on an estimate (owner 2026-11-19 "build": after a one-time pest or cockroach
 * job the customer is offered the quarterly plan with the setup fee at $0 for 30 days, and the job counts
 * as the first plan visit). The offer quote is a plan_start estimate that carries
 * estimate_data.planStart.offer = { jobId, endsAt, firstVisitFrom } (restart.js mintPlanStartEstimate).
 *
 * Pure on purpose, no database and no heavy requires: the mint, the slot reservation, the estimate
 * page and the extension check all read the stamp through this one function, so none of them parses
 * the shape on its own.
 */

// The audit reason on the quote's fee waiver (estimate_data.operatorPriceAdjustment.internalReason).
const PLAN_OFFER_WAIVER_REASON = 'One-time job to plan offer: setup fee waived (owner 2026-11-19)';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// { jobId, endsAt, firstVisitFrom } for an estimate that carries the offer, else null. `estimateData`
// is the estimate_data column as the caller holds it: the object or its JSON string.
function planOfferOf(estimateData) {
  let data = estimateData;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { return null; }
  }
  const offer = data?.planStart?.offer;
  if (!offer || typeof offer !== 'object') return null;
  const { jobId, endsAt, firstVisitFrom } = offer;
  if (typeof jobId !== 'string' || !jobId) return null;
  if (typeof endsAt !== 'string' || Number.isNaN(new Date(endsAt).getTime())) return null;
  if (typeof firstVisitFrom !== 'string' || !DATE_ONLY.test(firstVisitFrom)) return null;
  return { jobId, endsAt, firstVisitFrom };
}

module.exports = { planOfferOf, PLAN_OFFER_WAIVER_REASON };
