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

module.exports = { openMeteoForecastUrl, openMeteoArchiveAvailable };
