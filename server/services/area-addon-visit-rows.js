'use strict';

/**
 * Area add-ons on the booked visit (GATE_AREA_ADDONS, owner ruling 2026-10-08):
 * several add-ons on one estimate are ONE visit. The appointment stamps one
 * catalog service (the profile's primary, see primaryProfileService); every
 * OTHER sold area add-on becomes a structured `scheduled_service_addons` row on
 * that same appointment, written in the transaction that books it, so the job
 * card, the completion invoice, closeout and the visit's trace readers all see
 * every add-on the customer bought and not only the one in the visit's notes.
 *
 * Money contract (the admin schedule's own, services/invoice.js
 * buildScheduledServiceInvoiceLines): `scheduled_services.estimated_price`
 * stays the WHOLE visit total (the estimate's one-time total); each add-on row
 * carries only its own price, and the invoice's primary line is the total less
 * the add-on rows. Nothing here touches the parent price, so the invoice equals
 * the estimate's one-time total and no add-on is counted twice.
 *
 * Exactly once: rows are written only when a hold graduates (or a booked
 * appointment is adopted), never on the hold, so a released or expired hold
 * leaves nothing to clean up; and a row whose add-on is already on the visit
 * (a replayed accept, a second adoption) is skipped.
 */
const logger = require('./logger');
const { areaAddOnConfig, isAreaAddOnCatalogKey, AREA_ADDONS } = require('./pricing-engine/constants');

const AREA_ADDON_ENGINE_KEY = 'area_addon';
const AREA_ADDON_KEY_PREFIX = 'area_addon_';

// The profile service the appointment itself is stamped with. ONE rule for the
// catalog stamp (slot-reservation catalogLinkForProfile) and for "everything
// else is an add-on row" below. A service that is NOT an area add-on always
// outranks an add-on (a lawn treatment sold with a web sweep keeps its own
// completion profile, protocol and closeout requirements; the sweep becomes
// its add-on row). Within each group: the pest control row, else the first.
function primaryProfileService(serviceProfile = {}) {
  const services = Array.isArray(serviceProfile?.services) ? serviceProfile.services : [];
  const pestFirst = (rows) => rows.find((svc) => svc?.service === 'pest_control') || rows[0] || null;
  const hosts = services.filter((svc) => svc && svc.engineKey !== AREA_ADDON_ENGINE_KEY);
  return pestFirst(hosts) || pestFirst(services);
}

function areaAddOnProfileRows(serviceProfile = {}) {
  const services = Array.isArray(serviceProfile?.services) ? serviceProfile.services : [];
  return services.filter((svc) => svc?.engineKey === AREA_ADDON_ENGINE_KEY);
}

// The add-ons that need their own row: every sold area add-on except the one
// that already IS the visit's own service (`ownServiceKey`, a catalog key).
function secondaryAreaAddOns(serviceProfile, ownServiceKey = null) {
  return areaAddOnProfileRows(serviceProfile).filter((row) => !(ownServiceKey && row.catalogServiceKey === ownServiceKey));
}

function unresolvedError(row) {
  const err = new Error(`Area add-on "${row.label || 'unknown'}" cannot be booked as a visit line: its catalog key or price is missing. Rebuild the estimate.`);
  err.status = 409;
  err.statusCode = 409;
  err.code = 'AREA_ADDON_ROW_UNRESOLVED';
  err.isOperational = true;
  return err;
}

// What the estimate sold for one add-on, stored on the booked visit (`area_addon_scope` on
// scheduled_services for the add-on that IS the visit, on scheduled_service_addons for each
// row): the treated area the customer was quoted, the tier it priced at, and, for a
// grass-bound add-on, the grass that authorized the rate. The job card reads it back.
function soldScope(row) {
  const num = (value) => (Number(value) > 0 ? Number(value) : null);
  return {
    v: 1,
    addOnKey: row.addOnKey || null,
    catalogServiceKey: row.catalogServiceKey || null,
    areaSqFt: num(row.areaSqFt),
    tierSqFt: num(row.tierSqFt),
    grassType: row.grassType || null,
  };
}

function addOnRowData(row, catalog, cols, scheduledServiceId, trx) {
  const price = Math.round(Number(row.addOnPrice) * 100) / 100;
  const data = {
    scheduled_service_id: scheduledServiceId,
    service_id: catalog?.id || null,
    service_name: String(catalog?.name || row.label).slice(0, 200),
    estimated_price: price,
    // clock_timestamp, not the transaction's now(): rows keep the profile's order.
    created_at: trx.raw('clock_timestamp()'),
  };
  if (cols.base_price) data.base_price = price;
  // An explicit one-time line: a NULL pattern rides the parent visit's cadence
  // (admin-schedule lineDueOnRecurringDate), and a sold add-on is one application.
  if (cols.recurring_pattern) data.recurring_pattern = 'one_time';
  if (cols.service_key_snapshot) data.service_key_snapshot = row.catalogServiceKey;
  if (cols.area_addon_scope) data.area_addon_scope = JSON.stringify(soldScope(row));
  if (cols.service_category_snapshot) data.service_category_snapshot = catalog?.category || null;
  if (cols.estimated_duration_minutes && Number(row.durationMinutes) > 0) data.estimated_duration_minutes = Math.ceil(Number(row.durationMinutes));
  return data;
}

// The add-on that IS the appointment (its own catalog key) has no row; its sold scope is
// stamped on the appointment itself. No add-on in the profile, or the appointment is some
// other service: no query.
async function stampOwnAreaAddOnScope(trx, { scheduledServiceId, serviceProfile, ownServiceKey }) {
  const own = ownServiceKey ? areaAddOnProfileRows(serviceProfile).find((row) => row.catalogServiceKey === ownServiceKey) : null;
  if (!scheduledServiceId || !own) return;
  if (!(await trx.schema.hasColumn('scheduled_services', 'area_addon_scope'))) return;
  await trx('scheduled_services').where({ id: scheduledServiceId }).update({ area_addon_scope: JSON.stringify(soldScope(own)) });
}

// ---------------------------------------------------------------------------
// Keeping the sold scope when rows are replaced (Codex round 7 P1)
//
// The schedule's Update Details save deletes every scheduled_service_addons row of the visit and
// inserts the submitted set. The posted lines carry no `area_addon_scope` and must not: a client
// cannot forge or widen what the estimate sold. So the SERVER reads the stored scopes before the
// delete and puts each one back on the new row of the same catalog service afterwards. A scope is
// bound to its own catalog key: a row for another service never takes it, a removed add-on takes
// its scope with it, and a new row (an add-on the office adds by hand) has none.
// ---------------------------------------------------------------------------
function parseScope(value) {
  if (value && typeof value === 'object') return value;
  try { return typeof value === 'string' ? JSON.parse(value) : null; } catch { return null; }
}

async function hasScopeColumn(trx, table) {
  try { return !!(await trx.schema.hasColumn(table, 'area_addon_scope')); } catch { return false; }
}

// The stored scopes of a visit's add-on rows, in row order. [] before the migration or when none.
async function readAreaAddOnScopesToCarry(trx, visitId) {
  if (!visitId || !(await hasScopeColumn(trx, 'scheduled_service_addons'))) return [];
  const rows = await trx('scheduled_service_addons')
    .where({ scheduled_service_id: visitId })
    .whereNotNull('area_addon_scope')
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .select('id', 'service_id', 'area_addon_scope');
  return rows.map((row) => ({ serviceId: row.service_id || null, scope: parseScope(row.area_addon_scope) })).filter((entry) => entry.scope);
}

// Puts the carried scopes back on the freshly inserted rows of the same catalog service.
// Returns the number restored.
async function restoreCarriedAreaAddOnScopes(trx, visitId, carried = []) {
  if (!visitId || !Array.isArray(carried) || carried.length === 0) return 0;
  const cols = await trx('scheduled_service_addons').columnInfo();
  if (!cols.area_addon_scope) return 0;
  const fresh = await trx('scheduled_service_addons')
    .where({ scheduled_service_id: visitId })
    .whereNull('area_addon_scope')
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .select('id', 'service_id', ...(cols.service_key_snapshot ? ['service_key_snapshot'] : []));
  const taken = new Set();
  let restored = 0;
  for (const { serviceId, scope } of carried) {
    const key = scope.catalogServiceKey || null;
    const row = fresh.find((candidate) => !taken.has(String(candidate.id))
      && (key ? candidate.service_key_snapshot === key : serviceId && String(candidate.service_id) === String(serviceId)));
    if (!row) continue;
    taken.add(String(row.id));
    await trx('scheduled_service_addons').where({ id: row.id }).update({ area_addon_scope: JSON.stringify(scope) });
    restored += 1;
  }
  return restored;
}

// The add-on that IS the visit keeps `scheduled_services.area_addon_scope`. When an edit moves the
// visit to another service, the sold scope no longer describes it: clear it. Called with the
// planned update of the visit, before it is written; no query unless the update names a service.
async function clearOwnAreaAddOnScopeOnServiceChange(trx, visitId, updates = {}) {
  if (!visitId || (updates.service_id === undefined && updates.service_key_snapshot === undefined)) return false;
  if (!(await hasScopeColumn(trx, 'scheduled_services'))) return false;
  const cols = await trx('scheduled_services').columnInfo();
  const row = await trx('scheduled_services').where({ id: visitId })
    .first('area_addon_scope', 'service_id', ...(cols.service_key_snapshot ? ['service_key_snapshot'] : []));
  const scope = parseScope(row?.area_addon_scope);
  if (!scope) return false;
  const sameKey = updates.service_key_snapshot !== undefined
    ? (updates.service_key_snapshot || null) === (scope.catalogServiceKey || null)
    : (row.service_key_snapshot || scope.catalogServiceKey || null) === (scope.catalogServiceKey || null);
  const sameId = updates.service_id === undefined || String(updates.service_id ?? '') === String(row.service_id ?? '');
  if (sameKey && sameId) return false;
  await trx('scheduled_services').where({ id: visitId }).update({ area_addon_scope: null });
  return true;
}

// A staff booking owns its rows (the office chose the lines): the sold scope goes onto the row of the same
// catalog service, and no row is added or removed. Returns the number stamped.
async function stampExistingRowScopes(trx, scheduledServiceId, wanted) {
  if (!(await hasScopeColumn(trx, 'scheduled_service_addons'))) return 0;
  let stamped = 0;
  for (const row of wanted) {
    if (!row.catalogServiceKey) continue;
    stamped += await trx('scheduled_service_addons')
      .where({ scheduled_service_id: scheduledServiceId, service_key_snapshot: row.catalogServiceKey })
      .whereNull('area_addon_scope')
      .update({ area_addon_scope: JSON.stringify(soldScope(row)) });
  }
  return stamped;
}

async function dropUnsoldAddOnRows(trx, scheduledServiceId, wanted) {
  const sold = new Set(wanted.map((row) => row.catalogServiceKey).filter(Boolean));
  const carried = await trx('scheduled_service_addons').where({ scheduled_service_id: scheduledServiceId }).select('service_key_snapshot');
  const stale = [...new Set(carried.map((row) => row.service_key_snapshot).filter((key) => isAreaAddOnCatalogKey(key) && !sold.has(key)))];
  for (const key of stale) await trx('scheduled_service_addons').where({ scheduled_service_id: scheduledServiceId, service_key_snapshot: key }).del();
  return stale.length;
}

const CARRIED_ROW_DISCOUNT_COLUMNS = ['discount_id', 'discount_name', 'discount_type', 'discount_amount', 'discount_dollars'];
async function refreshCarriedAddOnRows(trx, scheduledServiceId, rows) {
  if (!rows.length) return 0;
  const cols = await trx('scheduled_service_addons').columnInfo();
  let refreshed = 0;
  for (const row of rows) {
    const price = Math.round(Number(row.addOnPrice) * 100) / 100;
    const data = { estimated_price: price };
    if (cols.base_price) data.base_price = price;
    // A discount stamped on the row by the original booking does not belong to the accepted estimate (an add-on is never
    // discounted): left in place, the invoice would bill less than the accepted total.
    for (const column of CARRIED_ROW_DISCOUNT_COLUMNS) if (cols[column]) data[column] = null;
    if (cols.area_addon_scope) data.area_addon_scope = JSON.stringify(soldScope(row));
    if (cols.estimated_duration_minutes && Number(row.durationMinutes) > 0) data.estimated_duration_minutes = Math.ceil(Number(row.durationMinutes));
    refreshed += await trx('scheduled_service_addons').where({ scheduled_service_id: scheduledServiceId, service_key_snapshot: row.catalogServiceKey }).update(data);
  }
  return refreshed;
}

/**
 * Write one add-on row per sold area add-on that the appointment does not
 * already carry. `trx` is the booking transaction. Returns the number written.
 * A priced add-on with no catalog key (or no price) cannot be a structured row:
 * it throws, rolling the booking back, rather than dropping a sold add-on.
 */
async function writeAreaAddOnVisitRows(trx, { scheduledServiceId, serviceProfile, ownServiceKey = null, addMissingRows = true, refreshExisting = false }) {
  await stampOwnAreaAddOnScope(trx, { scheduledServiceId, serviceProfile, ownServiceKey });
  const wanted = secondaryAreaAddOns(serviceProfile, ownServiceKey);
  // Adoption also drops a carried area add-on row the LOCKED estimate no longer sells (it was removed by a revision after the
  // staff booking): the visit total becomes the revised estimate's, so the stale row must not stay in dispatch or the invoice.
  if (scheduledServiceId && refreshExisting) await dropUnsoldAddOnRows(trx, scheduledServiceId, wanted);
  if (!scheduledServiceId || wanted.length === 0) return 0;
  if (!addMissingRows) return stampExistingRowScopes(trx, scheduledServiceId, wanted);
  for (const row of wanted) {
    if (!row.catalogServiceKey || !(Number(row.addOnPrice) > 0)) throw unresolvedError(row);
  }
  const present = await trx('scheduled_service_addons').where({ scheduled_service_id: scheduledServiceId })
    .select('service_key_snapshot');
  const have = new Set(present.map((r) => r.service_key_snapshot).filter(Boolean));
  const todo = wanted.filter((row) => !have.has(row.catalogServiceKey));
  // Adoption: a row the visit already carries for a sold add-on is brought to what the LOCKED estimate sells now (price,
  // minutes, sold scope), so a revision after the staff booking cannot leave dispatch and the invoice on the old tier.
  if (refreshExisting) await refreshCarriedAddOnRows(trx, scheduledServiceId, wanted.filter((row) => have.has(row.catalogServiceKey)));
  if (todo.length === 0) return 0;
  const catalogRows = await trx('services').whereIn('service_key', todo.map((row) => row.catalogServiceKey))
    .select('id', 'service_key', 'name', 'category');
  const byKey = new Map(catalogRows.map((c) => [c.service_key, c]));
  const cols = await trx('scheduled_service_addons').columnInfo();
  for (const row of todo) {
    if (!byKey.has(row.catalogServiceKey)) {
      logger.error(`[area-addon-visit-rows] catalog row ${row.catalogServiceKey} missing - add-on row written from its key snapshot only (visit ${scheduledServiceId})`);
    }
    await trx('scheduled_service_addons').insert(addOnRowData(row, byKey.get(row.catalogServiceKey), cols, scheduledServiceId, trx));
  }
  return todo.length;
}

/**
 * The same rows for an EXISTING appointment that the accept adopts (a booked
 * visit linked to the estimate; no hold graduates). The appointment's own
 * identity (`ownServiceKey`) is whatever it already is; every sold area add-on
 * it does not carry becomes an add-on row on it.
 */
// Minutes an existing appointment holds: its recorded duration, else its window.
function bookedVisitMinutes(row = {}) {
  const recorded = Number(row.estimated_duration_minutes);
  if (recorded > 0) return recorded;
  const toMinutes = (value) => {
    const match = /^(\d{1,2}):(\d{2})/.exec(String(value || ''));
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  };
  const start = toMinutes(row.window_start);
  const end = toMinutes(row.window_end);
  return start !== null && end !== null && end > start ? end - start : 0;
}

function needsNewSlotError(needed, booked) {
  const err = new Error(`The existing appointment holds ${booked || 'an unknown number of'} minutes and the add-on treatments need ${needed}. Book a new time for this estimate.`);
  err.status = 409;
  err.statusCode = 409;
  err.code = 'AREA_ADDON_VISIT_NEEDS_NEW_SLOT';
  err.isOperational = true;
  return err;
}

// Adopting an appointment that already exists never resizes it, so sold add-on
// work is attached only when the appointment already holds the whole visit
// (the sum the slot profile sizes a fresh booking to). A shorter or unsized
// appointment fails the accept closed: a new slot must be chosen, rather than
// 90 minutes of treatments riding a 30-minute stop into the next booking.
async function writeAdoptedAreaAddOns(trx, { scheduledServiceId, estimate, ownServiceKey = null, adoptedRow = {} }) {
  // Lazy: estimate-slot-availability loads slot-reservation, which loads this module.
  const availability = require('./estimate-slot-availability');
  if (areaAddOnProfileRows(availability.resolveEstimateSlotProfile(estimate, { serviceMode: 'one_time' })).length === 0) {
    // The estimate sells no add-on (any more): a carried add-on row is stale. One row read, nothing else.
    // A row was removed: the stored primary-line price is the split of the OLD mix, and the accept stamped the revised total.
    if (scheduledServiceId && (await dropUnsoldAddOnRows(trx, scheduledServiceId, [])) > 0) await clearPrimaryLinePrice(trx, scheduledServiceId);
    return 0;
  }
  // The SAME resolver a fresh booking sizes with: under scheduling capacity it
  // reads each service's catalog allowance on this transaction, so adoption
  // neither refuses a visit a new booking would fit nor passes a shorter one.
  const profile = await availability.resolveCatalogSlotProfile(estimate, { serviceMode: 'one_time' }, trx);
  const needed = Number(profile.durationMinutes) || 0;
  const booked = bookedVisitMinutes(adoptedRow);
  if (!(booked >= needed)) throw needsNewSlotError(needed, booked);
  // The appointment IS an add-on, and the estimate now sells a host service that a fresh booking would make the visit's own
  // service (primaryProfileService): adopting would leave the visit in the add-on lane with the host treatment on no row.
  // Adoption never changes a visit's own service, so a new time must be booked.
  const primary = primaryProfileService(profile);
  if (isAreaAddOnCatalogKey(ownServiceKey) && primary && primary.catalogServiceKey !== ownServiceKey) {
    throw Object.assign(new Error('The existing appointment no longer matches what this estimate sells. Book a new time for this estimate.'),
      { status: 409, statusCode: 409, code: 'AREA_ADDON_VISIT_NEEDS_NEW_SLOT', isOperational: true });
  }
  const written = await writeAreaAddOnVisitRows(trx, { scheduledServiceId, serviceProfile: profile, ownServiceKey, refreshExisting: true });
  // The accept stamped the accepted one-time total on the visit. A primary-line price left from the original booking would
  // be billed beside the add-on rows instead of that total: clear it, so the primary line is the total less the rows (the
  // split a freshly booked accept has).
  await clearPrimaryLinePrice(trx, scheduledServiceId);
  return written;
}

async function clearPrimaryLinePrice(trx, scheduledServiceId) {
  let hasPrimaryLine = false;
  try { hasPrimaryLine = !!(await trx.schema.hasColumn('scheduled_services', 'primary_line_price')); } catch { hasPrimaryLine = false; }
  if (hasPrimaryLine) await trx('scheduled_services').where({ id: scheduledServiceId }).update({ primary_line_price: null });
}

/**
 * The staff "Create Appointment" from a linked estimate (admin schedule): the posted lines carry identity, price and
 * duration, never what was sold, so the SERVER rebuilds the profile from the linked estimate and writes the sold scope
 * through the same writer the accept uses, onto the visit's own add-on and onto each add-on row the office kept. The
 * office keeps its own rows (`addMissingRows: false`): nothing is added or removed. No sold add-on: no query.
 */
async function writeStaffBookedAreaAddOnScopes(trx, { scheduledServiceId, estimate, ownServiceKey = null }) {
  if (!estimate || require('./area-addon-limits').soldAddOnKeys(estimate.estimate_data, { pricingAuthority: estimate.pricing_authority }).length === 0) return 0;
  const profile = require('./estimate-slot-availability').resolveEstimateSlotProfile(estimate, { serviceMode: 'one_time' });
  return writeAreaAddOnVisitRows(trx, { scheduledServiceId, serviceProfile: profile, ownServiceKey, addMissingRows: false });
}

// Update Details: the area add-on rows of a visit that carry no sold scope after the carried ones were restored (rows the edit
// added) get the scope its source estimate sells. One row read for a visit with none; no estimate, nothing stamped.
// The visit's OWN service too: an edit that moved the visit to an area add-on (its old scope was cleared by
// clearOwnAreaAddOnScopeOnServiceChange) gets that add-on's sold scope on the visit.
async function stampAddedAreaAddOnScopes(trx, visitId) {
  if (!visitId || !(await hasScopeColumn(trx, 'scheduled_service_addons')) || !(await hasScopeColumn(trx, 'scheduled_services'))) return 0;
  const visit = await trx('scheduled_services').where({ id: visitId }).first('source_estimate_id', 'service_key_snapshot', 'area_addon_scope');
  if (!visit || !visit.source_estimate_id) return 0;
  const ownKey = isAreaAddOnCatalogKey(visit.service_key_snapshot) && !parseScope(visit.area_addon_scope) ? visit.service_key_snapshot : null;
  const bare = await trx('scheduled_service_addons').where({ scheduled_service_id: visitId }).whereNull('area_addon_scope').select('service_key_snapshot');
  if (!ownKey && !bare.some((row) => isAreaAddOnCatalogKey(row.service_key_snapshot))) return 0;
  const estimate = await trx('estimates').where({ id: visit.source_estimate_id }).first('id', 'estimate_data', 'pricing_authority', 'show_one_time_option');
  return writeStaffBookedAreaAddOnScopes(trx, { scheduledServiceId: visitId, estimate, ownServiceKey: ownKey });
}

// ---------------------------------------------------------------------------
// What a staff booking or edit may put on a visit (Codex round 18 P1)
//
// The Create Appointment modal builds its lines from the estimate as it read it; the estimate can be revised before the
// booking transaction locks it. An area add-on line is therefore judged on the LOCKED estimate, inside the transaction, before
// anything is inserted: a posted add-on the estimate does not sell, or sells at another price, is refused (409, nothing
// written). Staff may still book FEWER add-ons than were sold (round 9: a line the office removed is not added back). An area
// add-on is priced and limited from an estimate, so one with no estimate to sell it is refused as well (the stored scope is
// what the job card, the governed rate and the yearly limits read; a hand-made line has none). An area add-on is one
// application: it never rides a repeating series (the series children skip it, see admin-schedule lineDueOnRecurringDate).
// ---------------------------------------------------------------------------
const nameOfServiceKey = (serviceKey) => (Object.values(AREA_ADDONS.items).find((cfg) => cfg.serviceKey === serviceKey) || {}).name || 'This add-on';

function postedRefusal(code, message) {
  return Object.assign(new Error(message), { status: 409, statusCode: 409, code, isOperational: true });
}

// The catalog service key of each add-on the estimate sells, with its price: a Map. Empty with no estimate or no sold add-on.
function soldAreaAddOnPrices(estimate) {
  if (!estimate) return new Map();
  const sold = require('./area-addon-limits').soldAddOnKeys(estimate.estimate_data, { pricingAuthority: estimate.pricing_authority });
  const soldServiceKeys = new Set(sold.map((key) => (AREA_ADDONS.items[key] || {}).serviceKey).filter(Boolean));
  if (!soldServiceKeys.size) return new Map();
  const profile = require('./estimate-slot-availability').resolveEstimateSlotProfile(estimate, { serviceMode: 'one_time' });
  const prices = new Map([...soldServiceKeys].map((key) => [key, null]));
  for (const row of areaAddOnProfileRows(profile)) if (prices.has(row.catalogServiceKey)) prices.set(row.catalogServiceKey, row.addOnPrice ?? null);
  return prices;
}

const samePrice = (posted, sold) => Number.isFinite(Number(posted)) && posted !== null && Math.round(Number(posted) * 100) === Math.round(Number(sold) * 100);

/**
 * Refuses (409, nothing written) a posted visit line that the estimate does not sell. `posted` is [{ key, price }]: the catalog
 * service key of the visit's own service and of each add-on line, with the add-on line's gross price (`price` undefined for the
 * visit's own service and for an edit that does not post prices). Only area add-on keys are judged; no such line: no query.
 * `estimate` is the row the caller holds locked (null when the visit has none). `recurring`: the visit is, or becomes, part of a
 * repeating series.
 */
function assertPostedAreaAddOnsSold(estimate, posted = [], { recurring = false, wholeVisit = true } = {}) {
  const wanted = posted.filter((line) => line && isAreaAddOnCatalogKey(line.key));
  if (!wanted.length) return;
  const name = nameOfServiceKey(wanted[0].key);
  if (recurring) throw postedRefusal('AREA_ADDON_ONE_TIME_ONLY', `${name} is a one-time application. Book it as its own appointment, not in a repeating series.`);
  // One estimate sells ONE application of an add-on: the same add-on twice on a visit (two lines, or the visit's own service and
  // a line) would book and bill two while the limit recheck counts one.
  const repeated = wanted.find((line, index) => wanted.findIndex((other) => other.key === line.key) !== index);
  if (repeated) throw postedRefusal('AREA_ADDON_DUPLICATE', `${nameOfServiceKey(repeated.key)} is on this appointment more than once. An estimate sells one application: remove the extra line.`);
  const sold = soldAreaAddOnPrices(estimate);

  for (const line of wanted) {
    const lineName = nameOfServiceKey(line.key);
    if (!sold.has(line.key)) {
      throw postedRefusal(estimate ? 'AREA_ADDON_NOT_ON_ESTIMATE' : 'AREA_ADDON_NEEDS_ESTIMATE', estimate
        ? `${lineName} is not sold on the linked estimate any more. The estimate changed after this appointment was built: reopen the estimate and build the appointment again.`
        : `${lineName} is priced and limited from an estimate. Build an estimate that sells it, then book from that estimate.`);
    }
    if (line.price !== undefined && sold.get(line.key) !== null && !samePrice(line.price, sold.get(line.key))) {
      throw postedRefusal('AREA_ADDON_PRICE_CHANGED', `The price of ${lineName} on the estimate changed after this appointment was built: reopen the estimate and build the appointment again.`);
    }
  }
  // `wholeVisit` (a booking: `posted` is everything the visit will carry): the add-on that carries the visit's drive and
  // booking cost on the estimate must stay when any other sold add-on is booked. The others are priced as additional add-ons,
  // so a visit of only those would be sold with no trip cost in its price.
  if (wholeVisit) assertCostCarrierKept(estimate, wanted, sold);
}

// The catalog keys of the sold add-ons that carry the visit's one drive or its one booking-and-invoicing charge.
function costCarrierServiceKeys(estimate) {
  if (!estimate) return [];
  const rows = require('./estimate-result-container').storedAreaAddOnRows(estimate.estimate_data, { pricingAuthority: estimate.pricing_authority });
  return [...new Set(rows.filter((row) => row && (row.carriesVisitDrive === true || row.carriesJobAdmin === true))
    .map((row) => row.catalogServiceKey || (AREA_ADDONS.items[row.addOnKey] || {}).serviceKey).filter(Boolean))];
}

function assertCostCarrierKept(estimate, wanted, sold) {
  const postedKeys = new Set(wanted.map((line) => line.key));
  const missing = costCarrierServiceKeys(estimate).find((key) => sold.has(key) && !postedKeys.has(key));
  if (!missing) return;
  throw postedRefusal('AREA_ADDON_CARRIER_REQUIRED', `${nameOfServiceKey(missing)} carries the visit's drive and booking cost on the estimate, so the other add-on treatments are priced without it. Keep ${nameOfServiceKey(missing)} on this appointment, or build a new estimate for the add-on treatments you want to book.`);
}

/**
 * The Update Details save: the area add-ons the edit ADDS to a visit (its own service moved to one, or a new add-on row) must be
 * sold by the visit's source estimate, and a repeating series never carries one. What the visit already carries is kept as it
 * is (the stored scopes are carried over by restoreCarriedAreaAddOnScopes). `updates` are the planned visit columns; `rowKeys`
 * are the catalog keys of the posted add-on rows (null when the save does not replace them). Returns { keys, added }: the area
 * add-on keys the visit carries after the edit and the ones the edit adds (both [] and no further query for a visit that has none).
 */
// What an edit leaves on the visit. Pure: `visit` is the stored row, `storedRowKeys` its add-on row keys, `posted` the posted rows
// ([{ key, price }]) or null when the save keeps the rows. Returns the visit's own key, the area add-on rows after the edit, the
// area add-on keys after the edit (own first), the keys the edit adds, and whether the edit touches the add-ons at all.
function editedAddOnPlan(visit, storedRowKeys, updates, posted) {
  const ownKey = updates.service_key_snapshot !== undefined ? updates.service_key_snapshot : visit.service_key_snapshot;
  const rowsAfter = (posted || storedRowKeys.map((key) => ({ key }))).filter((line) => isAreaAddOnCatalogKey(line.key));
  const finalKeys = [ownKey, ...rowsAfter.map((line) => line.key)].filter(isAreaAddOnCatalogKey);
  const before = new Set([visit.service_key_snapshot, ...storedRowKeys]);
  const added = [...new Set(finalKeys)].filter((key) => !before.has(key));
  return { ownKey, rowsAfter, finalKeys, added, touched: posted !== null || ownKey !== visit.service_key_snapshot };
}

// The lines the edit ADDS, each with the gross price the save writes. The visit's own service moved to an add-on is judged at
// `primary_line_price`; with none written the old service's price would stay, so its price is null (refused).
function addedAddOnLines(plan, updates) {
  const addedSet = new Set(plan.added);
  const ownPrice = updates.primary_line_price !== undefined ? updates.primary_line_price : null;
  const own = addedSet.has(plan.ownKey) ? [{ key: plan.ownKey, price: ownPrice }] : [];
  return [...own, ...plan.rowsAfter.filter((line) => addedSet.has(line.key))];
}

// The visit's own add-on, kept by the edit, posted at a primary price other than the stored one.
function keptOwnAddOnRepriced(plan, visit, updates) {
  const kept = isAreaAddOnCatalogKey(plan.ownKey) && !plan.added.includes(plan.ownKey);
  const both = updates.primary_line_price != null && visit.primary_line_price != null;
  return kept && both && !samePrice(updates.primary_line_price, visit.primary_line_price);
}

const priceLocked = (key) => postedRefusal('AREA_ADDON_PRICE_LOCKED', `${nameOfServiceKey(key)} is priced by its estimate, so its price cannot be changed on the appointment. To change it, revise the estimate and book again from it.`);

async function assertEditedAreaAddOns(trx, visitId, { updates = {}, rowKeys = null, rowLines = null } = {}) {
  const visit = await trx('scheduled_services').where({ id: visitId }).first();
  if (!visit) return { keys: [], added: [] };
  const storedRowKeys = (await areaAddOnKeysByVisit(trx, [visitId])).get(String(visitId)) || [];
  // The posted rows with their gross prices (`rowLines`), or their keys alone (`rowKeys`); null = the save keeps the rows.
  const keysOnly = rowKeys === null ? null : rowKeys.map((key) => ({ key }));
  const posted = Array.isArray(rowLines) ? rowLines.map((line) => ({ key: line && line.key, price: line ? line.price : undefined })) : keysOnly;
  const plan = editedAddOnPlan(visit, storedRowKeys, updates, posted);
  const result = { keys: plan.finalKeys, added: plan.added };
  if (!plan.finalKeys.length) return { keys: [], added: [] };
  // Becoming a series, or adding to one, with an area add-on on it.
  const inSeries = visit.is_recurring === true || Boolean(visit.recurring_parent_id);
  if (inSeries ? plan.added.length > 0 : updates.is_recurring === true) {
    assertPostedAreaAddOnsSold(null, [...new Set(plan.finalKeys)].map((key) => ({ key })), { recurring: true });
  }
  // Nothing about the add-ons changes: the rows are kept and the visit's own service is the same.
  if (!plan.touched) return result;
  // The source estimate, FOR SHARE: held to the end of the save, so a revision of the estimate waits behind this edit and
  // the scope stamp later in the save reads the same row (the lock Create Appointment takes).
  const estimate = visit.source_estimate_id
    ? await trx('estimates').where({ id: visit.source_estimate_id }).forShare().first('id', 'estimate_data', 'pricing_authority', 'show_one_time_option')
    : null;
  // The same add-on never rides the visit twice; what the edit ADDS is sold by the estimate, at the estimate's price.
  const added = addedAddOnLines(plan, updates);
  const repeated = plan.finalKeys.filter((key) => plan.finalKeys.indexOf(key) !== plan.finalKeys.lastIndexOf(key)).map((key) => ({ key }));
  for (const lines of [repeated, added]) {
    if (lines.length) assertPostedAreaAddOnsSold(estimate, lines, { wholeVisit: false });
  }
  // What the visit already carries keeps its price: an add-on is never repriced by hand (the rows, then the visit's own).
  await assertKeptAddOnRowPrices(trx, visitId, plan.rowsAfter.filter((line) => !plan.added.includes(line.key) && line.price != null));
  if (keptOwnAddOnRepriced(plan, visit, updates)) throw priceLocked(plan.ownKey);
  // The add-on that carries the visit's drive and booking cost on the estimate stays while another sold add-on stays.
  if (estimate) assertCostCarrierKept(estimate, plan.finalKeys.map((key) => ({ key })), soldAreaAddOnPrices(estimate));
  return result;
}

// A kept area add-on row posted at a gross price other than the one it is stored with is refused.
async function assertKeptAddOnRowPrices(trx, visitId, keptLines) {
  if (!keptLines.length) return;
  const stored = await trx('scheduled_service_addons').where({ scheduled_service_id: visitId })
    .whereIn('service_key_snapshot', keptLines.map((line) => line.key)).select('service_key_snapshot', 'base_price', 'estimated_price');
  const storedPrice = new Map((Array.isArray(stored) ? stored : []).map((row) => [row.service_key_snapshot, row.base_price ?? row.estimated_price]));
  for (const line of keptLines) {
    if (!storedPrice.has(line.key) || storedPrice.get(line.key) == null) continue;
    if (!samePrice(line.price, storedPrice.get(line.key))) {
      throw priceLocked(line.key);
    }
  }
}

// The attached area add-on rows of these visits (a `scheduled_service_addons` row
// whose catalog key is an area add-on): a Map of visit id to the catalog keys. ONE
// batched read. A visit with such a row has work the lightweight completion flows
// (the pest report flow, the lawn, lawn re-service and Tree & Shrub Fast Complete
// sheets) cannot record, so every eligibility check asks this. Ids that are not
// uuids cannot have rows and are skipped (no query at all when none is left).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function areaAddOnKeysByVisit(knex, visitIds = []) {
  const byVisit = new Map();
  const ids = [...new Set((Array.isArray(visitIds) ? visitIds : []).filter(Boolean).map(String))].filter((id) => UUID_RE.test(id));
  if (!ids.length) return byVisit;
  const rows = await knex('scheduled_service_addons as a')
    .leftJoin('services as s', 's.id', 'a.service_id')
    .whereIn('a.scheduled_service_id', ids)
    .select('a.scheduled_service_id', 'a.service_key_snapshot', 's.service_key');
  for (const row of rows) {
    // The booked snapshot wins over the live catalog key (the closeout resolver's rule).
    const key = String(row.service_key_snapshot || row.service_key || '');
    if (!key.startsWith(AREA_ADDON_KEY_PREFIX)) continue;
    const id = String(row.scheduled_service_id);
    byVisit.set(id, [...new Set([...(byVisit.get(id) || []), key])]);
  }
  return byVisit;
}

// What the completion screen shows beside a host visit's own form for each attached add-on:
// its catalog key and name and what the estimate sold (the stored `area_addon_scope`). The
// screen labels each add-on's product row with it. ONE batched read; the scope is read only
// where the column exists, so an environment before migration 20261008230000 still answers.
async function areaAddOnSoldByVisit(knex, visitIds = []) {
  const byVisit = new Map();
  const ids = [...new Set((Array.isArray(visitIds) ? visitIds : []).filter(Boolean).map(String))].filter((id) => UUID_RE.test(id));
  if (!ids.length) return byVisit;
  const withScope = await hasScopeColumn(knex, 'scheduled_service_addons');
  const rows = await knex('scheduled_service_addons as a')
    .leftJoin('services as s', 's.id', 'a.service_id')
    .whereIn('a.scheduled_service_id', ids)
    .orderBy('a.created_at', 'asc')
    .orderBy('a.id', 'asc')
    .select('a.scheduled_service_id', 'a.service_key_snapshot', 'a.service_name', 's.service_key', ...(withScope ? ['a.area_addon_scope'] : []));
  for (const row of rows) {
    const key = String(row.service_key_snapshot || row.service_key || '');
    if (!key.startsWith(AREA_ADDON_KEY_PREFIX)) continue;
    const scope = parseScope(row.area_addon_scope) || {};
    const cfg = areaAddOnConfig({ service: AREA_ADDON_ENGINE_KEY, addOnKey: key.slice(AREA_ADDON_KEY_PREFIX.length) });
    const num = (value) => (Number(value) > 0 ? Number(value) : null);
    const id = String(row.scheduled_service_id);
    byVisit.set(id, [...(byVisit.get(id) || []), {
      key,
      name: String(row.service_name || cfg?.name || '').slice(0, 120),
      areaSqFt: num(scope.areaSqFt),
      tierSqFt: num(scope.tierSqFt),
      areaLabel: cfg?.areaLabel || null,
      grassType: scope.grassType || null,
    }]);
  }
  return byVisit;
}

async function visitHasAreaAddOnRows(knex, visitId) {
  return (await areaAddOnKeysByVisit(knex, [visitId])).has(String(visitId));
}

module.exports = {
  areaAddOnKeysByVisit,
  areaAddOnSoldByVisit,
  visitHasAreaAddOnRows,
  writeAdoptedAreaAddOns,
  bookedVisitMinutes,
  AREA_ADDON_ENGINE_KEY,
  primaryProfileService,
  areaAddOnProfileRows,
  secondaryAreaAddOns,
  writeAreaAddOnVisitRows,
  writeStaffBookedAreaAddOnScopes,
  stampAddedAreaAddOnScopes,
  assertPostedAreaAddOnsSold,
  assertEditedAreaAddOns,
  readAreaAddOnScopesToCarry,
  restoreCarriedAreaAddOnScopes,
  clearOwnAreaAddOnScopeOnServiceChange,
};
