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
 * - IEM caches each multiday response for an hour under a key of window +
 *   the ~8-mile IEMRE cell, but reads `mrms_precip_in` at the request's own
 *   ~1 km MRMS cell. Inside that hour a nearby property gets the FIRST
 *   requester's rain (2026-09-28: 22 of 31 Monday watering emails). The
 *   response names the cell it was read at (`mrms_iemre_grid_i/j`), so a
 *   response for another cell is re-requested under a window (= cache key)
 *   derived from this property's cell, and is never returned as this
 *   property's rain.
 */

const logger = require('./logger');

const IEMRE_BASE = 'https://mesonet.agron.iastate.edu/iemre/multiday';
const FETCH_TIMEOUT_MS = 6000;

function round2(n) {
  return Number.isFinite(Number(n)) ? Math.round(Number(n) * 100) / 100 : null;
}

// MRMS grid on the IEM relay: 0.01 degree cells from 126W / 23N. Computed on
// the same four-decimal coordinates the URL carries, in integer ten-thousandths
// so a float quotient cannot land in the wrong cell.
const MRMS_WEST_E4 = 1260000;
const MRMS_SOUTH_E4 = 230000;
const CELL_E4 = 100;
// Earlier-start offsets for the re-request: two attempts, each spread over 29
// windows by the property's own cell, so neighbors do not meet again.
const RETRY_SPREAD_DAYS = 29;

function axisCells(coordE4, originE4) {
  const offset = coordE4 + originE4;
  const cell = Math.floor(offset / CELL_E4);
  // A coordinate exactly on a cell edge can fall either side in IEM's float
  // arithmetic; both cells are this property's.
  return offset % CELL_E4 === 0 ? [cell - 1, cell] : [cell];
}

function expectedMrmsCell(lat, lon) {
  const latE4 = Math.round(Number(lat.toFixed(4)) * 10000);
  const lonE4 = Math.round(Number(lon.toFixed(4)) * 10000);
  const iCells = axisCells(lonE4, MRMS_WEST_E4);
  const jCells = axisCells(latE4, -MRMS_SOUTH_E4);
  return { i: iCells[iCells.length - 1], j: jCells[jCells.length - 1], iCells, jCells };
}

// true = the response was read at this property's cell; false = it is another
// property's cached response; null = the relay did not name a cell (nothing to
// judge by, so the response is taken as before).
function responseCellMatches(payload, cell) {
  const i = payload?.mrms_iemre_grid_i;
  const j = payload?.mrms_iemre_grid_j;
  if (!Number.isInteger(i) || !Number.isInteger(j)) return null;
  return cell.iCells.includes(i) && cell.jCells.includes(j);
}

function shiftYmd(ymd, days) {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

function retryStart(start, cell, attempt) {
  const spread = attempt === 1
    ? (cell.i * 131 + cell.j) % RETRY_SPREAD_DAYS
    : (cell.i * 17 + cell.j * 7) % RETRY_SPREAD_DAYS;
  return shiftYmd(start, -(1 + (attempt - 1) * RETRY_SPREAD_DAYS + spread));
}

// One request per attempt, each under its own timeout. Returns the rows read
// at this property's cell, or null (unreachable, or another cell every time).
async function fetchOwnCellRows({ lat, lon, start, end, cell, controller }) {
  for (let attempt = 0; attempt <= 2; attempt += 1) {
    const windowStart = attempt === 0 ? start : retryStart(start, cell, attempt);
    const url = `${IEMRE_BASE}/${windowStart}/${end}/${lat.toFixed(4)}/${lon.toFixed(4)}/json`;
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) return null;
      const payload = await response.json();
      if (responseCellMatches(payload, cell) !== false) return Array.isArray(payload?.data) ? payload.data : null;
    } finally {
      clearTimeout(timeout);
    }
  }
  logger.warn('[mrms-qpe] relay answered with another cell on every attempt; no MRMS value');
  return null;
}

/**
 * Daily MRMS precipitation (inches) for [start, end] (YYYY-MM-DD, inclusive)
 * at a lat/lng. Returns { days: [{ date, inches|null }], complete } or null
 * when the service is unreachable / the payload is unusable / the relay kept
 * answering with another property's cell. `complete` is true only when every
 * requested day carries a finite value.
 */
async function fetchMrmsDailyRain({ latitude, longitude, start, end, signal } = {}) {
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !start || !end) return null;
  const controller = new AbortController();
  // Optional caller cancellation (a caller with its own shorter deadline).
  // Absent = exactly the timeout-only behavior every other caller has.
  const onCallerAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onCallerAbort, { once: true });
  }
  try {
    const rows = await fetchOwnCellRows({ lat, lon, start, end, cell: expectedMrmsCell(lat, lon), controller });
    if (!rows || !rows.length) return null;
    const byDate = new Map();
    for (const row of rows) {
      if (!row || typeof row.date !== 'string') continue;
      // null/'' is a GAP, not a zero — Number(null) === 0 would stamp a
      // missing observation as a measured dry day and silently undercount
      // the week (codex P2 #3096).
      const raw = row.mrms_precip_in;
      if (raw == null || raw === '') { byDate.set(row.date, null); continue; }
      const n = Number(raw);
      byDate.set(row.date, Number.isFinite(n) && n >= 0 ? round2(n) : null);
    }
    // Materialize the exact requested window so a short payload reads as gaps
    // (and the extra leading days of a re-request are dropped).
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
    if (signal) signal.removeEventListener('abort', onCallerAbort);
  }
}

module.exports = { fetchMrmsDailyRain, _test: { round2, expectedMrmsCell, retryStart } };
