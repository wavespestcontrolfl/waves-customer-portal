/**
 * Weather signals for the public Pest Pressure Forecast.
 *
 * Primary source: the National Weather Service API (api.weather.gov) — free,
 * keyless, covers all of Florida by lat/lng. We pull the next several daytime
 * forecast periods and reduce them to two signals the pest model cares about:
 * a representative daytime high (°F) and an average precipitation chance (%).
 *
 * SWFL points are additionally enriched with the Florida Automated Weather
 * Network (FAWN) recent-rainfall reading, which gives a better "is the ground
 * already wet" signal for mosquito/ant pressure than a forward precip chance.
 *
 * Everything here is best-effort and fails soft: if the network is slow or the
 * upstreams are down, getWeatherSignals resolves to { hasWeather: false } and
 * the forecast degrades to its pure seasonal baseline. Results are cached per
 * rounded coordinate for 3 hours so a popular embed can't hammer NWS/FAWN.
 */

const logger = require('../logger');
let fawn = null;
try { fawn = require('../fawn-weather'); } catch (_e) { fawn = null; }

const NWS_UA = 'WavesPestControl-PestForecast/1.0 (+https://www.wavespestcontrol.com)';
const CACHE_TTL = 3 * 60 * 60 * 1000; // 3 hours
const TIMEOUT_MS = 4000;

const _cache = new Map(); // key -> { at, value }

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
 * Resolve weekly weather signals for a coordinate. Never throws.
 * Returns: { hasWeather, tempHighF, precipChance, recentRainIn, source,
 *            warm, hot, dry, wet, coolSnap }
 */
async function getWeatherSignals({ lat, lng, region } = {}) {
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) {
    return flags({ hasWeather: false });
  }

  const key = cacheKey(lat, lng);
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value;

  let base = { hasWeather: false, tempHighF: null, precipChance: null, recentRainIn: null, source: null };
  try {
    const nws = await fetchNwsForecast(lat, lng);
    base = { ...base, ...nws, hasWeather: nws.tempHighF != null || nws.precipChance != null };
  } catch (err) {
    logger.warn?.(`[pest-forecast/weather] NWS lookup failed for ${key}: ${err.message}`);
  }

  // Enrich SWFL points with FAWN recent rainfall (best-effort, never blocks).
  if (fawn && region === 'sw') {
    try {
      const cur = await fawn.getCurrent({ latitude: lat, longitude: lng });
      // Guard explicitly against null/undefined — Number(null) === 0 would
      // otherwise inject a phantom 0" reading and falsely flag the week "dry".
      if (cur && cur.rainfall_in != null && Number.isFinite(Number(cur.rainfall_in))) {
        base.recentRainIn = Number(cur.rainfall_in);
        base.hasWeather = true;
        if (!base.source) base.source = 'fawn';
        else base.source = 'nws+fawn';
      }
    } catch (_e) { /* ignore — NWS signal already stands */ }
  }

  const value = flags(base);
  _cache.set(key, { at: Date.now(), value });
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

function _clearCache() { _cache.clear(); } // test hook

module.exports = { getWeatherSignals, flags, _clearCache };
