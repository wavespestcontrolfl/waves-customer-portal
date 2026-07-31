/**
 * MRMS gauge-corrected QPE at a property coordinate — the observed-rainfall
 * source for the rain engine (owner ruling 2026-07-30: measured radar rain
 * beats modeled estimates for per-lawn totals; MRMS primary, Open-Meteo
 * fallback).
 *
 * Served via the Iowa Environmental Mesonet's IEMRE JSON relay: the
 * `mrms_precip_in` field is the daily rollup of NOAA's Multi-Radar
 * Multi-Sensor gauge-corrected QPE (~1 km grid) — the same MultiSensor/
 * GaugeCorr product NOAA ships as GRIB2, without the GRIB pipeline. If IEM
 * ever proves unreliable, the escape hatch is pulling MRMS GRIB directly
 * from NOAA/NCEP; this module is the only file that would change.
 *
 * Semantics callers must respect:
 * - Values are OBSERVATIONS. The current (unclosed) day is a partial
 *   "so far" accumulation, never a full-day figure.
 * - A null/absent day is a GAP, not a zero — IEM backfills late, and a gap
 *   must fall through to the next source in the ladder.
 * - Academic service, no SLA: short timeout, fail-soft to null.
 */

const logger = require('./logger');

const IEMRE_BASE = 'https://mesonet.agron.iastate.edu/iemre/multiday';
const FETCH_TIMEOUT_MS = 6000;

function round2(n) {
  return Number.isFinite(Number(n)) ? Math.round(Number(n) * 100) / 100 : null;
}

/**
 * Daily MRMS precipitation (inches) for [start, end] (YYYY-MM-DD, inclusive)
 * at a lat/lng. Returns { days: [{ date, inches|null }], complete } or null
 * when the service is unreachable / the payload is unusable. `complete` is
 * true only when every requested day carries a finite value.
 */
async function fetchMrmsDailyRain({ latitude, longitude, start, end } = {}) {
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !start || !end) return null;
  const url = `${IEMRE_BASE}/${start}/${end}/${lat.toFixed(4)}/${lon.toFixed(4)}/json`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    const payload = await response.json();
    const rows = Array.isArray(payload?.data) ? payload.data : null;
    if (!rows || !rows.length) return null;
    const byDate = new Map();
    for (const row of rows) {
      if (!row || typeof row.date !== 'string') continue;
      const n = Number(row.mrms_precip_in);
      byDate.set(row.date, Number.isFinite(n) && n >= 0 ? round2(n) : null);
    }
    // Materialize the exact requested window so a short payload reads as gaps.
    const days = [];
    const startMs = Date.parse(`${start}T00:00:00Z`);
    const endMs = Date.parse(`${end}T00:00:00Z`);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
    for (let t = startMs; t <= endMs; t += 86400000) {
      const date = new Date(t).toISOString().slice(0, 10);
      days.push({ date, inches: byDate.has(date) ? byDate.get(date) : null });
    }
    return { days, complete: days.every((d) => d.inches != null) };
  } catch (err) {
    logger.warn(`[mrms-qpe] fetch failed: ${err.message}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { fetchMrmsDailyRain, _test: { round2 } };
