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

// Trailing N-day rainfall total (inches) from an Open-Meteo daily
// precipitation_sum array. With forecast_days=1 the final entry is today's
// forecast — drop it and sum the trailing completed days. Null when no usable
// data so the caller can degrade to 'rain_unknown'.
function sumTrailingPrecipInches(dailySums, days = 7) {
  if (!Array.isArray(dailySums) || !dailySums.length) return null;
  const completed = dailySums.slice(0, Math.max(0, dailySums.length - 1)).slice(-days);
  let total = 0;
  let any = false;
  for (const v of completed) {
    const n = Number(v);
    if (Number.isFinite(n)) { total += n; any = true; }
  }
  return any ? roundedNumber(total, 2) : null;
}

const _rain7dCache = new Map();
const RAIN_7D_TTL_MS = 3 * 60 * 60 * 1000; // 3h — daily rainfall moves slowly

function rain7dCacheKey(lat, lon) {
  return `${Number(lat).toFixed(2)},${Number(lon).toFixed(2)}`;
}

// Live trailing-7-day rainfall total (inches) for the lawn water balance, cached
// by rounded grid coordinate. Returns null on any failure so the report degrades
// to 'rain_unknown' rather than guessing.
async function fetchPast7DayRainInches({ latitude, longitude } = {}) {
  const lat = Number.isFinite(Number(latitude)) ? Number(latitude) : null;
  const lon = Number.isFinite(Number(longitude)) ? Number(longitude) : null;
  if (lat == null || lon == null) return null;
  const key = rain7dCacheKey(lat, lon);
  const cached = _rain7dCache.get(key);
  if (cached && Date.now() - cached.at < RAIN_7D_TTL_MS) return cached.value;

  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(lat));
  url.searchParams.set('longitude', String(lon));
  url.searchParams.set('daily', 'precipitation_sum');
  url.searchParams.set('past_days', '7');
  url.searchParams.set('forecast_days', '1');
  url.searchParams.set('precipitation_unit', 'inch');
  url.searchParams.set('timezone', 'America/New_York');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    const payload = await response.json();
    const value = sumTrailingPrecipInches(payload?.daily?.precipitation_sum, 7);
    _rain7dCache.set(key, { at: Date.now(), value });
    return value;
  } catch (err) {
    logger.warn(`[application-conditions] 7-day rainfall fetch failed: ${err.message}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  fetchApplicationConditions,
  fetchOpenMeteoConditions,
  fetchPast7DayRainInches,
  sumTrailingPrecipInches,
  normalizeFawnConditions,
  weatherCodeLabel,
};
