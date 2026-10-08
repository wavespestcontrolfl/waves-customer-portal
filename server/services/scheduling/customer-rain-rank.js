/**
 * Rain ranking on the customer booking surfaces (owner 2026-10-08,
 * GATE_CUSTOMER_RAIN_RANK, dark): the same rule the New Appointment picker
 * runs under GATE_BOOKING_RAIN_RANK (rain-fit.js), applied to the offers
 * buildBookingAvailability curates for /book, the inspection link and the
 * public reschedule page.
 *
 * It only changes ORDER: which hours are offered, the full day list, the
 * signed offers and the commit checks are untouched. An outdoor booking's
 * wet hours (60%+ NWS chance from the start through 2 h after the end, next
 * 3 dates) rank after its dry ones; a rain-OK booking's wet hours rank
 * first. Fail open: no forecast, a neutral booking or the gate off leaves
 * every candidate at tier 0, the order it has today.
 */
const logger = require('../logger');
const { rainFitFor, rainTierOf, withCatalogKeys, boundedHourlyRain } = require('./rain-fit');
const { etDateString } = require('../../utils/datetime-et');

const GATE = 'GATE_CUSTOMER_RAIN_RANK';

// What is being booked: an existing visit's own catalog identity when the
// caller has one (inspection link, reschedule), else the funnel's labels.
function servicesToClassify({ serviceIdentity, serviceLabels }) {
  const name = serviceIdentity && (serviceIdentity.serviceType || serviceIdentity.catalogServiceKey);
  if (name) return [{ name, serviceKey: serviceIdentity.catalogServiceKey || null }];
  return (Array.isArray(serviceLabels) ? serviceLabels : []).filter(Boolean);
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
    const hourly = await (deps.hourlyRain || boundedHourlyRain)(lat, lng, true);
    return rainTierOf(fit, hourly, etDateString(today || new Date()));
  } catch (err) {
    logger.warn(`[customer-rain-rank] skipped (today's order kept): ${err.message}`);
    return null;
  }
}

// Stamp each candidate's tier (0 when there is no tier function). Returns
// the same array, so the caller can chain its sort.
function stampRainTiers(candidates, tierOf) {
  for (const candidate of candidates) candidate.rain_tier = tierOf ? tierOf(candidate) : 0;
  return candidates;
}

// Tier difference for a comparator's first key; 0 for unstamped rows.
const rainTierDiff = (a, b) => (a.rain_tier ?? 0) - (b.rain_tier ?? 0);

module.exports = { customerRainTierOf, stampRainTiers, rainTierDiff, GATE };
