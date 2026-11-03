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
 * - The cache cell is the NEAREST 0.125 degree IEMRE point. Re-request windows
 *   spread by cell can still meet: on 2026-11-02 two neighbors held all three
 *   of one home's windows, in the same sweep order every Monday, so that home
 *   got no rain and no watering email. This process keeps a ledger of the
 *   windows it asked in each cache cell during the hour, and a property never
 *   asks a window another property already holds there.
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
// Requests per year segment: the window first, then up to two re-requests.
const MAX_REQUESTS = 3;
// IEM's cache cell: the nearest point of the 0.125 degree IEMRE grid from
// 126W / 23N, in the same ten-thousandths as the MRMS cell.
const IEMRE_CELL_E4 = 1250;
// IEM holds a response for an hour from the first request; a few minutes more
// covers clock drift between this process and the relay.
const CACHE_HOLD_MS = 65 * 60 * 1000;
const LEDGER_PRUNE_SIZE = 2000;
// The holder of a window that answered with a cell no property here asked
// for (another process, or a request from before a restart).
const FOREIGN = 'foreign';
// `${cacheCell}|${start}/${end}` -> { holder, at }: who first asked that window
// in that cache cell during the last hour.
const windowLedger = new Map();

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

// A coordinate exactly halfway between two IEMRE points belongs to both.
function nearestAxisPoints(offsetE4) {
  const below = Math.floor(offsetE4 / IEMRE_CELL_E4);
  const twice = 2 * (offsetE4 - below * IEMRE_CELL_E4);
  if (twice === IEMRE_CELL_E4) return [below, below + 1];
  return [twice < IEMRE_CELL_E4 ? below : below + 1];
}

// Every cache cell the relay may file this coordinate under.
function iemreCacheCells(lat, lon) {
  const latE4 = Math.round(Number(lat.toFixed(4)) * 10000);
  const lonE4 = Math.round(Number(lon.toFixed(4)) * 10000);
  const jPoints = nearestAxisPoints(latE4 - MRMS_SOUTH_E4);
  return nearestAxisPoints(lonE4 + MRMS_WEST_E4).flatMap((i) => jPoints.map((j) => `${i}:${j}`));
}

function heldByOther(cacheCells, key, holder, now) {
  return cacheCells.some((cacheCell) => {
    const entry = windowLedger.get(`${cacheCell}|${key}`);
    return entry != null && now - entry.at < CACHE_HOLD_MS && entry.holder !== holder;
  });
}

// The first request in a cache cell sets what IEM serves there for the hour,
// so a holder's own repeat keeps the original time.
function holdWindow(cacheCells, key, holder, now) {
  if (windowLedger.size > LEDGER_PRUNE_SIZE) {
    for (const [ledgerKey, entry] of windowLedger) if (now - entry.at >= CACHE_HOLD_MS) windowLedger.delete(ledgerKey);
  }
  for (const cacheCell of cacheCells) {
    const ledgerKey = `${cacheCell}|${key}`;
    const entry = windowLedger.get(ledgerKey);
    if (holder === FOREIGN || entry == null || now - entry.at >= CACHE_HOLD_MS) windowLedger.set(ledgerKey, { holder, at: now });
  }
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

// The relay leaves MRMS null for a window that spans two calendar years, so
// every request stays inside one year: a window is asked for one year at a
// time, and a re-request moves its start earlier only as far as January 1.
function yearSegments(start, end) {
  const segments = [];
  for (let year = Number(start.slice(0, 4)); year <= Number(end.slice(0, 4)); year += 1) {
    segments.push({
      start: year === Number(start.slice(0, 4)) ? start : `${year}-01-01`,
      end: year === Number(end.slice(0, 4)) ? end : `${year}-12-31`,
    });
  }
  return segments;
}

function daysBetween(fromYmd, toYmd) {
  return Math.round((Date.parse(`${toYmd}T00:00:00Z`) - Date.parse(`${fromYmd}T00:00:00Z`)) / 86400000);
}

// Other windows (= cache keys) that still cover [start, end] inside its year:
// an earlier start, or for a window that starts on January 1 a later end (the
// relay answers a window that runs past today with the days it has). The
// first two are the cell's spread re-requests; the rest walk on from the
// first, one day at a time, until the year has no other day left.
function* retryWindows({ start, end }, cell) {
  const year = start.slice(0, 4);
  const back = daysBetween(`${year}-01-01`, start);
  const forward = daysBetween(end, `${year}-12-31`);
  const room = back > 0 ? back : forward;
  if (!(room > 0)) return;
  const first = (cell.i * 131 + cell.j) % RETRY_SPREAD_DAYS;
  const second = RETRY_SPREAD_DAYS + (cell.i * 17 + cell.j * 7) % RETRY_SPREAD_DAYS;
  const offsets = [first, second];
  for (let step = 1; step < room; step += 1) offsets.push(first + step);
  for (const offset of offsets) {
    const shift = 1 + (offset % room);
    yield back > 0 ? { start: shiftYmd(start, -shift), end } : { start, end: shiftYmd(end, shift) };
  }
}

// One request per attempt, each under its own timeout: a slow request ends
// only itself, never another year's request in flight. `signal` is the
// caller's cancellation and ends every attempt. Returns the rows read at this
// property's cell, or null (unreachable, or another cell every time).
async function fetchOwnCellRows({ lat, lon, segment, cell, signal }) {
  const cacheCells = iemreCacheCells(lat, lon);
  const holder = `${cell.i}:${cell.j}`;
  const seen = new Set();
  let requests = 0;
  for (const window of [segment, ...retryWindows(segment, cell)]) {
    if (requests >= MAX_REQUESTS) break;
    const key = `${window.start}/${window.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Another property's rain is what IEM serves under this window here.
    if (heldByOther(cacheCells, key, holder, Date.now())) continue;
    holdWindow(cacheCells, key, holder, Date.now());
    requests += 1;
    const url = `${IEMRE_BASE}/${key}/${lat.toFixed(4)}/${lon.toFixed(4)}/json`;
    const controller = new AbortController();
    const onCallerAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onCallerAbort, { once: true });
    }
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) return null;
      const payload = await response.json();
      if (responseCellMatches(payload, cell) !== false) return Array.isArray(payload?.data) ? payload.data : null;
      holdWindow(cacheCells, key, FOREIGN, Date.now());
    } finally {
      clearTimeout(timeout);
      if (signal) signal.removeEventListener('abort', onCallerAbort);
    }
  }
  logger.warn(requests
    ? `[mrms-qpe] relay answered with another cell on all ${requests} request(s); no MRMS value`
    : '[mrms-qpe] other properties hold every window in this cache cell this hour; no MRMS value');
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
  try {
    const cell = expectedMrmsCell(lat, lon);
    // A year whose request fails leaves its days as gaps; the other year's
    // observations still stand.
    const perYear = await Promise.all(yearSegments(start, end).map((segment) => fetchOwnCellRows({ lat, lon, segment, cell, signal })
      .catch((err) => { logger.warn(`[mrms-qpe] fetch failed: ${err.message}`); return null; })));
    const rows = perYear.flatMap((part) => part || []);
    if (!rows.length) return null;
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
  }
}

module.exports = {
  fetchMrmsDailyRain,
  _test: { round2, expectedMrmsCell, iemreCacheCells, retryWindows, yearSegments, clearWindowLedger: () => windowLedger.clear() },
};
