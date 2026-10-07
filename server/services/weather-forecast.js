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
 * Backup (owner 2026-10-06): when NWS fails, the same readers answer from
 * Open-Meteo (paid key via open-meteo-endpoint.js) in the same shape.
 *
 * Everything here is fail-open: when both sources fail, any timeout / non-200
 * / parse problem returns null and the caller renders options without rain badges.
 * Weather decoration must never block a reschedule.
 */

const logger = require('./logger');
const { etOffsetIso } = require('../utils/datetime-et');

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
async function fetchJson(url, label, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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

// ── Open-Meteo backup (owner 2026-10-06) ─────────────────────────────────
// NWS stays the primary source: its hourly chance of rain is forecaster-
// checked on a 2.5 km grid, and on 2026-10-06 it read 78-85% through an
// afternoon storm at HQ that Open-Meteo's coarse ensemble chance put at
// 36-49%. Open-Meteo answers only when NWS fails, so a surface that shows
// rain keeps a number through an NWS outage. Same output shapes as the NWS
// readers; every entry carries source: 'open-meteo'.
// One read through the shared property-forecast client (its paid-key URL,
// hard deadline, cache and normalization) → NWS-shaped hours. Temperature
// and wind are the UNROUNDED readings: the job-card spray check compares
// them with label limits strictly, and NWS itself reports whole numbers.
// Required lazily: application-conditions is a large module most callers of
// this file never need.
const BACKUP_HOURS = 7 * 24;
// Whole-call budget, NWS included: the two NWS fetches (2.5 s each) were the
// worst case before the backup existed, so the backup only spends what NWS
// left of it and is skipped when too little remains. Direct callers (Rain Out
// options) await these readers without their own race.
const TOTAL_BUDGET_MS = 2 * FETCH_TIMEOUT_MS;
const BACKUP_MIN_MS = 1000;
// The shared client's own default deadline; never longer than that.
const FORECAST_BACKUP_MAX_MS = 3500;
// One backup read per grid key at a time: Rain Out asks for the daily and the
// hourly outlook together, and both reach the backup during an NWS outage
// before the shared client's cache is warm.
const _backupInFlight = new Map();

async function readOpenMeteoHours(latNum, lngNum, timeoutMs) {
  const { fetchPropertyForecast } = require('./service-report/application-conditions');
  const fromMs = Math.floor(Date.now() / 3600000) * 3600000;
  const forecast = await fetchPropertyForecast({
    latitude: latNum,
    longitude: lngNum,
    from: new Date(fromMs),
    to: new Date(fromMs + BACKUP_HOURS * 3600000),
    timeoutMs,
    exactReadings: true,
  });
  if (forecast?.status !== 'ok' || !Array.isArray(forecast.hourly)) return null;
  const hours = [];
  for (const row of forecast.hourly) {
    const startTime = etOffsetIso(row.at);
    if (!startTime) continue;
    hours.push({
      startTime,
      rainChance: Number.isFinite(row.precipitation_probability_pct) ? row.precipitation_probability_pct : null,
      shortForecast: null,
      temperatureF: Number.isFinite(row.temperature_f_exact) ? row.temperature_f_exact : null,
      windMph: Number.isFinite(row.wind_mph_exact) ? row.wind_mph_exact : null,
      source: 'open-meteo',
    });
  }
  return hours.length ? hours : null;
}

function raceDeadline(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(resolve, ms, null); }),
  ]).finally(() => clearTimeout(timer));
}

function fetchOpenMeteoHours(latNum, lngNum, startedAt, budgetMs = TOTAL_BUDGET_MS) {
  const remaining = budgetMs - (Date.now() - startedAt);
  const key = cacheKey(latNum, lngNum);
  const pending = _backupInFlight.get(key);
  // Joining a read another lookup started still keeps THIS lookup's budget:
  // it waits at most its own remaining time, then gives up with null while
  // the shared read finishes for the caller that started it.
  if (pending) return remaining > 0 ? raceDeadline(pending, remaining) : Promise.resolve(null);
  if (remaining < BACKUP_MIN_MS) return Promise.resolve(null);
  const read = readOpenMeteoHours(latNum, lngNum, Math.min(remaining, FORECAST_BACKUP_MAX_MS))
    .catch(() => null)
    .finally(() => _backupInFlight.delete(key));
  _backupInFlight.set(key, read);
  return read;
}

// Daily backup = the max hourly chance over the NWS daytime period
// (6 AM-6 PM ET), the window the NWS daily reader prefers. A date is stated
// only when all 12 daytime hours are present: the window starts at the
// current hour and ends 7 days later, so its first and last dates can be
// partial, and a max over part of a day understates a wetter missing part.
const DAYTIME_HOURS = 12;
function dailyFromHours(hours) {
  const byDate = {};
  for (const hour of hours) {
    const date = hour.startTime.slice(0, 10);
    const hh = Number(hour.startTime.slice(11, 13));
    if (hh < 6 || hh >= 18) continue;
    const day = byDate[date] || (byDate[date] = { hours: new Set(), rainChance: null });
    day.hours.add(hh);
    const chance = hour.rainChance;
    if (chance != null && (day.rainChance == null || chance > day.rainChance)) day.rainChance = chance;
  }
  const out = {};
  for (const [date, day] of Object.entries(byDate)) {
    if (day.hours.size === DAYTIME_HOURS) out[date] = { rainChance: day.rainChance, shortForecast: null, source: 'open-meteo' };
  }
  return Object.keys(out).length ? out : null;
}

async function openMeteoDailyBackup(latNum, lngNum, startedAt) {
  const hours = await fetchOpenMeteoHours(latNum, lngNum, startedAt);
  return hours ? dailyFromHours(hours) : null;
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

  const startedAt = Date.now();
  const byDate = (await nwsDaily(latNum, lngNum)) || (await openMeteoDailyBackup(latNum, lngNum, startedAt));
  if (!byDate) return null;
  _cache.set(key, { at: Date.now(), value: byDate });
  return byDate;
}

async function nwsDaily(latNum, lngNum) {
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

  return Object.keys(byDate).length === 0 ? null : byDate;
}

// Bounded daily lookup for decorative consumers (rain chips): the raw
// lookup can spend up to two live NWS fetches (2.5s timeout each) on a
// cold cache, and a payload that only DECORATES with weather must never
// wait that long. Races the lookup against a short deadline — on deadline
// the caller gets null NOW while the in-flight fetch keeps running and
// warms the shared cache for the next request. Failures (null result)
// additionally enter a short per-coordinate cooldown so a polling caller
// (the 15s tracker poll) doesn't re-fire live NWS fetches every tick
// through an outage; a deadline is NOT a failure and never enters the
// cooldown.
const _dailyFailCooldown = new Map();
const _dailyInFlight = new Map();
const DAILY_FAIL_COOLDOWN_MS = 60 * 1000;
const DEADLINE = Symbol('deadline');

async function getDailyRainOutlookBounded(lat, lng, { deadlineMs = 1200 } = {}) {
  if (lat == null || lng == null || lat === '' || lng === '') return null;
  const latNum = Number(lat);
  const lngNum = Number(lng);
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) return null;
  const key = cacheKey(latNum, lngNum);
  const failedAt = _dailyFailCooldown.get(key);
  if (failedAt && Date.now() - failedAt < DAILY_FAIL_COOLDOWN_MS) return null;

  // ONE live lookup per key at a time, and the cooldown bookkeeping rides
  // the lookup's own settlement — not the bounded caller's race result.
  // Without this, a lookup slower than the deadline settles after every
  // bounded caller already returned, its failure never reaches the
  // cooldown, and each 15s tracker poll launches a fresh live NWS fetch
  // for the same coordinate through the whole outage (Codex 2026-07-20).
  let lookup = _dailyInFlight.get(key);
  if (!lookup) {
    lookup = getDailyRainOutlook(latNum, lngNum).catch(() => null);
    _dailyInFlight.set(key, lookup);
    lookup.then((value) => {
      _dailyInFlight.delete(key);
      if (value === null) _dailyFailCooldown.set(key, Date.now());
      else _dailyFailCooldown.delete(key);
    });
  }

  let timer;
  const result = await Promise.race([
    lookup,
    new Promise((resolve) => { timer = setTimeout(resolve, deadlineMs, DEADLINE); }),
  ]).finally(() => clearTimeout(timer));

  return result === DEADLINE ? null : result;
}

// Hourly cache — shorter TTL than the daily one because storm-watch
// polls on a 15-minute cadence and hourly precip values move faster.
const _hourlyCache = new Map();
const HOURLY_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Hourly rain outlook for a coordinate (storm-watch nudges).
 *
 * @returns {Promise<Array<{startTime: string, rainChance: number|null, shortForecast: string|null}>|null>}
 *          NWS hourly periods (~next 156h, ISO startTime with local
 *          offset), or null when NWS is unreachable. Fail-open like
 *          the daily lookup — callers must tolerate null.
 */
function parseWindMph(text) {
  const nums = String(text || '').match(/\d+(?:\.\d+)?/g);
  if (!nums || nums.length === 0) return null;
  return Math.max(...nums.map(Number));
}

// Optional `budgetMs` / `nwsBudgetMs` (best-times ranking, Codex #6102 r2):
// a caller with a short wait caps NWS at `nwsBudgetMs` so a slow NWS failure
// still leaves the Open-Meteo backup time inside `budgetMs`. Defaults are
// the plain behavior: NWS fetches at their own timeout, backup on the rest.
async function getHourlyRainOutlook(lat, lng, { budgetMs = TOTAL_BUDGET_MS, nwsBudgetMs = budgetMs } = {}) {
  if (lat == null || lng == null || lat === '' || lng === '') return null;
  const latNum = Number(lat);
  const lngNum = Number(lng);
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) return null;

  const key = cacheKey(latNum, lngNum);
  const cached = _hourlyCache.get(key);
  if (cached && Date.now() - cached.at < HOURLY_CACHE_TTL_MS) return cached.value;

  const startedAt = Date.now();
  const hours = (await nwsHourly(latNum, lngNum, startedAt + nwsBudgetMs))
    || (await fetchOpenMeteoHours(latNum, lngNum, startedAt, budgetMs));
  if (!hours) return null;
  _hourlyCache.set(key, { at: Date.now(), value: hours });
  return hours;
}

// Each NWS fetch waits at most its own timeout and never past `deadlineAt`.
function nwsTimeout(deadlineAt) {
  return Math.min(FETCH_TIMEOUT_MS, deadlineAt - Date.now());
}

async function nwsHourly(latNum, lngNum, deadlineAt) {
  if (nwsTimeout(deadlineAt) <= 0) return null;
  const points = await fetchJson(`${NWS_BASE}/points/${latNum.toFixed(4)},${lngNum.toFixed(4)}`, 'points lookup', nwsTimeout(deadlineAt));
  const hourlyUrl = points?.properties?.forecastHourly;
  if (!hourlyUrl || nwsTimeout(deadlineAt) <= 0) return null;

  const forecast = await fetchJson(hourlyUrl, 'hourly forecast', nwsTimeout(deadlineAt));
  const periods = forecast?.properties?.periods;
  if (!Array.isArray(periods)) return null;

  const hours = periods
    .filter((p) => p?.startTime)
    .map((p) => ({
      startTime: p.startTime,
      rainChance: Number.isFinite(p?.probabilityOfPrecipitation?.value)
        ? p.probabilityOfPrecipitation.value
        : null,
      shortForecast: p.shortForecast || null,
      // Temperature (°F) and sustained wind (mph) ride the same period so the
      // job-card spray check can read label limits off one NWS fetch. NWS
      // renders windSpeed as "5 mph" / "5 to 10 mph" — the upper bound is
      // the conservative number for a max-wind label limit.
      temperatureF: Number.isFinite(p?.temperature) ? p.temperature : null,
      windMph: parseWindMph(p?.windSpeed),
    }));

  return hours.length === 0 ? null : hours;
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
  getDailyRainOutlookBounded,
  getHourlyRainOutlook,
  forecastLinkForZip,
  _test: { dailyFromHours, _backupInFlight, cacheKey, _cache, _hourlyCache, _dailyFailCooldown, parseWindMph },
};
