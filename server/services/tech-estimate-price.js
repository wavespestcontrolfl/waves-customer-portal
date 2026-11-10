'use strict';

/**
 * The technician estimate tool's price preview (GATE_TECH_ESTIMATES, owner 2026-11-09). Step 1 of 4:
 * it prices and saves nothing, sends nothing.
 *
 * The phone sends WHO (a customer on his route, or a new person he typed), WHICH pest services, and edits to a
 * few measured facts. The SERVER does the rest: the property lookup, the pricing request, the price
 * (serverRecomputeFromEstimateData, the office save's own re-pricing) and the answer, built field by field.
 * Nothing that moves a price (discount, credit, override, waiver, adjustment, move) is read from the phone.
 *
 * Services: the pest lines the engine prices from the property alone (general pest, mosquito, rodent, termite
 * bait). Lines that need job facts the first release does not collect stay with the office: roach, flea, bed
 * bug and stinging insect; trenching, Bora-Care, pre-slab, foam, WDO; rodent trapping, exclusion, guarantee,
 * sanitation and dead-animal work; the mosquito misting system. Lawn, tree and shrub, palms and the area
 * add-ons are not pest lines.
 */

const db = require('../models/db');
const logger = require('./logger');
const { classifyServiceCategory } = require('./auto-dispatch/service-category');
const { listCapabilities } = require('./technician-capabilities');
const { normalizeProspect } = require('./field-lead-gps');
const { roundMoney } = require('./billing-cadence');

const ONE_TIME_HOLD_DOLLARS = 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The estimator's own selectedServices keys. The capability category comes from the existing job-type
// classifier (auto-dispatch/service-category.js) run on the label, not from a table kept here.
const PEST_SERVICES = Object.freeze([
  ['PEST', 'Recurring pest control'],
  ['OT_PEST', 'One-time pest control'],
  ['MOSQUITO', 'Mosquito program'],
  ['OT_MOSQUITO', 'One-time mosquito treatment'],
  ['RODENT_BAIT', 'Rodent bait stations'],
  ['TERMITE_BAIT', 'Termite bait stations'],
].map(([key, label]) => Object.freeze({ key, label, category: classifyServiceCategory(label) })));

// The measured facts a technician may correct, with sane bounds. Each one feeds the pest pricing:
// homeSqFt and stories -> the pest footprint (pricing-engine/service-pricing.js resolvePestFootprint),
// lotSqFt -> the pest labor model and the mosquito treatable area, perimeterLF -> termite bait stations.
const FACT_LIMITS = Object.freeze({
  homeSqFt: { min: 300, max: 20000, whole: true },
  lotSqFt: { min: 500, max: 2000000, whole: true },
  stories: { min: 1, max: 4, whole: true },
  perimeterLF: { min: 40, max: 5000, whole: false },
});
const FACT_NAMES = Object.keys(FACT_LIMITS);

// What a list-price quote of these lines needs, as the office tool's own defaults send it.
const LIST_PRICE_OPTION_DEFAULTS = Object.freeze({
  pestFreq: 4,
  mosquitoProgram: 'monthly12',
  termiteBaitSystem: 'trelona',
  termiteMonitoringTier: 'basic',
  termiteScope: 'bait_monitoring_no_warranty',
  termiteOwnership: 'own',
});

class PriceRefusal extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const numberOrNull = (value) => (value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null);

async function servicesFor(req) {
  if (req.techRole === 'admin') return PEST_SERVICES;
  const capabilities = await listCapabilities(db, req.technicianId);
  const qualified = new Set(capabilities.filter((c) => c.state === 'qualified').map((c) => c.service_category));
  return PEST_SERVICES.filter((s) => qualified.has(s.category));
}

async function setupFor(req) {
  const services = await servicesFor(req);
  return {
    enabled: true,
    oneTimeHoldDollars: ONE_TIME_HOLD_DOLLARS,
    services: services.map(({ key, label, category }) => ({ key, label, category })),
  };
}

// ---------------------------------------------------------------------------
// The request body

function normalizeServices(raw, allowed) {
  if (!Array.isArray(raw) || raw.length === 0) throw new PriceRefusal(400, 'Pick at least one service.');
  const keys = [...new Set(raw.map((k) => String(k)))];
  const allowedKeys = new Set(allowed.map((s) => s.key));
  if (keys.some((k) => !allowedKeys.has(k))) throw new PriceRefusal(400, 'One of those services is not open to this login.');
  return keys;
}

// Allow-listed facts only; every other key is ignored. A present fact must be a sane number.
function normalizeFacts(raw) {
  const out = {};
  const given = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  for (const name of FACT_NAMES) {
    if (given[name] === undefined || given[name] === null || given[name] === '') continue;
    const { min, max, whole } = FACT_LIMITS[name];
    const value = Number(given[name]);
    if (!Number.isFinite(value) || value < min || value > max || (whole && !Number.isInteger(value))) {
      throw new PriceRefusal(400, `${name} must be a${whole ? ' whole' : ''} number from ${min} to ${max}.`);
    }
    out[name] = value;
  }
  return out;
}

const joinAddress = (parts) => parts.map((p) => String(p || '').trim()).filter(Boolean).join(', ');

// Who is being quoted: { customerId, address } or { prospect, address }. A customer off his route is a 404, like an unknown id.
async function resolveSubject(req, body) {
  const { customerId, prospect } = body;
  if ((customerId ? 1 : 0) + (prospect ? 1 : 0) !== 1) throw new PriceRefusal(400, 'Send either a customer or a new person.');
  if (prospect) {
    const checked = normalizeProspect(prospect);
    if (checked.error) throw new PriceRefusal(400, checked.error);
    const p = checked.prospect;
    return { prospect: p, address: joinAddress([p.address, p.city, `FL ${p.zip}`]) };
  }
  const { technicianServicesCustomer } = require('./technician-visit-scope');
  const notFound = new PriceRefusal(404, 'Customer not found');
  if (typeof customerId !== 'string' || !UUID_RE.test(customerId)) throw notFound;
  if (!(await technicianServicesCustomer(req, customerId))) throw notFound;
  const row = await db('customers').where({ id: customerId }).first('id', 'address_line1', 'address_line2', 'city', 'state', 'zip');
  if (!row) throw notFound;
  const address = joinAddress([row.address_line1, row.address_line2, row.city, `${row.state || 'FL'} ${row.zip || ''}`]);
  return { customerId: row.id, address };
}

// ---------------------------------------------------------------------------
// The profile: the lookup's, scoped and corrected the way the office tool builds it

// The condo development's parcel: its lot and area reads describe the wrong thing (client lib/lookupPrefill.js).
const UNIT_PARCEL_AREA_READS = ['estimatedTurfSf', 'turfSource', 'turfCappedToParcel', 'turfFallbackPreviewSf',
  'imperviousSurfacePercent', 'imperviosSurfacePercent', 'estimatedBedAreaSf', 'estimatedBedAreaPercent',
  'bedAreaSource', 'estimatedHedgeLinearFt'];

function lookupValues(profile) {
  const perimeter = profile.perimeterSource === 'computed_from_footprint' ? undefined : profile.perimeter;
  return {
    homeSqFt: numberOrNull(profile.homeSqFt) || null,
    lotSqFt: numberOrNull(profile.lotSqFt) || null,
    stories: numberOrNull(profile.stories) || null,
    perimeterLF: numberOrNull(profile.perimeterLF ?? profile.perimeterLf ?? perimeter) || null,
  };
}

// The tool's form defaults for what the lookup leaves blank (EstimateToolViewV2 buildTurfRequestProfile).
function withFormDefaults(ep) {
  const profile = { ...ep };
  delete profile.squareFootage;
  if (Array.isArray(profile.fieldVerifyFlags) && profile.fieldVerifyFlags.some((f) => f && f.field === 'lotSize' && f.scope === 'unit_parcel')) {
    for (const key of UNIT_PARCEL_AREA_READS) delete profile[key];
  }
  const pool = ep.pool === 'YES';
  const cage = pool && ep.poolCage === 'YES';
  Object.assign(profile, {
    pool: pool ? 'YES' : 'NO',
    poolCage: cage ? 'YES' : 'NO',
    poolCageSize: cage ? (ep.poolCageSize && ep.poolCageSize !== 'NONE' ? ep.poolCageSize : 'MEDIUM') : 'NONE',
    shrubDensity: ep.shrubDensity || 'MODERATE',
    treeDensity: ep.treeDensity || 'MODERATE',
    landscapeComplexity: ep.landscapeComplexity || 'MODERATE',
    nearWater: ep.nearWater && ep.nearWater !== 'NONE' ? 'YES' : 'NO',
    homeSqFt: numberOrNull(ep.homeSqFt) || 0,
    lotSqFt: numberOrNull(ep.lotSqFt) || 0,
    stories: numberOrNull(ep.stories) || 1,
  });
  return profile;
}

const EDIT_STAMPS = {
  homeSqFt: (p) => { p._homeSqFtManuallyEdited = true; },
  stories: (p) => { p.storiesSource = 'manual'; },
  perimeterLF: (p) => { p.perimeterSource = 'manual'; },
  lotSqFt: () => {},
};

// Turf derived from the lookup's lot or building is stale once either is corrected (the tool's lookupTurfIsStale).
function dropStaleTurf(profile, changed) {
  const lot = changed.includes('lotSqFt');
  const building = changed.includes('homeSqFt') || changed.includes('stories');
  const stale = profile.turfSource === 'county_prior' ? (lot || building) : (profile.turfCappedToParcel === true && lot);
  if (!stale) return;
  for (const key of ['estimatedTurfSf', 'turfSource', 'turfCappedToParcel', 'countyTurfPriorSf']) delete profile[key];
}

// The pest footprint follows Home Sq Ft and Stories, exactly as the tool re-derives it on every price.
function deriveFootprint(profile, changed) {
  if (changed.includes('stories') && profile.footprintUnknown === true) profile.footprintUnknown = false;
  if (profile.footprintUnknown === true) return;
  profile.footprint = profile.homeSqFt ? Math.round(profile.homeSqFt / (profile.stories || 1)) : 0;
}

function buildProfile(lookupProfile, facts) {
  const base = withFormDefaults(lookupProfile);
  const fromLookup = lookupValues(lookupProfile);
  const changed = FACT_NAMES.filter((name) => facts[name] !== undefined && facts[name] !== fromLookup[name]);
  for (const name of changed) {
    base[name] = facts[name];
    EDIT_STAMPS[name](base);
  }
  dropStaleTurf(base, changed);
  deriveFootprint(base, changed);
  const shown = {};
  for (const name of FACT_NAMES) {
    const value = changed.includes(name) ? facts[name] : fromLookup[name];
    if (value) shown[name] = { value, source: changed.includes(name) ? 'technician' : 'lookup' };
  }
  return { profile: base, changed, shown };
}

// ---------------------------------------------------------------------------
// The lookup and the pricing request

async function lookupProfile(address) {
  const { performPropertyLookup } = require('../routes/property-lookup-v2');
  const { lookupOptionsFor } = require('./property-lookup/lookup-callers');
  let lookup;
  try {
    lookup = await performPropertyLookup(address, lookupOptionsFor('tech_estimate_tool', { prioritizeAccuracy: true }));
  } catch (err) {
    logger.warn(`[tech-estimates] property lookup failed: ${err.code || err.name}`);
    throw new PriceRefusal(502, 'The property lookup is not available right now. Try again, or ask the office.');
  }
  if (!lookup || !lookup.enriched) throw new PriceRefusal(422, 'The property could not be looked up. Ask the office to price this one.');
  return lookup.enriched;
}

// The whole pricing request, built here. `options` holds only the matched customer and the list-price defaults.
function buildEngineRequest({ profile, services, subject }) {
  return {
    profile,
    selectedServices: services,
    options: {
      ...LIST_PRICE_OPTION_DEFAULTS,
      address: subject.address,
      ...(subject.customerId ? { existingCustomerId: subject.customerId } : {}),
    },
  };
}

// The customer evidence the office save derives on the server: tier services, setup-waiver services, active plan.
async function customerEvidence(subject) {
  if (!subject.customerId) return {};
  const { resolveCustomerQualifyingEvidence, isActivePlanCustomer } = require('./waveguard-existing-services');
  try {
    const evidence = await resolveCustomerQualifyingEvidence(db, { customerId: subject.customerId, address: subject.address, logger });
    return {
      priorQualifyingServices: evidence.tierKeys,
      setupWaiverPriorQualifyingServices: evidence.setupWaiverKeys,
      recurringCustomer: await isActivePlanCustomer(db, subject.customerId),
    };
  } catch (err) {
    logger.warn(`[tech-estimates] customer evidence unavailable: ${err.message}`);
    throw new PriceRefusal(503, 'Could not confirm this customer\'s services. Try again in a moment.');
  }
}

async function recompute(engineRequest, deps) {
  const { serverRecomputeFromEstimateData } = require('./admin-estimate-persistence');
  let result;
  try {
    result = await serverRecomputeFromEstimateData({ engineRequest }, deps);
  } catch (err) {
    if (!err || err.failClosed !== true) throw err;
    throw new PriceRefusal(422, 'The office needs to price this one.');
  }
  if (!result || result.recomputed !== true) throw new PriceRefusal(422, 'The price could not be worked out. Ask the office to price this one.');
  return result;
}

// ---------------------------------------------------------------------------
// The answer, built field by field

function cleanName(name) {
  const text = String(name || '').trim();
  return /^[a-z0-9_]+$/.test(text) ? text.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : text;
}

function buildLines(mapped) {
  const lines = [];
  for (const row of (mapped.recurring && mapped.recurring.services) || []) {
    const monthly = numberOrNull(row.mo ?? row.monthly);
    if (!(monthly > 0)) continue;
    // After the WaveGuard bundle tier, like the totals: the lines add up to the monthly and annual totals.
    const annual = roundMoney(numberOrNull(row.annualAfterDiscount) ?? monthly * 12);
    lines.push({ label: cleanName(row.name), monthly: roundMoney(annual / 12), annual });
  }
  const oneTime = mapped.oneTime || {};
  for (const row of [...(oneTime.items || []), ...(oneTime.specItems || [])]) {
    const price = numberOrNull(row.price);
    if (price > 0) lines.push({ label: cleanName(row.name), oneTime: roundMoney(price) });
  }
  const setup = numberOrNull(oneTime.membershipFee);
  if (setup > 0) lines.push({ label: 'WaveGuard setup fee', oneTime: roundMoney(setup) });
  return lines;
}

// A line the engine parked for the office: a custom quote, a manager approval or a manual review.
function needsOfficePricing(result, profile, services) {
  const { isCommercialProfile } = require('../routes/property-lookup-v2')._private;
  const { needsTurfManualConfirmation } = require('../routes/property-lookup-v2');
  if (isCommercialProfile(profile)) return true;
  if (needsTurfManualConfirmation(profile, services, {})) return true;
  if (result.serverResult && result.serverResult.quoteRequired === true) return true;
  const raw = (result.rawEngineResult && result.rawEngineResult.lineItems) || [];
  return raw.some((li) => li && (li.quoteRequired || li.requiresCustomQuote || li.autoQuoteRequiresAdminApproval || li.requiresManualReview));
}

// A typed address that belongs to a customer who is not on his route goes to the office (the message never says why).
async function addressBelongsToOffRouteCustomer(req, subject) {
  if (!subject.prospect || req.techRole === 'admin') return false;
  const { normalizedEstimateStreet, normalizedStampedStreet, sameScopeKey } = require('./estimate-property-linkage');
  const { technicianServicesCustomer } = require('./technician-visit-scope');
  const typed = normalizedEstimateStreet(subject.address);
  const houseNumber = (/^\s*(\d+)/.exec(subject.prospect.address) || [])[1];
  if (!typed || !houseNumber) return false;
  const rows = await db('customers').where({ zip: subject.prospect.zip.slice(0, 5) }).where('address_line1', 'ilike', `${houseNumber} %`)
    .select('id', 'address_line1', 'address_line2', 'city', 'zip').limit(25);
  for (const row of rows) {
    const same = sameScopeKey(typed, normalizedStampedStreet(row.address_line1, row.address_line2, row.city, row.zip));
    if (same && !(await technicianServicesCustomer(req, row.id))) return true;
  }
  return false;
}

async function officeFirstVerdict({ req, subject, result, profile, services, changed, oneTimeTotal }) {
  const reasons = changed.map((name) => `changed_fact:${name}`);
  if (oneTimeTotal > ONE_TIME_HOLD_DOLLARS) reasons.push('one_time_over_limit');
  if (needsOfficePricing(result, profile, services)) reasons.push('needs_office_pricing');
  if (await addressBelongsToOffRouteCustomer(req, subject)) reasons.push('office_review_address');
  return { required: reasons.length > 0, reasons };
}

async function priceQuote(req, body) {
  const allowed = await servicesFor(req);
  const services = normalizeServices(body.services, allowed);
  const facts = normalizeFacts(body.facts);
  const subject = await resolveSubject(req, body);
  const { profile, changed, shown } = buildProfile(await lookupProfile(subject.address), facts);
  const engineRequest = buildEngineRequest({ profile, services, subject });
  const deps = await customerEvidence(subject);
  const result = await recompute(engineRequest, deps);
  const totals = result.serverTotals || {};
  const oneTimeTotal = roundMoney(totals.onetimeTotal || 0);
  return {
    lines: buildLines(result.serverResult),
    monthlyTotal: roundMoney(totals.monthlyTotal || 0),
    annualTotal: roundMoney(totals.annualTotal || 0),
    oneTimeTotal,
    facts: shown,
    officeFirst: await officeFirstVerdict({ req, subject, result, profile, services, changed, oneTimeTotal }),
  };
}

module.exports = {
  PriceRefusal,
  ONE_TIME_HOLD_DOLLARS,
  PEST_SERVICES,
  setupFor,
  priceQuote,
  _private: { buildEngineRequest, buildProfile, normalizeFacts },
};
