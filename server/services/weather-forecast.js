/**
 * NWS forecast helper (api.weather.gov).
 *
 * Complements services/fawn-weather.js: FAWN is real-time station
 * OBSERVATIONS (is it raining now); this module is the FORECAST source
 * (will it rain Thursday) used by the tech rain-out flow to badge
 * reschedule options with precipitation chances and to build the
 * customer-facing forecast link.
 *
 * NWS is free, keyless, and official — it only asks for a User-Agent
 * identifying the caller. Two-step fetch: /points/{lat},{lng} resolves
 * the forecast grid URL, then the grid forecast returns 12-hour
 * periods with probabilityOfPrecipitation.
 *
 * Everything here is fail-open: any timeout / non-200 / parse problem
 * returns null and the caller renders options without rain badges.
 * Weather decoration must never block a reschedule.
 */

const logger = require('./logger');

const NWS_BASE = 'https://api.weather.gov';
const USER_AGENT = '(wavespestcontrol.com, contact@wavespestcontrol.com)';
const FETCH_TIMEOUT_MS = 2500;
const CACHE_TTL_MS = 30 * 60 * 1000;

// Forecast cache keyed by rounded grid coordinate. SWFL route density
// means most of a day's customers share a key.
const _cache = new Map();

function cacheKey(lat, lng) {
  return `${Number(lat).toFixed(2)},${Number(lng).toFixed(2)}`;
}

// `label` is what gets logged on failure — NEVER the URL. Both NWS
// request URLs embed location (customer lat/lng on /points, the
// resolved grid cell on /gridpoints), and address-level PII does not
// belong in application logs.
async function fetchJson(url, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/geo+json' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    logger.info(`[weather-forecast] ${label} fetch failed: ${err.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Daily rain outlook for a coordinate.
 *
 * @returns {Promise<Object<string, {rainChance: number|null, shortForecast: string|null}>|null>}
 *          map of 'YYYY-MM-DD' (local forecast date) → daytime-period
 *          precipitation chance, or null when NWS is unreachable.
 */
async function getDailyRainOutlook(lat, lng) {
  // Reject empty inputs BEFORE coercion — Number(null) is 0, which
  // would send an ungeocoded customer's lookup to lat 0.
  if (lat == null || lng == null || lat === '' || lng === '') return null;
  const latNum = Number(lat);
  const lngNum = Number(lng);
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) return null;

  const key = cacheKey(latNum, lngNum);
  const cached = _cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const points = await fetchJson(`${NWS_BASE}/points/${latNum.toFixed(4)},${lngNum.toFixed(4)}`, 'points lookup');
  const forecastUrl = points?.properties?.forecast;
  if (!forecastUrl) return null;

  const forecast = await fetchJson(forecastUrl, 'grid forecast');
  const periods = forecast?.properties?.periods;
  if (!Array.isArray(periods)) return null;

  const byDate = {};
  for (const period of periods) {
    if (!period?.startTime) continue;
    // startTime is ISO with the grid's local offset (SWFL = ET), so the
    // leading 10 chars are already the local calendar date.
    const date = String(period.startTime).slice(0, 10);
    const chance = period?.probabilityOfPrecipitation?.value;
    const entry = {
      rainChance: Number.isFinite(chance) ? chance : null,
      shortForecast: period.shortForecast || null,
    };
    // Prefer the daytime period (that's when we service); only let a
    // night period stand in when no daytime entry exists for the date.
    if (period.isDaytime || !byDate[date]) byDate[date] = entry;
  }

  if (Object.keys(byDate).length === 0) return null;
  _cache.set(key, { at: Date.now(), value: byDate });
  return byDate;
}

/**
 * Customer-facing forecast link for their own area. NWS zipcity page —
 * official, ad-free, loads fine on mobile.
 */
function forecastLinkForZip(zip) {
  const clean = String(zip || '').trim().match(/^\d{5}/);
  return clean ? `https://forecast.weather.gov/zipcity.php?inputstring=${clean[0]}` : null;
}

module.exports = {
  getDailyRainOutlook,
  forecastLinkForZip,
  _test: { cacheKey, _cache },
};
