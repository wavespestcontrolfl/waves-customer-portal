/**
 * The 07:05 notice's rain note (owner 2026-11-19 D3, "Rain days: indoor work, by hour and place": the notice names rain
 * hours by area; $0).
 *
 * For today and the next days inside the rain rules' horizon (scheduling/rain-fit.js RAIN_DAYS: Florida hourly
 * forecasts past about 3 days are too weak to move a booking), each of the day board's forecast areas
 * (scheduling/forecast-zones.js ZONE_COORDS, the points the board's rain figures read) lists the hours inside the
 * notice's day (DAY_OPEN to DAY_CLOSE) whose NWS chance of rain is RAIN_PCT or more, joined into spans. An hour is the
 * NWS hour whose local start names that date and hour (as stop-rain.js and rain-fit.js isWetWindow match it). Today
 * counts from the current hour: an hour already over is neither wet nor missing, and a day already over is left out.
 *
 * NWS only, never the paid backup (weather-forecast.js getNwsHourlyRain). Nothing is guessed: unknown is not dry
 * (rain-fit.js isWetWindow, Codex #6102 r3). An area NWS does not answer is named as unread; an area whose answer has
 * no reading for an hour of a day is named under that day (`gaps`).
 */
const weatherForecast = require('../weather-forecast');
const { getNwsHourlyRain } = weatherForecast;
const { ZONE_COORDS } = require('../scheduling/forecast-zones');
const { RAIN_PCT, RAIN_DAYS } = require('../scheduling/rain-fit');
const { DAY_OPEN, DAY_CLOSE } = require('../auto-dispatch/candidate-slots');
const { etDateString, etParts, addETDays } = require('../../utils/datetime-et');

const HOUR = 60;

/**
 * One area's day from `from` (minutes from midnight, ET wall clock; a whole hour) to DAY_CLOSE: its wet spans
 * `{ start, end, max }` (`max` = the highest chance inside the span) and `missing`, the hours with no reading.
 */
function readDay(hours, day, from = DAY_OPEN) {
  const spans = [];
  let missing = 0;
  for (let m = from; m < DAY_CLOSE; m += HOUR) {
    const key = `${day}T${String(Math.floor(m / HOUR)).padStart(2, '0')}`;
    const hour = hours.find((h) => String(h?.startTime || '').slice(0, 13) === key);
    const chance = hour && Number.isFinite(hour.rainChance) ? hour.rainChance : null;
    if (chance == null) {
      missing += 1;
      continue;
    }
    if (chance < RAIN_PCT) continue;
    const last = spans[spans.length - 1];
    if (last && last.end === m) {
      last.end = m + HOUR;
      last.max = Math.max(last.max, chance);
    } else {
      spans.push({ start: m, end: m + HOUR, max: chance });
    }
  }
  return { spans, missing };
}

/**
 * `{ days: [{ day, areas: [{ zone, spans }], gaps: [zone] }], unread: [zone], outlooks: { [zone]: hours | null } }`:
 * each day of the horizon from `now`'s ET date that has an hour left, with the areas that have a wet span that day and
 * the areas whose answer lacks a reading for an hour of it, in the board's area order. `read` is the hourly reader (the
 * NWS-only one); a read that fails or throws leaves its area unread.
 */
async function rainNote(now, { read = getNwsHourlyRain, backup } = {}) {
  const zones = Object.keys(ZONE_COORDS);
  const backupFn = backup !== undefined
    ? backup
    : (read === getNwsHourlyRain && typeof weatherForecast.getOpenMeteoHourlyBackup === 'function'
      ? (lat, lng) => weatherForecast.getOpenMeteoHourlyBackup(lat, lng)
      : null);
  const outlooks = Object.fromEntries(await Promise.all(zones.map(async (zone) => {
    const { lat, lng } = ZONE_COORDS[zone];
    let hours = await Promise.resolve().then(() => read(lat, lng)).catch(() => null);
    if (!Array.isArray(hours) && backupFn) {
      hours = await Promise.resolve().then(() => backupFn(lat, lng)).catch(() => null);
    }
    return [zone, Array.isArray(hours) ? hours : null];
  })));
  const today = etDateString(now);
  const firstHour = (day) => (day === today ? Math.max(DAY_OPEN, etParts(now).hour * HOUR) : DAY_OPEN);
  const days = Array.from({ length: RAIN_DAYS }, (_, i) => etDateString(addETDays(now, i)))
    .filter((day) => firstHour(day) < DAY_CLOSE);
  return {
    days: days.map((day) => {
      const read = zones.filter((zone) => outlooks[zone]).map((zone) => ({ zone, ...readDay(outlooks[zone], day, firstHour(day)) }));
      return {
        day,
        areas: read.filter((area) => area.spans.length).map(({ zone, spans }) => ({ zone, spans })),
        gaps: read.filter((area) => area.missing).map((area) => area.zone),
      };
    }),
    unread: zones.filter((zone) => !outlooks[zone]),
    outlooks,
  };
}

module.exports = { rainNote, _internals: { readDay } };
