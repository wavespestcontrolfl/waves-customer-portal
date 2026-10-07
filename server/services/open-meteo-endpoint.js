/**
 * Open-Meteo endpoint (owner 2026-10-06, "A then B"): the free endpoint is
 * non-commercial only, so production uses the paid Standard plan once
 * OPEN_METEO_API_KEY is set — the customer- host with the key as `apikey`.
 * Standard has no historical (archive) API, so archiveAvailable() is false
 * with a key; closed-day rain already comes from NOAA MRMS first
 * (mergeMrmsIntoWeek). Unset = the free endpoints exactly as before.
 *
 * The key rides in the URL: never log a URL built here.
 */
function openMeteoKey() {
  return String(process.env.OPEN_METEO_API_KEY || '').trim() || null;
}

function openMeteoForecastUrl() {
  const key = openMeteoKey();
  const url = new URL(key ? 'https://customer-api.open-meteo.com/v1/forecast' : 'https://api.open-meteo.com/v1/forecast');
  if (key) url.searchParams.set('apikey', key);
  return url;
}

function openMeteoArchiveAvailable() {
  return !openMeteoKey();
}

// The forecast endpoint keeps 92 past days (`past_days` max). With the paid
// key (no archive) an older window has no Open-Meteo source at all: callers
// skip the request and settle on what NOAA MRMS gives (Codex #6052 r1).
const FORECAST_PAST_DAYS = 92;

function openMeteoCoversDate(ymd, todayYmd) {
  if (!openMeteoKey()) return true;
  const days = (Date.parse(`${todayYmd}T00:00:00Z`) - Date.parse(`${ymd}T00:00:00Z`)) / 86400000;
  return !(days > FORECAST_PAST_DAYS);
}

module.exports = { openMeteoForecastUrl, openMeteoArchiveAvailable, openMeteoCoversDate, FORECAST_PAST_DAYS };
