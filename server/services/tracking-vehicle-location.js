const db = require('../models/db');
const logger = require('./logger');
const { pingTechLocation } = require('./tech-status');
const {
  finiteNumber,
  isFreshTimestamp,
  techMappingCutoff,
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

// ONE place decides which tracker a position belongs to (Codex round-44 P2, the 5th/6th remap
// race): the technician's CURRENT mapping and the tech_status cache are read in ONE statement
// (technicians LEFT JOIN tech_status), so the cutoff is derived from the mapping as it is NOW, not
// from a row a caller read earlier (an A->B remap between the caller's read and this lookup used
// to leave an A-device point acceptable). tech_status stores no device identity, so a cached fix
// is accepted only if it was reported AND received by the server STRICTLY AFTER the mapping's last change
// (technicians.bouncie_imei_changed_at; NULL = never remapped = no cutoff). A caller-passed
// `cachedNotBefore` is honored only as an EXTRA floor (it can tighten, never loosen).
async function readMappingAndCache(techId) {
  return db('technicians as t')
    .leftJoin('tech_status as ts', 'ts.tech_id', 't.id')
    .where('t.id', techId)
    .first('t.bouncie_imei', 't.bouncie_imei_changed_at', 'ts.lat', 'ts.lng', 'ts.location_updated_at', 'ts.location_received_at');
}

function cachedPositionFrom(row, extraFloor = null) {
  const lat = finiteNumber(row?.lat);
  const lng = finiteNumber(row?.lng);
  const lastReportedAt = row?.location_updated_at;
  if (lat == null || lng == null || !isFreshTimestamp(lastReportedAt)) return null;
  const fixMs = new Date(lastReportedAt).getTime();
  const mapped = techMappingCutoff(row.bouncie_imei_changed_at);
  if (mapped != null) {
    const mappedMs = new Date(mapped).getTime();
    // BOTH must postdate the remap. The provider fix time alone is not proof: the tracker accepts
    // provider timestamps up to two minutes in the FUTURE, so an old device's point committed before
    // the remap can carry a fix time past the remap. The server's own receipt time for these
    // coordinates (tech_status.location_received_at — stamped NOW() only by writers that change
    // lat/lng; tech_status.updated_at is NOT used because status-only writes restamp it) proves the
    // point was written after the remap. A missing receipt cannot prove it -> untrusted.
    const receivedMs = row.location_received_at ? new Date(row.location_received_at).getTime() : NaN;
    if (!(fixMs > mappedMs) || !(receivedMs > mappedMs)) return null;
  }
  if (extraFloor != null && !(fixMs >= new Date(extraFloor).getTime())) return null;
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

async function resolveBouncieFallback({
  techId,
  imei,
  bouncieService,
  timeoutMs,
  logPrefix,
}) {
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

    // The fetched point is served ONLY if the guarded write proves the mapping (Codex round-44):
    // the statement writes only while technicians.bouncie_imei STILL equals the IMEI this point
    // came from (a row-locked compare-and-write), and must RETURN that row. A null (remapped
    // meanwhile), a timeout (the upsert may still be waiting on the technician row and could yet
    // come back null) or an error all mean "unverifiable": no position for this poll, fail closed.
    // Accepted cost: a slow write yields no map point for that poll.
    const UNVERIFIED = Symbol('unverified');
    let written;
    try {
      written = await withTimeout(pingTechLocation({
        tech_id: techId,
        lat,
        lng,
        ignition: loc.isRunning,
        speed_mph: loc.speed ?? loc.speed_mph,
        reported_at: lastReportedAt,
        requireBouncieImei: imei,
      }), timeoutMs, UNVERIFIED);
    } catch (err) {
      logger.warn(`[${logPrefix}] tech_status fallback write failed: ${err.message}`);
      return null;
    }
    if (written === UNVERIFIED) {
      logger.warn(`[${logPrefix}] tech ${techId} guarded write did not settle within ${timeoutMs}ms; serving no position`);
      return null;
    }
    if (!written) {
      logger.info(`[${logPrefix}] tech ${techId} was remapped while its old device was being read; discarding the fetched location`);
      return null;
    }

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
  // Accepted for compatibility; the CURRENT mapping is read here and is the only IMEI ever used.
  bouncieImei: _callerImei = null,
  bouncieService = null,
  allowBouncieFallback = true,
  timeoutMs = BOUNCIE_LOCATION_FALLBACK_TIMEOUT_MS,
  logPrefix = 'tracking-vehicle-location',
  cachedNotBefore = null,
} = {}) {
  if (!techId) return null;

  let row;
  try {
    row = await readMappingAndCache(techId);
  } catch (err) {
    logger.warn(`[${logPrefix}] tracker mapping / tech_status lookup failed: ${err.message}`);
    return null; // cannot prove which vehicle this is -> no position
  }
  if (!row) return null;

  const cached = cachedPositionFrom(row, cachedNotBefore);
  if (cached) return cached;

  if (!allowBouncieFallback) return null;
  const imei = String(row.bouncie_imei || '').trim();
  if (!imei) return null;
  return resolveBouncieFallback({ techId, imei, bouncieService, timeoutMs, logPrefix });
}

module.exports = {
  BOUNCIE_LOCATION_FALLBACK_TIMEOUT_MS,
  STALE_TECH_STATUS_MS,
  resolveFreshTechPosition,
  _test: {
    withTimeout,
  },
};
