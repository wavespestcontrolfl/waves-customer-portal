/**
 * Misting refill pricing at add-on booking (misting PR 2a). The refill catalog row carries the Standard price as its base_price;
 * a Natural or Premium plan is priced per refill application from the live misting table (DB-authoritative through the
 * pricing_config sync). The solution a customer's plan was quoted with is read from the stored estimate, so nothing new is persisted:
 * the series visits already carry source_estimate_id.
 *
 * resolveAddonUnitPrice is the ONE place the rule lives. Every other add-on keeps the price it was given, byte for byte.
 */
const db = require('../models/db');
const logger = require('./logger');
const { MISTING_REFILL_CATALOG_KEY } = require('../utils/mosquito-misting-system');
const { mistingRefillPriceFor } = require('./pricing-engine/mosquito-misting-config');
const { storedMistingRows } = require('./estimate-result-container');

const SOLUTIONS = ['standard', 'natural', 'premium'];
const DEFAULT_SOLUTION = 'standard';

const asSolution = (value) => {
  const key = String(value == null ? '' : value).trim().toLowerCase();
  return SOLUTIONS.includes(key) ? key : null;
};

function parseData(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// The solution a stored estimate's misting plan was priced with: the mapped plan row or install item (pricingKnobs.refillSolution,
// solution, refill.solution), a raw engine line (solution, refill.solution), else the chosen input. Unknown reads Standard.
function mistingRefillSolutionFromEstimateData(estimateData) {
  const data = parseData(estimateData);
  if (!data) return DEFAULT_SOLUTION;
  let rows = [];
  try { rows = storedMistingRows(data); } catch { rows = []; }
  for (const row of rows) {
    const found = asSolution(row.solution) || asSolution(row.refill && row.refill.solution)
      || asSolution(row.pricingKnobs && row.pricingKnobs.refillSolution);
    if (found) return found;
  }
  const inputs = [data.engineInputs, data.inputs, data.result && data.result.engineInputs].find((value) => value && typeof value === 'object');
  const chosen = inputs && inputs.services && (inputs.services.mosquitoMisting || inputs.services.mosquito_misting);
  return asSolution(chosen && chosen.solution) || DEFAULT_SOLUTION;
}

// The solution of the misting plan a visit belongs to, or null when no accepted plan can be established.
//   1. the visit's own source_estimate_id (unchanged: an unknown solution inside that estimate reads Standard);
//   2. else the customer's newest ACCEPTED estimate that carries a misting plan, scoped to the visit's property when the visit names
//      one (estimates.property_id must match). Drafts, sent-but-unaccepted, declined or expired quotes and another property's
//      quote never decide the price.
// Null (nothing established, or an unreadable lookup) leaves the price to the catalog / staff: resolveAddonUnitPrice returns the
// price it was given.
async function mistingRefillSolutionForVisit(visitRow, database = db) {
  try {
    const estimateId = visitRow && (visitRow.source_estimate_id || visitRow.sourceEstimateId);
    if (estimateId) {
      const row = await database('estimates').where({ id: estimateId }).first('estimate_data');
      return mistingRefillSolutionFromEstimateData(row && row.estimate_data);
    }
    const customerId = visitRow && (visitRow.customer_id || visitRow.customerId);
    if (customerId) {
      const propertyId = visitRow.property_id || visitRow.propertyId || null;
      const rows = await database('estimates')
        .where({ customer_id: customerId, status: 'accepted' })
        .orderBy('accepted_at', 'desc')
        .orderBy('id', 'desc')
        .limit(20)
        .select('id', 'property_id', 'estimate_data');
      for (const row of Array.isArray(rows) ? rows : []) {
        if (propertyId && String(row.property_id || '') !== String(propertyId)) continue;
        const data = parseData(row.estimate_data);
        if (data && storedMistingRows(data).length) return mistingRefillSolutionFromEstimateData(data);
      }
    }
  } catch (err) {
    logger.warn(`[misting-refill-pricing] solution lookup failed (price left to the catalog): ${err.message}`);
    return null;
  }
  return null;
}

/**
 * The unit price of an add-on line.
 * @param {object} addon  { serviceKey, price (the price on the line now, may be null), catalogBasePrice }
 * @param {object} parentVisit  the visit the add-on rides on, or the booking in progress: { source_estimate_id, customer_id, property_id }
 * A refill line with no price, or still at the unedited catalog price, takes the accepted plan's solution price; a price staff typed
 * in is kept. When no accepted plan can be established the price is left exactly as given (one debug line). Every other add-on
 * returns its price untouched.
 */
async function resolveAddonUnitPrice(addon, parentVisit, database = db) {
  const price = addon ? addon.price : null;
  const key = addon && (addon.serviceKey || addon.service_key);
  if (key !== MISTING_REFILL_CATALOG_KEY) return price;
  const catalog = addon.catalogBasePrice != null ? Number(addon.catalogBasePrice) : null;
  const isDefault = price == null || (catalog != null && Math.abs(Number(price) - catalog) < 0.005);
  if (!isDefault) return price;
  const solution = await mistingRefillSolutionForVisit(parentVisit, database);
  if (!solution) {
    logger.debug(`[misting-refill-pricing] no accepted misting plan found for customer ${(parentVisit && (parentVisit.customer_id || parentVisit.customerId)) || 'unknown'}: refill price left for staff to select`);
    return price;
  }
  return mistingRefillPriceFor(solution);
}

module.exports = {
  mistingRefillSolutionFromEstimateData,
  mistingRefillSolutionForVisit,
  resolveAddonUnitPrice,
};
