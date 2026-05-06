const logger = require('./logger');

const STALE_TECH_STATUS_MS = 5 * 60 * 1000;
const CUSTOMER_TRACKING_ETA_TIMEOUT_MS = 750;

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function isFreshTimestamp(value, nowMs = Date.now(), staleMs = STALE_TECH_STATUS_MS) {
  if (!value) return false;
  const updatedMs = new Date(value).getTime();
  return Number.isFinite(updatedMs) && nowMs - updatedMs <= staleMs;
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
    if (!eta) return null;
    return {
      minutes: eta.etaMinutes ?? null,
      distanceMiles: eta.distanceMiles ?? null,
      source: eta.source || null,
      techUpdatedAt,
    };
  } catch (err) {
    logger.warn(`[${logPrefix}] ETA lookup failed: ${err.message}`);
    return null;
  }
}

module.exports = {
  STALE_TECH_STATUS_MS,
  CUSTOMER_TRACKING_ETA_TIMEOUT_MS,
  finiteNumber,
  isFreshTimestamp,
  calculateBoundedTrackingEta,
};
