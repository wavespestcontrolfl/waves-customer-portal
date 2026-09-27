/**
 * Weather signals for the public Pest Pressure Forecast.
 *
 * Primary source: the National Weather Service API (api.weather.gov) — free,
 * keyless, covers all of Florida by lat/lng. We pull the next several daytime
 * forecast periods and reduce them to two signals the pest model cares about:
 * a representative daytime high (°F) and an average precipitation chance (%).
 *
 * SWFL points are additionally enriched with yesterday's measured rainfall at
 * the city's own coordinate: NOAA MRMS gauge-corrected radar (~1 km grid, via
 * mrms-qpe.js), the same observed-rain source the irrigation emails quote.
 * It gives a better "is the ground already wet" signal for mosquito/ant
 * pressure than a forward precip chance.
 *
 * Everything here is best-effort and fails soft: if the network is slow or the
 * upstreams are down, getWeatherSignals resolves to { hasWeather: false } and
 * the forecast degrades to its pure seasonal baseline. Results are cached per
 * rounded coordinate until their freshUntil (3 hours; 15 minutes while a
 * SWFL city's rain reading is missing; never past ET midnight, when
 * "yesterday" moves) so a popular embed can't hammer NWS/MRMS.
 */

const logger = require('../logger');
const { fetchMrmsDailyRain } = require('../mrms-qpe');
const { etDateString, addETDays, parseETDateTime } = require('../../utils/datetime-et');

const NWS_UA = 'WavesPestControl-PestForecast/1.0 (+https://www.wavespestcontrol.com)';
const CACHE_TTL = 3 * 60 * 60 * 1000; // 3 hours
// A SWFL fill still missing yesterday's rain (IEM backfills late; an outage)
// is retried this soon, not published rain-less for the full CACHE_TTL — a
// missing reading can read as "dry".
const MISSING_RAIN_RETRY = 15 * 60 * 1000; // 15 minutes
const TIMEOUT_MS = 4000;

const _cache = new Map(); // key -> signals (each carries its own freshUntil)
// The fill in progress per coordinate — concurrent requests share it.
const _inflight = new Map(); // key -> Promise<signals>
// Last measured MRMS reading per coordinate, for the ET day it measured.
const _rainMemo = new Map(); // key -> { day, inches }

// Epoch ms at which signals filled at `at` stop being fresh: CACHE_TTL, or
// MISSING_RAIN_RETRY for a rain-less SWFL fill, and never past the next ET
// midnight, when "yesterday" moves. The forecast cache and the public
// route's HTTP lifetimes honor this same instant.
function freshUntil(at, { missingRain = false } = {}) {
  const midnight = parseETDateTime(`${etDateString(addETDays(at, 1))}T00:00`).getTime();
  return Math.min(at.getTime() + (missingRain ? MISSING_RAIN_RETRY : CACHE_TTL), midnight);
}

function cacheKey(lat, lng) {
  return `${Number(lat).toFixed(2)},${Number(lng).toFixed(2)}`;
}

async function fetchJson(url, { headers } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': NWS_UA, Accept: 'application/geo+json', ...headers },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchNwsForecast(lat, lng) {
  // Step 1: resolve the gridpoint → forecast URL.
  const points = await fetchJson(`https://api.weather.gov/points/${Number(lat).toFixed(4)},${Number(lng).toFixed(4)}`);
  const forecastUrl = points?.properties?.forecast;
  if (!forecastUrl) throw new Error('no forecast url');

  // Step 2: pull the periods and reduce daytime ones to high/precip signals.
  const forecast = await fetchJson(forecastUrl);
  const periods = Array.isArray(forecast?.properties?.periods) ? forecast.properties.periods : [];
  const daytime = periods.filter((p) => p && p.isDaytime).slice(0, 6);
  if (!daytime.length) throw new Error('no daytime periods');

  const temps = daytime
    .map((p) => Number(p.temperature))
    .filter((t) => Number.isFinite(t));
  const precip = daytime
    .map((p) => (p.probabilityOfPrecipitation && p.probabilityOfPrecipitation.value != null
      ? Number(p.probabilityOfPrecipitation.value) : null))
    .filter((v) => Number.isFinite(v));

  const tempHighF = temps.length ? Math.round(temps.reduce((a, b) => a + b, 0) / temps.length) : null;
  const precipChance = precip.length ? Math.round(precip.reduce((a, b) => a + b, 0) / precip.length) : null;
  return { tempHighF, precipChance, source: 'nws' };
}

/**
 * Measured rainfall (inches) for `day` — yesterday, the most recent CLOSED ET
 * day; MRMS's current day is only a partial "so far" accumulation — at a
 * coordinate, or null. A closed day's total doesn't change, so a reading
 * already measured for `day` is reused when a later lookup the same day fails
 * or comes back empty, rather than dropping a known total (a missing reading
 * can read as "dry"); it is never reused for any other day. Never throws: the
 * NWS signal stands on its own. Logged once per cache fill (not per request).
 */
async function fetchRecentRainIn(lat, lng, key, day) {
  const known = _rainMemo.get(key);
  const lastGood = known && known.day === day ? known.inches : null;
  try {
    const rain = await fetchMrmsDailyRain({ latitude: lat, longitude: lng, start: day, end: day });
    if (!rain) {
      logger.warn?.(`[pest-forecast/weather] MRMS rainfall unavailable for ${key} (${day})`);
      return lastGood;
    }
    const inches = rain.days.find((d) => d.date === day)?.inches;
    // A null day is a GAP (IEM backfills late), not a measured dry day —
    // Number(null) === 0 would inject a phantom 0" and falsely flag "dry".
    if (inches == null || !Number.isFinite(Number(inches))) {
      logger.info?.(`[pest-forecast/weather] MRMS has no rainfall yet for ${key} (${day})`);
      return lastGood;
    }
    _rainMemo.set(key, { day, inches: Number(inches) });
    return Number(inches);
  } catch (err) {
    logger.warn?.(`[pest-forecast/weather] MRMS lookup failed for ${key}: ${err.message}`);
    return lastGood;
  }
}

/**
 * Resolve weekly weather signals for a coordinate. Never throws.
 * Returns: { hasWeather, tempHighF, precipChance, recentRainIn, source,
 *            warm, hot, dry, wet, coolSnap, freshUntil }
 */
async function getWeatherSignals({ lat, lng, region } = {}) {
  const now = new Date();
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) {
    return { ...flags({ hasWeather: false }), freshUntil: freshUntil(now) };
  }

  const key = cacheKey(lat, lng);
  const hit = _cache.get(key);
  if (hit && now.getTime() < hit.freshUntil) return hit;

  // One fill per coordinate at a time: concurrent requests share it, so a
  // slower failed lookup can never overwrite a faster good one, and a burst
  // of requests costs one set of upstream calls.
  if (!_inflight.has(key)) {
    const fill = fillSignals({ lat, lng, region, key, now })
      .finally(() => { if (_inflight.get(key) === fill) _inflight.delete(key); });
    _inflight.set(key, fill);
  }
  return _inflight.get(key);
}

async function fillSignals({ lat, lng, region, key, now }) {
  // SWFL points also get yesterday's measured rainfall. Started before the
  // NWS lookup so a cache fill waits for the slower of the two, not both.
  const wantsRain = region === 'sw';
  const rainLookup = wantsRain
    ? fetchRecentRainIn(lat, lng, key, etDateString(addETDays(now, -1)))
    : Promise.resolve(null);

  let base = { hasWeather: false, tempHighF: null, precipChance: null, recentRainIn: null, source: null };
  try {
    const nws = await fetchNwsForecast(lat, lng);
    base = { ...base, ...nws, hasWeather: nws.tempHighF != null || nws.precipChance != null };
  } catch (err) {
    logger.warn?.(`[pest-forecast/weather] NWS lookup failed for ${key}: ${err.message}`);
  }

  const recentRainIn = await rainLookup;
  if (recentRainIn != null) {
    base.recentRainIn = recentRainIn;
    base.hasWeather = true;
    base.source = base.source ? `${base.source}+mrms` : 'mrms';
  }

  const value = { ...flags(base), freshUntil: freshUntil(now, { missingRain: wantsRain && recentRainIn == null }) };
  _cache.set(key, value);
  return value;
}

// Derive the boolean flags the pest model reads from the raw readings.
function flags(b) {
  const tempHighF = b.tempHighF ?? null;
  const precipChance = b.precipChance ?? null;
  const recentRainIn = b.recentRainIn ?? null;
  return {
    hasWeather: !!b.hasWeather,
    tempHighF,
    precipChance,
    recentRainIn,
    source: b.source ?? null,
    warm: tempHighF != null && tempHighF >= 85,
    hot: tempHighF != null && tempHighF >= 92,
    coolSnap: tempHighF != null && tempHighF <= 66,
    wet: (precipChance != null && precipChance >= 50) || (recentRainIn != null && recentRainIn >= 0.75),
    dry: (precipChance != null && precipChance <= 20) && (recentRainIn == null || recentRainIn < 0.1),
  };
}

function _clearCache() { _cache.clear(); _rainMemo.clear(); _inflight.clear(); } // test hook

module.exports = { getWeatherSignals, flags, _clearCache };
