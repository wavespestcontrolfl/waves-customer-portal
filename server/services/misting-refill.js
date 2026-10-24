/**
 * Misting refill pricing and attachment rules (misting PR 2c, GATE_MOSQUITO_MISTING).
 *
 * A refill (catalog key mosquito_misting_refill) is ONE refill application, billed once on the one visit it is added to. Its price is
 * the per-application price of the solution the customer's ACCEPTED misting estimate was sold with (Standard / Natural / Premium).
 * The catalog row's base_price is only the Standard placeholder, so nothing here ever reads it.
 *
 * ONE resolver (resolveRefillAttachment) decides every attach, in this order, and every staff path calls it:
 *   1. series      a refill never goes on a repeating series (its price would be multiplied across the prepaid term);
 *   2. parent      only a Mosquito Misting Service Plan visit takes a refill;
 *   3. estimate    the accepted misting estimate for this customer AND property: the visit's own source estimate when it is one,
 *                  else the property's newest accepted misting estimate. Draft, sent, declined, expired or another property's
 *                  estimates never decide the price;
 *   4. solution    read from that estimate's stored rows (the stamped refill solution), else its engine inputs;
 *   5. price       the LIVE pricing_config table (mosquito_misting_pricing, through the db-bridge sync) at the time of the attach.
 * Any step that cannot be established is a refusal (ok false), never a default: an unpriced refill is refused with a staff-readable
 * reason and nothing is billed at the Standard placeholder.
 *
 * The result carries the invoice line name with the solution label ("Mosquito Misting System Refill - Natural (botanical)"), which is
 * what the visit invoice builder prints (it uses scheduled_service_addons.service_name).
 */
const db = require('../models/db');
const logger = require('./logger');
const {
  MISTING_REFILL_CATALOG_KEY, MISTING_SERVICE_CATALOG_KEY, isMistingSelection,
} = require('../utils/mosquito-misting-system');
const { MOSQUITO_MISTING } = require('./pricing-engine/constants');
const { mistingRefillPriceFor } = require('./pricing-engine/mosquito-misting-config');
const { storedMistingRows } = require('./estimate-result-container');

const REFILL_BASE_NAME = 'Mosquito Misting System Refill';
const NEWEST_ACCEPTED_LIMIT = 20;

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);
// GATE_MOSQUITO_MISTING, read at call time. A test that mocks the gate module with a partial set reads as off.
const refillLive = () => {
  const gates = require('../config/feature-gates');
  return typeof gates.mosquitoMistingLive === 'function' && gates.mosquitoMistingLive() === true;
};
const isRefillKey = (serviceKey) => serviceKey === MISTING_REFILL_CATALOG_KEY;

const REFUSALS = {
  MISTING_REFILL_ON_SERIES: [400, 'A misting refill is billed on one visit. Book the series first, then add the refill to that one visit (Edit visit, Add-ons).'],
  MISTING_REFILL_ADDON_ONLY: [400, 'A misting refill is an add-on. Add it to a Mosquito Misting Service Plan visit; it cannot be the visit itself.'],
  MISTING_REFILL_WRONG_PARENT: [400, 'A misting refill can only be added to a Mosquito Misting Service Plan visit.'],
  MISTING_REFILL_UNPRICED: [409, 'This misting refill cannot be priced: no accepted misting estimate was found for this customer and property. Accept the misting estimate first, then add the refill.'],
  MISTING_REFILL_SOLUTION_UNREADABLE: [409, 'This misting refill cannot be priced: the accepted misting estimate does not say which refill solution was sold. Re-send the estimate or ask the office to fix it.'],
  MISTING_REFILL_PRICE_UNAVAILABLE: [409, 'This misting refill cannot be priced: the live misting price table has no price for the refill solution that was sold.'],
  MISTING_REFILL_LOOKUP_FAILED: [503, 'The accepted misting estimate could not be read, so the refill was not priced. Try again in a moment.'],
};

function refusal(code, extra = {}) {
  const [status, message] = REFUSALS[code];
  return { ok: false, code, status, message, ...extra };
}

function parseData(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function asSolution(value) {
  const key = String(value == null ? '' : value).trim().toLowerCase();
  return hasOwn(MOSQUITO_MISTING.refills, key) ? key : null;
}

// What one stored estimate says about a misting plan: { carries, solution }. `carries` is false when it has no misting plan at all
// (a pest or lawn estimate); `solution` is null when it has one but does not say which refill solution was sold.
function readEstimateMisting(row) {
  const data = parseData(row && row.estimate_data);
  if (!data) return { carries: false, solution: null };
  let rows = [];
  try { rows = storedMistingRows(data, { pricingAuthority: row.pricing_authority }); } catch { rows = []; }
  const inputs = [data.engineInputs, data.inputs, data.result && data.result.engineInputs].find((v) => v && typeof v === 'object');
  const services = (inputs && inputs.services) || {};
  const chosen = [services.mosquitoMisting, services.mosquito_misting].find(isMistingSelection);
  if (!rows.length && !chosen) return { carries: false, solution: null };
  for (const line of rows) {
    const found = asSolution(line.pricingKnobs && line.pricingKnobs.refillSolution) || asSolution(line.solution)
      || asSolution(line.refill && line.refill.solution);
    if (found) return { carries: true, solution: found };
  }
  // Inputs only: a selection that names no solution was priced by the engine at its default solution; one that names an unknown
  // solution is ambiguous, so it reads as unreadable.
  if (chosen && typeof chosen === 'object' && chosen.solution != null && String(chosen.solution).trim() !== '') {
    return { carries: true, solution: asSolution(chosen.solution) };
  }
  return { carries: true, solution: chosen ? MOSQUITO_MISTING.defaultSolution : null };
}

// The customer's one active property, read-only (null when there are none or several). The booking paths anchor a booking with no
// chosen property to this one, so a refill with no explicit property is for this house. Never creates a property.
async function readSoleActivePropertyId(customerId, database) {
  if (!customerId) return null;
  const rows = await database('customer_properties').where({ customer_id: customerId, active: true }).limit(2).select('id');
  return Array.isArray(rows) && rows.length === 1 ? rows[0].id : null;
}

// An estimate is for this property when it names it. An estimate that names no property (written before the linkage) belongs to the
// customer's sole property only.
const sameProperty = (row, propertyId, soleId) => (row.property_id
  ? String(row.property_id) === String(propertyId || '')
  : !!propertyId && String(propertyId) === String(soleId || ''));

const ESTIMATE_COLUMNS = ['id', 'customer_id', 'property_id', 'status', 'accepted_at', 'estimate_data', 'pricing_authority'];

// The accepted misting estimate that decides the refill solution, or null. Throws only on a failed read.
async function findAcceptedMistingEstimate({ customerId, propertyId, soleId, sourceEstimateId }, database) {
  if (sourceEstimateId) {
    const own = await database('estimates').where({ id: sourceEstimateId }).first(...ESTIMATE_COLUMNS);
    if (own && own.status === 'accepted' && String(own.customer_id || '') === String(customerId || '')
      && sameProperty(own, propertyId, soleId)) {
      const read = readEstimateMisting(own);
      if (read.carries) return { id: own.id, ...read };
    }
  }
  const candidates = await database('estimates')
    .where({ customer_id: customerId, status: 'accepted' })
    .orderBy('accepted_at', 'desc')
    .orderBy('id', 'desc')
    .limit(NEWEST_ACCEPTED_LIMIT)
    .select(...ESTIMATE_COLUMNS);
  for (const row of Array.isArray(candidates) ? candidates : []) {
    if (!sameProperty(row, propertyId, soleId)) continue;
    const read = readEstimateMisting(row);
    if (read.carries) return { id: row.id, ...read };
  }
  return null;
}

/**
 * Decide one refill attach. `parentServiceKey` is the catalog key of the visit the refill goes on; `isRecurring` is true for a
 * series booking. Returns { ok: true, solution, solutionLabel, unitPrice, estimateId, lineName } or { ok: false, code, status, message }.
 */
async function resolveRefillAttachment({
  customerId, propertyId = null, sourceEstimateId = null, parentServiceKey = null, isRecurring = false,
}, database = db) {
  if (isRecurring) return refusal('MISTING_REFILL_ON_SERIES');
  if (isRefillKey(parentServiceKey)) return refusal('MISTING_REFILL_ADDON_ONLY');
  if (parentServiceKey !== MISTING_SERVICE_CATALOG_KEY) return refusal('MISTING_REFILL_WRONG_PARENT');
  let found;
  try {
    const soleId = await readSoleActivePropertyId(customerId, database);
    found = await findAcceptedMistingEstimate({
      customerId, propertyId: propertyId || soleId, soleId, sourceEstimateId,
    }, database);
  } catch (err) {
    logger.warn(`[misting-refill] accepted estimate lookup failed for customer ${customerId}: ${err.message}`);
    return refusal('MISTING_REFILL_LOOKUP_FAILED');
  }
  if (!found) return refusal('MISTING_REFILL_UNPRICED');
  if (!found.solution) return refusal('MISTING_REFILL_SOLUTION_UNREADABLE', { estimateId: found.id });
  const unitPrice = mistingRefillPriceFor(found.solution);
  if (unitPrice == null) return refusal('MISTING_REFILL_PRICE_UNAVAILABLE', { solution: found.solution, estimateId: found.id });
  const solutionLabel = MOSQUITO_MISTING.refills[found.solution].label;
  return {
    ok: true,
    solution: found.solution,
    solutionLabel,
    unitPrice,
    estimateId: found.id,
    lineName: `${REFILL_BASE_NAME} - ${solutionLabel}`,
  };
}

// Refusals that leave a refill the visit ALREADY carries in place (it keeps its stored price and name): the resolver could not price
// it now, which must not block an unrelated edit of the visit. A NEW refill is always refused for these.
const KEEP_STORED_ON = new Set(['MISTING_REFILL_UNPRICED', 'MISTING_REFILL_SOLUTION_UNREADABLE', 'MISTING_REFILL_PRICE_UNAVAILABLE']);

// The error a route throws for a refusal: operational, carrying the status, the staff text and the stable code.
function refusalError(result) {
  return Object.assign(new Error(result.message), {
    status: result.status, statusCode: result.status, code: result.code, isOperational: true,
  });
}

module.exports = {
  REFILL_BASE_NAME,
  refillLive,
  isRefillKey,
  readEstimateMisting,
  resolveRefillAttachment,
  refusalError,
  KEEP_STORED_ON,
};
