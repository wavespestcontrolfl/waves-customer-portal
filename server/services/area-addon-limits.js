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
 * completed or cancelled), PLUS the live holds of other estimates that share the customer, the phone or (no phone) the
 * address (a hold is unowned until its accept, so it names no customer of its own). Only the visit rows the caller names
 * (the hold being graduated, the appointment being adopted, the rows a staff booking just made) and the estimate's own
 * unowned hold are left out: an accepted estimate booked a second time counts its first booking.
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
    const hint = configOf(key)?.limitProduct;
    const product = hint ? matchCatalogProduct({ raw: hint, catalogProductHints: [hint] }, catalog) : null;
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

// Add-on visits already booked and not done, at this property. `excludeVisitIds` are the rows the caller is
// committing right now (never "every row of the estimate": a second booking from an accepted estimate must see
// the first). Holds of other estimates that share the customer, phone or address count too (see heldDates).
async function bookedDates(database, { customerId, propertyId, keys, excludeVisitIds = [], prospect = null }) {
  const serviceKeys = keys.map((key) => configOf(key).serviceKey);
  const keyOfService = new Map(keys.map((key) => [configOf(key).serviceKey, key]));
  const skip = excludeVisitIds.filter(isUuid);
  const place = (query) => {
    if (propertyId) query.where(function placedHereOrUnplaced() { this.whereNull('s.property_id').orWhere('s.property_id', propertyId); });
    if (skip.length) query.whereNotIn('s.id', skip);
    return query;
  };
  const scope = (query) => place(query.where('s.customer_id', customerId).whereNotIn('s.status', NOT_BOOKED_STATUSES));
  const [own, rows, held] = await Promise.all([
    isUuid(customerId) ? scope(database('scheduled_services as s').whereIn('s.service_key_snapshot', serviceKeys)).select('s.service_key_snapshot as service_key', 's.scheduled_date') : [],
    isUuid(customerId) ? scope(database('scheduled_service_addons as a').join('scheduled_services as s', 's.id', 'a.scheduled_service_id').whereIn('a.service_key_snapshot', serviceKeys))
      .select('a.service_key_snapshot as service_key', 's.scheduled_date') : [],
    heldDates(database, { customerId, keys, place, prospect }),
  ]);
  const out = new Map();
  for (const row of [...own, ...rows]) {
    const key = keyOfService.get(row.service_key);
    if (key && row.scheduled_date) out.set(key, [...(out.get(key) || []), dayOf(row.scheduled_date)]);
  }
  for (const [key, dates] of held) out.set(key, [...(out.get(key) || []), ...dates]);
  return out;
}

// The two forms one person's contact takes in the estimates table, comparable in SQL and in JS: the last 10 digits of
// the phone, and the address with everything but letters and digits dropped.
const phoneKey = (value) => { const digits = String(value || '').replace(/\D/g, ''); return digits.length >= 10 ? digits.slice(-10) : ''; };
const addressKey = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const prospectOf = (estimate) => ({ estimateId: estimate && estimate.id, phone: phoneKey(estimate && estimate.customer_phone), address: addressKey(estimate && estimate.address) });

// Live holds (customer-less rows with an expiry) of OTHER estimates of the same person: a hold names no customer of its
// own until its accept, and the add-ons it will book are on its estimate, not on the hold row. Same person = the known
// customer's estimate, the same phone, or, when the estimate has no phone, the same address. The estimate's own hold is
// the one being replaced or graduated, so it never counts against itself.
async function heldDates(database, { customerId, keys, place, prospect }) {
  const { estimateId = null, phone = '', address = '' } = prospect || {};
  if (!isUuid(customerId) && !phone && !address) return new Map();
  const grace = require('./slot-reservation').commitGraceMinutes();
  const holds = await place(database('scheduled_services as s')
    .whereNull('s.customer_id').whereNotNull('s.source_estimate_id').whereNotNull('s.reservation_expires_at')
    .whereNotIn('s.status', NOT_BOOKED_STATUSES)
    .whereRaw('s.reservation_expires_at >= NOW() - make_interval(mins => ?)', [grace]))
    .modify((query) => { if (isUuid(estimateId)) query.whereNot('s.source_estimate_id', estimateId); })
    .select('s.source_estimate_id', 's.scheduled_date');
  const out = new Map();
  if (!holds.length) return out;
  const estimates = await database('estimates').whereIn('id', [...new Set(holds.map((hold) => hold.source_estimate_id))])
    .where(function sameContact() {
      if (isUuid(customerId)) this.orWhere('customer_id', customerId);
      if (phone) this.orWhereRaw("right(regexp_replace(COALESCE(customer_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [phone]);
      else if (address) this.orWhereRaw("regexp_replace(lower(COALESCE(address, '')), '[^a-z0-9]', '', 'g') = ?", [address]);
    })
    .select('id', 'estimate_data');
  const soldBy = new Map(estimates.map((row) => [String(row.id), soldAddOnKeys(row.estimate_data)]));
  for (const hold of holds) {
    for (const key of (soldBy.get(String(hold.source_estimate_id)) || []).filter((k) => keys.includes(k))) {
      if (hold.scheduled_date) out.set(key, [...(out.get(key) || []), dayOf(hold.scheduled_date)]);
    }
  }
  return out;
}

/**
 * The injected history summary for these add-on keys at this customer's property, or throws when a
 * read fails (the caller decides what a failed read means). { available: true, asOf, byKey }.
 * Keys with no limit (the web sweep) are not read. No known customer: no reads, an empty summary.
 */
async function loadAreaAddOnHistory(database, { customerId, propertyId = null, keys = [], asOf = etDateString(), excludeVisitId = null, excludeVisitIds = [], prospect = null } = {}) {
  const wanted = limitedKeys(keys);
  const empty = { available: true, asOf, byKey: {} };
  const known = isUuid(customerId);
  if (!wanted.length || !(known || (prospect && (prospect.phone || prospect.address)))) return empty;
  // No customer yet (a new lead): the ledger is keyed by customer and has nothing; only the holds of the same person count.
  const property = known ? await resolvePropertyId(database, customerId, propertyId) : (isUuid(propertyId) ? propertyId : null);
  const productByKey = known ? await productIdsByKey(database, wanted) : new Map();
  const [ledger, booked] = await Promise.all([
    known ? ledgerDates(database, { customerId, propertyId: property, productByKey, asOf, excludeVisitId }) : new Map(),
    bookedDates(database, { customerId, propertyId: property, keys: wanted, excludeVisitIds: [...excludeVisitIds, excludeVisitId], prospect }),
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
  return applyAreaAddOnHistory(v1Input, await quoteAreaAddOnHistory(database, { entries, customerId: opts.existingCustomerId || opts.customerId, propertyId: opts.propertyId }));
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

// What the recheck applies to: the limited add-ons the estimate sold (priced rows only), while the gate
// is on. [] otherwise - nothing to read.
function recheckKeys(estimate) {
  if (!require('../config/feature-gates').gateEnvValue('GATE_AREA_ADDONS')) return [];
  return limitedKeys(soldAddOnKeys(estimate && (estimate.estimate_data || estimate.estimateData)));
}

/**
 * The customer and property whose history the recheck reads. THE RULE: if a customer or property is known
 * by the time of the check, the history is read; "no customer" passes only when none is known at all. An
 * estimate row can have no customer_id (a lead or standalone estimate) while the request, the accept, a
 * booked appointment or its group names one, so the order is: the caller's verified customer and property
 * (the staff booking's, the public accept's locked or phone-matched customer), the estimate's own, the
 * appointment linked to the estimate (a staff booking, an adopted appointment), the owner of its estimate
 * group (the accepted sibling), then `resolveCustomer` (the caller's phone match). A linked appointment
 * supplies the property only for the customer it belongs to. Throws when a read fails (the caller fails
 * closed). customerId null = no customer known anywhere.
 */
async function limitSubject(database, estimate, { customerId = null, propertyId = null, resolveCustomer = null } = {}) {
  const customer = [customerId, estimate && estimate.customer_id].find(isUuid) || null;
  const property = [propertyId, estimate && estimate.property_id].find(isUuid) || null;
  if (!isUuid(estimate && estimate.id) || (customer && property)) return { customerId: customer, propertyId: property };
  const visit = await linkedVisit(database, estimate.id, customer);
  return {
    customerId: customer || (visit && visit.customer_id) || await unownedEstimateCustomer(database, estimate, resolveCustomer),
    propertyId: property || (visit && visit.property_id) || null,
  };
}

// The appointment linked to the estimate, when it belongs to the known customer (or when no customer is known
// yet): { customer_id, property_id } as uuids or null. In a savepoint: a failed read must not poison the
// transaction it runs inside.
async function linkedVisit(database, estimateId, customer) {
  const row = await savepointScope(database, (scoped) => scoped('scheduled_services')
    .where({ source_estimate_id: estimateId }).whereNotNull('customer_id').orderBy('created_at', 'desc').first('customer_id', 'property_id'));
  if (!row || !isUuid(row.customer_id) || (customer && String(row.customer_id) !== String(customer))) return null;
  return { customer_id: row.customer_id, property_id: isUuid(row.property_id) ? row.property_id : null };
}

// The customer of an estimate nothing else names: the owner of its estimate group (the accepted sibling), else
// the caller's phone match. null when neither finds one.
async function unownedEstimateCustomer(database, estimate, resolveCustomer) {
  const owner = await savepointScope(database, (scoped) => require('./recurring-card-on-file').resolveGroupedEstimateOwnerId(estimate, scoped, { throwOnError: true }));
  const resolved = isUuid(owner) ? owner : await (resolveCustomer ? resolveCustomer() : null);
  return isUuid(resolved) ? resolved : null;
}

// One transaction-scoped advisory lock per prospective identity: the phone's last 10 digits, then (also) the address. The
// namespace is this check's own, so no other writer waits on it; take it AFTER the estimate row lock, the order the
// reserve and the accept both already run in. Outside a transaction it fences nothing, so it does nothing.
async function lockProspectIdentity(database, estimate) {
  if (!database.isTransaction) return;
  const { phone, address } = prospectOf(estimate);
  for (const key of [phone && `phone:${phone}`, address && `address:${address}`].filter(Boolean)) {
    await database.raw("SELECT pg_advisory_xact_lock(hashtext('area-addon-identity'), hashtext(?::text))", [key]);
  }
}

// The earliest day of these visits (the rows a caller is committing), or null when none is named or found.
async function visitsFirstDay(database, ids) {
  const list = (ids || []).filter(isUuid);
  if (!list.length) return null;
  const rows = await database('scheduled_services as s').whereIn('s.id', list).select('s.scheduled_date');
  return rows.map((row) => dayOf(row.scheduled_date)).filter(Boolean).sort()[0] || null;
}

const HISTORY_STAFF_MESSAGE = 'The treatment history for this property could not be read, so the add-on yearly limits cannot be confirmed. Try again, or book the add-on by hand.';

/**
 * The recheck at accept / reserve / commit / staff booking: throws a 409 when a sold add-on's yearly
 * limit is now reached at this property (history can change between quote and accept), and a 409 with
 * its own code when the history cannot be read (fail closed for the chemical add-ons). Nothing for an
 * estimate with no priced add-on, with the gate off (the gated guards own that), or when no customer is
 * known at all (limitSubject). `customerId` and `property` ({ property_id }) are what the caller has verified (the
 * booking's customer and property); `resolveCustomer` is the caller's last resort for an unowned estimate
 * (the phone match), called only when nothing else names a customer. `appliedOn` is the day the add-on will
 * be applied (the booked visit); default the earliest day of `excludeVisitIds` (the rows being committed), else today. `database` should be the accept transaction. Staff get the
 * dates; the customer gets the office hand-off.
 */
async function assertAreaAddOnLimitsOpen(database, { estimate, customerId = null, property = null, resolveCustomer = null, appliedOn = null, staff = false, excludeVisitIds = [] } = {}) {
  const keys = recheckKeys(estimate);
  if (!keys.length) return;
  let history;
  let day = appliedOn;
  try {
    // The caller named the visits it is committing but no day: the day is theirs (the earliest).
    day = appliedOn || await visitsFirstDay(database, excludeVisitIds);
    // No customer named yet (a new lead accepting): two accepts by the same person would each read an empty history and both
    // commit. Serialize on who they are (phone, else address) BEFORE the read; a named customer is already serialized by the
    // customer lock every booking of that customer takes.
    if (![customerId, estimate.customer_id].some(isUuid)) await lockProspectIdentity(database, estimate);
    const subject = await limitSubject(database, estimate, { customerId, propertyId: property && property.property_id, resolveCustomer });
    // In a savepoint: a failed read must not poison the transaction it runs inside (the 409 below is the answer).
    history = await savepointScope(database, (scoped) => loadAreaAddOnHistory(scoped, {
      customerId: subject.customerId, propertyId: subject.propertyId, keys, excludeVisitIds, prospect: prospectOf(estimate),
    }));
  } catch (err) {
    // The caller's own retryable answer (the customer is being updated right now) is not a history failure.
    if (err && err.code === 'CUSTOMER_BUSY_RETRY') throw err;
    logger.warn(`[area-addon-limits] accept recheck history unavailable for estimate ${estimate.id}: ${err.code || err.name}: ${err.message}`);
    throw limitError(409, HISTORY_CODE, staff ? HISTORY_STAFF_MESSAGE : HISTORY_CUSTOMER_MESSAGE);
  }
  const reached = keys
    .map((key) => ({ key, verdict: areaAddOnLimitVerdict(key, history, { day: dayOf(day) }) }))
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
  productIdsByKey,
  limitSubject,
  phoneKey,
  addressKey,
};
