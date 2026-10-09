'use strict';

/**
 * Area add-on yearly limits, the database side (owner ruling 2026-10-08, add-on-only limits).
 * The rules and wording are the pure module pricing-engine/area-addon-limits.js, fed by the one
 * table AREA_ADDONS.items; this file only READS the history that module is given and enforces it
 * at the points where an add-on is quoted, accepted, reserved or booked. It never blocks a
 * program visit: the rule is evaluated for an add-on row only.
 *
 * History = the applications of the add-on's product at the treatment PLACE in the last 12 months (Codex round 18: a label limit is
 * about the property, whoever the customer record is). The place is the property the caller names (else the known customer's
 * only property), widened to every customer_properties row of the same address_key, of any customer; with no property id the
 * estimate's (or the quote's) free-text address is parsed to that same key (the parse the accept links properties with) and, for a
 * visit that has no property id, compared as letters and digits. Counted for the place, across ALL customers: the FDACS
 * application ledger (`property_application_history`: program applications and add-on applications both land there; the known
 * customer's rows are scoped to the treated property the way application-limits scopes them, other customers' rows must be
 * provably at the place), the add-on visits already booked and not yet done (a visit whose own service is the add-on, or a
 * `scheduled_service_addons` row for it, on a visit that is not completed or cancelled; a visit with no property id is placed by
 * its source estimate's address), and the live holds of other estimates at the place (a hold is unowned until its accept, so it
 * names no customer of its own; holdIsHere decides by property ids when both sides have one, else by the treatment address). The
 * known customer's own rows that cannot be placed (no property id) keep counting for that customer. Only the visit rows the
 * caller names (the hold being graduated, the appointment being adopted, the rows a staff booking just made) and the estimate's
 * own unowned hold are left out: an accepted estimate booked a second time counts its first booking.
 *
 * Nothing known (no customer, property or address, a new lead with none) has no history: the add-on prices normally.
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
const { storedAreaAddOnRows } = require('./estimate-result-container');

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
const gateOn = () => require('../config/feature-gates').gateEnvValue('GATE_AREA_ADDONS');

// The catalog rows each limited add-on reads its history for, as a Map of key to ids: every row of the add-on's governed
// product, active or not (area-addon-governed-rate.js resolveGovernedProducts, the one resolver). A product deactivated
// in the Service Library keeps its ledger history, and so does a duplicate-named row of it. A limited add-on whose
// governed product has no catalog row has no readable ledger: that is an unreadable history (the callers answer it with
// the custom-quote line or the history-unavailable refusal), never an empty one.
async function limitProductIds(database, keys) {
  const serviceKeys = new Map(keys.map((key) => [configOf(key).serviceKey, key]));
  const resolved = await require('./area-addon-governed-rate').resolveGovernedProducts(database, [...serviceKeys.keys()]);
  const idsByKey = new Map();
  for (const [serviceKey, key] of serviceKeys) {
    const resolution = resolved.get(serviceKey);
    if (resolution && resolution.ids.length) idsByKey.set(key, resolution.ids);
  }
  const unresolved = keys.filter((key) => !idsByKey.has(key));
  if (unresolved.length) {
    throw Object.assign(new Error(`No catalog product for the limit of: ${unresolved.join(', ')}`), { code: 'AREA_ADDON_LIMIT_PRODUCT_UNRESOLVED' });
  }
  return idsByKey;
}

// The treated property: the one the caller names, else the customer's only active property, else
// null (the customer's whole history counts: a row that cannot be placed counts everywhere).
async function resolvePropertyId(database, customerId, propertyId) {
  if (isUuid(propertyId)) return propertyId;
  const rows = await database('customer_properties').where({ customer_id: customerId, active: true }).limit(2).select('id');
  return rows.length === 1 ? rows[0].id : null;
}

// The two forms one estimate's contact takes, comparable in SQL and in JS: the last 10 digits of the phone, and the address
// with everything but letters and digits dropped.
const phoneKey = (value) => { const digits = String(value || '').replace(/\D/g, ''); return digits.length >= 10 ? digits.slice(-10) : ''; };
const addressKey = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// THE PLACE (Codex round 18 on #6135: a label limit is about the treatment property, whoever the customer record is). Two people
// at one address (two estimate links, two phones) are two customers with two customer_properties rows of ONE address_key; the
// history is read for all of them.
// The place of a free-text estimate address in the two forms it is compared in: `text` (letters and digits only, the form the
// identity lock keys on) and `canon`, the customer_properties.address_key the same address carries. parseEstimateAddress is how
// the accept turns an estimate address into a property row and the address-keys module's addressKey is how that row's key is
// made (suffix, unit and ZIP+4 insensitive), so "1 Test Way Apt 4" and "1 test way, unit 4, 34202-1234" are one place. A partial
// parse has no city or ZIP to key on: text only.
function addressPlace(raw) {
  const text = addressKey(raw);
  const parts = text ? require('./estimate-property-linkage').parseEstimateAddress(raw) : null;
  return { text, canon: parts && !parts.partial ? require('./customer-property-address-keys').addressKey(parts) : '' };
}

// The address_keys of a place: those of the properties the caller names (a property id is the place's identity; the address text
// is not consulted then), else the key of the address. Reads only the named properties.
async function placeKeys(database, { seeds = [], address = '' }) {
  const seedIds = [...new Set(seeds.filter(isUuid))];
  const shape = addressPlace(address);
  const keys = new Set(seedIds.length ? [] : [shape.canon].filter(Boolean));
  if (seedIds.length) (await database('customer_properties').whereIn('id', seedIds).select('address_key')).forEach((row) => row.address_key && keys.add(row.address_key));
  return { seedIds, keys: [...keys].sort(), text: shape.text };
}

// The place a history is read for: { ids, keys, text }. `ids` are the named properties and every customer_properties row, of any
// customer, carrying the place's key. The caller's property ids, else the address (its estimate's or the quote's).
async function resolvePlace(database, options) {
  const { seedIds, keys, text } = await placeKeys(database, options);
  const siblings = keys.length ? await database('customer_properties').whereIn('address_key', keys).select('id') : [];
  return { ids: [...new Set([...seedIds, ...siblings.map((row) => String(row.id))])], keys, text };
}

const placeIsKnown = (place) => place.ids.length > 0 || Boolean(place.text);

// Does this free-text estimate address sit at the place? The same letters and digits, or the same canonical key.
function addressIsAtPlace(raw, place) {
  const there = addressPlace(raw);
  return Boolean(there.text) && (there.text === place.text || place.keys.includes(there.canon));
}

// Applications of each key's product in the last 12 months, from the ledger: the known customer's at the treated property (the
// scope application-limits uses), and those of every OTHER customer at the place (the frozen property id on the row, else, for a
// legacy row with none, its visit's property).
async function ledgerDates(database, { customerId, propertyId, place, productByKey, asOf, excludeVisitId }) {
  const ids = [...productByKey.values()].flat();
  const out = new Map();
  if (!ids.length) return out;
  const known = isUuid(customerId);
  const applicationLimits = require('./application-limits');
  const recent = () => database('property_application_history').whereIn('product_id', ids)
    .where('application_date', '>', addDays(asOf, -WINDOW_DAYS)).whereNull('retracted_at');
  const scope = (query, treated) => applicationLimits.scopeHistoryToTreatment(query, database, { propertyId: treated, excludeScheduledServiceId: excludeVisitId }, 'property_application_history')
    .select('product_id', 'application_date');
  const [own, placed] = await Promise.all([
    known ? scope(recent().where({ customer_id: customerId }), propertyId) : [],
    place.ids.length ? scope(ledgerAtPlace(database, recent(), place.ids, known ? customerId : null), null) : [],
  ]);
  const keyOfProduct = new Map([...productByKey].flatMap(([key, productIds]) => productIds.map((id) => [String(id), key])));
  for (const row of [...own, ...placed]) {
    const key = keyOfProduct.get(String(row.product_id));
    if (key) out.set(key, [...(out.get(key) || []), dayOf(row.application_date)]);
  }
  return out;
}

// The ledger rows of customers other than `customerId` that are provably at the place.
function ledgerAtPlace(database, query, propertyIds, customerId) {
  if (customerId) query.whereNot('customer_id', customerId);
  return query.where(function placedAtPlace() {
    this.whereIn('property_id', propertyIds).orWhere(function legacyRowOfAVisitHere() {
      this.whereNull('property_id').whereIn('service_record_id', database('service_records as sr')
        .join('scheduled_services as ss', 'ss.id', 'sr.scheduled_service_id').whereIn('ss.property_id', propertyIds).select('sr.id'));
    });
  });
}

// The add-on visits booked and not done that `restrict` keeps, as { service_key, scheduled_date, source_estimate_id } rows: a
// visit whose own service is the add-on, and the add-on rows of any visit. `skip` are the visit ids the caller is committing
// right now (never "every row of the estimate": a second booking from an accepted estimate must see the first).
async function bookedVisitRows(database, { serviceKeys, skip, restrict }) {
  const live = (query) => {
    query.whereNotIn('s.status', NOT_BOOKED_STATUSES);
    if (skip.length) query.whereNotIn('s.id', skip);
    return restrict(query);
  };
  const columns = (prefix) => [`${prefix}.service_key_snapshot as service_key`, 's.scheduled_date', 's.source_estimate_id'];
  const [own, rows] = await Promise.all([
    live(database('scheduled_services as s').whereIn('s.service_key_snapshot', serviceKeys)).select(...columns('s')),
    live(database('scheduled_service_addons as a').join('scheduled_services as s', 's.id', 'a.scheduled_service_id').whereIn('a.service_key_snapshot', serviceKeys)).select(...columns('a')),
  ]);
  return [...own, ...rows];
}

// A visit that belongs to a customer other than the one being read.
const ofAnotherCustomer = (query, customerId) => {
  query.whereNotNull('s.customer_id');
  if (isUuid(customerId)) query.whereNot('s.customer_id', customerId);
  return query;
};

// Visits of other customers with no property id of their own, placed by the address of the estimate they were booked from.
async function unplacedVisitsAtPlace(database, base, place, customerId) {
  const rows = await bookedVisitRows(database, { ...base, restrict: (query) => ofAnotherCustomer(query, customerId).whereNull('s.property_id').whereNotNull('s.source_estimate_id') });
  if (!rows.length) return [];
  const estimates = await database('estimates').whereIn('id', [...new Set(rows.map((row) => row.source_estimate_id))]).select('id', 'address');
  const here = new Set(estimates.filter((row) => addressIsAtPlace(row.address, place)).map((row) => String(row.id)));
  return rows.filter((row) => here.has(String(row.source_estimate_id)));
}

// Add-on visits already booked and not done: the known customer's at the treated property (a visit with no property id counts),
// those of ANY customer at the place (by the visit's property id, else by its source estimate's address), and the live holds at
// the place (see heldDates).
async function bookedDates(database, { customerId, propertyId, place, keys, excludeVisitIds = [], prospect = null }) {
  const keyOfService = new Map(keys.map((key) => [configOf(key).serviceKey, key]));
  const base = { serviceKeys: [...keyOfService.keys()], skip: excludeVisitIds.filter(isUuid) };
  const mine = (query) => {
    query.where('s.customer_id', customerId);
    if (propertyId) query.where(function placedHereOrUnplaced() { this.whereNull('s.property_id').orWhere('s.property_id', propertyId); });
    return query;
  };
  const [own, here, unplaced, held] = await Promise.all([
    isUuid(customerId) ? bookedVisitRows(database, { ...base, restrict: mine }) : [],
    place.ids.length ? bookedVisitRows(database, { ...base, restrict: (query) => ofAnotherCustomer(query, customerId).whereIn('s.property_id', place.ids) }) : [],
    placeIsKnown(place) ? unplacedVisitsAtPlace(database, base, place, customerId) : [],
    heldDates(database, { estimateId: prospect && prospect.estimateId, place, keys, skip: base.skip }),
  ]);
  const out = new Map();
  for (const row of [...own, ...here, ...unplaced]) {
    const key = keyOfService.get(row.service_key);
    if (key && row.scheduled_date) out.set(key, [...(out.get(key) || []), dayOf(row.scheduled_date)]);
  }
  for (const [key, dates] of held) out.set(key, [...(out.get(key) || []), ...dates]);
  return out;
}

const prospectOf = (estimate) => ({
  estimateId: estimate && estimate.id,
  phone: phoneKey(estimate && estimate.customer_phone),
  address: addressKey(estimate && estimate.address),
  rawAddress: String((estimate && estimate.address) || ''),
  propertyId: estimate && isUuid(estimate.property_id) ? estimate.property_id : null,
});

// Does this hold sit at the place? A hold names no customer, so it may lack a reliable property identity. With a property id on
// BOTH sides (the hold's own, else its estimate's; the place's property ids) the ids decide, whatever the phone or the address
// say. Otherwise the treatment ADDRESS must be the place's (holdsAddressIsAt): a phone alone never places a hold, because one
// phone can have estimates at several properties.
function holdIsHere(hold, theirs, place) {
  const theirProperty = [hold.property_id, theirs.property_id].find(isUuid) || null;
  if (theirProperty && place.ids.length) return place.ids.some((id) => String(id) === String(theirProperty));
  return addressIsAtPlace(theirs.address, place);
}

// Live holds (customer-less rows with an expiry) of OTHER estimates AT this place, whoever their phone belongs to: a hold names
// no customer of its own until its accept, and the add-ons it will book are on its estimate, not on the hold row. The estimate's
// own hold is the one being replaced or graduated, so it never counts against itself.
async function heldDates(database, { estimateId = null, place, keys, skip = [] }) {
  if (!placeIsKnown(place)) return new Map();
  const grace = require('./slot-reservation').commitGraceMinutes();
  const holds = await database('scheduled_services as s')
    .whereNull('s.customer_id').whereNotNull('s.source_estimate_id').whereNotNull('s.reservation_expires_at')
    .whereNotIn('s.status', NOT_BOOKED_STATUSES)
    .whereRaw('s.reservation_expires_at >= NOW() - make_interval(mins => ?)', [grace])
    .modify((query) => {
      if (place.ids.length) query.where(function placedHereOrUnplaced() { this.whereNull('s.property_id').orWhereIn('s.property_id', place.ids); });
      if (skip.length) query.whereNotIn('s.id', skip);
      if (isUuid(estimateId)) query.whereNot('s.source_estimate_id', estimateId);
    })
    .select('s.source_estimate_id', 's.scheduled_date', 's.property_id');
  const out = new Map();
  if (!holds.length) return out;
  const estimates = await database('estimates').whereIn('id', [...new Set(holds.map((hold) => hold.source_estimate_id))])
    .select('id', 'estimate_data', 'pricing_authority', 'address', 'property_id');
  const byId = new Map(estimates.map((row) => [String(row.id), row]));
  for (const hold of holds) {
    const theirs = byId.get(String(hold.source_estimate_id));
    if (!theirs || !hold.scheduled_date || !holdIsHere(hold, theirs, place)) continue;
    const sold = soldAddOnKeys(theirs.estimate_data, { pricingAuthority: theirs.pricing_authority });
    for (const key of sold.filter((k) => keys.includes(k))) out.set(key, [...(out.get(key) || []), dayOf(hold.scheduled_date)]);
  }
  return out;
}

// Is anyone known to read a history for? A customer, a property, or an address (the place's history counts, whoever owns it).
const hasHistorySubject = (customerId, { propertyId, prospect, address }) => isUuid(customerId) || isUuid(propertyId)
  || Boolean(prospect && prospect.propertyId) || Boolean(addressKey(address));

// The treated property of the history read. A known customer: the caller's, else their only active property. No customer
// yet (a new lead): only the caller's own property id; the rest of the place comes from the address.
const historyProperty = (database, customerId, propertyId) => (isUuid(customerId)
  ? resolvePropertyId(database, customerId, propertyId)
  : (isUuid(propertyId) ? propertyId : null));

// The dates behind each wanted key: the ledger first, then the visits booked and held, sorted.
function assembleHistory(wanted, asOf, ledger, booked) {
  const byKey = {};
  for (const key of wanted) byKey[key] = { dates: [...(ledger.get(key) || []), ...(booked.get(key) || [])].filter(Boolean).sort() };
  return { available: true, asOf, byKey };
}

/**
 * The injected history summary for these add-on keys at the treatment PLACE, or throws when a read fails (the caller decides
 * what a failed read means). { available: true, asOf, byKey }. The place is the property the caller names (else the known
 * customer's only property), widened to every customer_properties row of the same address_key; with no property the estimate's
 * (or the quote's) address stands in. Keys with no limit (the web sweep) are not read. Nothing known (no customer, property or
 * address): no reads, an empty summary.
 */
async function loadAreaAddOnHistory(database, options = {}) {
  const { customerId, propertyId = null, keys = [], excludeVisitId = null, excludeVisitIds = [], prospect = null } = options;
  const asOf = options.asOf || etDateString();
  const wanted = limitedKeys(keys);
  const address = options.address || (prospect && prospect.rawAddress) || '';
  if (!wanted.length || !hasHistorySubject(customerId, { propertyId, prospect, address })) return { available: true, asOf, byKey: {} };
  const property = await historyProperty(database, customerId, propertyId);
  const place = await resolvePlace(database, { seeds: [property, prospect && prospect.propertyId], address });
  const productByKey = await limitProductIds(database, wanted);
  const [ledger, booked] = await Promise.all([
    ledgerDates(database, { customerId, propertyId: property, place, productByKey, asOf, excludeVisitId }),
    bookedDates(database, { customerId, propertyId: property, place, keys: wanted, excludeVisitIds: [...excludeVisitIds, excludeVisitId], prospect }),
  ]);
  return assembleHistory(wanted, asOf, ledger, booked);
}

// Is there anyone to read a quote history for? A verified customer, or a quoted address (a new lead at an address that has a history).
const hasQuoteSubject = (customerId, address) => isUuid(customerId) || Boolean(addressKey(address));

// What the QUOTE steps attach to the engine input (services.areaAddOnHistory): undefined when no limit can
// apply (gate off, no add-on with a limit, no known customer or address), the summary on success, and
// { available: false } when the read failed so the engine returns the custom-quote line, never a silent pass.
// `entries` are the request's add-on entries ({ key }), `customerId` the verified customer, `address` the quoted address.
async function quoteAreaAddOnHistory(database, { entries, customerId, propertyId = null, address = null, requesterRole = null } = {}) {
  const keys = limitedKeys((Array.isArray(entries) ? entries : []).map((entry) => entry && entry.key));
  const known = isUuid(customerId);
  if (!keys.length || !hasQuoteSubject(customerId, address) || !gateOn()) return undefined;
  // A place's treatment history (product, last date, next allowed date) is office data: only an admin requester reads it at
  // quote time. For a known customer anyone else gets the history-unavailable custom-quote line and no read is made; a new lead
  // (no customer, only an address) is priced as before. The accept, reserve and booking rechecks still enforce the limit.
  if (requesterRole !== 'admin') return known ? { available: false, reason: 'history_not_authorized' } : undefined;
  try {
    return await loadAreaAddOnHistory(database, { customerId, propertyId, address, keys });
  } catch (err) {
    logger.warn(`[area-addon-limits] quote history unavailable: ${err.code || err.name}: ${err.message}`);
    return { available: false, reason: 'history_unavailable' };
  }
}

// The same read for the estimator's two quote steps. `calculate` takes the engine input the translator built and
// the request options (existingCustomerId, propertyId, address); `save` takes the posted estimate data and body. Both return
// what to hand the engine (or undefined) and never throw.
// `requesterRole` is the authenticated staff role (req.techRole), never a value from the request body.
async function attachQuoteAreaAddOnHistory(database, v1Input, options, { requesterRole = null } = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const entries = v1Input && v1Input.services && v1Input.services.areaAddOns;
  return applyAreaAddOnHistory(v1Input, await quoteAreaAddOnHistory(database, {
    entries, customerId: opts.existingCustomerId || opts.customerId, propertyId: opts.propertyId, address: opts.address, requesterRole,
  }));
}
// The save knows the saving technician's id, not the role: the role is read from the technicians row (active staff only).
async function requesterRoleOf(database, technicianId) {
  if (!isUuid(technicianId)) return null;
  const row = await database('technicians').where({ id: technicianId, active: true }).first('role');
  return row ? row.role : null;
}
async function quoteAreaAddOnHistoryForSave(database, estimateData, body, { technicianId = null } = {}) {
  const fromRequest = estimateData && estimateData.engineRequest && estimateData.engineRequest.options && estimateData.engineRequest.options.areaAddOns;
  const fromInputs = estimateData && estimateData.engineInputs && estimateData.engineInputs.services && estimateData.engineInputs.services.areaAddOns;
  const entries = fromRequest || fromInputs;
  const { customerId, propertyId, address } = body || {};
  // No limited add-on, no customer and no address, or the gate off: nothing is read, not even the role.
  const keys = limitedKeys((Array.isArray(entries) ? entries : []).map((entry) => entry && entry.key));
  if (!keys.length || !hasQuoteSubject(customerId, address) || !gateOn()) return undefined;
  let requesterRole = null;
  try { requesterRole = await requesterRoleOf(database, technicianId); } catch (err) {
    logger.warn(`[area-addon-limits] requester role unavailable: ${err.code || err.name}: ${err.message}`);
  }
  return quoteAreaAddOnHistory(database, { entries, customerId, propertyId, address, requesterRole });
}

// Server-authoritative: the history on an engine input comes from the server, never from a client-posted copy.
function applyAreaAddOnHistory(v1Input, history) {
  if (!v1Input || typeof v1Input.services !== 'object' || v1Input.services === null) return v1Input;
  // A copy of `services`: the object may be shared with the posted estimate data, which is stored as sent.
  const { areaAddOnHistory: _posted, ...services } = v1Input.services;
  v1Input.services = history === undefined ? services : { ...services, areaAddOnHistory: history };
  return v1Input;
}

// The sold (priced) add-on keys of a stored estimate: the rows an accept would book. The rows are the
// authoritative container's (storedAreaAddOnRows, estimate-result-container.js: one answer for every
// reader, so a stale `engineResult` a revision left behind is never rechecked or booked, and an estimate
// whose only container is `engineResult` still is), and a row is priced by any amount field the booking
// normalizer reads. An unpriced custom-quote row is not booked. `pricingAuthority` is the row's
// `pricing_authority`.
const SOLD_AMOUNT_FIELDS = ['priceAfterDiscount', 'amountAfterDiscount', 'totalAfterDiscount', 'price', 'amount', 'total'];
const isSoldAddOnRow = (row) => typeof row.addOnKey === 'string'
  && row.quoteRequired !== true && row.requiresCustomQuote !== true
  && SOLD_AMOUNT_FIELDS.some((field) => Number(row[field]) > 0);
function soldAddOnKeys(estimateData, options = {}) {
  return [...new Set(storedAreaAddOnRows(estimateData, options).filter(isSoldAddOnRow).map((row) => row.addOnKey))];
}

function limitError(status, code, message, extra = {}) {
  return Object.assign(new Error(message), { status, statusCode: status, code, isOperational: true, ...extra });
}

/**
 * The booking fence of one customer: the transaction-scoped customer-comms advisory lock every staff booking, Mark Won and
 * public accept of that customer already takes, so two bookings of one customer read and write the add-on history one at a
 * time. NON-BLOCKING on purpose: the callers already hold the estimate row, and a merge-undo locks the customer and then the
 * estimate, so a blocking take could deadlock; a busy account is the caller's own retryable 409 `CUSTOMER_BUSY_RETRY` and
 * nothing is written. Reentrant: a customer this transaction already locked passes. Held to the end of the transaction.
 */
async function fenceCustomerBookings(trx, customerId) {
  if (await require('../utils/customer-comms-lock').tryLockCustomerComms(trx, customerId)) return;
  throw limitError(409, 'CUSTOMER_BUSY_RETRY', 'This account is being updated right now — please retry your acceptance in a moment.');
}

// What the recheck applies to: the limited add-ons the estimate sold (priced rows only), while the gate
// is on. [] otherwise - nothing to read.
function recheckKeys(estimate) {
  if (!gateOn()) return [];
  return limitedKeys(soldAddOnKeys(estimate && (estimate.estimate_data || estimate.estimateData), { pricingAuthority: estimate && estimate.pricing_authority }));
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

// The transaction-scoped advisory locks that serialize two requests for one PLACE (and, with nobody named, one phone). The
// namespace is this check's own, so no other writer waits on it; take it AFTER the estimate row lock, the order the reserve and
// the accept both already run in. Keys, always in this class order: `phone:` (last 10 digits; only when no customer is named: a
// named customer is serialized by that customer's booking lock), `address:` (letters and digits), `property:` (the estimate's
// property id), then `place:` (each canonical address_key of the place, sorted: two people at one address have two customers, two
// phones and two property rows, and this is the one key they share). Outside a transaction it fences nothing, so it does nothing.
// `seeds` are the verified property ids the caller names beside the estimate's own.
async function lockProspectIdentity(database, estimate, { named = false, seeds = [] } = {}) {
  if (!database.isTransaction) return;
  const { phone, address, propertyId, rawAddress } = prospectOf(estimate);
  const take = (key) => database.raw("SELECT pg_advisory_xact_lock(hashtext('area-addon-identity'), hashtext(?::text))", [key]);
  for (const key of [!named && phone && `phone:${phone}`, address && `address:${address}`, propertyId && `property:${propertyId}`].filter(Boolean)) await take(key);
  if (!address && ![propertyId, ...seeds].some(isUuid)) return;
  // In a savepoint: a failed lookup must not poison the transaction it runs inside (the 409 is the answer).
  const { keys } = await savepointScope(database, (scoped) => placeKeys(scoped, { seeds: [propertyId, ...seeds], address: rawAddress }));
  for (const key of keys) await take(`place:${key}`);
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
 * (the phone match), called only when nothing else names a customer; `fenceCustomer(id)` is the caller's lock for a customer found that way. `appliedOn` is the day the add-on will
 * be applied (the booked visit); default the earliest day of `excludeVisitIds` (the rows being committed), else today. `database` should be the accept transaction. Staff get the
 * dates; the customer gets the office hand-off.
 */
// The booking customer and day, then the history for them: { day, history }. Everything that can fail on the way is one read
// (the caller turns a failure into the fail-closed 409).
async function readLimitHistory(database, { estimate, keys, customerId, property, resolveCustomer, fenceCustomer, fenceNamed = false, appliedOn, excludeVisitIds }) {
  // The caller named the visits it is committing but no day: the day is theirs (the earliest).
  const day = appliedOn || await visitsFirstDay(database, excludeVisitIds);
  const named = [customerId, estimate.customer_id];
  // Two accepts for one PLACE by different people (two phones, so two customers or none yet) share no customer lock and no phone:
  // serialize on the place (its address and property keys) BEFORE the read, named customer or not, and, with nobody named yet
  // (a new lead accepting), on the phone too. The customer lock a named customer's booking takes serializes that customer only.
  await lockProspectIdentity(database, estimate, { named: named.some(isUuid), seeds: [property && property.property_id] });
  const subject = await limitSubject(database, estimate, { customerId, propertyId: property && property.property_id, resolveCustomer });
  // A customer this check found for itself (the group's owner, a linked appointment's, the phone match) is not one the caller
  // has locked: the caller's own fence takes the lock that serializes that customer's bookings before the read. A caller
  // that locks nobody up front (the customer's reserve: it holds the estimate row only) says so with `fenceNamed`, and the
  // customer the estimate names is fenced too.
  if (fenceCustomer && subject.customerId && (fenceNamed || !named.includes(subject.customerId))) await fenceCustomer(subject.customerId);
  // In a savepoint: a failed read must not poison the transaction it runs inside (the 409 is the answer).
  const history = await savepointScope(database, (scoped) => loadAreaAddOnHistory(scoped, {
    customerId: subject.customerId, propertyId: subject.propertyId, keys, excludeVisitIds, prospect: prospectOf(estimate),
  }));
  return { day, history };
}

async function assertAreaAddOnLimitsOpen(database, { estimate, staff = false, ...options } = {}) {
  const keys = recheckKeys(estimate);
  if (!keys.length) return;
  let read;
  try {
    read = await readLimitHistory(database, { estimate, keys, excludeVisitIds: [], ...options });
  } catch (err) {
    // The caller's own retryable answer (the customer is being updated right now) is not a history failure.
    if (err && err.code === 'CUSTOMER_BUSY_RETRY') throw err;
    logger.warn(`[area-addon-limits] accept recheck history unavailable for estimate ${estimate.id}: ${err.code || err.name}: ${err.message}`);
    throw limitError(409, HISTORY_CODE, staff ? HISTORY_STAFF_MESSAGE : HISTORY_CUSTOMER_MESSAGE);
  }
  const { day, history } = read;
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

// ---------------------------------------------------------------------------------------------------------------------
// A booked visit that MOVES (Codex round 18 P1): the booking verdict belongs to the day and the place it was made for.
//
// A visit that carries a limited area add-on (its own service, or an add-on row) keeps the verdict of its old date and place when
// it is moved, so a visit booked before the limit was reached elsewhere, or moved beside another application of the product, would
// break the add-on's yearly limit. Every mover of a booked visit's date or property calls this inside its own transaction, before
// it writes: the same place-based history the booking reads (loadAreaAddOnHistory), this visit left out, judged on the NEW day.
// Nothing is read for a visit that carries no limited add-on (one query) or that stays on its day and place. Keyed on the data,
// never on GATE_AREA_ADDONS: a visit booked gate-on is moved gate-off. Staff get the dates; a customer-facing caller gets the
// office hand-off, never the dates. A time-of-day or technician change is not a move and is not asked.
// ---------------------------------------------------------------------------------------------------------------------
const MOVE_CUSTOMER_MESSAGE = 'An add-on treatment on this appointment cannot be moved to that day. Please contact our office and we will find a day that works.';
const MOVE_HISTORY_STAFF_MESSAGE = 'The treatment history for this property could not be read, so the add-on yearly limits cannot be confirmed for the new day. Try again.';

// The catalog keys of the add-on rows on one visit ([] when none). A read failure is the caller's (fail closed).
async function visitRowServiceKeys(database, visitId) {
  const rows = await database('scheduled_service_addons').where({ scheduled_service_id: visitId }).select('service_key_snapshot');
  return rows.map((row) => row.service_key_snapshot).filter(Boolean);
}

// The place of a visit that has no property of its own: its source estimate's address stands in (or null).
async function visitProspect(database, visit, property) {
  if (isUuid(property) || !isUuid(visit.source_estimate_id)) return null;
  const estimate = await database('estimates').where({ id: visit.source_estimate_id }).first('id', 'address', 'property_id', 'customer_phone');
  return estimate ? { estimate, prospect: prospectOf(estimate) } : null;
}

async function movedVisitHistory(database, { visit, visitId, property, keys }) {
  const found = await visitProspect(database, visit, property);
  // Two requests for one place share this key, and a move waits behind a booking of the same place.
  await lockProspectIdentity(database, found ? found.estimate : { property_id: isUuid(property) ? property : null }, { named: true, seeds: [property] });
  return savepointScope(database, (scoped) => loadAreaAddOnHistory(scoped, {
    customerId: visit.customer_id, propertyId: isUuid(property) ? property : null, keys, excludeVisitIds: [visitId], prospect: found ? found.prospect : null,
  }));
}

// What a move asks about: { row, day, property, keys } (the visit, the day and property it lands on, the LIMITED add-on keys it
// carries), or null when there is nothing to ask (no such visit, the same day and place, no limited add-on).
async function movedVisitSubject(database, options) {
  const { visitId, scheduledDate, propertyId, serviceKeys, force } = options;
  if (!isUuid(visitId)) return null;
  const row = options.visit || await database('scheduled_services').where({ id: visitId }).first('customer_id', 'property_id', 'scheduled_date', 'source_estimate_id', 'service_key_snapshot');
  if (!row) return null;
  const day = dayOf(scheduledDate || row.scheduled_date);
  const property = propertyId || row.property_id || null;
  if (!force && day === dayOf(row.scheduled_date) && String(property || '') === String(row.property_id || '')) return null;
  const carried = serviceKeys || [row.service_key_snapshot, ...(await visitRowServiceKeys(database, visitId))];
  const keys = limitedKeys(carried.map((serviceKey) => limitKeyOfServiceKey(serviceKey)).filter(Boolean));
  return keys.length ? { row, day, property, keys } : null;
}

/**
 * Refuses (409) a move of a booked visit onto a day (or a property) where a limited add-on it carries is at its limit. Options:
 * `visitId`; `visit`, the visit's row when the caller holds it ({ customer_id, property_id, scheduled_date, source_estimate_id,
 * service_key_snapshot }; else it is read); `scheduledDate` / `propertyId`, the new day and property (default: the visit's own);
 * `serviceKeys`, the catalog keys the visit will carry (default: its own service and its add-on rows); `force`, ask even when day
 * and property are unchanged (an edit that adds an add-on); `staff`, the detail names dates (otherwise the office hand-off).
 */
async function assertMovedVisitLimitsOpen(database, options = {}) {
  const subject = await movedVisitSubject(database, options);
  if (!subject) return;
  const { row, day, property, keys } = subject;
  let history;
  try {
    history = await movedVisitHistory(database, { visit: row, visitId: options.visitId, property, keys });
  } catch (err) {
    logger.warn(`[area-addon-limits] move recheck history unavailable for visit ${options.visitId}: ${err.code || err.name}: ${err.message}`);
    throw limitError(409, HISTORY_CODE, options.staff ? MOVE_HISTORY_STAFF_MESSAGE : MOVE_CUSTOMER_MESSAGE);
  }
  const reached = keys
    .map((key) => ({ key, verdict: areaAddOnLimitVerdict(key, history, { day }) }))
    .find(({ verdict }) => verdict && verdict.reason === LIMIT_REACHED_REASON);
  if (reached) throw limitError(409, LIMIT_CODE, options.staff ? reached.verdict.detail : MOVE_CUSTOMER_MESSAGE, { addOnKey: reached.key, limit: reached.verdict });
}

// The limit key (AREA_ADDONS.items key) of a catalog service key, or null when the add-on has no limit.
const limitKeyOfServiceKey = (serviceKey) => limitedKeys(Object.keys(AREA_ADDONS.items)).find((key) => configOf(key).serviceKey === serviceKey) || null;

// The job card line for a chemical add-on's product ("Application 1 of 2 in 12 months; last applied
// 2026-08-01."). The cards are already built; this adds `governed.use` to each card that is an add-on's own card
// (`addOnKey`, the add-on's catalog service key: a host card of the same product has none), from the visit's property
// history (its own visit left out). Display only: a failed read leaves the card as it was.
async function attachLimitUse(cards, { serviceId, visitDay, dbh }) {
  const governedCards = (cards || []).filter((card) => card && card.governed && card.addOnKey);
  if (!governedCards.length) return cards;
  try {
    const visit = await dbh('scheduled_services').where({ id: serviceId }).first('customer_id', 'property_id');
    if (!visit || !isUuid(visit.customer_id)) return cards;
    const keyOfCard = new Map(governedCards.map((card) => [card, limitKeyOfServiceKey(card.addOnKey)]));
    const keys = [...keyOfCard.values()].filter(Boolean);
    if (!keys.length) return cards;
    const history = await loadAreaAddOnHistory(dbh, { customerId: visit.customer_id, propertyId: visit.property_id, keys, asOf: visitDay, excludeVisitId: serviceId });
    for (const [card, key] of keyOfCard) {
      if (!key) continue;
      const dates = ((history.byKey[key] && history.byKey[key].dates) || []).filter((d) => d !== null);
      card.governed = { ...card.governed, use: limitUseText(configOf(key), dates, visitDay) };
    }
  } catch (err) {
    logger.warn(`[area-addon-limits] job card use line skipped for ${serviceId}: ${err.code || err.name}: ${err.message}`);
  }
  return cards;
}

// ---------------------------------------------------------------------------------------------------------------------
// The completion audit of an add-on's OWN yearly limit (Codex round 18 P1).
//
// The chemical add-ons have NO product_limits rows by owner ruling ("add-on-only limits, no product-wide rows"), so the closeout's
// hard-limit audit (application-limits auditHardCountLimits) reads nothing for Snapshot, Topchoice, Acelepryn or QuikPro, and a
// Tree & Shrub or pest host that carries such an add-on was never audited at all. This check judges each application recorded
// for an add-on (a service_products row tagged `area_addon_key`) against that add-on's own limit (AREA_ADDONS.items maxPerYear /
// minDaysApart), on the same place-based history the booking uses, with this visit's own ledger rows left out; a second
// application of the product on the same record counts as a same-day application, so a host row plus an add-on row of one
// product, or two rows of the add-on, break a spacing rule or a count that the first one met. The work is done and ledgered,
// so the result is only ever an advisory finding for the office. A host program row without a tag is never judged here.
// ---------------------------------------------------------------------------------------------------------------------
const YEARLY_LIMIT_TYPE = 'area_addon_yearly_limit';

// The tagged rows of one record that belong to a LIMITED add-on: { key, productName, productId }. [] before the column exists.
async function limitedAddOnRows(database, recordId) {
  const cols = await database('service_products').columnInfo();
  if (!cols.area_addon_key) return [];
  const rows = await database('service_products').where({ service_record_id: recordId }).whereNotNull('area_addon_key')
    .select('product_id', 'product_name', 'area_addon_key');
  return rows.map((row) => ({ key: limitKeyOfServiceKey(row.area_addon_key), productId: row.product_id || null, productName: row.product_name }))
    .filter((row) => row.key);
}

// Applications of the add-on's product recorded on this record (live ledger rows only).
async function ownApplicationCount(database, recordId, productIds) {
  const row = await database('property_application_history').where({ service_record_id: recordId }).whereIn('product_id', productIds)
    .whereNull('retracted_at').count('* as n').first();
  return Number(row && row.n) || 0;
}

async function yearlyLimitFindings(database, { svc, record, rows }) {
  const keys = [...new Set(rows.map((row) => row.key))];
  const day = dayOf(record.service_date || svc.scheduled_date) || etDateString();
  const [history, products] = await Promise.all([
    loadAreaAddOnHistory(database, { customerId: svc.customer_id, propertyId: svc.property_id, keys, excludeVisitId: svc.id, asOf: day }),
    limitProductIds(database, keys),
  ]);
  const findings = [];
  for (const key of keys) {
    const extra = Math.max(0, (await ownApplicationCount(database, record.id, products.get(key))) - 1);
    const dates = [...((history.byKey[key] && history.byKey[key].dates) || []), ...Array(extra).fill(day)];
    const verdict = areaAddOnLimitVerdict(key, { available: true, asOf: day, byKey: { [key]: { dates } } }, { day });
    if (!verdict || verdict.reason !== LIMIT_REACHED_REASON) continue;
    const row = rows.find((entry) => entry.key === key);
    findings.push({
      code: 'application_limit_exceeded',
      productId: row.productId,
      productName: row.productName,
      limitType: YEARLY_LIMIT_TYPE,
      current: verdict.count,
      max: verdict.max,
      detail: verdict.detail,
      message: `Recorded. The office will review: ${verdict.detail}`,
    });
  }
  return findings;
}

/**
 * The completion check for the add-ons' own yearly limits. `addOnRows` is false when the closeout has no row tagged to an add-on
 * (nothing is read then). `notify` sends the findings to the office; the merged advisory comes back (the same object when nothing
 * is over). A history that cannot be read is one 'unavailable' finding, never a throw and never a block.
 */
async function flagAddOnYearlyLimits({ svc, record, database, advisory, notify, addOnRows = true }) {
  if (!addOnRows || !svc || !record || !record.id) return advisory;
  let findings;
  try {
    const rows = await limitedAddOnRows(database, record.id);
    findings = rows.length ? await yearlyLimitFindings(database, { svc, record, rows }) : [];
  } catch (err) {
    logger.warn(`[area-addon-limits] completion limit check failed for record ${record.id}: ${err.code || err.name}: ${err.message}`);
    findings = [{ code: 'application_limit_check_unavailable', productId: null, message: 'Recorded. The office will review: product limits could not be checked for this visit.' }];
  }
  if (!findings.length) return advisory;
  await notify({ svc, record, findings });
  return { advisory: true, blocks: [...((advisory && advisory.blocks) || []), ...findings.map((f) => ({ code: f.code, message: f.message, productId: f.productId }))] };
}

module.exports = {
  MOVE_CUSTOMER_MESSAGE,
  assertMovedVisitLimitsOpen,
  YEARLY_LIMIT_TYPE,
  flagAddOnYearlyLimits,
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
  fenceCustomerBookings,
  attachLimitUse,
  limitSubject,
  phoneKey,
  addressKey,
};
