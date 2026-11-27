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
const { etOffsetIso, etParts, etDateString, parseETDateTime } = require('../utils/datetime-et');

const NWS_BASE = 'https://api.weather.gov';
const USER_AGENT = '(wavespestcontrol.com, contact@wavespestcontrol.com)';
const FETCH_TIMEOUT_MS = 2500;
const CACHE_TTL_MS = 30 * 60 * 1000;

// Forecast cache keyed by rounded grid coordinate. SWFL route density
// means most of a day's customers share a key.
const _cache = new Map();

// Size bound for the coordinate-keyed caches. Public routes pass caller-
// chosen coordinates, and a TTL that is only checked on read never frees an
// entry, so a caller varying the point could grow a cache without limit
// (Codex #6126 r4). On a write past the bound: drop expired entries, then
// the oldest (a Map keeps insertion order). 500 keys of the 2-decimal grid
// cover far more than a day's real customers.
const CACHE_MAX_ENTRIES = 500;
function cachePut(cache, key, entry, ttlMs) {
  cache.delete(key);
  cache.set(key, entry);
  if (cache.size <= CACHE_MAX_ENTRIES) return;
  const now = Date.now();
  const stampOf = (e) => (typeof e === 'number' ? e : e.at);
  for (const [k, e] of cache) if (now - stampOf(e) >= ttlMs) cache.delete(k);
  while (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
}

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

// WMO weather interpretation codes for thunderstorm (95 = slight/moderate, 96 = slight hail, 99 = heavy hail).
const THUNDER_WMO_CODES = new Set([95, 96, 99]);
function isThunderWmoCode(code) {
  return Number.isFinite(code) && THUNDER_WMO_CODES.has(code);
}

async function readOpenMeteoHours(latNum, lngNum, timeoutMs, fromMs = Math.floor(Date.now() / 3600000) * 3600000) {
  const { fetchPropertyForecast } = require('./service-report/application-conditions');
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
      hasThunder: isThunderWmoCode(row.weather_code),
      temperatureF: Number.isFinite(row.temperature_f_exact) ? row.temperature_f_exact : null,
      windMph: Number.isFinite(row.wind_mph_exact) ? row.wind_mph_exact : null,
      windGustMph: Number.isFinite(row.wind_gust_mph) ? row.wind_gust_mph : null,
      // The shared forecast module's ready 16-point label ("N" .. "NNW"); null until a row carries it.
      windDirection: typeof row.wind_dir === 'string' && row.wind_dir ? row.wind_dir : null,
      relativeHumidity: Number.isFinite(row.humidity_pct) ? row.humidity_pct : null,
      ...(Number.isFinite(row.precipitation_in) ? { precipitationIn: row.precipitation_in } : {}),
      source: 'open-meteo',
    });
  }
  return hours.length ? hours : null;
}

// Standalone Open-Meteo hourly backup (already-paid flat Standard plan when OPEN_METEO_API_KEY is set).
// Validates coordinates, shares in-flight dedupe and the property-forecast cache; never throws.
async function getOpenMeteoHourlyBackup(lat, lng, { timeoutMs = FORECAST_BACKUP_MAX_MS } = {}) {
  if (lat == null || lng == null || lat === '' || lng === '') return null;
  const latNum = Number(lat);
  const lngNum = Number(lng);
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) return null;
  return fetchOpenMeteoHours(latNum, lngNum, Date.now(), Math.max(BACKUP_MIN_MS, Number(timeoutMs) || FORECAST_BACKUP_MAX_MS));
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
  const read = readOpenMeteoHours(latNum, lngNum, Math.min(remaining, FORECAST_BACKUP_MAX_MS)).catch(() => null);
  // A read under a caller's own short budget is not published for others to
  // join: an uncapped reader (storm watch, Rain Out) arriving meanwhile
  // starts its own full-length read instead of inheriting this timeout
  // (Codex #6102 r6).
  if (budgetMs < TOTAL_BUDGET_MS) return read;
  const shared = read.finally(() => _backupInFlight.delete(key));
  _backupInFlight.set(key, shared);
  return shared;
}

// Daily backup = the max hourly chance over the NWS daytime period
// (6 AM-6 PM ET), the window the NWS daily reader prefers. A date is stated
// only when all 12 daytime hours are present: the window starts at the
// current hour and ends 7 days later, so its first and last dates can be
// partial, and a max over part of a day understates a wetter missing part.
const DAYTIME_HOURS = 12;
const maxOf = (a, b) => (b != null && (a == null || b > a) ? b : a);
// Complete daytime dates, in date order: [{ date, rainChance, tempHighF }].
function daytimeFromHours(hours) {
  const byDate = new Map();
  for (const hour of hours) {
    const date = hour.startTime.slice(0, 10);
    const hh = Number(hour.startTime.slice(11, 13));
    if (hh < 6 || hh >= 18) continue;
    if (!byDate.has(date)) byDate.set(date, { date, hours: new Set(), rainChance: null, tempHighF: null });
    const day = byDate.get(date);
    day.hours.add(hh);
    day.rainChance = maxOf(day.rainChance, hour.rainChance);
    day.tempHighF = maxOf(day.tempHighF, hour.temperatureF);
  }
  return [...byDate.values()]
    .filter((day) => day.hours.size === DAYTIME_HOURS)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(({ date, rainChance, tempHighF }) => ({ date, rainChance, tempHighF }));
}

function dailyFromHours(hours) {
  const out = {};
  for (const day of daytimeFromHours(hours)) {
    out[day.date] = { rainChance: day.rainChance, shortForecast: null, source: 'open-meteo' };
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Open-Meteo daytime (6 AM-6 PM ET) highs and rain chances for the complete
 * dates in the next 7 days, for a reader with its own NWS path that needs a
 * backup (pest forecast). Shares the backup read, its dedupe and the shared
 * client's cache. `timeoutMs` = what the caller's own budget has left
 * (never longer than the client's deadline). Never throws; null when
 * unavailable.
 */
async function getOpenMeteoDaytime(lat, lng, { timeoutMs = FORECAST_BACKUP_MAX_MS } = {}) {
  const latNum = Number(lat);
  const lngNum = Number(lng);
  if (lat == null || lng == null || !Number.isFinite(latNum) || !Number.isFinite(lngNum)) return null;
  // While today's daytime period is running (6 AM-6 PM ET) the read starts
  // at today's 6 AM, so today is a complete date here as it is among NWS's
  // daytime periods; a read from the current hour would drop it and shift
  // the six dates one day later (Codex #6119 r3). Its own read (another
  // window than the hourly backup's), never thrown.
  const now = new Date(Date.now());
  const etHour = etParts(now).hour;
  const fromMs = etHour >= 6 && etHour < 18
    ? parseETDateTime(`${etDateString(now)}T06:00`).getTime()
    : Math.floor(now.getTime() / 3600000) * 3600000;
  const hours = await readOpenMeteoHours(latNum, lngNum, Math.min(timeoutMs, FORECAST_BACKUP_MAX_MS), fromMs).catch(() => null);
  const days = hours ? daytimeFromHours(hours) : [];
  return days.length ? days : null;
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
  cachePut(_cache, key, { at: Date.now(), value: byDate }, CACHE_TTL_MS);
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
      if (value === null) cachePut(_dailyFailCooldown, key, Date.now(), DAILY_FAIL_COOLDOWN_MS);
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

// Thunder / lightning / squall detection from NWS hourly shortForecast text.
const THUNDER_FORECAST_RE = /\b(thunder\w*|t-?storm\w*|lightning|squall\w*)\b/i;
const THUNDER_MOVE_PCT = 50;

function parseHasThunder(shortForecast) {
  return THUNDER_FORECAST_RE.test(String(shortForecast || ''));
}

// Parse NWS windGust (either a string like "25 mph" or a QuantitativeValue object { value, unitCode }).
function parseWindGustMph(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') return parseWindMph(raw);
  if (typeof raw === 'object' && Number.isFinite(raw.value)) {
    const unit = String(raw.unitCode || '').toLowerCase();
    if (unit.includes('km_h') || unit.includes('km/h')) return Math.round(raw.value * 0.621371 * 10) / 10;
    if (unit.includes('kt') || unit.includes('knot')) return Math.round(raw.value * 1.15078 * 10) / 10;
    return raw.value;
  }
  return null;
}

// Owner ruling 2026-11-26:
//   - Move triggers: rain, lightning/thunder, tropical storm / hurricane / severe thunderstorm / tornado / flash flood.
//   - Alert-only (NEVER moves visits or pauses ads): heat advisories and wind advisories.
const TROPICAL_ALERT_RE = /hurricane|tropical\s+(storm|depression|cyclone)|storm\s+surge/i;
const SEVERE_STORM_ALERT_RE = /tornado|severe\s+thunderstorm|special\s+marine|extreme\s+wind|flash\s+flood|flood\s+warning/i;
const LIGHTNING_THUNDER_ALERT_RE = /lightning|thunderstorm/i;
const HEAT_ALERT_RE = /excessive\s+heat|heat\s+(advisory|warning|watch)/i;
const WIND_ALERT_RE = /wind\s+(advisory|warning)|high\s+wind|gale/i;

function classifyNwsAlertEvent(event) {
  const text = String(event || '').trim();
  if (!text) return { category: 'other', moveTrigger: false };
  if (TROPICAL_ALERT_RE.test(text)) return { category: 'tropical_storm', moveTrigger: true };
  if (SEVERE_STORM_ALERT_RE.test(text)) return { category: 'severe_storm', moveTrigger: true };
  if (LIGHTNING_THUNDER_ALERT_RE.test(text)) return { category: 'lightning_thunder', moveTrigger: true };
  if (HEAT_ALERT_RE.test(text)) return { category: 'heat_advisory', moveTrigger: false };
  if (WIND_ALERT_RE.test(text)) return { category: 'wind_advisory', moveTrigger: false };
  return { category: 'other', moveTrigger: false };
}

// Bounded cache + in-flight dedupe for free keyless NWS active alerts (/alerts/active?point=lat,lng).
const _alertsCache = new Map();
const _nwsAlertsInFlight = new Map();
const ALERTS_CACHE_TTL_MS = 10 * 60 * 1000;

async function fetchNwsActiveAlerts(latNum, lngNum, timeoutMs) {
  const data = await fetchJson(
    `${NWS_BASE}/alerts/active?point=${latNum.toFixed(4)},${lngNum.toFixed(4)}`,
    'active alerts',
    timeoutMs,
  );
  if (!data || !Array.isArray(data.features)) return null;
  return data.features
    .map((f) => f?.properties)
    .filter((p) => p && typeof p.event === 'string' && p.event.trim())
    .map((p) => {
      const { category, moveTrigger } = classifyNwsAlertEvent(p.event);
      return {
        id: p.id || null,
        event: p.event.trim(),
        severity: p.severity || null,
        urgency: p.urgency || null,
        certainty: p.certainty || null,
        headline: p.headline || null,
        onset: p.onset || p.effective || null,
        expires: p.ends || p.expires || null,
        category,
        moveTrigger,
      };
    });
}

/**
 * Free, keyless NWS active weather alerts for a coordinate (api.weather.gov/alerts/active).
 * Fail-open: returns null on network/parse error, [] when NWS reports no active alerts.
 * Never logs coordinates or URLs.
 */
async function getNwsActiveAlerts(lat, lng, { fetchTimeoutMs: askedMs, cacheOnly = false } = {}) {
  if (lat == null || lng == null || lat === '' || lng === '') return null;
  const latNum = Number(lat);
  const lngNum = Number(lng);
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) return null;
  const key = cacheKey(latNum, lngNum);
  const cached = _alertsCache.get(key);
  if (cached && Date.now() - cached.at < ALERTS_CACHE_TTL_MS) return cached.value;
  if (cacheOnly) return null;

  const timeoutMs = Math.max(FETCH_TIMEOUT_MS, Number(askedMs) || 0);
  const pending = _nwsAlertsInFlight.get(key);
  if (pending) return raceDeadline(pending, timeoutMs);

  const read = fetchNwsActiveAlerts(latNum, lngNum, timeoutMs).catch(() => null);
  const shared = read.finally(() => _nwsAlertsInFlight.delete(key));
  _nwsAlertsInFlight.set(key, shared);
  const alerts = await shared;
  if (Array.isArray(alerts)) cachePut(_alertsCache, key, { at: Date.now(), value: alerts }, ALERTS_CACHE_TTL_MS);
  return alerts;
}

// True when an NWS alert's active interval [onset, expires] overlaps [startMs, endMs].
// Missing onset/expires fails open as active across the current/near window so a warning with
// an open-ended expiration is never silently ignored.
function alertOverlapsWindow(alert, startMs, endMs) {
  if (!alert || !Number.isFinite(startMs) || !Number.isFinite(endMs)) return false;
  const onsetMs = alert.onset ? Date.parse(alert.onset) : -Infinity;
  const expiresMs = alert.expires ? Date.parse(alert.expires) : Infinity;
  const start = Number.isFinite(onsetMs) ? onsetMs : -Infinity;
  const end = Number.isFinite(expiresMs) ? expiresMs : Infinity;
  return start < endMs && end > startMs;
}

// Approximate NOAA heat index (°F) when temp >= 80°F and relative humidity >= 40%.
function heatIndexF(tempF, rh) {
  if (!Number.isFinite(tempF) || !Number.isFinite(rh) || tempF < 80 || rh < 40) return tempF ?? null;
  return Math.round(
    -42.379 + 2.04901523 * tempF + 10.14333127 * rh - 0.22475541 * tempF * rh
    - 6.83783e-3 * tempF * tempF - 5.481717e-2 * rh * rh + 1.22874e-3 * tempF * tempF * rh
    + 8.5282e-4 * tempF * rh * rh - 1.99e-6 * tempF * tempF * rh * rh,
  );
}

const maxFinite = (cur, val) => (Number.isFinite(val) && (cur == null || val > cur) ? val : cur);

function selectHazardWindow(hours, { day, startMin, endMin, afterHours, now }) {
  const list = Array.isArray(hours) ? hours : [];
  if (day) {
    const startH = Math.floor(startMin / 60);
    const lastMin = Math.min(24 * 60, endMin + afterHours * 60);
    const startDate = parseETDateTime(`${day}T${String(startH).padStart(2, '0')}:00`);
    const windowStartMs = startDate ? startDate.getTime() : null;
    const windowEndMs = windowStartMs != null ? windowStartMs + (lastMin - startH * 60) * 60 * 1000 : null;
    const keys = new Set();
    for (let m = startH * 60; m < lastMin; m += 60) keys.add(`${day}T${String(Math.floor(m / 60)).padStart(2, '0')}`);
    return { windowStartMs, windowEndMs, matchingHours: list.filter((h) => keys.has(String(h?.startTime || '').slice(0, 13))) };
  }
  if (!now) return { windowStartMs: null, windowEndMs: null, matchingHours: [] };
  const windowStartMs = now.getTime();
  const windowEndMs = windowStartMs + Math.max(1, (endMin - startMin) || 120) * 60 * 1000;
  const matchingHours = list.filter((h) => {
    const s = Date.parse(h?.startTime);
    return Number.isFinite(s) && s + 3600000 > windowStartMs && s < windowEndMs;
  });
  return { windowStartMs, windowEndMs, matchingHours };
}

function summarizeHazardHours(matchingHours, thunderPct) {
  let peakRain = null;
  let hasThunder = false;
  let peakWindGust = null;
  let peakWind = null;
  let peakHeatIndex = null;
  for (const h of matchingHours) {
    if (!h) continue;
    peakRain = maxFinite(peakRain, h.rainChance);
    peakWindGust = maxFinite(peakWindGust, h.windGustMph);
    peakWind = maxFinite(peakWind, h.windMph);
    peakHeatIndex = maxFinite(peakHeatIndex, heatIndexF(h.temperatureF, h.relativeHumidity));
    const isThunder = h.hasThunder === true || parseHasThunder(h.shortForecast);
    if (isThunder && (h.rainChance == null || h.rainChance >= thunderPct)) hasThunder = true;
  }
  return { peakRain, hasThunder, peakWindGust, peakWind, peakHeatIndex };
}

const HAZARD_DEFAULTS = {
  day: null, startMin: 8 * 60, endMin: 17 * 60, afterHours: 0, now: null,
  rainThresholdPct: 70, thunderPct: THUNDER_MOVE_PCT,
};

/**
 * Unified hazard classifier (owner ruling 2026-11-26):
 *   - Move triggers: rain >= rainThresholdPct, thunder/lightning (hasThunder && PoP >= thunderPct),
 *     or active NWS tropical_storm / severe_storm / lightning_thunder alert overlapping the window.
 *   - Alert-only (NEVER sets moveTrigger): heat advisories/high heat index (>=105°F), wind advisories/high gusts (>=30 mph or sustained >=25 mph).
 */
function classifyWeatherHazard(hours, alerts, options) {
  const cfg = { ...HAZARD_DEFAULTS, ...options };
  const { windowStartMs, windowEndMs, matchingHours } = selectHazardWindow(hours, cfg);
  const hasWindow = windowStartMs != null && windowEndMs != null;
  const activeAlerts = (Array.isArray(alerts) ? alerts : []).filter((a) => !hasWindow || alertOverlapsWindow(a, windowStartMs, windowEndMs));
  const severeAlerts = activeAlerts.filter((a) => a.moveTrigger === true);
  const allAdvisories = activeAlerts.filter((a) => a.category === 'heat_advisory' || a.category === 'wind_advisory');
  const { peakRain, hasThunder, peakWindGust, peakWind, peakHeatIndex } = summarizeHazardHours(matchingHours, cfg.thunderPct);

  // Synthesize alert-only advisory banners for extreme heat/wind even if NWS has no formal advisory posted.
  const categories = new Set(allAdvisories.map((a) => a.category));
  if (!categories.has('heat_advisory') && peakHeatIndex >= 105) {
    allAdvisories.push({ event: `High Heat (${peakHeatIndex}°F heat index)`, category: 'heat_advisory', moveTrigger: false });
  }
  if (!categories.has('wind_advisory') && (peakWindGust >= 30 || peakWind >= 25)) {
    const mph = peakWindGust >= 30 ? `${peakWindGust} mph gusts` : `${peakWind} mph wind`;
    allAdvisories.push({ event: `High Wind (${mph})`, category: 'wind_advisory', moveTrigger: false });
  }

  const severeCats = new Set(severeAlerts.map((a) => a.category));
  const reasons = [
    severeCats.has('tropical_storm') && 'tropical_storm',
    severeCats.has('severe_storm') && 'severe_storm',
    (hasThunder || severeCats.has('lightning_thunder')) && 'lightning_thunder',
    peakRain >= cfg.rainThresholdPct && 'rain',
  ].filter(Boolean);

  return {
    moveTrigger: reasons.length > 0,
    stormTrigger: severeAlerts.length > 0 || hasThunder,
    reasons,
    peakRain,
    hasThunder,
    severeAlerts,
    advisories: allAdvisories,
  };
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
  const nws = await nwsHourlyShared(latNum, lngNum, key, startedAt + nwsBudgetMs, nwsBudgetMs < TOTAL_BUDGET_MS);
  // Another reader may have cached an NWS answer while this one waited.
  const fresh = _hourlyCache.get(key);
  if (!nws && fresh && Date.now() - fresh.at < HOURLY_CACHE_TTL_MS) return fresh.value;
  const hours = nws || (await fetchOpenMeteoHours(latNum, lngNum, startedAt, budgetMs));
  if (!hours) return null;
  // A backup answer reached only because THIS caller capped NWS is not
  // cached: an uncapped reader (storm watch, Rain Out) must still try NWS,
  // the primary source (Codex #6102 r3).
  if (nws || nwsBudgetMs >= TOTAL_BUDGET_MS) cachePut(_hourlyCache, key, { at: Date.now(), value: hours }, HOURLY_CACHE_TTL_MS);
  return hours;
}

// NWS only, never the paid backup (the 07:05 notice's rain note, owner 2026-11-19 D3: "$0"): a fresh cached NWS answer,
// else one NWS read (joining a read already running for the same grid key); null when NWS fails. A backup answer another
// reader cached is not used, and no backup read is made. An NWS answer is cached for the other readers.
// `cacheOnly` returns the fresh cached NWS answer or null and makes no read.
// `fetchTimeoutMs` (the ads rain-mode record, 2026-11-24): a cron with no one waiting lets each NWS fetch run longer than
// the 2.5 s default; its first prod ticks lost 4 of 6 areas to that timeout at the busy top of the hour.
async function getNwsHourlyRain(lat, lng, { fetchTimeoutMs: askedMs, cacheOnly = false } = {}) {
  // Only ever longer than the default: a shorter wait would cut a read other callers share.
  const fetchTimeoutMs = Math.max(FETCH_TIMEOUT_MS, Number(askedMs) || 0);
  if (lat == null || lng == null || lat === '' || lng === '') return null;
  const latNum = Number(lat);
  const lngNum = Number(lng);
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) return null;
  const key = cacheKey(latNum, lngNum);
  const cached = _hourlyCache.get(key);
  const fromNws = (hours) => Array.isArray(hours) && !hours.some((h) => h.source === 'open-meteo');
  if (cached && Date.now() - cached.at < HOURLY_CACHE_TTL_MS && fromNws(cached.value)) return cached.value;
  // `cacheOnly` (the hourly rain pass once NWS looks down): a fresh cached NWS answer or null, never a fetch.
  if (cacheOnly) return null;
  // A longer read is never published as the shared in-flight read: a reader with a short budget that joined it would
  // wait past the time it keeps for its own backup.
  const longer = fetchTimeoutMs > FETCH_TIMEOUT_MS;
  const nws = await nwsHourlyShared(latNum, lngNum, key, Date.now() + 2 * fetchTimeoutMs, longer, fetchTimeoutMs);
  if (nws) cachePut(_hourlyCache, key, { at: Date.now(), value: nws }, HOURLY_CACHE_TTL_MS);
  return nws;
}

// One uncapped NWS hourly read per grid key at a time. A capped caller (the
// picker) joins one already running for up to its own NWS deadline instead
// of starting a second, shorter read that may lose to the backup while the
// full read is about to answer (Codex #6102 r9). A capped read is never
// published: an uncapped reader must not inherit its short deadline.
const _nwsHourlyInFlight = new Map();
function nwsHourlyShared(latNum, lngNum, key, deadlineAt, capped, fetchTimeoutMs = FETCH_TIMEOUT_MS) {
  const pending = _nwsHourlyInFlight.get(key);
  if (pending) {
    const left = deadlineAt - Date.now();
    return left > 0 ? raceDeadline(pending, left) : Promise.resolve(null);
  }
  const read = nwsHourly(latNum, lngNum, deadlineAt, fetchTimeoutMs).catch(() => null);
  if (capped) return read;
  const shared = read.finally(() => _nwsHourlyInFlight.delete(key));
  _nwsHourlyInFlight.set(key, shared);
  return shared;
}

// Each NWS fetch waits at most its own timeout and never past `deadlineAt`.
function nwsTimeout(deadlineAt, fetchTimeoutMs = FETCH_TIMEOUT_MS) {
  return Math.min(fetchTimeoutMs, deadlineAt - Date.now());
}

async function nwsHourly(latNum, lngNum, deadlineAt, fetchTimeoutMs = FETCH_TIMEOUT_MS) {
  const left = () => nwsTimeout(deadlineAt, fetchTimeoutMs);
  if (left() <= 0) return null;
  const points = await fetchJson(`${NWS_BASE}/points/${latNum.toFixed(4)},${lngNum.toFixed(4)}`, 'points lookup', left());
  const hourlyUrl = points?.properties?.forecastHourly;
  if (!hourlyUrl || left() <= 0) return null;

  const forecast = await fetchJson(hourlyUrl, 'hourly forecast', left());
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
      hasThunder: parseHasThunder(p?.shortForecast),
      // Temperature (°F) and sustained wind (mph) ride the same period so the
      // job-card spray check can read label limits off one NWS fetch. NWS
      // renders windSpeed as "5 mph" / "5 to 10 mph" — the upper bound is
      // the conservative number for a max-wind label limit.
      temperatureF: Number.isFinite(p?.temperature) ? p.temperature : null,
      windMph: parseWindMph(p?.windSpeed),
      windGustMph: parseWindGustMph(p?.windGust),
      // The compass label NWS gives ("E", "ENE") and the relative humidity (%): the card names the wind's
      // direction, and the tech heat line needs the humidity.
      windDirection: typeof p?.windDirection === 'string' && p.windDirection.trim() ? p.windDirection.trim() : null,
      relativeHumidity: Number.isFinite(p?.relativeHumidity?.value) ? p.relativeHumidity.value : null,
    }));

  return hours.length === 0 ? null : hours;
}

// Patient hourly read for background rain jobs (rain-pass, schedule rain record, rain-term, ads rain-mode):
// NWS stays primary (10 s timeout + one retry). When NWS fails both attempts, falls back to the already-paid
// Open-Meteo Standard backup (getOpenMeteoHourlyBackup) so an NWS outage does not blind rain automation.
// Callers injecting a custom `read` in unit tests stay isolated unless they also pass `backup`.
const NWS_PATIENT_WAIT_MS = 10000;
async function getNwsHourlyRainPatient(lat, lng, { read = getNwsHourlyRain, backup } = {}) {
  const once = () => Promise.resolve()
    .then(() => read(lat, lng, { fetchTimeoutMs: NWS_PATIENT_WAIT_MS }))
    .catch(() => null);
  const nws = (await once()) || (await once());
  if (nws) return nws;
  const backupFn = backup !== undefined ? backup : (read === getNwsHourlyRain ? getOpenMeteoHourlyBackup : null);
  if (!backupFn) return null;
  return Promise.resolve().then(() => backupFn(lat, lng)).catch(() => null).then((h) => h || null);
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
  getNwsHourlyRain,
  getNwsHourlyRainPatient,
  getOpenMeteoHourlyBackup,
  getNwsActiveAlerts,
  classifyNwsAlertEvent,
  classifyWeatherHazard,
  alertOverlapsWindow,
  parseHasThunder,
  isThunderWmoCode,
  parseWindGustMph,
  THUNDER_MOVE_PCT,
  NWS_PATIENT_WAIT_MS,
  getOpenMeteoDaytime,
  forecastLinkForZip,
  _test: { cachePut, CACHE_MAX_ENTRIES, dailyFromHours, daytimeFromHours, _backupInFlight, _nwsHourlyInFlight, _nwsAlertsInFlight, cacheKey, _cache, _hourlyCache, _alertsCache, _dailyFailCooldown, parseWindMph, parseHasThunder, isThunderWmoCode, parseWindGustMph, heatIndexF },
};
