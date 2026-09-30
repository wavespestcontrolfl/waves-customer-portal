const db = require('../models/db');
const logger = require('./logger');
const { pingTechLocation } = require('./tech-status');
const {
  finiteNumber,
  isFreshTimestamp,
  STALE_TECH_STATUS_MS,
} = require('./customer-tracking-eta');

const BOUNCIE_LOCATION_FALLBACK_TIMEOUT_MS = 1500;

async function withTimeout(promise, timeoutMs, fallbackValue = null) {
  let timeoutId;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve(fallbackValue), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

// `notBefore` (Codex round-24 P2): tech_status is keyed by technician and stores
// no device identity, so after an admin repoints the technician at another
// tracker a cached row may hold the OLD vehicle's coordinates. A caller that
// needs the position to belong to the CURRENT mapping passes the instant the
// mapping was last edited; a cached fix reported before it is not trusted.
async function readTechStatusPosition(techId, notBefore = null) {
  const ts = await db('tech_status')
    .where({ tech_id: techId })
    .first('lat', 'lng', 'location_updated_at', 'updated_at');
  if (!ts) return null;

  const lat = finiteNumber(ts.lat);
  const lng = finiteNumber(ts.lng);
  const lastReportedAt = ts.location_updated_at;
  if (lat == null || lng == null || !isFreshTimestamp(lastReportedAt)) return null;
  if (notBefore != null && !(new Date(lastReportedAt).getTime() >= new Date(notBefore).getTime())) return null;

  return {
    lat,
    lng,
    heading: null,
    isRunning: null,
    updatedAt: lastReportedAt,
    lastReportedAt,
    stale: false,
    source: 'tech_status',
  };
}

async function lookupBouncieImei(techId) {
  const tech = await db('technicians')
    .where({ id: techId })
    .first('bouncie_imei');
  const imei = String(tech?.bouncie_imei || '').trim();
  return imei || null;
}

// Is the technician STILL mapped to the IMEI a fetched location came from? A read
// failure or a missing row cannot prove it -> false.
async function mappingStillMatches(techId, imei) {
  try {
    const tech = await db('technicians').where({ id: techId }).first('bouncie_imei');
    return Boolean(tech) && String(tech.bouncie_imei || '').trim() === imei;
  } catch (err) {
    logger.warn(`[tracking-vehicle-location] mapping recheck failed: ${err.message}`);
    return false;
  }
}

async function resolveBouncieFallback({
  techId,
  bouncieImei,
  bouncieService,
  timeoutMs,
  logPrefix,
}) {
  const imei = String(bouncieImei || await lookupBouncieImei(techId) || '').trim();
  if (!imei) return null;

  try {
    const svc = bouncieService || require('./bouncie');
    const loc = await withTimeout(
      Promise.resolve(svc.getLocationByImei(imei)),
      timeoutMs,
      null
    );
    if (!loc) return null;

    const lat = finiteNumber(loc.lat);
    const lng = finiteNumber(loc.lng);
    const lastReportedAt = loc.updatedAt || loc.lastUpdated || loc.timestamp || null;
    if (lat == null || lng == null || !isFreshTimestamp(lastReportedAt)) return null;

    // Revalidate the mapping BEFORE returning the coordinates (Codex round-38 P2): an
    // IMEI remap that landed while getLocationByImei was in flight makes this the OLD
    // vehicle's point. The guarded cache write below only protects persistence; the
    // response must not publish one wrong map point / ETA either. Unverifiable or
    // changed -> discard (fail closed: no map point, no ETA).
    if (!(await mappingStillMatches(techId, imei))) return null;

    pingTechLocation({
      tech_id: techId,
      lat,
      lng,
      ignition: loc.isRunning,
      speed_mph: loc.speed ?? loc.speed_mph,
      reported_at: lastReportedAt,
      // Compare-and-write (round-37 P2): only while the tech is STILL mapped to the
      // IMEI this point was fetched from — an in-flight fetch from a device that was
      // remapped meanwhile must not seed the cache with the old vehicle's fix.
      requireBouncieImei: imei,
    }).catch((err) => {
      logger.warn(`[${logPrefix}] tech_status fallback write failed: ${err.message}`);
    });

    return {
      lat,
      lng,
      heading: loc.heading ?? null,
      isRunning: loc.isRunning ?? null,
      updatedAt: lastReportedAt,
      lastReportedAt,
      stale: false,
      source: 'bouncie_api',
    };
  } catch (err) {
    logger.warn(`[${logPrefix}] Bouncie location fallback failed: ${err.message}`);
    return null;
  }
}

async function resolveFreshTechPosition({
  techId,
  bouncieImei = null,
  bouncieService = null,
  allowBouncieFallback = true,
  timeoutMs = BOUNCIE_LOCATION_FALLBACK_TIMEOUT_MS,
  logPrefix = 'tracking-vehicle-location',
  cachedNotBefore = null,
} = {}) {
  if (!techId) return null;

  try {
    const statusPosition = await readTechStatusPosition(techId, cachedNotBefore);
    if (statusPosition) return statusPosition;
  } catch (err) {
    logger.warn(`[${logPrefix}] tech_status lookup failed: ${err.message}`);
  }

  if (!allowBouncieFallback) return null;
  return resolveBouncieFallback({
    techId,
    bouncieImei,
    bouncieService,
    timeoutMs,
    logPrefix,
  });
}

module.exports = {
  BOUNCIE_LOCATION_FALLBACK_TIMEOUT_MS,
  STALE_TECH_STATUS_MS,
  resolveFreshTechPosition,
  _test: {
    withTimeout,
  },
};
