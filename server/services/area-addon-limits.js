'use strict';

/**
 * Area add-on yearly limits, the database side (owner ruling 2026-10-08, add-on-only limits).
 * The rules and wording are the pure module pricing-engine/area-addon-limits.js, fed by the one
 * table AREA_ADDONS.items; this file only READS the history that module is given and enforces it
 * at the points where an add-on is quoted, accepted, reserved or booked. It never blocks a
 * program visit: the rule is evaluated for an add-on row only.
 *
 * History = the applications of the add-on's product at the property in the last 12 months,
 * read from the FDACS application ledger (`property_application_history`, scoped to the treated
 * property the way application-limits scopes it; program applications and add-on applications
 * both land there) PLUS the add-on visits already booked and not yet done (a visit whose own
 * service is the add-on, or a `scheduled_service_addons` row for it, on a visit that is not
 * completed or cancelled). The booked rows of the estimate being accepted are left out.
 *
 * No known customer (a new lead) has no history: the add-on prices normally.
 * Every query here takes uuid ids only and reads tables that exist from the first migrations of
 * the add-on lane on; a caller that is not on the add-on path never reaches this file.
 */
const logger = require('./logger');
const { AREA_ADDONS } = require('./pricing-engine/constants');
const {
  WINDOW_DAYS, LIMIT_REACHED_REASON, HISTORY_UNAVAILABLE_REASON, addDays, addOnLimit, areaAddOnLimitVerdict, limitUseText,
} = require('./pricing-engine/area-addon-limits');
const { etDateString, etCalendarDayOf } = require('../utils/datetime-et');
const { savepointScope } = require('../utils/savepoint-read');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A visit in one of these statuses is not a pending booking (it is done, or it will not happen).
const NOT_BOOKED_STATUSES = ['completed', 'cancelled', 'skipped', 'no_show', 'rescheduled', 'incomplete'];

const LIMIT_CODE = 'AREA_ADDON_YEARLY_LIMIT_REACHED';
const HISTORY_CODE = 'AREA_ADDON_HISTORY_UNAVAILABLE';
const LIMIT_CUSTOMER_MESSAGE = 'One of the add-on treatments on this estimate was applied at your property too recently to repeat. Please contact our office and we will confirm what can be scheduled.';
const HISTORY_CUSTOMER_MESSAGE = 'We could not confirm the treatment history for the add-ons on this estimate. Please contact our office and we will finish booking.';

const isUuid = (value) => typeof value === 'string' && UUID_RE.test(value);
const configOf = (key) => (Object.prototype.hasOwnProperty.call(AREA_ADDONS.items, key) ? AREA_ADDONS.items[key] : null);
const limitedKeys = (keys) => [...new Set(keys || [])].filter((key) => addOnLimit(configOf(key)));
const dayOf = (value) => (value ? etCalendarDayOf(value) : null);

// The catalog product each limited add-on reads its history for: the governed protocol's own hint
// resolved by the job card's matcher, so the card and the check name the same row.
async function productIdsByKey(database, keys) {
  const { matchCatalogProduct } = require('./waveguard-plan-engine');
  const products = await database('products_catalog')
    .where(function activeOrUnknown() { this.where({ active: true }).orWhereNull('active'); })
    .select('id', 'name');
  const aliases = products.length
    ? await database('product_aliases').whereIn('product_id', products.map((p) => p.id)).select('product_id', 'alias_name')
    : [];
  const byProduct = new Map();
  for (const row of aliases) byProduct.set(row.product_id, [...(byProduct.get(row.product_id) || []), row.alias_name]);
  const catalog = products.map((p) => ({ ...p, aliases: byProduct.get(p.id) || [] }));
  const out = new Map();
  for (const key of keys) {
    const hint = configOf(key).limitProduct;
    const product = matchCatalogProduct({ raw: hint, catalogProductHints: [hint] }, catalog);
    if (product) out.set(key, product.id);
  }
  return out;
}

// The treated property: the one the caller names, else the customer's only active property, else
// null (the customer's whole history counts: a row that cannot be placed counts everywhere).
async function resolvePropertyId(database, customerId, propertyId) {
  if (isUuid(propertyId)) return propertyId;
  const rows = await database('customer_properties').where({ customer_id: customerId, active: true }).limit(2).select('id');
  return rows.length === 1 ? rows[0].id : null;
}

// Applications of each key's product on the property in the last 12 months, from the ledger.
async function ledgerDates(database, { customerId, propertyId, productByKey, asOf, excludeVisitId }) {
  const ids = [...productByKey.values()];
  const out = new Map();
  if (!ids.length) return out;
  const applicationLimits = require('./application-limits');
  const rows = await applicationLimits.scopeHistoryToTreatment(database('property_application_history')
    .where({ customer_id: customerId })
    .whereIn('product_id', ids)
    .where('application_date', '>', addDays(asOf, -WINDOW_DAYS))
    .whereNull('retracted_at'), database, { propertyId, excludeScheduledServiceId: excludeVisitId }, 'property_application_history')
    .select('product_id', 'application_date');
  const keyOfProduct = new Map([...productByKey].map(([key, id]) => [String(id), key]));
  for (const row of rows) {
    const key = keyOfProduct.get(String(row.product_id));
    if (key) out.set(key, [...(out.get(key) || []), dayOf(row.application_date)]);
  }
  return out;
}

// Add-on visits already booked and not done, at this property, other than the estimate being accepted.
async function bookedDates(database, { customerId, propertyId, keys, excludeEstimateId, excludeVisitId }) {
  const serviceKeys = keys.map((key) => configOf(key).serviceKey);
  const keyOfService = new Map(keys.map((key) => [configOf(key).serviceKey, key]));
  const scope = (query, table) => {
    query.where(`${table}.customer_id`, customerId).whereNotIn(`${table}.status`, NOT_BOOKED_STATUSES);
    if (propertyId) query.where(function placedHereOrUnplaced() { this.whereNull(`${table}.property_id`).orWhere(`${table}.property_id`, propertyId); });
    if (isUuid(excludeVisitId)) query.whereNot(`${table}.id`, excludeVisitId);
    if (isUuid(excludeEstimateId)) query.where(function notThisEstimate() { this.whereNull(`${table}.source_estimate_id`).orWhereNot(`${table}.source_estimate_id`, excludeEstimateId); });
    return query;
  };
  const [own, rows] = await Promise.all([
    scope(database('scheduled_services as s').whereIn('s.service_key_snapshot', serviceKeys), 's').select('s.service_key_snapshot as service_key', 's.scheduled_date'),
    scope(database('scheduled_service_addons as a').join('scheduled_services as s', 's.id', 'a.scheduled_service_id').whereIn('a.service_key_snapshot', serviceKeys), 's')
      .select('a.service_key_snapshot as service_key', 's.scheduled_date'),
  ]);
  const out = new Map();
  for (const row of [...own, ...rows]) {
    const key = keyOfService.get(row.service_key);
    if (key && row.scheduled_date) out.set(key, [...(out.get(key) || []), dayOf(row.scheduled_date)]);
  }
  return out;
}

/**
 * The injected history summary for these add-on keys at this customer's property, or throws when a
 * read fails (the caller decides what a failed read means). { available: true, asOf, byKey }.
 * Keys with no limit (the web sweep) are not read. No known customer: no reads, an empty summary.
 */
async function loadAreaAddOnHistory(database, { customerId, propertyId = null, keys = [], asOf = etDateString(), excludeEstimateId = null, excludeVisitId = null } = {}) {
  const wanted = limitedKeys(keys);
  const empty = { available: true, asOf, byKey: {} };
  if (!wanted.length || !isUuid(customerId)) return empty;
  const property = await resolvePropertyId(database, customerId, propertyId);
  const productByKey = await productIdsByKey(database, wanted);
  const [ledger, booked] = await Promise.all([
    ledgerDates(database, { customerId, propertyId: property, productByKey, asOf, excludeVisitId }),
    bookedDates(database, { customerId, propertyId: property, keys: wanted, excludeEstimateId, excludeVisitId }),
  ]);
  const byKey = {};
  for (const key of wanted) byKey[key] = { dates: [...(ledger.get(key) || []), ...(booked.get(key) || [])].filter(Boolean).sort() };
  return { available: true, asOf, byKey };
}

// What the QUOTE steps attach to the engine input (services.areaAddOnHistory): undefined when no limit can
// apply (gate off, no add-on with a limit, no known customer), the summary on success, and
// { available: false } when the read failed so the engine returns the custom-quote line, never a silent pass.
// `entries` are the request's add-on entries ({ key }), `customerId` the verified customer.
async function quoteAreaAddOnHistory(database, { entries, customerId, propertyId = null } = {}) {
  const keys = limitedKeys((Array.isArray(entries) ? entries : []).map((entry) => entry && entry.key));
  if (!keys.length || !isUuid(customerId) || !require('../config/feature-gates').gateEnvValue('GATE_AREA_ADDONS')) return undefined;
  try {
    return await loadAreaAddOnHistory(database, { customerId, propertyId, keys });
  } catch (err) {
    logger.warn(`[area-addon-limits] quote history unavailable: ${err.code || err.name}: ${err.message}`);
    return { available: false, reason: 'history_unavailable' };
  }
}

// The same read for the estimator's two quote steps. `calculate` takes the engine input the translator built and
// the request options (existingCustomerId, propertyId); `save` takes the posted estimate data and body. Both return
// what to hand the engine (or undefined) and never throw.
async function attachQuoteAreaAddOnHistory(database, v1Input, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const entries = v1Input && v1Input.services && v1Input.services.areaAddOns;
  return applyAreaAddOnHistory(v1Input, await quoteAreaAddOnHistory(database, { entries, customerId: opts.existingCustomerId, propertyId: opts.propertyId }));
}
async function quoteAreaAddOnHistoryForSave(database, estimateData, body) {
  const fromRequest = estimateData && estimateData.engineRequest && estimateData.engineRequest.options && estimateData.engineRequest.options.areaAddOns;
  const fromInputs = estimateData && estimateData.engineInputs && estimateData.engineInputs.services && estimateData.engineInputs.services.areaAddOns;
  return quoteAreaAddOnHistory(database, {
    entries: fromRequest || fromInputs,
    customerId: body && body.customerId,
    propertyId: body && body.propertyId,
  });
}

// Server-authoritative: the history on an engine input comes from the server, never from a client-posted copy.
function applyAreaAddOnHistory(v1Input, history) {
  if (!v1Input || typeof v1Input.services !== 'object' || v1Input.services === null) return v1Input;
  // A copy of `services`: the object may be shared with the posted estimate data, which is stored as sent.
  const { areaAddOnHistory: _posted, ...services } = v1Input.services;
  v1Input.services = history === undefined ? services : { ...services, areaAddOnHistory: history };
  return v1Input;
}

// The sold (priced) add-on keys of a stored estimate: the rows an accept would book.
function soldAddOnKeys(estimateData) {
  let data = estimateData;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { return []; } }
  const roots = [data, data?.result].filter((root) => root && typeof root === 'object');
  const items = roots.flatMap((root) => (Array.isArray(root.oneTime?.items) ? root.oneTime.items : []));
  return [...new Set(items
    .filter((row) => row && row.service === 'area_addon' && typeof row.addOnKey === 'string' && Number(row.price) > 0)
    .map((row) => row.addOnKey))];
}

function limitError(status, code, message, extra = {}) {
  return Object.assign(new Error(message), { status, statusCode: status, code, isOperational: true, ...extra });
}

// What the recheck applies to: the limited add-ons the estimate sold (priced rows only), for a known
// customer, while the gate is on. [] otherwise - nothing to read.
function recheckKeys(estimate, customer) {
  if (!isUuid(customer) || !require('../config/feature-gates').gateEnvValue('GATE_AREA_ADDONS')) return [];
  return limitedKeys(soldAddOnKeys(estimate && (estimate.estimate_data || estimate.estimateData)));
}

const HISTORY_STAFF_MESSAGE = 'The treatment history for this property could not be read, so the add-on yearly limits cannot be confirmed. Try again, or book the add-on by hand.';

/**
 * The recheck at accept / reserve / commit / staff booking: throws a 409 when a sold add-on's yearly
 * limit is now reached at this property (history can change between quote and accept), and a 409 with
 * its own code when the history cannot be read (fail closed for the chemical add-ons). Nothing for an
 * estimate with no priced add-on, with the gate off (the gated guards own that), or with no known
 * customer. `appliedOn` is the day the add-on will be applied (the booked visit); default today.
 * `database` should be the accept transaction. Staff get the dates; the customer gets the office hand-off.
 */
async function assertAreaAddOnLimitsOpen(database, { estimate, customerId = null, appliedOn = null, staff = false } = {}) {
  const customer = customerId || estimate.customer_id;
  const keys = recheckKeys(estimate, customer);
  if (!keys.length) return;
  let history;
  try {
    // In a savepoint: a failed read must not poison the transaction it runs inside (the 409 below is the answer).
    history = await savepointScope(database, (scoped) => loadAreaAddOnHistory(scoped, {
      customerId: customer, propertyId: estimate.property_id, keys, excludeEstimateId: estimate.id,
    }));
  } catch (err) {
    logger.warn(`[area-addon-limits] accept recheck history unavailable for estimate ${estimate.id}: ${err.code || err.name}: ${err.message}`);
    throw limitError(409, HISTORY_CODE, staff ? HISTORY_STAFF_MESSAGE : HISTORY_CUSTOMER_MESSAGE);
  }
  const reached = keys
    .map((key) => ({ key, verdict: areaAddOnLimitVerdict(key, history, { day: appliedOn }) }))
    .find(({ verdict }) => verdict && verdict.reason === LIMIT_REACHED_REASON);
  if (reached) throw limitError(409, LIMIT_CODE, staff ? reached.verdict.detail : LIMIT_CUSTOMER_MESSAGE, { addOnKey: reached.key, limit: reached.verdict });
}

// The same recheck as a refusal object for the callers that answer with a body instead of throwing:
// null, or { status: 409, body: { error, code } }.
async function areaAddOnLimitRefusal(database, options) {
  try {
    await assertAreaAddOnLimitsOpen(database, options);
    return null;
  } catch (err) {
    if (err && (err.code === LIMIT_CODE || err.code === HISTORY_CODE)) return { status: 409, body: { error: err.message, code: err.code } };
    throw err;
  }
}

// The job card line for a chemical add-on's product ("Application 1 of 2 in 12 months; last applied
// 2026-08-01."). The cards are already built; this adds `governed.use` to each card whose product is an
// add-on's limit product, from the visit's property history (its own visit left out). Display only: a
// failed read leaves the card as it was.
async function attachLimitUse(cards, { catalog, serviceId, visitDay, dbh }) {
  const governedCards = (cards || []).filter((card) => card && card.governed);
  if (!governedCards.length) return cards;
  try {
    const { matchCatalogProduct } = require('./waveguard-plan-engine');
    const visit = await dbh('scheduled_services').where({ id: serviceId }).first('customer_id', 'property_id');
    if (!visit || !isUuid(visit.customer_id)) return cards;
    const keyOfProduct = new Map();
    for (const key of limitedKeys(Object.keys(AREA_ADDONS.items))) {
      const hint = configOf(key).limitProduct;
      const product = matchCatalogProduct({ raw: hint, catalogProductHints: [hint] }, catalog);
      if (product) keyOfProduct.set(String(product.id), key);
    }
    const keys = governedCards.map((card) => keyOfProduct.get(String(card.id))).filter(Boolean);
    if (!keys.length) return cards;
    const history = await loadAreaAddOnHistory(dbh, { customerId: visit.customer_id, propertyId: visit.property_id, keys, asOf: visitDay, excludeVisitId: serviceId });
    for (const card of governedCards) {
      const key = keyOfProduct.get(String(card.id));
      const dates = key ? ((history.byKey[key] && history.byKey[key].dates) || []).filter((d) => d !== null) : null;
      if (key) card.governed = { ...card.governed, use: limitUseText(configOf(key), dates, visitDay) };
    }
  } catch (err) {
    logger.warn(`[area-addon-limits] job card use line skipped for ${serviceId}: ${err.code || err.name}: ${err.message}`);
  }
  return cards;
}

module.exports = {
  LIMIT_CODE,
  HISTORY_CODE,
  LIMIT_CUSTOMER_MESSAGE,
  HISTORY_CUSTOMER_MESSAGE,
  NOT_BOOKED_STATUSES,
  LIMIT_REACHED_REASON,
  HISTORY_UNAVAILABLE_REASON,
  loadAreaAddOnHistory,
  quoteAreaAddOnHistory,
  attachQuoteAreaAddOnHistory,
  quoteAreaAddOnHistoryForSave,
  applyAreaAddOnHistory,
  soldAddOnKeys,
  assertAreaAddOnLimitsOpen,
  areaAddOnLimitRefusal,
  attachLimitUse,
};
