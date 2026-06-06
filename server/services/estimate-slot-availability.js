/**
 * Estimate slot availability — thin wrapper around scheduling/find-time.js
 * for the customer-facing estimate view.
 *
 * Given an estimate token's underlying row, returns the best route-aware
 * time slots over the next 14 days. Route-optimality is detour-based
 * (the cost the fleet
 * actually pays, not raw distance to the nearest stop) because find-time
 * already computed it that way and the signal is honest.
 *
 * Customer-facing label is copy-only: "Nearby {dayName} — {techFirstName}
 * is servicing a property close to you" — renders from the data this
 * service returns without exposing other customers' info. We carry the
 * underlying detourMinutes on the response for future A/B testing.
 *
 * This module knows nothing about route-level optimization and doesn't touch
 * Google's Routes API or DistanceMatrix. Haversine-based detour from
 * find-time.js is good enough at current volume, and it's zero per-request
 * API cost. The only Google call we make is geocoding the estimate's
 * address — once per unique address, cached 24h.
 *
 * TODO(separate-PR): customers table naming drift — the canonical coordinate
 * columns are `latitude` / `longitude` (added by 20260414000029_geofence_timers).
 * find-time.js also reads `customers.lat as cust_lat` which isn't a real
 * column on customers, so that alias returns null; the query falls back to
 * scheduled_services.lat/lng which IS real. Consolidate naming in a
 * dedicated surgical PR.
 */
const db = require('../models/db');
const logger = require('./logger');
const { findAvailableSlots } = require('./scheduling/find-time');
const { addETDays, etDateString, etParts } = require('../utils/datetime-et');
const {
  pricingBundleMatchesEstimateTotals,
} = require('./estimate-pricing-bundle-utils');

const BLOCKED_STATES_FOR_SLOTS = new Set(['accepted', 'declined', 'expired']);

const DEFAULT_OPTS = {
  windowDays: 14,
  maxResults: 6,
  proximityDriveMinutes: 20,
  expanderMaxResults: 3,
  durationMinutes: 60,
  includeWeekends: true,
  minimumLeadMinutes: 120,
};

const SERVICE_LABELS = {
  pest_control: 'Pest Control',
  lawn_care: 'Lawn Care',
  mosquito: 'Mosquito',
  tree_shrub: 'Tree & Shrub',
  termite_bait: 'Termite Bait',
  palm_injection: 'Palm Injection',
  rodent_bait: 'Rodent Bait Stations',
};

const MAX_ESTIMATE_SLOT_DURATION_MINUTES = 180;
const SLOT_DAY_END_MINUTES = 17 * 60;

// ---------- in-memory caches ----------

const wrapperCache = new Map();      // key: `${estimateId}:${hourOfDay}` → { result, expiresAt }
const WRAPPER_TTL_MS = 5 * 60 * 1000;

const geocodeCache = new Map();      // key: normalized address → { coords, expiresAt }
const GEOCODE_TTL_MS = 24 * 60 * 60 * 1000;

function cacheHour() {
  return new Date().toISOString().slice(0, 13); // 'YYYY-MM-DDTHH' — 1-hour bucket
}

function cleanupCache(cache) {
  const now = Date.now();
  for (const [k, v] of cache.entries()) {
    if (v.expiresAt < now) cache.delete(k);
  }
}

// ---------- estimate service profile ----------

function parseEstimateData(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' ? value : {};
}

function firstPositiveNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function normalizeFrequencyKey(value) {
  if (value == null) return '';
  const raw = String(value).trim().toLowerCase();
  if (!raw) return '';
  const compact = raw.replace(/[^a-z0-9]/g, '');
  if (['monthly', 'month', 'everymonth', '12x', '12xperyear'].includes(compact)) return 'monthly';
  if (['bimonthly', 'bimonth', 'everyothermonth', 'everytwomonths', 'every2months', '6x', '6xperyear'].includes(compact)) return 'bi_monthly';
  if (['quarterly', 'quarter', 'everyquarter', 'everythreemonths', 'every3months', '4x', '4xperyear'].includes(compact)) return 'quarterly';
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) {
    if (numeric >= 12) return 'monthly';
    if (numeric >= 6) return 'bi_monthly';
    return 'quarterly';
  }
  return raw;
}

function serviceKeyFor(value = {}) {
  const raw = String(
    value.service || value.service_key || value.key || value.kind
    || value.name || value.label || value.displayName || ''
  ).toLowerCase();
  if (/lawn|turf|fertili[sz]|weed|fungus|chinch/.test(raw)) return 'lawn_care';
  if (/mosquito/.test(raw)) return 'mosquito';
  if (/tree|shrub|ornamental/.test(raw)) return 'tree_shrub';
  if (/palm/.test(raw)) return 'palm_injection';
  if (/rodent|rat|mouse|mice/.test(raw)) return 'rodent_bait';
  if (/termite/.test(raw)) return 'termite_bait';
  if (/pest|roach|ant|spider|perimeter|general/.test(raw)) return 'pest_control';
  return raw.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'service';
}

function labelForService(row = {}) {
  const key = serviceKeyFor(row);
  return row.displayName || row.label || row.name || SERVICE_LABELS[key] || 'Service';
}

function visitsForService(row = {}) {
  return firstPositiveNumber(
    row.visitsPerYear,
    row.appsPerYear,
    row.visits,
    row.apps,
    row.frequency,
  );
}

function estimatePropertyNumbers(estData = {}) {
  const inputs = estData.inputs || estData.engineInputs || estData.result?.inputs || {};
  const services = inputs.services || {};
  return {
    homeSqFt: firstPositiveNumber(inputs.homeSqFt, inputs.sqft, inputs.propertySqft, estData.homeSqFt),
    lotSqFt: firstPositiveNumber(inputs.lotSqFt, inputs.lot_size, estData.lotSqFt),
    lawnSqFt: firstPositiveNumber(
      inputs.lawnSqFt,
      inputs.turfSqFt,
      services.lawn?.lawnSqFt,
      services.lawn?.turfSqFt,
      estData.lawnSqFt,
    ),
  };
}

function clampDuration(minutes) {
  const n = Number(minutes);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_OPTS.durationMinutes;
  const rounded = Math.ceil(n / 15) * 15;
  return Math.max(30, Math.min(MAX_ESTIMATE_SLOT_DURATION_MINUTES, rounded));
}

function durationForService(row = {}, estData = {}) {
  const key = serviceKeyFor(row);
  const visits = visitsForService(row);
  const { homeSqFt, lotSqFt, lawnSqFt } = estimatePropertyNumbers(estData);

  if (key === 'pest_control') {
    if (/interior|initial|roach|cockroach/i.test(String(row.label || row.name || row.displayName || ''))) return 60;
    if (visits >= 12) return 30;
    if (visits >= 6) return 40;
    return 60;
  }
  if (key === 'lawn_care') {
    const turf = lawnSqFt || lotSqFt;
    if (turf) return Math.max(45, Math.round(25 + (turf / 1000) * 4));
    return 45;
  }
  if (key === 'mosquito') return 30;
  if (key === 'tree_shrub') return Math.max(45, Math.round(25 + ((lotSqFt || 5000) / 1000) * 2));
  if (key === 'termite_bait') return 45;
  if (key === 'palm_injection') return 30;
  if (key === 'rodent_bait') return 45;
  if (homeSqFt || lotSqFt) return 45;
  return 30;
}

const FREQUENCY_LABELS = {
  quarterly: 'Quarterly',
  bi_monthly: 'Bi-monthly',
  monthly: 'Monthly',
};

function visitsForFrequencyKey(key) {
  switch (normalizeFrequencyKey(key)) {
    case 'monthly': return 12;
    case 'bi_monthly': return 6;
    case 'quarterly': return 4;
    default: return null;
  }
}

function pestTiersForEstimateData(estData = {}) {
  const result = estData.result && typeof estData.result === 'object'
    ? estData.result
    : (estData.engineResult && typeof estData.engineResult === 'object' ? estData.engineResult : {});
  const inner = result.results && typeof result.results === 'object' ? result.results : {};
  if (Array.isArray(inner.pestTiers)) return inner.pestTiers;
  if (Array.isArray(result.pestTiers)) return result.pestTiers;
  return [];
}

function frequencyKeyForPestTier(tier = {}) {
  return normalizeFrequencyKey(
    tier.key
    || tier.label
    || tier.frequency
    || tier.cadence
    || tier.apps
    || tier.v
  );
}

function storedRecurringRowsForEstimate(estimate = {}, estData = {}) {
  const lists = [
    estData.result?.recurring?.services,
    estData.recurring?.services,
    Array.isArray(estData.services) ? estData.services.filter((svc) => svc.recurring || svc.frequency || svc.visitsPerYear || svc.visits) : null,
  ];
  const rows = lists.find((list) => Array.isArray(list) && list.length) || [];
  if (rows.length) return rows.map((row) => ({ ...row }));

  if (estimate.service_interest) {
    return String(estimate.service_interest)
      .split(/\s*\+\s*|\s*,\s*/)
      .map((label) => label.trim())
      .filter(Boolean)
      .map((label) => ({ label, name: label }));
  }
  return [];
}

function selectedGeneratedPricingFrequency(estimate = {}, estData = {}, selectedFrequency = '') {
  const requested = normalizeFrequencyKey(selectedFrequency)
    || normalizeFrequencyKey(estData.customerSelection?.frequency);
  if (!requested) return null;

  const pestTiers = pestTiersForEstimateData(estData);
  const recurringRows = storedRecurringRowsForEstimate(estimate, estData);
  const hasPestSignal = pestTiers.length > 0
    || recurringRows.some((row) => serviceKeyFor(row) === 'pest_control')
    || /pest/i.test(String(estimate.service_interest || ''))
    || !!estData.inputs?.services?.pest
    || !!estData.engineInputs?.services?.pest;
  if (!hasPestSignal) return null;

  const pestTier = pestTiers.find((tier) => frequencyKeyForPestTier(tier) === requested) || null;
  const pestVisits = firstPositiveNumber(
    pestTier?.apps,
    pestTier?.v,
    pestTier?.visitsPerYear,
    pestTier?.visits,
    visitsForFrequencyKey(requested),
  );
  const pestPerTreatment = firstPositiveNumber(
    pestTier?.pa,
    pestTier?.perTreatment,
    pestTier?.perApp,
    pestTier?.perVisit,
  );
  const perServiceTreatments = [{
    service: 'pest_control',
    label: `Pest Control (${pestTier?.label || FREQUENCY_LABELS[requested] || requested})`,
    visitsPerYear: pestVisits,
    perTreatment: pestPerTreatment,
  }];

  const seen = new Set(['pest_control']);
  for (const row of recurringRows) {
    const key = serviceKeyFor(row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    perServiceTreatments.push({
      ...row,
      service: key,
      label: labelForService(row),
      visitsPerYear: visitsForService(row),
      perTreatment: firstPositiveNumber(row.perTreatment, row.perApp, row.perVisit),
    });
  }

  return {
    key: requested,
    label: FREQUENCY_LABELS[requested] || selectedFrequency || requested,
    perServiceTreatments,
  };
}

function selectedPricingFrequency(estimate = {}, estData = {}, selectedFrequency = '') {
  const bundle = estData.sendSnapshot?.pricingBundle;
  const frequencies = Array.isArray(bundle?.frequencies) ? bundle.frequencies : [];
  if (frequencies.length && pricingBundleMatchesEstimateTotals(bundle, estimate)) {
    const requested = normalizeFrequencyKey(selectedFrequency)
      || normalizeFrequencyKey(estData.customerSelection?.frequency);
    return frequencies.find((frequency) => normalizeFrequencyKey(frequency.key || frequency.label) === requested)
      || frequencies[0];
  }
  return selectedGeneratedPricingFrequency(estimate, estData, selectedFrequency);
}

function recurringRowsForEstimate(estimate = {}, estData = {}, selectedFrequency = '') {
  const frequency = selectedPricingFrequency(estimate, estData, selectedFrequency);
  if (Array.isArray(frequency?.perServiceTreatments) && frequency.perServiceTreatments.length) {
    return frequency.perServiceTreatments.map((row) => ({ ...row }));
  }

  return storedRecurringRowsForEstimate(estimate, estData);
}

function compactServiceLabel(label) {
  return String(label || 'Service')
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'Service';
}

function formatServiceProfileLabel(services) {
  const parts = [];
  const seen = new Set();
  for (const svc of services) {
    const base = compactServiceLabel(svc.label);
    const visits = Number(svc.visitsPerYear);
    const label = Number.isFinite(visits) && visits > 0
      ? `${Math.round(visits)}x ${base}`
      : base;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(label);
  }
  return parts.join(' + ');
}

function resolveEstimateSlotProfile(estimate = {}, userOpts = {}) {
  const estData = parseEstimateData(estimate.estimate_data);
  const serviceMode = userOpts.serviceMode === 'one_time' ? 'one_time' : 'recurring';
  const selectedFrequency = userOpts.selectedFrequency || '';
  const rawRows = serviceMode === 'one_time'
    ? []
    : recurringRowsForEstimate(estimate, estData, selectedFrequency);

  const services = rawRows
    .map((row) => {
      const key = serviceKeyFor(row);
      const label = labelForService(row);
      return {
        service: key,
        label,
        visitsPerYear: visitsForService(row),
        durationMinutes: durationForService(row, estData),
      };
    })
    .filter((row) => row.service && row.label);

  const totalDuration = services.reduce((sum, svc) => sum + (Number(svc.durationMinutes) || 0), 0);
  const durationMinutes = clampDuration(userOpts.durationMinutes || totalDuration || DEFAULT_OPTS.durationMinutes);
  const serviceLabel = formatServiceProfileLabel(services)
    || estimate.service_interest
    || (serviceMode === 'one_time' ? 'One-time service' : 'Estimate service');

  return {
    serviceMode,
    selectedFrequency: normalizeFrequencyKey(selectedFrequency) || null,
    durationMinutes,
    serviceLabel,
    services,
  };
}

// ---------- geocoding ----------

async function geocodeAddress(address) {
  const key = (address || '').trim().toLowerCase();
  if (!key) return null;

  cleanupCache(geocodeCache);
  const cached = geocodeCache.get(key);
  if (cached) return cached.coords;

  const apiKey = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    logger.warn('[estimate-slots] no GOOGLE_MAPS_API_KEY — skipping geocode');
    return null;
  }

  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (data.status !== 'OK' || !data.results?.length) {
      logger.warn(`[estimate-slots] geocode failed for "${address.slice(0, 60)}": ${data.status}`);
      return null;
    }
    const loc = data.results[0].geometry.location;
    const coords = { lat: loc.lat, lng: loc.lng };
    geocodeCache.set(key, { coords, expiresAt: Date.now() + GEOCODE_TTL_MS });
    return coords;
  } catch (err) {
    logger.error(`[estimate-slots] geocode error: ${err.message}`);
    return null;
  }
}

// ---------- coordinate resolution ----------

function parseCityFromAddress(address) {
  const raw = String(address || '').trim();
  if (!raw) return '';
  const parts = raw.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 3) return parts[parts.length - 2];
  const match = raw.match(/,\s*([^,]+),\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?/i);
  return match?.[1]?.trim() || '';
}

async function fallbackZoneCenter(city) {
  const normalizedCity = String(city || '').trim().toLowerCase();
  if (!normalizedCity) return null;
  try {
    const zones = await db('service_zones').select('zone_name', 'cities', 'center_lat', 'center_lng');
    const match = zones.find((zone) => {
      const cities = Array.isArray(zone.cities) ? zone.cities : [];
      return cities.some((candidate) => String(candidate || '').trim().toLowerCase() === normalizedCity);
    });
    const lat = match?.center_lat != null ? Number(match.center_lat) : null;
    const lng = match?.center_lng != null ? Number(match.center_lng) : null;
    if (Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0) {
      return { lat, lng, source: 'service_zone_fallback', city, zoneName: match.zone_name || null };
    }
  } catch (err) {
    logger.warn(`[estimate-slots] service-zone fallback failed: ${err.message}`);
  }
  return null;
}

async function resolveEstimateCoords(estimate) {
  let customerAddress = '';
  let customerCity = '';

  // Prefer linked-customer coords (zero cost, zero external call).
  if (estimate.customer_id) {
    try {
      const cust = await db('customers')
        .where({ id: estimate.customer_id })
        .first('latitude', 'longitude', 'address_line1', 'city', 'state', 'zip');
      const lat = cust?.latitude != null ? Number(cust.latitude) : null;
      const lng = cust?.longitude != null ? Number(cust.longitude) : null;
      if (Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0) {
        return { lat, lng, source: 'customer_record' };
      }
      customerAddress = [cust?.address_line1, cust?.city, cust?.state, cust?.zip].filter(Boolean).join(', ');
      customerCity = cust?.city || '';
    } catch (err) {
      logger.warn(`[estimate-slots] customer coord lookup failed: ${err.message}`);
    }
  }

  // Fallback: geocode the exact estimate/customer address.
  const addressCandidates = [estimate.address, customerAddress].filter(Boolean);
  for (const address of addressCandidates) {
    const coords = await geocodeAddress(address);
    if (coords) {
      return { ...coords, source: 'geocoded' };
    }
  }

  // Last resort for local/dev or missing geocode keys: match the city to the
  // same service-zone centers used by the book-online availability route.
  const city = parseCityFromAddress(estimate.address) || customerCity || parseCityFromAddress(customerAddress);
  const zoneCoords = await fallbackZoneCenter(city);
  if (zoneCoords) return zoneCoords;

  return null;
}

// ---------- slot classification ----------

function parseAnchorTime(anchorStr) {
  // Anchor strings from find-time look like 'Sarah Smith (09:30)' or
  // 'HQ (start of day)'. Extract minutes-since-midnight; null if not
  // a real stop (HQ) or unparseable.
  if (!anchorStr) return null;
  const m = anchorStr.match(/\((\d{1,2}):(\d{2})\)\s*$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mm)) return null;
  return h * 60 + mm;
}

function pickNearbyAnchor(slot) {
  // Detour is cheap because at least one anchor is a real stop. Pick the
  // non-HQ anchor; when both are real stops, pick whichever is closer in
  // time to the slot's start_time (the user's spec — that's the stop the
  // customer-facing 'we're close by' label would most naturally reference).
  const afterIsReal = !!slot?.insertion?.after_stop_id;
  const beforeIsReal = !!slot?.insertion?.before_stop_id;
  if (!afterIsReal && !beforeIsReal) return null;

  const slotStartMin = parseAnchorTime(`x (${slot.start_time})`);
  const afterMin = afterIsReal ? parseAnchorTime(slot.insertion.after) : null;
  const beforeMin = beforeIsReal ? parseAnchorTime(slot.insertion.before) : null;

  if (afterIsReal && !beforeIsReal) return 'after';
  if (beforeIsReal && !afterIsReal) return 'before';
  if (slotStartMin == null) return 'after'; // arbitrary tiebreak
  const afterDelta = afterMin == null ? Infinity : Math.abs(slotStartMin - afterMin);
  const beforeDelta = beforeMin == null ? Infinity : Math.abs(slotStartMin - beforeMin);
  return afterDelta <= beforeDelta ? 'after' : 'before';
}

// Round a "HH:MM" string to the next full hour. e.g. "08:13" → "09:00",
// "08:00" → "08:00" (idempotent when already on an hour mark). Used to
// clean up find-time's minute-precise start times — customers expect
// hour-rounded service windows ("9:00–10:00", not "8:13–9:13").
// The slight delay (up to 59 min) from find-time's earliestStart is
// acceptable: find-time already accounts for latestEnd when computing
// the candidate, so the rounded window still usually fits the day.
function roundUpToHour(hhmm) {
  if (!hhmm || typeof hhmm !== 'string') return hhmm;
  const parts = hhmm.split(':');
  const h = Number(parts[0]);
  const m = Number(parts[1] || 0);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm;
  if (m === 0) return `${String(h).padStart(2, '0')}:00`;
  const nextH = (h + 1) % 24;
  return `${String(nextH).padStart(2, '0')}:00`;
}

function addMinutesToHHMM(hhmm, minutes) {
  const parts = String(hhmm).split(':');
  const h = Number(parts[0]);
  const m = Number(parts[1] || 0);
  if (!Number.isFinite(h)) return hhmm;
  const total = h * 60 + (Number.isFinite(m) ? m : 0) + (Number(minutes) || 0);
  const nextH = Math.floor(total / 60) % 24;
  const nextM = ((total % 60) + 60) % 60;
  return `${String(nextH).padStart(2, '0')}:${String(nextM).padStart(2, '0')}`;
}

function slotWindowFitsDay(windowStart, windowEnd) {
  const startMin = timeToMinutes(windowStart);
  const endMin = timeToMinutes(windowEnd);
  if (startMin == null || endMin == null) return true;
  return endMin > startMin && endMin <= SLOT_DAY_END_MINUTES;
}

// Customer-facing window rotation for slots on sparse days. find-time
// returns the earliest feasible start per (date, gap), so when a day has
// no other stops every slot collapses to 8 AM (→ rounded to 9 AM). For
// those days the technician is genuinely available 8a–5p, so we rotate
// the displayed window across the working day to give customers real
// choice. Route-optimal slots (placed adjacent to another customer for
// drive-time savings) keep their original time — that's the whole point
// of route optimization. Skips noon for lunch.
const PREFERRED_WINDOWS = ['09:00', '10:00', '11:00', '13:00', '14:00', '15:00', '16:00'];

function spreadWindowsAcrossDay(slots, durationMinutes = DEFAULT_OPTS.durationMinutes) {
  if (!Array.isArray(slots) || slots.length <= 1) return slots;
  const windows = PREFERRED_WINDOWS.filter((win) =>
    slotWindowFitsDay(win, addMinutesToHHMM(win, durationMinutes)));
  if (!windows.length) return slots;
  let nonOptimalIdx = 0;
  return slots.map((s) => {
    // Preserve the route-optimized time for slots placed near another
    // customer — moving them to a different hour would destroy the
    // routing benefit that earned them the "Nearby" tag.
    if (s.routeOptimal) return s;
    const win = windows[nonOptimalIdx % windows.length];
    nonOptimalIdx += 1;
    return {
      ...s,
      windowStart: win,
      windowEnd: addMinutesToHHMM(win, durationMinutes),
      slotId: `${s.date}_${win.replace(':', '-')}_${s.techId || 'unassigned'}`,
    };
  });
}

function splitSlotResults(slots, maxResults, expanderMaxResults) {
  const visibleCount = Math.max(0, Number(maxResults) || 0);
  const moreCount = Math.max(0, Number(expanderMaxResults) || 0);
  const safeSlots = Array.isArray(slots) ? slots : [];
  return {
    primary: safeSlots.slice(0, visibleCount),
    expander: safeSlots.slice(visibleCount, visibleCount + moreCount),
  };
}

function dateWithTimeSlotId(date, windowStart, techId) {
  return `${date}_${String(windowStart).replace(':', '-')}_${techId || 'unassigned'}`;
}

function dedupeSlots(slots = []) {
  const byKey = new Map();
  for (const slot of slots) {
    const key = slot?.slotId || `${slot?.date}|${slot?.windowStart}|${slot?.techId || 'unassigned'}`;
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing || slot?.routeOptimal === true || (slot?.nearbyJob && !existing.nearbyJob)) {
      byKey.set(key, slot);
    }
  }
  return [...byKey.values()];
}

function compareCustomerFacingSlots(a, b) {
  const dateCmp = String(a?.date || '').localeCompare(String(b?.date || ''));
  if (dateCmp !== 0) return dateCmp;

  const timeCmp = String(a?.windowStart || '').localeCompare(String(b?.windowStart || ''));
  if (timeCmp !== 0) return timeCmp;

  if (!!a?.routeOptimal !== !!b?.routeOptimal) return a?.routeOptimal ? -1 : 1;

  const aDetour = a?.nearbyJob?.detourMinutes ?? Infinity;
  const bDetour = b?.nearbyJob?.detourMinutes ?? Infinity;
  if (aDetour !== bDetour) return aDetour - bDetour;

  return String(a?.slotId || '').localeCompare(String(b?.slotId || ''));
}

function etDateRange(windowDays, now = new Date()) {
  const safeWindowDays = Math.max(1, Number(windowDays) || DEFAULT_OPTS.windowDays);
  const start = etDateString(now);
  const end = etDateString(addETDays(now, safeWindowDays));
  return { dateFrom: start, dateTo: end };
}

function enumerateETDateStrings(dateFrom, dateTo, { includeWeekends = true } = {}) {
  const dates = [];
  const start = new Date(`${dateFrom}T12:00:00Z`);
  const end = new Date(`${dateTo}T12:00:00Z`);
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const ymd = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    if (!includeWeekends && (dow === 0 || dow === 6)) continue;
    dates.push(ymd);
  }
  return dates;
}

function earliestBookableMinuteForDate(date, now = new Date(), minimumLeadMinutes = DEFAULT_OPTS.minimumLeadMinutes) {
  if (date !== etDateString(now)) return 0;
  const parts = etParts(now);
  return parts.hour * 60 + parts.minute + Math.max(0, Number(minimumLeadMinutes) || 0);
}

function buildAsapCapacitySlotsForTechs({
  dateFrom,
  dateTo,
  durationMinutes,
  techs = [],
  includeWeekends = true,
  maxCandidates = 36,
  minimumLeadMinutes = DEFAULT_OPTS.minimumLeadMinutes,
  now = new Date(),
} = {}) {
  if (!techs.length) return [];

  const groups = [];
  for (const date of enumerateETDateStrings(dateFrom, dateTo, { includeWeekends })) {
    const earliestMinute = earliestBookableMinuteForDate(date, now, minimumLeadMinutes);
    for (const windowStart of PREFERRED_WINDOWS) {
      if (timeToMinutes(windowStart) < earliestMinute) continue;
      const windowEnd = addMinutesToHHMM(windowStart, durationMinutes);
      if (!slotWindowFitsDay(windowStart, windowEnd)) continue;
      const group = [];
      for (const tech of techs) {
        group.push({
          slotId: dateWithTimeSlotId(date, windowStart, tech.id),
          date,
          windowStart,
          windowEnd,
          durationMinutes,
          techFirstName: (tech.name || '').split(/\s+/)[0] || null,
          techId: tech.id,
          routeOptimal: false,
          nearbyJob: null,
          capacityType: 'asap_open',
        });
      }
      groups.push(group);
    }
  }
  const safeMax = Math.max(0, Number(maxCandidates) || 0);
  const selected = [];
  const maxGroupLength = groups.reduce((max, group) => Math.max(max, group.length), 0);
  for (let techIndex = 0; techIndex < maxGroupLength && selected.length < safeMax; techIndex += 1) {
    for (const group of groups) {
      if (selected.length >= safeMax) break;
      if (group[techIndex]) selected.push(group[techIndex]);
    }
  }
  return selected.sort(compareCustomerFacingSlots);
}

async function buildAsapCapacitySlots(options = {}) {
  const techs = await db('technicians')
    .where({ active: true })
    .select('id', 'name');
  return buildAsapCapacitySlotsForTechs({ ...options, techs });
}

// Reorder a date-sorted slot pool so customers see a spread of distinct
// days instead of every window on the single soonest date. Without this,
// the soonest available date (e.g. one busy Sunday) fills all six primary
// cards and the list reads like "Sunday 10a / Sunday 11a / Sunday 1p /
// ..." — visually monotonous and hides nearer-term variety on Mon/Wed/etc.
//
// Strategy mirrors booking.js curateSlots: one window per day, in
// chronological order, then a second pass for any remaining capacity. The
// soonest day's earliest-time slot stays first — that's the "book me ASAP"
// option, surfaced regardless of route proximity. Input must already be
// sorted by compareCustomerFacingSlots so each day's bucket is best-first.
function diversifyByDay(sortedSlots) {
  if (!Array.isArray(sortedSlots) || sortedSlots.length <= 1) return sortedSlots;
  const byDate = new Map(); // insertion order = chronological (input is date-asc)
  for (const slot of sortedSlots) {
    const date = slot?.date || '';
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(slot);
  }
  // Each bucket is time-asc (compareCustomerFacingSlots). The soonest day
  // (index 0) keeps its earliest window so the first card is always the
  // genuine ASAP option, regardless of route proximity. Every later day is
  // rotated by its position so the list leads with a spread of times
  // (9a, 10a, 11a, 1p, ...) instead of nine identical 9 AM windows — the
  // same "choice across the day" intent as booking.js curateSlots.
  const buckets = [...byDate.values()].map((bucket, dayIndex) => {
    if (dayIndex === 0 || bucket.length <= 1) return bucket;
    const offset = dayIndex % bucket.length;
    return [...bucket.slice(offset), ...bucket.slice(0, offset)];
  });
  const ordered = [];
  for (let rank = 0; ordered.length < sortedSlots.length; rank += 1) {
    let addedThisRank = false;
    for (const bucket of buckets) {
      if (bucket[rank]) {
        ordered.push(bucket[rank]);
        addedThisRank = true;
      }
    }
    if (!addedThisRank) break;
  }
  return ordered;
}

function selectCustomerFacingSlots(slots, limit) {
  const safeLimit = Math.max(0, Number(limit) || 0);
  if (!safeLimit) return [];

  const sorted = (Array.isArray(slots) ? slots : [])
    .filter(Boolean)
    .sort(compareCustomerFacingSlots);

  return diversifyByDay(sorted).slice(0, safeLimit);
}

// Drop any candidate whose rounded display window collides with a real
// booking on the same tech/date. find-time evaluates the un-rounded
// earliestStart; the hour-rounding done in classifySlot can shift the
// displayed window forward by up to 59 minutes, which can land on top of
// the very next anchor that find-time was routing around. Without this
// guard the slot is shown to the customer but reserveSlot() then fails
// with SLOT_UNAVAILABLE on tap.
async function filterCollidingSlots(slots, { dateFrom, dateTo }) {
  if (!Array.isArray(slots) || slots.length === 0) return slots;
  const rows = await db('scheduled_services')
    .whereBetween('scheduled_date', [dateFrom, dateTo])
    .whereNotIn('status', ['cancelled'])
    .andWhere((q) => {
      q.whereNull('reservation_expires_at').orWhereRaw('reservation_expires_at > NOW()');
    })
    .select('technician_id', 'scheduled_date', 'window_start', 'window_end', 'estimated_duration_minutes');

  const byTechDate = new Map();
  for (const row of rows) {
    const date = (typeof row.scheduled_date === 'string'
      ? row.scheduled_date
      : row.scheduled_date.toISOString()).slice(0, 10);
    const key = `${row.technician_id || 'unassigned'}|${date}`;
    if (!byTechDate.has(key)) byTechDate.set(key, []);
    const startMin = timeToMinutes(String(row.window_start || '').slice(0, 5));
    const explicitEndMin = timeToMinutes(String(row.window_end || '').slice(0, 5));
    const fallbackDuration = Number(row.estimated_duration_minutes) > 0
      ? Number(row.estimated_duration_minutes)
      : DEFAULT_OPTS.durationMinutes;
    byTechDate.get(key).push({
      startMin,
      endMin: explicitEndMin ?? (startMin != null ? startMin + fallbackDuration : null),
    });
  }

  return slots.filter((s) => {
    const key = `${s.techId || 'unassigned'}|${s.date}`;
    const existing = byTechDate.get(key) || [];
    const slotStart = timeToMinutes(s.windowStart);
    const slotEnd = timeToMinutes(s.windowEnd);
    if (slotStart == null || slotEnd == null) return true;
    if (!slotWindowFitsDay(s.windowStart, s.windowEnd)) return false;
    if (existing.length === 0) return true;
    return !existing.some((b) => {
      if (b.startMin == null || b.endMin == null) return false;
      return slotStart < b.endMin && slotEnd > b.startMin;
    });
  });
}

function timeToMinutes(hhmm) {
  if (!hhmm) return null;
  const parts = String(hhmm).split(':');
  const h = Number(parts[0]);
  const m = Number(parts[1] || 0);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

// Filter a customer-facing slot pool by time-of-day preference ('morning' |
// 'afternoon' | 'evening' | 'any'). morning = before noon; afternoon/evening
// fall inside the 12pm–5pm working window.
function filterTimeOfDay(slots, timeOfDay) {
  if (!timeOfDay || timeOfDay === 'any') return slots;
  return (Array.isArray(slots) ? slots : []).filter((s) => {
    const min = timeToMinutes(s.windowStart);
    if (min == null) return true;
    return timeOfDay === 'morning' ? min < 12 * 60 : min >= 12 * 60;
  });
}

function classifySlot(slot, proximityDriveMinutes, durationMinutes = DEFAULT_OPTS.durationMinutes) {
  const routeOptimal = Number.isFinite(slot.detour_minutes) && slot.detour_minutes <= proximityDriveMinutes;
  const nearbyAnchor = routeOptimal ? pickNearbyAnchor(slot) : null;
  // Round display times to clean hour boundaries. slotId still uses the
  // rounded start so collisions between two slots that rounded to the
  // same hour (possible at the edge of find-time's range) don't both
  // generate identical IDs — techId differentiates.
  const windowStart = roundUpToHour(slot.start_time);
  const windowEnd = addMinutesToHHMM(windowStart, durationMinutes);
  return {
    slotId: `${slot.date}_${windowStart.replace(':', '-')}_${slot.technician?.id || 'unassigned'}`,
    date: slot.date,
    windowStart,
    windowEnd,
    durationMinutes,
    techFirstName: (slot.technician?.name || '').split(/\s+/)[0] || null,
    techId: slot.technician?.id || null,
    routeOptimal,
    nearbyJob: routeOptimal && nearbyAnchor
      ? { detourMinutes: slot.detour_minutes }
      : null,
  };
}

// ---------- main ----------

async function getAvailableSlots(estimateId, userOpts = {}) {
  const opts = { ...DEFAULT_OPTS, ...userOpts };

  const estimate = await db('estimates').where({ id: estimateId }).first();
  if (!estimate) {
    const err = new Error('estimate not found');
    err.code = 'ESTIMATE_NOT_FOUND';
    throw err;
  }
  if (BLOCKED_STATES_FOR_SLOTS.has(estimate.status)) {
    const err = new Error(`cannot load slots for estimate in state '${estimate.status}'`);
    err.code = 'ESTIMATE_TERMINAL';
    throw err;
  }
  if (estimate.expires_at && new Date(estimate.expires_at) < new Date()) {
    const err = new Error('estimate has expired');
    err.code = 'ESTIMATE_EXPIRED';
    throw err;
  }

  const serviceProfile = resolveEstimateSlotProfile(estimate, userOpts);

  // Cache check — keyed per (estimateId, hour bucket).
  cleanupCache(wrapperCache);
  const cacheKey = [
    estimateId,
    cacheHour(),
    opts.windowDays,
    opts.maxResults,
    opts.expanderMaxResults,
    opts.includeWeekends ? 'weekends' : 'weekdays',
    serviceProfile.serviceMode,
    serviceProfile.selectedFrequency || 'default',
    serviceProfile.durationMinutes,
    opts.minimumLeadMinutes,
    opts.dateFrom || 'auto',
    opts.dateTo || 'auto',
    opts.timeOfDay || 'any',
  ].join(':');
  const cached = wrapperCache.get(cacheKey);
  if (cached) {
    return { ...cached.result, metadata: { ...cached.result.metadata, cacheHit: true } };
  }

  // A caller-supplied explicit window (specific date or AI-parsed range)
  // overrides the rolling windowDays lookahead.
  const { dateFrom, dateTo } = (opts.dateFrom && opts.dateTo)
    ? { dateFrom: opts.dateFrom, dateTo: opts.dateTo }
    : etDateRange(opts.windowDays);
  const TARGET_TOTAL = opts.maxResults + opts.expanderMaxResults;
  const coords = await resolveEstimateCoords(estimate);

  // If we can't resolve coords, degrade gracefully: return empty primary,
  // no route-proximity tags. Getting the customer on the calendar still
  // matters more than withholding slots because geocoding failed.
  if (!coords) {
    const asapRaw = await buildAsapCapacitySlots({
      dateFrom,
      dateTo,
      durationMinutes: serviceProfile.durationMinutes,
      includeWeekends: opts.includeWeekends,
      maxCandidates: Math.max(TARGET_TOTAL * 6, 24),
      minimumLeadMinutes: opts.minimumLeadMinutes,
    });
    const asap = await filterCollidingSlots(asapRaw, { dateFrom, dateTo });
    const spread = spreadWindowsAcrossDay(asap.sort(compareCustomerFacingSlots), serviceProfile.durationMinutes);
    const filtered = await filterCollidingSlots(spread, { dateFrom, dateTo });
    const selected = selectCustomerFacingSlots(filterTimeOfDay(filtered, opts.timeOfDay), TARGET_TOTAL);
    const { primary, expander } = splitSlotResults(selected, opts.maxResults, opts.expanderMaxResults);
    const fallback = {
      primary,
      expander,
      nearby: [...primary, ...expander].some((s) => s.routeOptimal),
      metadata: {
        estimateAddress: estimate.address || null,
        estimateCoords: null,
        windowDays: opts.windowDays,
        proximityDriveMinutes: opts.proximityDriveMinutes,
        includeWeekends: opts.includeWeekends,
        minimumLeadMinutes: opts.minimumLeadMinutes,
        serviceProfile,
        generatedAt: new Date().toISOString(),
        cacheHit: false,
        coordsSource: 'none',
      },
    };
    return fallback;
  }

  // Pull a generous topN so we can split customer-facing slots post-hoc
  // without a second call. find-time sorts by score (detour + day penalty)
  // ascending, so this includes far more candidates than we'll surface.
  const [raw, asapRaw] = await Promise.all([
    findAvailableSlots({
      lat: coords.lat,
      lng: coords.lng,
      durationMinutes: serviceProfile.durationMinutes,
      dateFrom,
      dateTo,
      topN: Number.MAX_SAFE_INTEGER,
      includeWeekends: opts.includeWeekends,
    }),
    buildAsapCapacitySlots({
      dateFrom,
      dateTo,
      durationMinutes: serviceProfile.durationMinutes,
      includeWeekends: opts.includeWeekends,
      maxCandidates: Math.max(TARGET_TOTAL * 6, 24),
      minimumLeadMinutes: opts.minimumLeadMinutes,
    }),
  ]);

  const classifiedRaw = (raw?.slots || [])
    .map((s) => classifySlot(s, opts.proximityDriveMinutes, serviceProfile.durationMinutes));
  // Drop candidates whose rounded display window collides with a real
  // existing booking on the same tech/date — see filterCollidingSlots.
  const classified = await filterCollidingSlots(classifiedRaw, { dateFrom, dateTo });

  // Target: always show the soonest upcoming customer-facing windows first,
  // even when those windows are not route-optimal. Route-optimality remains
  // a per-slot badge/copy signal, not a reason to bury sooner dates.
  const asap = await filterCollidingSlots(asapRaw, { dateFrom, dateTo });
  const sortedPool = dedupeSlots([...asap, ...classified]).sort(compareCustomerFacingSlots);
  const spread = spreadWindowsAcrossDay(sortedPool, serviceProfile.durationMinutes);
  // spreadWindowsAcrossDay re-assigns windowStart for non-route-optimal
  // slots; that can land them on an existing booking, so re-filter once
  // more before choosing the final customer-facing list.
  const filtered = await filterCollidingSlots(spread, { dateFrom, dateTo });
  const selected = selectCustomerFacingSlots(filterTimeOfDay(filtered, opts.timeOfDay), TARGET_TOTAL);
  const { primary, expander } = splitSlotResults(selected, opts.maxResults, opts.expanderMaxResults);

  const result = {
    primary,
    expander,
    nearby: [...primary, ...expander].some((s) => s.routeOptimal),
    metadata: {
      estimateAddress: estimate.address || null,
      estimateCoords: { lat: coords.lat, lng: coords.lng },
      coordsSource: coords.source,
      windowDays: opts.windowDays,
      proximityDriveMinutes: opts.proximityDriveMinutes,
      includeWeekends: opts.includeWeekends,
      minimumLeadMinutes: opts.minimumLeadMinutes,
      serviceProfile,
      generatedAt: new Date().toISOString(),
      cacheHit: false,
      // TODO: PR B's accept-handler invalidates this cache on every new
      // scheduled_services insert. For now, the 5-min TTL is the only
      // staleness guard.
    },
  };

  wrapperCache.set(cacheKey, { result, expiresAt: Date.now() + WRAPPER_TTL_MS });
  return result;
}

// ---------- Waves AI date/time search ----------

// Natural-language slot search for the estimate page. Parses the customer's
// free-text "when" into a date window + time-of-day, then returns the matching
// open slots (same primary/expander shape SlotPicker already renders) plus a
// short recap line and a `nearby` flag for the soft route-density message.
async function findEstimateSlots(estimateId, userOpts = {}) {
  const { parseWhen, summarizeWindow } = require('./scheduling/parse-when');
  const query = String(userOpts.query || '').trim();

  const when = await parseWhen(query, {
    now: new Date(),
    minDaysOut: 0,
    maxDaysOut: 90,
    defaultWindowDays: DEFAULT_OPTS.windowDays,
  });

  const result = await getAvailableSlots(estimateId, {
    serviceMode: userOpts.serviceMode,
    selectedFrequency: userOpts.selectedFrequency,
    dateFrom: when.dateFrom,
    dateTo: when.dateTo,
    timeOfDay: when.timeOfDay,
    // Widen the result set for a search — the window may span several days.
    maxResults: 8,
    expanderMaxResults: 4,
  });

  const primary = result.primary || [];
  const expander = result.expander || [];
  const nearby = result.nearby ?? [...primary, ...expander].some((s) => s.routeOptimal);
  return {
    summary: summarizeWindow(when, { count: primary.length + expander.length, nearby }),
    understood: when.understood,
    window: { date_from: when.dateFrom, date_to: when.dateTo },
    time_of_day: when.timeOfDay,
    nearby,
    primary,
    expander,
  };
}

// ---------- admin debug variant ----------

async function getSlotDebug(estimateId, userOpts = {}) {
  const opts = { ...DEFAULT_OPTS, ...userOpts };
  const estimate = await db('estimates').where({ id: estimateId }).first();
  if (!estimate) {
    const err = new Error('estimate not found');
    err.code = 'ESTIMATE_NOT_FOUND';
    throw err;
  }

  const startedAt = Date.now();
  const geocodeBefore = geocodeCache.size;
  const serviceProfile = resolveEstimateSlotProfile(estimate, userOpts);
  const coords = await resolveEstimateCoords(estimate);
  const geocodeAfter = geocodeCache.size;

  if (!coords) {
    return {
      estimate: { id: estimate.id, token: estimate.token, status: estimate.status, address: estimate.address },
      error: 'could not resolve estimate coordinates',
      computeTimeMs: Date.now() - startedAt,
    };
  }

  const { dateFrom, dateTo } = etDateRange(opts.windowDays);

  const raw = await findAvailableSlots({
    lat: coords.lat,
    lng: coords.lng,
    durationMinutes: serviceProfile.durationMinutes,
    dateFrom,
    dateTo,
    topN: 200, // broad — debug surface wants everything
    includeWeekends: opts.includeWeekends,
  });

  const classified = (raw?.slots || []).map((s) => ({
    ...classifySlot(s, opts.proximityDriveMinutes, serviceProfile.durationMinutes),
    raw: {
      score: s.score,
      detour_minutes: s.detour_minutes,
      baseline_drive_minutes: s.baseline_drive_minutes,
      total_drive_minutes: s.total_drive_minutes,
      insertion: s.insertion,
      stops_that_day: s.stops_that_day,
    },
  }));

  return {
    estimate: {
      id: estimate.id,
      token: estimate.token,
      status: estimate.status,
      address: estimate.address,
      customerId: estimate.customer_id,
    },
    coords,
    window: { dateFrom, dateTo, durationMinutes: serviceProfile.durationMinutes },
    serviceProfile,
    proximityDriveMinutes: opts.proximityDriveMinutes,
    rawEvaluated: raw?.evaluated || 0,
    rawTotalFeasible: raw?.total_feasible || 0,
    routeOptimalCount: classified.filter((s) => s.routeOptimal).length,
    cacheSnapshot: {
      wrapperEntries: wrapperCache.size,
      geocodeEntries: geocodeAfter,
      geocodeMissedThisRequest: geocodeAfter > geocodeBefore ? 1 : 0,
    },
    computeTimeMs: Date.now() - startedAt,
    slots: classified,
  };
}

// Narrow cache invalidation for PR B's accept handler — one slot booking
// on estimate X means estimate X's cached slot list is stale, but nothing
// else is. Scans all cache entries and drops anything keyed to this
// estimate (across all hour buckets — the key shape is `${estimateId}:${hour}`).
function invalidateEstimate(estimateId) {
  if (!estimateId) return 0;
  const prefix = `${estimateId}:`;
  let dropped = 0;
  for (const k of wrapperCache.keys()) {
    if (k.startsWith(prefix)) { wrapperCache.delete(k); dropped++; }
  }
  return dropped;
}

module.exports = {
  getAvailableSlots,
  findEstimateSlots,
  getSlotDebug,
  invalidateEstimate,
  resolveEstimateSlotProfile,
  // Exposed for tests — don't rely on them in app code.
  _internals: {
    parseAnchorTime,
    pickNearbyAnchor,
    classifySlot,
    buildAsapCapacitySlots,
    buildAsapCapacitySlotsForTechs,
    dedupeSlots,
    earliestBookableMinuteForDate,
    enumerateETDateStrings,
    etDateRange,
    splitSlotResults,
    selectCustomerFacingSlots,
    diversifyByDay,
    compareCustomerFacingSlots,
    spreadWindowsAcrossDay,
    resolveEstimateSlotProfile,
    durationForService,
    addMinutesToHHMM,
    slotWindowFitsDay,
    clearCaches() { wrapperCache.clear(); geocodeCache.clear(); },
  },
};
