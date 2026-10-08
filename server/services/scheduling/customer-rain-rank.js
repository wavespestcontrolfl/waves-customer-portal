/**
 * Rain ranking on the customer booking surfaces (owner 2026-10-08,
 * GATE_CUSTOMER_RAIN_RANK, dark): the same rule the New Appointment picker
 * runs under GATE_BOOKING_RAIN_RANK (rain-fit.js), applied to the offers
 * buildBookingAvailability curates for /book, the inspection link and the
 * public reschedule page, and to the estimate page's slot list
 * (estimate-slot-availability.js).
 *
 * It only changes ORDER: which hours are offered, the full day list, the
 * signed offers and the commit checks are untouched. A recommendation whose
 * tier is above 0 carries `display_tier`, which the booking picker sorts by
 * first (it re-sorts the recommendations itself by nearby, then rank). An outdoor booking's
 * wet hours (60%+ NWS chance from the start through 2 h after the end, next
 * 3 dates) rank after its dry ones; a rain-OK booking's wet hours rank
 * first. Fail open: no forecast, a neutral booking or the gate off leaves
 * every candidate at tier 0, the order it has today.
 */
const logger = require('../logger');
const { rainFitFor, rainTierOf, withCatalogKeys, boundedHourlyRain, inRainHorizon } = require('./rain-fit');
const { etDateString } = require('../../utils/datetime-et');

const GATE = 'GATE_CUSTOMER_RAIN_RANK';

// What is being booked: an existing visit's own catalog identity when the
// caller has one (inspection link, reschedule), else the funnel's labels.
function servicesToClassify({ serviceIdentity, serviceLabels }) {
  const name = serviceIdentity && (serviceIdentity.serviceType || serviceIdentity.catalogServiceKey);
  if (name) return [{ name, serviceKey: serviceIdentity.catalogServiceKey || null }];
  // Labels, or { name, serviceKey } rows from a caller that has the key.
  return (Array.isArray(serviceLabels) ? serviceLabels : []).filter((item) => (item && item.name) || typeof item === 'string');
}

/**
 * The tier function for one availability build, or null (today's order).
 * Never throws. `skip` = the caller runs another ranking profile that owns
 * the order (public re-service: soonest callback first).
 */
async function customerRainTierOf({
  serviceIdentity = null, serviceLabels = [], lat, lng, today, skip = false, db, deps = {},
} = {}) {
  try {
    const { gateEnvValue } = require('../../config/feature-gates');
    if (skip || !gateEnvValue(GATE)) return null;
    const services = await withCatalogKeys(servicesToClassify({ serviceIdentity, serviceLabels }), db, { gate: GATE });
    const fit = rainFitFor(services);
    if (fit === 'neutral') return null;
    // Checked last, just before the read: only a build that would really
    // start a forecast lookup spends the budget (Codex #6126 r3).
    if (!forecastAllowed(lat, lng)) return null;
    const hourly = await (deps.hourlyRain || boundedHourlyRain)(lat, lng, true);
    return rainTierOf(fit, hourly, etDateString(today || new Date()));
  } catch (err) {
    logger.warn(`[customer-rain-rank] skipped (today's order kept): ${err.message}`);
    return null;
  }
}

// Public availability routes are unauthenticated, and each cold coordinate
// costs an outbound forecast read (a paid one when NWS fails). So a read is
// made only for a point inside the service area's coarse box, and at most
// FORECAST_BUDGET of them start per minute in this process; past that the
// build keeps today's order (Codex #6126 r2). A repeat of the same point is
// served from the forecast cache and still counts: the budget is a ceiling,
// not an exact count of provider calls.
const FORECAST_BUDGET = 60;
const BUDGET_WINDOW_MS = 60 * 1000;
const _forecastStarts = [];
function takeForecastBudget(now = Date.now()) {
  while (_forecastStarts.length && now - _forecastStarts[0] >= BUDGET_WINDOW_MS) _forecastStarts.shift();
  if (_forecastStarts.length >= FORECAST_BUDGET) return false;
  _forecastStarts.push(now);
  return true;
}

function forecastAllowed(lat, lng) {
  const { isInServiceAreaCoarseBox } = require('../service-area');
  return isInServiceAreaCoarseBox(Number(lat), Number(lng)) && takeForecastBudget();
}

/**
 * One availability build's rain ranking. Nothing is read until `stamp` sees
 * a candidate inside the rain horizon: a browse of later dates, or a build
 * with no candidate, makes no identity lookup and no forecast request and
 * waits for none (every tier would be the same; Codex #6126 r1 + r2). The
 * read is then one bounded lookup; a point outside the service area or a
 * spent budget keeps today's order.
 */
function startCustomerRainRank({ today, lat, lng, ...rest } = {}) {
  const todayYmd = etDateString(today || new Date());
  return {
    async stamp(candidates) {
      const needed = candidates.some((c) => inRainHorizon(c.date, todayYmd));
      return stampRainTiers(candidates, needed ? await customerRainTierOf({ today, lat, lng, ...rest }) : null);
    },
  };
}

/**
 * The tier function for estimate slots ({ date, windowStart, windowEnd }),
 * or null (today's order). Same gate, rules, service-area check and budget
 * as the booking builder; nothing is read unless a slot is inside the rain
 * horizon. `services` = the estimate's service profile rows or labels;
 * `point` = its coordinates ({ lat, lng }), null when it has none.
 */
async function slotRainTierOf(slots, { services = [], profile = null, point = null, today, db, deps = {} } = {}) {
  const todayYmd = etDateString(today || new Date());
  const list = Array.isArray(slots) ? slots : [];
  if (!list.some((slot) => inRainHorizon(slot?.date, todayYmd))) return null;
  const { gateEnvValue } = require('../../config/feature-gates');
  if (!gateEnvValue(GATE)) return null;
  const rows = profile && Array.isArray(profile.services) ? profile.services : services;
  const serviceLabels = await estimateServiceIdentities(rows, { profile, db, deps });
  const tierOf = await customerRainTierOf({ serviceLabels, lat: point?.lat, lng: point?.lng, today, db, deps });
  return tierOf ? (slot) => tierOf({ date: slot.date, start_time: slot.windowStart, end_time: slot.windowEnd }) : null;
}

// An estimate's services as { name, serviceKey } for the classifier. A row's
// display label can differ from the catalog name, so its catalog key settles
// the identity ahead of it. In order: the verified key frozen on the line
// (catalogServiceKey); the row resolveCatalogSlotProfile resolved under the
// capacity gate (resolvedServiceKey); else the same catalog lookup made here
// for that one row, so the ranking does not depend on the capacity gate
// (Codex #6127 r2). A lookup that fails or finds nothing leaves the label.
const MAX_ESTIMATE_SERVICES = 12;
async function estimateServiceIdentities(rows, { profile, db, deps = {} }) {
  const out = [];
  for (const service of (Array.isArray(rows) ? rows : []).slice(0, MAX_ESTIMATE_SERVICES)) {
    if (typeof service === 'string') { out.push(service); continue; }
    const name = service?.label || service?.service;
    let serviceKey = service?.catalogServiceKey || service?.resolvedServiceKey || null;
    if (!serviceKey && profile) serviceKey = await catalogKeyForRow(profile, service, { db, deps });
    out.push({ name, serviceKey });
  }
  return out;
}

async function catalogKeyForRow(profile, service, { db, deps = {} }) {
  try {
    const lookup = deps.catalogLinkForProfile || require('../slot-reservation').catalogLinkForProfile;
    const link = await lookup(db, { ...profile, services: [service] });
    return (link && link.service_key) || null;
  } catch (err) {
    logger.warn(`[customer-rain-rank] estimate catalog lookup failed (label used): ${err.message}`);
    return null;
  }
}

// Stable reorder by rain tier that keeps the first `pinned` items exactly
// where they are: the caller's lead cards (the soonest opening, a scarce
// first day) carry promises of their own.
// A moved item whose tier is above 0 is returned as a copy carrying
// `display_tier`, because the picker re-sorts its top recommendations by
// nearby and would otherwise lift a wet nearby slot back up. The pinned
// items never carry it: they keep today's place on screen too.
function demoteByRainTier(list, tierOf, pinned = 1) {
  if (!tierOf || !Array.isArray(list) || list.length <= pinned) return list;
  const rest = list.slice(pinned).map((item, i) => ({ item, i, tier: tierOf(item) }));
  rest.sort((a, b) => (a.tier - b.tier) || (a.i - b.i));
  return [...list.slice(0, pinned), ...rest.map((r) => withDisplayTier(r.item, r.tier))];
}

// What the client sorts a recommendation by before anything else: the rain
// tier, sent only when it is above 0 (absent = 0), so a payload with no
// rain ranking is byte-identical to today's. `rain_tier` itself stays
// server-side.
function withDisplayTier(slot, rainTier) {
  return rainTier > 0 ? { ...slot, display_tier: rainTier } : slot;
}

// Stamp each candidate's tier (0 when there is no tier function). Returns
// the same array, so the caller can chain its sort.
function stampRainTiers(candidates, tierOf) {
  for (const candidate of candidates) candidate.rain_tier = tierOf ? tierOf(candidate) : 0;
  return candidates;
}

// Tier difference for a comparator's first key; 0 for unstamped rows.
const rainTierDiff = (a, b) => (a.rain_tier ?? 0) - (b.rain_tier ?? 0);

module.exports = { slotRainTierOf, demoteByRainTier, _test: { _forecastStarts, FORECAST_BUDGET }, startCustomerRainRank, customerRainTierOf, stampRainTiers, withDisplayTier, rainTierDiff, GATE };
