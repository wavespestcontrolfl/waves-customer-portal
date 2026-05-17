const FawnWeather = require('../fawn-weather');
const logger = require('../logger');

function finiteNumber(value) {
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

module.exports = {
  fetchApplicationConditions,
  fetchOpenMeteoConditions,
  normalizeFawnConditions,
  weatherCodeLabel,
};
