/** Reviewed service areas on the existing property record. Lookup estimates
 * remain estimates; visit coverage and application actuals never write here. */
const { createHash } = require('crypto');
const db = require('../models/db');
const { addressKey } = require('./customer-properties');
const { gateEnvValue } = require('../config/feature-gates');
const { technicianCurrentVisitFilter, lockOwnedLiveVisit } = require('./technician-visit-scope');
const logger = require('./logger');

const AREA_KEYS = ['beds', 'lawn', 'mosquito'];
const AREA_SOURCES = ['imagery', 'field', 'recorded', 'computed'];
const propertyServiceAreasEnabled = () => gateEnvValue('GATE_PROPERTY_SERVICE_AREAS');
const fail = (message, status = 400) => Object.assign(new Error(message), {
  status, statusCode: status, isOperational: true,
  ...(status === 409 ? { code: 'property_service_area_changed' } : {}),
});

// A live lookup is a paid upstream call reachable by any assigned tech. Repeat
// refreshes for one address inside this window are served from the lookup
// cache (estimates only) instead of going back upstream. The claim lives on
// the shared property_lookups row, so it holds across replicas and deploys.
const LOOKUP_REFRESH_COOLDOWN_SECONDS = 2 * 60;
const claimLookupRefresh = address => require('./property-lookup/lookup-cache')
  .claimLiveRefresh(address, LOOKUP_REFRESH_COOLDOWN_SECONDS);

function areaNumber(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1000000 ? value : null;
}

function reviewedAreas(property) {
  const saved = property.service_area_measurements || {};
  if (saved.addressKey !== addressKey(property)) return {};
  return Object.fromEntries(AREA_KEYS.filter(key => areaNumber(saved.areas?.[key]?.sqft) !== null
    && AREA_SOURCES.includes(saved.areas[key].source) && saved.areas[key].reviewedAt && saved.areas[key].reviewedBy
    && (key !== 'beds' || saved.areas[key].sqft === property.bed_sqft)
    && (key !== 'lawn' || saved.areas[key].sqft === property.property_sqft))
    .map(key => [key, saved.areas[key]]));
}

function areaVersion(property, primaryLawnSqft = null) {
  return createHash('sha256').update(JSON.stringify([
    property.id, addressKey(property), property.is_primary, property.bed_sqft,
    property.property_sqft, primaryLawnSqft, property.service_area_measurements || {},
  ])).digest('hex');
}

async function primaryLawnArea(property, knex) {
  if (!property.is_primary) return null;
  const customer = await knex('customers').where({ id: property.customer_id }).first();
  if (addressKey(customer) !== addressKey(property)) return null;
  const profile = await knex('customer_turf_profiles').where({ customer_id: property.customer_id }).first();
  return areaNumber(profile?.lawn_sqft);
}

// Dark-shipped column: legacy writers (the turf-profile editor) run before
// migration 20260927010000 on a fresh deploy. Only a positive answer is
// cached; a negative one is re-checked so the first post-migration write works.
let areaColumnKnown = false;
async function hasAreaMeasurementsColumn(knex = db) {
  if (areaColumnKnown) return true;
  const present = await knex.schema.hasColumn('customer_properties', 'service_area_measurements').catch(() => false);
  if (present) areaColumnKnown = true;
  return present;
}

function validateAreaChanges(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('Enter the areas you reviewed.');
  const entries = Object.entries(input);
  if (!entries.length || entries.some(([key]) => !AREA_KEYS.includes(key))) throw fail('Select a valid property area.');
  const changes = {};
  for (const [key, entry] of entries) {
    if (!entry || areaNumber(entry.sqft) === null || !AREA_SOURCES.includes(entry.source)) {
      throw fail('Area must be a whole number from 0 to 1,000,000 sq ft with a measurement source.');
    }
    changes[key] = { sqft: entry.sqft, source: entry.source };
  }
  return changes;
}

async function visitProperty(visit, knex) {
  const history = require('./lawn-assessment-history');
  const scope = await history.scopeForAssessment(history.visitEvidence(visit.customer_id, visit), knex);
  if (!scope.propertyId) throw fail('The service property needs to be resolved before saving areas.', 409);
  return scope.propertyId;
}

async function loadAreaProperty(scope, req, knex = db, { lock = false } = {}) {
  let { customerId, propertyId } = scope;
  if (scope.serviceId) {
    const visit = lock
      ? await lockOwnedLiveVisit(knex, req, scope.serviceId)
      : await technicianCurrentVisitFilter(req, knex('scheduled_services').where({ id: scope.serviceId })).first();
    if (!visit) throw fail('Service not found.', 404);
    if (customerId && customerId !== visit.customer_id) throw fail('The service property changed. Reload the job.', 409);
    customerId = visit.customer_id;
    propertyId = await visitProperty(visit, knex);
    if (scope.propertyId && scope.propertyId !== propertyId) throw fail('The service property changed. Reload the job.', 409);
  } else if (req.techRole !== 'admin') {
    throw fail('Property not found.', 404);
  }
  const query = knex('customer_properties').where({ id: propertyId, customer_id: customerId, active: true });
  if (lock) query.forUpdate();
  const property = await query.first();
  if (!property || !property.address_line1) throw fail('Property not found.', 404);
  return property;
}

function lookupSuggestions(enriched = {}) {
  const candidate = (value, source) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1000000) return null;
    return { sqft: Math.round(value), source, reviewedAt: null, reviewedBy: null };
  };
  const result = {};
  // These are the lookup's area reads, never the pricing engine's density,
  // lot-category proxy, or 2,000-sq-ft default. Review is required to save.
  const beds = candidate(enriched.estimatedBedAreaSf, 'imagery');
  const lawn = ['vision', 'county_prior'].includes(enriched.turfSource) && enriched.turfObservation !== 'unobservable'
    ? candidate(enriched.estimatedTurfSf, enriched.turfSource === 'vision' ? 'imagery' : 'computed') : null;
  if (beds) result.beds = beds;
  if (lawn) result.lawn = lawn;
  // Mosquito coverage has its own scope. Turf + beds is not an observed
  // mosquito treatment area, so staff enter/review that area independently.
  return result;
}

async function readAreaMeasurements(scope, req, { knex = db, refresh = false, lookup, claimRefresh = claimLookupRefresh } = {}) {
  const property = await loadAreaProperty(scope, req, knex);
  const saved = reviewedAreas(property);
  const lawnSqft = await primaryLawnArea(property, knex);
  const version = areaVersion(property, lawnSqft);
  let estimates = {};
  if (refresh || AREA_KEYS.some(key => !saved[key])) {
    const address = [property.address_line1, property.address_line2, property.city, property.state, property.zip].filter(Boolean).join(', ');
    // A repeat refresh inside the cooldown reuses the cached lookup.
    const liveRefresh = refresh && await claimRefresh(address);
    const performLookup = lookup || require('../routes/property-lookup-v2').performPropertyLookup;
    // A missing/offline cache cannot hide already saved measurements or
    // turn a successful review save into an apparent failure.
    const result = await performLookup(address, liveRefresh ? { refresh: true } : { cacheOnly: true, persist: false })
      .catch(error => {
        if (!liveRefresh) return null;
        // Upstream messages can name providers, keys, URLs or the street
        // address: log only a stable error code, never the message.
        logger.warn(`[property-service-areas] lookup refresh failed property=${property.id} code=${error?.code || error?.name || 'error'}`);
        throw fail('Property lookup is unavailable right now. Try again in a few minutes.', 502);
      });
    estimates = lookupSuggestions(result?.enriched);
    // A slow lookup cannot return the former property's values after an
    // address change or reassignment. The lookup owns its own address cache.
    const fresh = await loadAreaProperty({ ...scope, propertyId: property.id }, req, knex);
    if (areaVersion(fresh, await primaryLawnArea(fresh, knex)) !== version) throw fail('Property areas changed. Reload and review the current values.', 409);
  }
  const legacy = {};
  if (areaNumber(property.bed_sqft) !== null) legacy.beds = { sqft: property.bed_sqft, source: 'recorded', reviewedAt: null };
  // The primary property's turf profile overrides; otherwise the property's
  // own recorded lawn area (already part of the version hash) is the fallback.
  const recordedLawn = lawnSqft !== null ? lawnSqft : areaNumber(property.property_sqft);
  if (recordedLawn !== null) legacy.lawn = { sqft: recordedLawn, source: 'recorded', reviewedAt: null };
  const areas = Object.fromEntries(AREA_KEYS.map(key => [key, saved[key] || legacy[key] || estimates[key] || null]));
  // addressKey lets the editor tell an address change on the same property
  // row from an ordinary concurrent measurement edit (version mixes both).
  return { enabled: true, propertyId: property.id, customerId: property.customer_id,
    addressKey: addressKey(property), version, areas };
}

async function saveAreaMeasurements(scope, req, input, { knex = db } = {}) {
  const changes = validateAreaChanges(input?.areas);
  if (typeof input?.version !== 'string' || !/^[a-f0-9]{64}$/.test(input.version)) throw fail('Reload the property areas before saving.', 409);
  const initial = await loadAreaProperty(scope, req, knex);
  const { withTurfProfileFence } = require('./customer-pricing-ai');
  await withTurfProfileFence(knex, initial.customer_id, async trx => {
    const property = await loadAreaProperty({ ...scope, customerId: initial.customer_id, propertyId: initial.id }, req, trx, { lock: true });
    if (areaVersion(property, await primaryLawnArea(property, trx)) !== input.version) throw fail('Property areas changed. Reload before saving your correction.', 409);
    const before = reviewedAreas(property);
    const next = { ...before };
    const reviewedAt = new Date().toISOString();
    for (const [key, value] of Object.entries(changes)) next[key] = { ...value, reviewedAt, reviewedBy: req.technicianId };
    await trx('customer_properties').where({ id: property.id }).update({
      service_area_measurements: { addressKey: addressKey(property), areas: next },
      ...(changes.beds ? { bed_sqft: changes.beds.sqft } : {}),
      ...(changes.lawn ? { property_sqft: changes.lawn.sqft } : {}), updated_at: trx.fn.now(),
    });
    const customer = await trx('customers').where({ id: property.customer_id }).first();
    // Existing primary-property readers keep using their existing columns.
    // A secondary property's measurement can never overwrite those mirrors.
    if (property.is_primary && addressKey(customer) === addressKey(property)) {
      if (changes.beds) await trx('customers').where({ id: property.customer_id }).update({ bed_sqft: changes.beds.sqft, updated_at: trx.fn.now() });
      if (changes.lawn) {
        await trx('customers').where({ id: property.customer_id }).update({ property_sqft: changes.lawn.sqft, updated_at: trx.fn.now() });
        await trx('customer_turf_profiles').insert({ customer_id: property.customer_id, lawn_sqft: changes.lawn.sqft })
          .onConflict('customer_id').merge({ lawn_sqft: changes.lawn.sqft, updated_at: trx.fn.now() });
      }
    }
    await require('./audit-log').recordAuditEvent({
      actor_type: req.techRole === 'admin' ? 'admin' : 'technician', actor_id: req.technicianId,
      action: 'property_service_areas_reviewed', resource_type: 'customer_property', resource_id: property.id,
      metadata: { customer_id: property.customer_id, service_id: scope.serviceId || null, before, after: next },
      critical: true, trx,
    });
  });
  return readAreaMeasurements(scope, req, { knex });
}

/** Freeze visit coverage inside normal completion (which holds the customer
 * and visit locks), never into property totals. */
async function snapshotVisitArea(input, service, req, knex = db, { treatmentEvidence = true } = {}) {
  if (!input || !propertyServiceAreasEnabled()) return null;
  const { detectServiceLine } = require('./service-report/service-line-configs');
  const kind = { tree_shrub: 'beds', lawn: 'lawn', mosquito: 'mosquito' }[detectServiceLine(service.service_type)];
  if (!kind || input.kind !== kind || areaNumber(input.treatedSqft) === null || typeof input.propertyId !== 'string') {
    throw fail('Review the area treated for this service.', 400);
  }
  const property = await loadAreaProperty({ serviceId: service.id, propertyId: input.propertyId }, req, knex);
  if (input.version !== areaVersion(property, await primaryLawnArea(property, knex))) throw fail('Property areas changed. Reload and review the job coverage.', 409);
  const measured = reviewedAreas(property)[kind];
  // An untreated (incomplete, no products) visit only records coverage the
  // tech set for this visit (explicitVisitArea, or a value that differs from
  // the reviewed default); it never freezes
  // the default as if it had been treated.
  if (!treatmentEvidence && input.explicitVisitArea !== true && measured?.sqft === input.treatedSqft) return null;
  return { propertyId: property.id, kind, treatedSqft: input.treatedSqft,
    propertyAreaSqft: measured?.sqft ?? null, measurementSource: measured?.source ?? null,
    reviewedAt: measured?.reviewedAt ?? null };
}

module.exports = { AREA_KEYS, AREA_SOURCES, propertyServiceAreasEnabled, areaNumber, areaVersion, reviewedAreas,
  validateAreaChanges, lookupSuggestions, loadAreaProperty, readAreaMeasurements, saveAreaMeasurements, snapshotVisitArea,
  hasAreaMeasurementsColumn,
  _resetAreaColumnCache: () => { areaColumnKnown = false; } };
