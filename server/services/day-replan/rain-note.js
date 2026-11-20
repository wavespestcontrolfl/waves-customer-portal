/**
 * The 07:05 notice's rain note (owner 2026-11-19 D3, "Rain days: indoor work, by hour and place": the notice names rain
 * hours by area; $0).
 *
 * For today and the next days inside the rain rules' horizon (scheduling/rain-fit.js RAIN_DAYS: Florida hourly
 * forecasts past about 3 days are too weak to move a booking), each of the day board's forecast areas
 * (scheduling/forecast-zones.js ZONE_COORDS, the points the board's rain figures read) lists the hours inside the
 * notice's day (DAY_OPEN to DAY_CLOSE) whose NWS chance of rain is RAIN_PCT or more, joined into spans. An hour is the
 * NWS hour whose local start names that date and hour (as stop-rain.js and rain-fit.js isWetWindow match it).
 *
 * NWS only, never the paid backup (weather-forecast.js getNwsHourlyRain). An area NWS does not answer is named as
 * unread; nothing is guessed. It sends nothing and changes no visit.
 */
const { getNwsHourlyRain } = require('../weather-forecast');
const { ZONE_COORDS } = require('../scheduling/forecast-zones');
const { RAIN_PCT, RAIN_DAYS } = require('../scheduling/rain-fit');
const { DAY_OPEN, DAY_CLOSE } = require('../auto-dispatch/candidate-slots');
const { etDateString, addETDays } = require('../../utils/datetime-et');

const HOUR = 60;

/**
 * The wet spans of one area's day: `{ start, end, max }` (minutes from midnight, ET wall clock; `max` = the highest
 * chance inside the span), hour by hour from DAY_OPEN to DAY_CLOSE. An hour with no reading is not wet.
 */
function wetSpans(hours, day) {
  const spans = [];
  for (let m = DAY_OPEN; m < DAY_CLOSE; m += HOUR) {
    const key = `${day}T${String(Math.floor(m / HOUR)).padStart(2, '0')}`;
    const hour = hours.find((h) => String(h?.startTime || '').slice(0, 13) === key);
    const chance = hour && Number.isFinite(hour.rainChance) ? hour.rainChance : null;
    if (chance == null || chance < RAIN_PCT) continue;
    const last = spans[spans.length - 1];
    if (last && last.end === m) {
      last.end = m + HOUR;
      last.max = Math.max(last.max, chance);
    } else {
      spans.push({ start: m, end: m + HOUR, max: chance });
    }
  }
  return spans;
}

/**
 * `{ days: [{ day, areas: [{ zone, spans }] }], unread: [zone], outlooks: { [zone]: hours | null } }`: each day of the
 * horizon from `now`'s ET date, with the areas that have a wet span that day, in the board's area order. `read` is the
 * hourly reader (the NWS-only one); a read that fails or throws leaves its area unread.
 */
async function rainNote(now, { read = getNwsHourlyRain } = {}) {
  const zones = Object.keys(ZONE_COORDS);
  const outlooks = Object.fromEntries(await Promise.all(zones.map(async (zone) => {
    const hours = await Promise.resolve().then(() => read(ZONE_COORDS[zone].lat, ZONE_COORDS[zone].lng)).catch(() => null);
    return [zone, Array.isArray(hours) ? hours : null];
  })));
  const days = Array.from({ length: RAIN_DAYS }, (_, i) => etDateString(addETDays(now, i)));
  return {
    days: days.map((day) => ({
      day,
      areas: zones.filter((zone) => outlooks[zone]).map((zone) => ({ zone, spans: wetSpans(outlooks[zone], day) }))
        .filter((area) => area.spans.length),
    })),
    unread: zones.filter((zone) => !outlooks[zone]),
    outlooks,
  };
}

module.exports = { rainNote, _internals: { wetSpans } };
