// Chance of rain at each stop on the day list: the hourly forecast for the
// stop's zone at the hour its window opens (owner 2026-10-24: one rain
// figure per stop, by time of day and the area the tech is in, in place of
// the day-wide chip the list header used to repeat). DISPLAY ONLY: nothing
// written, no stop held or moved. The forecast is optional — a zone without
// a usable hourly outlook, or a date past its horizon, reads null.

const { boundedHourlyRain } = require('./rain-fit');

// Rows the tech will not drive to carry no figure.
const NOT_A_STOP = new Set(['cancelled', 'skipped', 'no_show']);

// "2026-10-24T09" for a 09:30 window on that date — the hourly rows carry an
// ISO startTime with the local offset, so the first 13 characters name the
// local hour (the same match rain-fit's isWetWindow makes).
function hourKey(date, windowStart) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(windowStart || ''));
  if (!m || !/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return null;
  const hour = Number(m[1]);
  if (!(hour >= 0 && hour < 24)) return null;
  return `${date}T${String(hour).padStart(2, '0')}`;
}

/**
 * Hourly outlooks for the zones present, each bounded so a slow forecast
 * never holds the payload: `{ [zone]: hours|null }`. Zones without
 * coordinates are left out (no figure, never a wrong place).
 */
async function zoneHourlyOutlooks(zones, zoneCoords) {
  const known = [...new Set(zones || [])].filter((z) => zoneCoords?.[z]);
  const pairs = await Promise.all(known.map(async (z) => [z, await boundedHourlyRain(zoneCoords[z].lat, zoneCoords[z].lng).catch(() => null)]));
  return Object.fromEntries(pairs);
}

/**
 * Sets `rainAtStop` (0–100 or null) in place on each service from its zone's
 * hourly outlook at its window-start hour on `date`.
 */
function attachStopRain(services, date, hourlyByZone) {
  for (const s of services || []) {
    s.rainAtStop = null;
    if (NOT_A_STOP.has(s.status)) continue;
    const key = hourKey(date, s.windowStart);
    const hours = hourlyByZone?.[s.zone];
    if (!key || !Array.isArray(hours)) continue;
    const hour = hours.find((h) => String(h?.startTime || '').slice(0, 13) === key);
    if (hour && Number.isFinite(hour.rainChance)) s.rainAtStop = hour.rainChance;
  }
}

module.exports = { attachStopRain, zoneHourlyOutlooks, hourKey };
