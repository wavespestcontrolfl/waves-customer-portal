const FawnWeather = require('../fawn-weather');
const logger = require('../logger');

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function roundedNumber(value, digits = 0) {
  const n = finiteNumber(value);
  if (n == null) return null;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

function hasUsefulConditionValue(conditions = {}) {
  return [
    conditions.temp_f,
    conditions.humidity_pct,
    conditions.wind_mph,
    conditions.rain_24h_in,
    conditions.soil_temp_f,
  ].some((value) => finiteNumber(value) != null);
}

function weatherCodeLabel(code) {
  const value = Number(code);
  if (!Number.isFinite(value)) return null;
  if (value === 0) return 'Clear';
  if ([1, 2].includes(value)) return 'Partly cloudy';
  if (value === 3) return 'Cloudy';
  if ([45, 48].includes(value)) return 'Fog';
  if ([51, 53, 55, 56, 57].includes(value)) return 'Drizzle';
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(value)) return 'Rain';
  if ([71, 73, 75, 77, 85, 86].includes(value)) return 'Snow';
  if ([95, 96, 99].includes(value)) return 'Thunderstorms';
  return null;
}

function normalizeFawnConditions(snapshot = {}, { capturedAt = new Date() } = {}) {
  if (snapshot.station === 'unavailable' || snapshot.error) return null;
  const station = snapshot.station && snapshot.station !== 'unavailable' ? String(snapshot.station) : null;
  const conditions = {
    temp_f: roundedNumber(snapshot.temp_f),
    humidity_pct: roundedNumber(snapshot.humidity_pct),
    wind_mph: roundedNumber(snapshot.wind_mph),
    rain_24h_in: roundedNumber(snapshot.rain_24h_in ?? snapshot.rainfall_in, 2),
    soil_temp_f: roundedNumber(snapshot.soil_temp_f),
    source: station ? `FAWN - ${station}` : 'FAWN',
    provider: 'fawn',
    station,
    station_key: snapshot.station_key || null,
    observation_time: snapshot.observation_time || null,
    captured_at: capturedAt.toISOString(),
    latitude: finiteNumber(snapshot.latitude),
    longitude: finiteNumber(snapshot.longitude),
  };

  return hasUsefulConditionValue(conditions) ? conditions : null;
}

async function fetchOpenMeteoConditions({ latitude, longitude } = {}) {
  const lat = Number.isFinite(Number(latitude)) ? Number(latitude) : 27.40;
  const lon = Number.isFinite(Number(longitude)) ? Number(longitude) : -82.40;
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(lat));
  url.searchParams.set('longitude', String(lon));
  url.searchParams.set('current', 'temperature_2m,relative_humidity_2m,wind_speed_10m,precipitation,weather_code');
  url.searchParams.set('hourly', 'precipitation');
  url.searchParams.set('past_days', '1');
  url.searchParams.set('forecast_days', '1');
  url.searchParams.set('temperature_unit', 'fahrenheit');
  url.searchParams.set('wind_speed_unit', 'mph');
  url.searchParams.set('precipitation_unit', 'inch');
  url.searchParams.set('timezone', 'America/New_York');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    const payload = await response.json();
    const current = payload.current || {};
    const times = Array.isArray(payload.hourly?.time) ? payload.hourly.time : [];
    const precip = Array.isArray(payload.hourly?.precipitation) ? payload.hourly.precipitation : [];
    let currentIndex = times.length - 1;
    if (current.time) {
      const idx = times.lastIndexOf(current.time);
      if (idx >= 0) currentIndex = idx;
    }
    const rainWindow = precip.slice(Math.max(0, currentIndex - 23), currentIndex + 1);
    const rain24h = rainWindow.reduce((sum, value) => {
      const n = Number(value);
      return Number.isFinite(n) ? sum + n : sum;
    }, 0);
    const conditions = {
      temp_f: roundedNumber(current.temperature_2m),
      humidity_pct: roundedNumber(current.relative_humidity_2m),
      wind_mph: roundedNumber(current.wind_speed_10m),
      rain_24h_in: roundedNumber(rain24h, 2),
      sky: weatherCodeLabel(current.weather_code),
      source: 'Open-Meteo',
      provider: 'open_meteo',
      captured_at: new Date().toISOString(),
      latitude: lat,
      longitude: lon,
    };
    return hasUsefulConditionValue(conditions) ? conditions : null;
  } catch (err) {
    logger.warn(`[application-conditions] Open-Meteo fallback failed: ${err.message}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchApplicationConditions({ latitude, longitude } = {}) {
  const coords = { latitude, longitude };
  try {
    const fawnSnapshot = await FawnWeather.getCurrent(coords);
    const fawnConditions = normalizeFawnConditions(fawnSnapshot);
    if (fawnConditions) return fawnConditions;
  } catch (err) {
    logger.warn(`[application-conditions] FAWN condition capture failed: ${err.message}`);
  }

  return fetchOpenMeteoConditions(coords);
}

// Sum of daily precipitation (inches) over a window. Returns null if ANY day is
// missing/non-numeric: a partial week can't be trusted as a weekly total (a gap
// day might have rained), and summing the rest would undercount and could falsely
// flag under-watering. An incomplete window → 'rain_unknown', never a guess. A
// genuine all-zero (dry) week still returns 0.
function sumPrecipInches(dailySums) {
  if (!Array.isArray(dailySums) || !dailySums.length) return null;
  let total = 0;
  for (const v of dailySums) {
    if (v == null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    total += n;
  }
  return roundedNumber(total, 2);
}

// Open-Meteo's et0_fao_evapotranspiration follows daily_units — 'inch' when we
// request precipitation_unit=inch, but 'mm' by default. Convert mm → inches so a
// ~40 mm week can never be mistaken for a 40" target. Unknown unit defaults to
// inches (matches our request).
function et0SumToInches(sum, unit) {
  const n = Number(sum);
  if (sum == null || !Number.isFinite(n)) return null;
  return String(unit || 'inch').toLowerCase().includes('mm')
    ? roundedNumber(n / 25.4, 2)
    : roundedNumber(n, 2);
}

// { start, end } YYYY-MM-DD for the `days`-day window ending ON serviceDate.
function rainWindowEndingOn(serviceDate, days = 7) {
  const ymd = (serviceDate instanceof Date ? serviceDate.toISOString() : String(serviceDate || '')).slice(0, 10);
  const end = new Date(`${ymd}T00:00:00Z`);
  if (Number.isNaN(end.getTime())) return null;
  const start = new Date(end.getTime() - (days - 1) * 86400000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(end) };
}

const _rainCache = new Map();
const RAIN_TTL_MS = 6 * 60 * 60 * 1000; // 6h

function rainCacheKey(lat, lon, end) {
  return `${Number(lat).toFixed(2)},${Number(lon).toFixed(2)},${end}`;
}

// Trailing-7-day weather totals (inches) for the week ENDING ON the service date
// — keyed to the visit, never "now", so a long-lived report token always renders
// the same season-consistent water balance. Returns { rainInches, et0Inches }
// (reference evapotranspiration, FAO-56). Cached by coord+date; each metric is
// trusted only over a COMPLETE window, else null → the report degrades (rainfall
// → 'rain_unknown'; ET₀ → grass×season fallback target).
//
// NOTE: Open-Meteo returns et0_fao_evapotranspiration in the precipitation unit
// (inches here). Eyeball a real report once — a ~25× value would mean it came
// back in mm.
async function fetchServiceWeekWeather({ latitude, longitude, serviceDate } = {}) {
  const empty = { rainInches: null, et0Inches: null };
  const lat = Number.isFinite(Number(latitude)) ? Number(latitude) : null;
  const lon = Number.isFinite(Number(longitude)) ? Number(longitude) : null;
  const range = rainWindowEndingOn(serviceDate, 7);
  if (lat == null || lon == null || !range) return empty;
  const key = rainCacheKey(lat, lon, range.end);
  const cached = _rainCache.get(key);
  if (cached && Date.now() - cached.at < RAIN_TTL_MS) return cached.value;

  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(lat));
  url.searchParams.set('longitude', String(lon));
  url.searchParams.set('daily', 'precipitation_sum,et0_fao_evapotranspiration');
  url.searchParams.set('start_date', range.start);
  url.searchParams.set('end_date', range.end);
  url.searchParams.set('precipitation_unit', 'inch');
  url.searchParams.set('timezone', 'America/New_York');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return empty;
    const payload = await response.json();
    const daily = payload?.daily || {};
    const times = daily.time;
    const expectedDays = Math.round(
      (Date.parse(`${range.end}T00:00:00Z`) - Date.parse(`${range.start}T00:00:00Z`)) / 86400000,
    ) + 1;
    // Each metric is trusted only when its array spans the full window dates AND
    // every day has a real value (sumPrecipInches rejects partial/short arrays).
    const windowOk = Array.isArray(times) && times.length === expectedDays
      && times[0] === range.start && times[times.length - 1] === range.end;
    const sumIfFull = (arr) => (windowOk && Array.isArray(arr) && arr.length === expectedDays)
      ? sumPrecipInches(arr) : null;
    const value = {
      rainInches: sumIfFull(daily.precipitation_sum),
      et0Inches: et0SumToInches(
        sumIfFull(daily.et0_fao_evapotranspiration),
        payload?.daily_units?.et0_fao_evapotranspiration,
      ),
    };
    _rainCache.set(key, { at: Date.now(), value });
    return value;
  } catch (err) {
    logger.warn(`[application-conditions] service-week weather fetch failed: ${err.message}`);
    return empty;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  fetchApplicationConditions,
  fetchOpenMeteoConditions,
  fetchServiceWeekWeather,
  sumPrecipInches,
  et0SumToInches,
  rainWindowEndingOn,
  normalizeFawnConditions,
  weatherCodeLabel,
};
