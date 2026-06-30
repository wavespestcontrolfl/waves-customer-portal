const logger = require('./logger');

const STALE_TECH_STATUS_MS = 5 * 60 * 1000;
const FUTURE_TIMESTAMP_TOLERANCE_MS = 2 * 60 * 1000;
const CUSTOMER_TRACKING_ETA_TIMEOUT_MS = 750;

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function isFreshTimestamp(value, nowMs = Date.now(), staleMs = STALE_TECH_STATUS_MS) {
  if (!value) return false;
  const updatedMs = new Date(value).getTime();
  return Number.isFinite(updatedMs)
    && updatedMs - nowMs <= FUTURE_TIMESTAMP_TOLERANCE_MS
    && nowMs - updatedMs <= staleMs;
}

// Synchronous straight-line ETA used as a guaranteed floor when the
// provider (Google Distance Matrix) is slow or unavailable. Mirrors the
// haversine fallback in bouncie.calculateETAFromCoords exactly (1.4x road
// factor, 30mph average, 1-min minimum) so the customer page reads the
// same whether the number came from the provider or this fallback.
function haversineEtaFallback(fromLat, fromLng, toLat, toLng) {
  const R = 3959;
  const dLat = (toLat - fromLat) * Math.PI / 180;
  const dLng = (toLng - fromLng) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(fromLat * Math.PI / 180) * Math.cos(toLat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  const dist = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const roadDist = dist * 1.4;
  const etaMin = Math.round((roadDist / 30) * 60);
  return {
    minutes: Math.max(1, etaMin),
    distanceMiles: Math.round(roadDist * 10) / 10,
    source: 'haversine',
  };
}

async function calculateBoundedTrackingEta({
  techLat,
  techLng,
  customerLat,
  customerLng,
  techUpdatedAt,
  bouncieService,
  timeoutMs = CUSTOMER_TRACKING_ETA_TIMEOUT_MS,
  logPrefix = 'customer-tracking-eta',
} = {}) {
  const fromLat = finiteNumber(techLat);
  const fromLng = finiteNumber(techLng);
  const toLat = finiteNumber(customerLat);
  const toLng = finiteNumber(customerLng);
  if (fromLat == null || fromLng == null || toLat == null || toLng == null) return null;
  if (!isFreshTimestamp(techUpdatedAt)) return null;

  try {
    const svc = bouncieService || require('./bouncie');
    const etaPromise = Promise.resolve(
      svc.calculateETAFromCoords(fromLat, fromLng, toLat, toLng)
    ).catch((err) => {
      logger.warn(`[${logPrefix}] ETA calculation failed: ${err.message}`);
      return null;
    });
    let timeoutId;
    const timeoutPromise = new Promise((resolve) => {
      timeoutId = setTimeout(() => resolve(null), timeoutMs);
    });
    const eta = await Promise.race([etaPromise, timeoutPromise]).finally(() => {
      clearTimeout(timeoutId);
    });
    // The provider can time out (slow Distance Matrix), throw, or omit the
    // duration. In all of those cases we still have a fresh tech position
    // and a valid destination, so fall back to a synchronous haversine
    // estimate rather than dropping the ETA — otherwise the customer track
    // page renders the live map with no minutes ("—" instead of a number).
    if (!eta || eta.etaMinutes == null) {
      return { ...haversineEtaFallback(fromLat, fromLng, toLat, toLng), techUpdatedAt };
    }
    return {
      minutes: eta.etaMinutes,
      distanceMiles: eta.distanceMiles ?? null,
      source: eta.source || null,
      techUpdatedAt,
    };
  } catch (err) {
    logger.warn(`[${logPrefix}] ETA lookup failed: ${err.message}`);
    return { ...haversineEtaFallback(fromLat, fromLng, toLat, toLng), techUpdatedAt };
  }
}

module.exports = {
  STALE_TECH_STATUS_MS,
  FUTURE_TIMESTAMP_TOLERANCE_MS,
  CUSTOMER_TRACKING_ETA_TIMEOUT_MS,
  finiteNumber,
  isFreshTimestamp,
  calculateBoundedTrackingEta,
};
