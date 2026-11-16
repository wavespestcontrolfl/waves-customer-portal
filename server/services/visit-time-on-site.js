/**
 * Time on site as the truck GPS measured it (owner 2026-11-12: "start tracking time on site by the
 * truck GPS, not the close of the service").
 *
 * READ-THROUGH ONLY. services/trip-link.js writes visit_gps_legs every night; this module reads the
 * matched legs and picks which number staff see. Nothing here writes a minute anywhere. Job cost
 * (job-costing.js keeps the 2026-10-31 standard minutes) and the customer service report
 * (service-report/metrics-band.js computeOnSiteMin) never import this file.
 *
 * ONE precedence rule, pickMeasuredOnSite:
 *   1. a time a person corrected by hand   -> evidence 'operator_corrected'
 *   2. the GPS minutes of a matched leg    -> evidence 'gps_measured'
 *   3. neither                             -> null: the caller keeps the number it shows today and
 *      labels it as not measured by GPS (resolveVisitTimeOnSite does that for the admin visit card;
 *      route-performance.js recordedTiming continues down its own ladder).
 */
const logger = require('./logger');

const GPS_EVIDENCE = 'gps_measured';
const CORRECTED_EVIDENCE = 'operator_corrected';
const NOT_GPS_EVIDENCE = 'not_gps';
// job-costing.js treats a span over 480 minutes as junk; a correction by hand may go to 720 (completion rule).
const MAX_GPS_MINUTES = 480;
const MAX_CORRECTED_MINUTES = 720;
const MISSING_RECHECK_MS = 60 * 1000;

let tableKnown = false;
let tableMissingAt = 0;

function resetTableCache() {
  tableKnown = false;
  tableMissingAt = 0;
}

async function legsTableExists(conn) {
  if (tableKnown) return true;
  if (tableMissingAt && Date.now() - tableMissingAt < MISSING_RECHECK_MS) return false;
  tableKnown = !!(await conn.schema.hasTable('visit_gps_legs'));
  tableMissingAt = tableKnown ? 0 : Date.now();
  return tableKnown;
}

function minutesWithin(value, max) {
  if (value == null || value === '') return null;
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes > 0 && minutes <= max ? minutes : null;
}

/**
 * Map<visitId, minutes> of matched GPS legs with a believable on-site span. One query for all ids.
 * Never throws: a missing table or a read error gives an empty map (the caller then shows today's number).
 */
async function loadGpsOnSiteMinutes(conn, visitIds) {
  const result = new Map();
  const ids = [...new Set((visitIds || []).filter(Boolean))];
  if (!ids.length) return result;
  try {
    if (!(await legsTableExists(conn))) return result;
    const rows = await conn('visit_gps_legs')
      .whereIn('scheduled_service_id', ids)
      .where({ status: 'matched' })
      .select('scheduled_service_id', 'gps_on_site_minutes');
    for (const row of rows) {
      const minutes = minutesWithin(row.gps_on_site_minutes, MAX_GPS_MINUTES);
      if (minutes != null) result.set(row.scheduled_service_id, minutes);
    }
  } catch (err) {
    logger.warn(`[visit-time-on-site] GPS minutes not read; showing recorded minutes: ${err.message}`);
    return new Map();
  }
  return result;
}

/** The precedence rule. Returns { minutes, evidence } or null when neither a correction nor a GPS leg exists. */
function pickMeasuredOnSite({ correctedMinutes, gpsMinutes } = {}) {
  const corrected = minutesWithin(correctedMinutes, MAX_CORRECTED_MINUTES);
  if (corrected != null) return { minutes: corrected, evidence: CORRECTED_EVIDENCE };
  const gps = minutesWithin(gpsMinutes, MAX_GPS_MINUTES);
  if (gps != null) return { minutes: gps, evidence: GPS_EVIDENCE };
  return null;
}

/**
 * What the admin visit card shows. `fallbackMinutes` is exactly the number the card showed before this
 * change; without a correction or GPS leg it comes back unchanged and marked 'not_gps'.
 */
function resolveVisitTimeOnSite({ adjustedMinutes, gpsMinutes, fallbackMinutes } = {}) {
  const measured = pickMeasuredOnSite({ correctedMinutes: adjustedMinutes, gpsMinutes });
  if (measured) return measured;
  const fallback = Number(fallbackMinutes);
  return { minutes: Number.isFinite(fallback) && fallback > 0 ? fallback : null, evidence: NOT_GPS_EVIDENCE };
}

module.exports = {
  GPS_EVIDENCE, CORRECTED_EVIDENCE, NOT_GPS_EVIDENCE, MAX_GPS_MINUTES,
  loadGpsOnSiteMinutes, pickMeasuredOnSite, resolveVisitTimeOnSite, resetTableCache,
};
