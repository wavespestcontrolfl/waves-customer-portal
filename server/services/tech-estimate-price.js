'use strict';

/**
 * The technician estimate tool's price preview (GATE_TECH_ESTIMATES, owner 2026-11-09). Step 1 of 4:
 * it prices and saves nothing, sends nothing. tech-estimate-save.js (step 2a) saves the same quote as a draft.
 *
 * The phone sends WHO (a visit of his: the customer and the house he is standing at; or a new person he typed),
 * WHICH pest services, and edits to a few measured facts. The SERVER does the rest, on the path that already makes estimates with no office user
 * (services/moving-auto-estimate.js): the property lookup, the county-confirmed sizes (lead-draft-measurements
 * countyMeasurements), the arbitrated facts (estimator-engine/source-arbitration), the engine input
 * (estimator-engine/draft-builder buildEngineInput) and the price as a DRY RUN of the shared estimate save
 * (admin-estimate-persistence createOrReuseAdminEstimate). Nothing that moves a price (discount, credit,
 * override, waiver, adjustment, move) is read from the phone, and nothing is saved.
 *
 * A home the county has not confirmed (unit address, condo, townhome, new build, commercial) is never priced
 * here: the answer is 422 office_prices, the same bar the move estimates use.
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
const { SQFT_SOURCES } = require('./estimator-engine/source-arbitration');
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

// Each key as the engine's own service object, and the estimator form's switch for it. These mirror what
// routes/property-lookup-v2.js translateV2CallToV1Input emits for the key with the office tool's defaults
// (routes/property-lookup-v2.js:5497 pest frequency 4 -> quarterly, :5580 pest, :5745 mosquito, :5752 termite,
// :5777 rodent bait, :5781 one-time pest at NONE urgency, :5793 one-time mosquito); tech-estimates.test.js pins every entry against the translator.
const deepFreeze = (value) => {
  Object.values(value).forEach((v) => { if (v && typeof v === 'object') deepFreeze(v); });
  return Object.freeze(value);
};
// `line` is the engine's own name for the priced line of that service (generateEstimate lineItems[].service);
// judgePrepared reads it so a quote never shows fewer services than were chosen.
const ENGINE_SERVICES = deepFreeze({
  PEST: { form: 'svcPest', line: 'pest_control', services: { pest: { frequency: 'quarterly', roachType: 'none' } } },
  OT_PEST: { form: 'svcOnetimePest', line: 'one_time_pest', services: { oneTimePest: { urgency: 'NONE', afterHours: false } } },
  MOSQUITO: { form: 'svcMosquito', line: 'mosquito', services: { mosquito: { tier: 'monthly12' } } },
  OT_MOSQUITO: { form: 'svcOnetimeMosquito', line: 'one_time_mosquito', services: { oneTimeMosquito: {} } },
  RODENT_BAIT: { form: 'svcRodentBait', line: 'rodent_bait', services: { rodentBait: {} } },
  TERMITE_BAIT: {
    form: 'svcTermiteBait',
    line: 'termite_bait',
    services: { termite: { system: 'trelona', monitoringTier: 'basic', scope: 'bait_monitoring_no_warranty', measurements: {} } },
  },
});
const PEST_FREQUENCY_FORM_VALUE = '4';

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

// A visit of his, with the columns the place rule reads. technicianCurrentVisitFilter is the portal's own read scope
// for a technician (his assignment, not a dead one, inside the access window); an admin is unscoped.
function ownVisit(req, visitId) {
  const { technicianCurrentVisitFilter } = require('./technician-visit-scope');
  return technicianCurrentVisitFilter(req, db('scheduled_services')
    .leftJoin('customers as c', 'scheduled_services.customer_id', 'c.id')
    .where('scheduled_services.id', visitId))
    .first('scheduled_services.customer_id',
      'scheduled_services.service_address_line1', 'scheduled_services.service_address_line2',
      'scheduled_services.service_address_city', 'scheduled_services.service_address_state', 'scheduled_services.service_address_zip',
      'c.address_line1 as customer_address_line1', 'c.address_line2 as customer_address_line2',
      'c.city as customer_city', 'c.state as customer_state', 'c.zip as customer_zip');
}

// Who is being quoted: { customerId, visitId, address } or { prospect, address }.
// A customer is always quoted through a VISIT of his, never by a bare customer id: a customer can have more than one
// saved property, and the quote is for the house he is standing at. That house is the visit's stamped service address
// when it has one (a second home or a rental), else the customer's primary address: the arrival detector's own rule,
// the one the lead flag uses (field-lead-gps.js visitedPremise). A visit that is not his is a 404, like an unknown id.
async function resolveSubject(req, body) {
  const { visitId, prospect } = body;
  if ((visitId ? 1 : 0) + (prospect ? 1 : 0) !== 1) throw new PriceRefusal(400, 'Send either a visit or a new person.');
  if (prospect) {
    const checked = normalizeProspect(prospect);
    if (checked.error) throw new PriceRefusal(400, checked.error);
    const p = checked.prospect;
    return { prospect: p, address: joinAddress([p.address, p.city, `FL ${p.zip}`]) };
  }
  const notFound = new PriceRefusal(404, 'Visit not found');
  if (typeof visitId !== 'string' || !UUID_RE.test(visitId)) throw notFound;
  const visit = await ownVisit(req, visitId);
  if (!visit || !visit.customer_id) throw notFound;
  const place = require('./field-lead-gps').visitedPremise(visit);
  const state = (visit.service_address_line1 ? visit.service_address_state : visit.customer_state) || 'FL';
  return {
    customerId: String(visit.customer_id),
    visitId,
    address: joinAddress([place.address, place.unit, place.city, `${state} ${place.zip || ''}`]),
  };
}

// ---------------------------------------------------------------------------
// The county-confirmed home, the technician's facts laid over it, and the engine input

const OFFICE_PRICES = Object.freeze({ error: 'The office needs to price this one.', code: 'office_prices' });
const officePrices = () => new PriceRefusal(422, OFFICE_PRICES.error, { code: OFFICE_PRICES.code });

// One technician's budget of PAID lookups for one Eastern day. An address already in the 180-day lookup cache costs
// nothing and is never counted, so an honest day (a price, a re-price, the save) spends one unit per new address.
const DAILY_PAID_LOOKUPS = 30;

async function lookupFor(req, address) {
  const { performPropertyLookup } = require('../routes/property-lookup-v2');
  const { lookupOptionsFor } = require('./property-lookup/lookup-callers');
  const unavailable = (err) => {
    logger.warn(`[tech-estimates] property lookup failed: ${err.code || err.name}`);
    return new PriceRefusal(502, 'The property lookup is not available right now. Try again, or ask the office.');
  };
  // The free read first: only a cache miss spends money.
  let cached;
  try {
    cached = await performPropertyLookup(address, lookupOptionsFor('tech_estimate_tool', { cacheOnly: true, persist: false }));
  } catch (err) {
    throw unavailable(err);
  }
  if (cached) return cached;
  // The last point before the paid call. The counter is the portal's shared daily counter (one row per bucket and day,
  // all processes, kept across deploys); failClosed: a counter that cannot be read refuses the paid call.
  const { consumeSharedDailyCap } = require('../middleware/public-llm-shared-cap');
  const budget = await consumeSharedDailyCap({
    bucket: `tech-estimate-lookup:${req.technicianId}`, defaultMax: DAILY_PAID_LOOKUPS, failClosed: true,
  });
  if (!budget.allowed) {
    throw new PriceRefusal(429, 'You reached today\'s limit of new address lookups. Ask the office to price this one.', { code: 'daily_limit' });
  }
  try {
    return await performPropertyLookup(address, lookupOptionsFor('tech_estimate_tool', { prioritizeAccuracy: true }));
  } catch (err) {
    throw unavailable(err);
  }
}

// Only a county-confirmed single-family home at an address with no unit is priced here (the move estimates' own bar).
function assertCountyConfirmedHome(lookup, address) {
  const { countyMeasurements, wholeHomeAddress } = require('./lead-draft-measurements')._private;
  const { isCommercialProfile } = require('../routes/property-lookup-v2')._private;
  if (!lookup || !lookup.enriched || isCommercialProfile(lookup.enriched)) throw officePrices();
  if (!wholeHomeAddress(address) || !countyMeasurements(lookup)) throw officePrices();
}

// The arbitrated facts with the technician's numbers laid over them. A typed number that differs from the
// arbitrated one is a changed fact. A stories count a person saw is not an AI estimate, so its evidence goes.
function layerFacts(lookup, facts, keys) {
  const { resolvePropertyFacts } = require('./estimator-engine/source-arbitration');
  const resolved = resolvePropertyFacts({ extraction: null, propertyRecord: lookup.propertyRecord, customer: null, isCommercial: false });
  const propertyFacts = { ...resolved, propertyType: resolved.propertyType || 'single_family' };
  const shown = {
    homeSqFt: Math.round(Number(propertyFacts.home && propertyFacts.home.value)) || null,
    lotSqFt: Math.round(Number(propertyFacts.lot && propertyFacts.lot.value)) || null,
    stories: Number(propertyFacts.stories) || null,
  };
  const changed = [];
  const typed = (name) => facts[name] !== undefined && facts[name] !== shown[name];
  if (typed('homeSqFt')) propertyFacts.home = { ...propertyFacts.home, value: facts.homeSqFt, source: SQFT_SOURCES.CALLER_STATED };
  if (typed('lotSqFt')) propertyFacts.lot = { ...propertyFacts.lot, value: facts.lotSqFt, source: SQFT_SOURCES.CALLER_STATED };
  if (typed('stories')) { propertyFacts.stories = facts.stories; propertyFacts.storiesEvidence = null; }
  for (const name of ['homeSqFt', 'lotSqFt', 'stories']) if (typed(name)) { changed.push(name); shown[name] = facts[name]; }
  // The measured termite perimeter has no arbitrated value to compare with: a typed one is always a change.
  const perimeterLF = keys.includes('TERMITE_BAIT') ? facts.perimeterLF : undefined;
  if (perimeterLF !== undefined) { changed.push('perimeterLF'); shown.perimeterLF = perimeterLF; }
  const source = (name) => (changed.includes(name) ? 'technician' : 'lookup');
  const out = {};
  for (const name of Object.keys(shown)) if (shown[name]) out[name] = { value: shown[name], source: source(name) };
  return { propertyFacts, changed, shown: out, perimeterLF };
}

// The engine's own service objects for the chosen keys (copies; the table is frozen).
function engineServices(keys, perimeterLF) {
  const services = {};
  for (const key of keys) Object.assign(services, structuredClone(ENGINE_SERVICES[key].services));
  if (perimeterLF !== undefined) services.termite.measurements = { perimeterLF };
  return services;
}

// The save's own body, as moving-auto-estimate.js estimateBody builds one. The estimator form's keys in
// `inputs` let the office reopen the draft; the phone supplies none of them directly.
function estimateBody({ subject, keys, facts: layered, engineInputs }) {
  const { shown } = layered;
  const edited = (name) => (layered.changed.includes(name) ? { [`_${name}Edited`]: true } : {});
  const inputs = {
    ...(subject.customerId ? { customerId: subject.customerId } : {}),
    address: subject.address,
    propertyType: 'Single Family',
    homeSqFt: String((shown.homeSqFt && shown.homeSqFt.value) || engineInputs.homeSqFt || ''),
    lotSqFt: String((shown.lotSqFt && shown.lotSqFt.value) || engineInputs.lotSqFt || ''),
    stories: String(engineInputs.stories || 1),
    ...Object.fromEntries(keys.map((key) => [ENGINE_SERVICES[key].form, true])),
    ...(keys.includes('PEST') ? { pestFreq: PEST_FREQUENCY_FORM_VALUE } : {}),
    ...(layered.perimeterLF !== undefined ? { termitePerimeterLF: String(layered.perimeterLF) } : {}),
    ...edited('homeSqFt'), ...edited('lotSqFt'), ...edited('stories'),
  };
  const who = subject.prospect
    ? { customerName: [subject.prospect.firstName, subject.prospect.lastName].filter(Boolean).join(' '), customerPhone: subject.prospect.phone }
    : { customerId: subject.customerId };
  return { ...who, address: subject.address, showOneTimeOption: false, billByInvoice: false, estimateData: { engineInputs, inputs } };
}

// The dry run of the shared save. A refusal under 500 is "the office prices this one", never echoed; a bad phone is the
// technician's own typo, so its message stands. A 5xx stays a server error.
async function dryRun(req, body) {
  try {
    return await require('./admin-estimate-persistence').createOrReuseAdminEstimate({
      database: db, body, technicianId: req.technicianId, technician: req.technician, dryRun: true, requireLivePricing: true,
    });
  } catch (err) {
    const status = Number(err && (err.statusCode || err.status));
    if (err && err.code === 'INVALID_PHONE') throw new PriceRefusal(400, err.message);
    if (status >= 400 && status < 500) throw officePrices();
    throw err;
  }
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

// The verdict, like moving-auto-estimate.js cleanPrice: server-priced, with an engine line for every chosen service,
// and whether the office must look at a line (engineReview) or at the address (memberAddress, the save's own check).
function judgePrepared(prepared, keys) {
  const { lineRequiresReview, lineHasHeuristicTurf } = require('./estimator-engine/draft-builder');
  const estimate = prepared && prepared.estimate;
  const data = parseEstimateData(estimate);
  const lines = (data && data.engineResult && data.engineResult.lineItems) || [];
  if (!estimate || estimate.pricing_authority !== 'SERVER' || !data) throw officePrices();
  // Never a partial quote: every chosen service must come back as its own engine line, and a line the engine
  // could not price (quote required) has no number to show. The office prices the whole quote then.
  const unpriced = (line) => line.quoteRequired || line.requiresQuote;
  const missing = keys.some((key) => !lines.some((line) => line && line.service === ENGINE_SERVICES[key].line));
  if (missing || lines.some(unpriced)) throw officePrices();
  const flagged = (line) => lineRequiresReview(line) || lineHasHeuristicTurf(line)
    || String(line.pricingConfidence || '').toUpperCase() === 'LOW';
  return { data, estimate, engineReview: lines.some(flagged), memberAddress: Boolean(prepared.memberLinkageWarning) };
}

function parseEstimateData(estimate) {
  const raw = estimate && estimate.estimate_data;
  if (typeof raw !== 'string') return raw || null;
  try { return JSON.parse(raw); } catch { return null; }
}

// Everything up to the save body, shared by the preview and the create so the two cannot drift: the services he
// may quote, his facts, who is quoted, the county-confirmed home, and the body for the shared estimate save.
async function prepareQuote(req, body) {
  const allowed = await servicesFor(req);
  const keys = normalizeServices(body.services, allowed);
  const facts = normalizeFacts(body.facts);
  const subject = await resolveSubject(req, body);
  const lookup = await lookupFor(req, subject.address);
  assertCountyConfirmedHome(lookup, subject.address);
  const layered = layerFacts(lookup, facts, keys);
  const { buildEngineInput } = require('./estimator-engine/draft-builder');
  const engineInputs = buildEngineInput({
    intent: { services: engineServices(keys, layered.perimeterLF), is_commercial: false, category: 'RESIDENTIAL' },
    propertyFacts: layered.propertyFacts,
    context: {},
    lookupEnriched: lookup.enriched,
  });
  return { keys, subject, layered, saveBody: estimateBody({ subject, keys, facts: layered, engineInputs }) };
}

// The dry run of the save, judged.
async function judgeQuote(req, prep) {
  return judgePrepared(await dryRun(req, prep.saveBody), prep.keys);
}

// A new person whose typed phone is already a customer's goes to the office first (the portal's one phone identity
// query). The preview and the create both ask, so the phone shows the verdict the save will store.
async function phoneMatchesCustomer(subject) {
  if (!subject.prospect) return false;
  const { findKnownCallerCustomer } = require('../utils/known-caller-phone');
  return Boolean(await findKnownCallerCustomer(db, subject.prospect.phone, ['id']));
}

// The server's detailed reasons the office looks first, in a fixed order.
function detailedReasons(prep, judged, { phoneMatch = false } = {}) {
  const reasons = prep.layered.changed.map((name) => `changed_fact:${name}`);
  if (roundMoney(judged.estimate.onetime_total) > ONE_TIME_HOLD_DOLLARS) reasons.push('one_time_over_limit');
  if (judged.engineReview) reasons.push('engine_review');
  if (judged.memberAddress) reasons.push('member_address');
  if (phoneMatch) reasons.push('phone_matches_customer');
  return reasons;
}

// What the phone may see: engine_review, member_address and phone_matches_customer are ONE code, so an answer never says
// that an address or a phone belongs to a customer.
const OFFICE_REVIEW_REASONS = new Set(['engine_review', 'member_address', 'phone_matches_customer']);
function phoneReasons(detailed) {
  const shown = detailed.map((reason) => (OFFICE_REVIEW_REASONS.has(reason) ? 'office_review' : reason));
  return [...new Set(shown)];
}

// The answer, field by field, from an estimate row (a dry run, the saved row or a stored one) and its parsed data.
function quoteAnswer(estimate, data, { facts, detailed }) {
  const reasons = phoneReasons(detailed);
  return {
    lines: buildLines((data && data.result) || {}),
    monthlyTotal: roundMoney(estimate.monthly_total),
    annualTotal: roundMoney(estimate.annual_total),
    oneTimeTotal: roundMoney(estimate.onetime_total),
    facts,
    officeFirst: { required: reasons.length > 0, reasons },
  };
}

async function priceQuote(req, body) {
  const prep = await prepareQuote(req, body);
  const judged = await judgeQuote(req, prep);
  const { agentEngineResultDigest } = require('./agent-estimate-preview');
  const phoneMatch = await phoneMatchesCustomer(prep.subject);
  return {
    ...quoteAnswer(judged.estimate, judged.data, { facts: prep.layered.shown, detailed: detailedReasons(prep, judged, { phoneMatch }) }),
    // A hash of the engine result, not a price: the create sends it back so a price that moved in between is refused.
    digest: agentEngineResultDigest(judged.data.engineResult),
  };
}

module.exports = {
  PriceRefusal,
  ONE_TIME_HOLD_DOLLARS,
  PEST_SERVICES,
  setupFor,
  priceQuote,
  officePrices,
  prepareQuote,
  judgeQuote,
  detailedReasons,
  phoneMatchesCustomer,
  phoneReasons,
  quoteAnswer,
  buildLines,
  parseEstimateData,
  _private: { ENGINE_SERVICES, layerFacts, engineServices, estimateBody, normalizeFacts },
};
