/**
 * Measured rain by WORK HOUR, the grader for the two rain records (ads/rain-mode.js, scheduling/rain-schedule-record.js).
 * 2026-11-26: both graded against a DAILY radar total, but the rule they test is about work hours (DAY_OPEN to
 * DAY_CLOSE, 8 AM to 5 PM ET). On 2026-11-25 most of the rain fell before 8 AM (Sarasota 0.49 of 0.55 in) while Venice and
 * Punta Gorda had measurable rain in 7 or 8 of 9 work hours; a daily total scored every area alike.
 *
 * Source: IEM ASOS hourly precipitation (p01i), one free request for the four stations below, in ET, routine reports only
 * (https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py). The IEMRE hourly point read
 * (/iemre/hourly/<date>/<lat>/<lng>/json, hourly_precip_in) was tried first and rejected: on 2026-11-25 it showed 2 wet
 * work hours at Venice where the Venice and Punta Gorda airports showed 7 and 8. Free, no key, no geocoding, never the
 * paid Open-Meteo key. Academic service, no SLA and a request rate limit: one request per day, kept 10 minutes, a short
 * timeout, and any failure is "unread" (null), never dry.
 *
 * Reading rules: a report at HH:MM covers the hour ending at HH:MM, so it belongs to the hour of HH:MM minus 30
 * minutes (the 7:53 report is hour 7). 'T' (trace) reads 0, 'M' and a missing report read null (no reading). An hour is
 * measurable at MEASURABLE_IN or more. Two reports in one hour keep the larger.
 */
const logger = require('../logger');
const { DAY_OPEN, DAY_CLOSE } = require('../auto-dispatch/candidate-slots');
const { etDateString, addETDays, parseETDateTime } = require('../../utils/datetime-et');

const MEASURABLE_IN = 0.01;
const FETCH_MS = 8000;
const CACHE_MS = 10 * 60 * 1000;
const ASOS_URL = 'https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py';

// Station points from IEM's FL_ASOS network.
const STATIONS = {
  SRQ: { lat: 27.4014, lng: -82.5586 }, // Sarasota-Bradenton
  VNC: { lat: 27.0716, lng: -82.4403 }, // Venice
  PGD: { lat: 26.9172, lng: -81.9914 }, // Punta Gorda
  SPG: { lat: 27.7651, lng: -82.627 }, // St. Petersburg
};
// Forecast area (scheduling/forecast-zones.js ZONE_COORDS) -> stations, nearest first. An hour with no report at the
// first reads the next. Parrish, Palmetto, Lakewood Ranch, Bradenton N and Sarasota are all within 25 km of SRQ.
const AREA_STATIONS = {
  parrish: ['SRQ', 'SPG'],
  palmetto: ['SRQ', 'SPG'],
  lakewood_ranch: ['SRQ', 'VNC'],
  bradenton_north: ['SRQ', 'SPG'],
  sarasota: ['SRQ', 'VNC'],
  venice_north_port: ['VNC', 'SRQ'],
};
const NEAREST_N = 2;

const WORK_HOURS = [];
for (let m = DAY_OPEN; m < DAY_CLOSE; m += 60) WORK_HOURS.push(m / 60);

const dayAfter = (date) => etDateString(addETDays(parseETDateTime(`${date}T12:00`), 1));
const dayBefore = (date) => etDateString(addETDays(parseETDateTime(`${date}T12:00`), -1));

/** The ET calendar date and hour a report belongs to: its valid time minus 30 minutes. valid = 'YYYY-MM-DD HH:MM' (ET). */
function bucketOf(valid) {
  const date = valid.slice(0, 10);
  const minutes = Number(valid.slice(11, 13)) * 60 + Number(valid.slice(14, 16)) - 30;
  if (!Number.isFinite(minutes)) return null;
  return minutes < 0 ? { date: dayBefore(date), hour: 23 } : { date, hour: Math.floor(minutes / 60) };
}

/** { SRQ: { 7: 0.08, ... }, ... } for `day`, from the CSV, or null when it is not the CSV. */
function parseObs(csv, day) {
  const lines = String(csv || '').trim().split('\n');
  if (!lines[0].startsWith('station,valid,p01i')) return null;
  const obs = Object.fromEntries(Object.keys(STATIONS).map((s) => [s, {}]));
  for (const line of lines.slice(1)) {
    const [station, valid, raw] = line.split(',');
    const bucket = obs[station] && bucketOf(String(valid || ''));
    if (!bucket || bucket.date !== day) continue;
    const inches = raw === 'T' ? 0 : raw === 'M' || raw === '' || raw == null ? null : Number(raw);
    if (!Number.isFinite(inches)) continue;
    obs[station][bucket.hour] = Math.max(inches, obs[station][bucket.hour] ?? 0);
  }
  return obs;
}

const cache = new Map(); // day -> { at, promise }

/** The day's hourly readings at every station, or null when IEM did not answer. Kept 10 minutes; a failure is never kept. */
function fetchHourlyObs(day, { fetchFn = fetch, timeoutMs = FETCH_MS, now = Date.now } = {}) {
  const hit = cache.get(day);
  if (hit && now() - hit.at < CACHE_MS) return hit.promise;
  const [y1, m1, d1] = day.split('-');
  const [y2, m2, d2] = dayAfter(day).split('-');
  const stations = Object.keys(STATIONS).map((s) => `station=${s}`).join('&');
  const url = `${ASOS_URL}?${stations}&data=p01i&year1=${y1}&month1=${Number(m1)}&day1=${Number(d1)}`
    + `&year2=${y2}&month2=${Number(m2)}&day2=${Number(d2)}&tz=America%2FNew_York&format=onlycomma&latlon=no&missing=M&trace=T&report_type=3`;
  const promise = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchFn(url, { signal: controller.signal });
      if (!res.ok) return null;
      return parseObs(await res.text(), day);
    } catch (err) {
      logger.warn(`[work-hour-rain] ${day} read failed: ${err.message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  })();
  cache.set(day, { at: now(), promise });
  promise.then((obs) => { if (!obs && cache.get(day)?.promise === promise) cache.delete(day); });
  return promise;
}

/** The inches for `hour` at the first of `stations` that has a reading, else null. */
function readHour(obs, stations, hour) {
  for (const s of stations) {
    const v = obs?.[s]?.[hour];
    if (Number.isFinite(v)) return v;
  }
  return null;
}

/** { wet_hours, inches, missing } over `hours`: wet = MEASURABLE_IN or more; a missing hour is null, never dry. */
function tallyHours(obs, stations, hours) {
  let wet = 0;
  let missing = 0;
  let inches = 0;
  for (const h of hours) {
    const v = readHour(obs, stations, h);
    if (v == null) missing += 1;
    else {
      inches += v;
      if (v >= MEASURABLE_IN) wet += 1;
    }
  }
  return { wet_hours: wet, inches: Math.round(inches * 100) / 100, missing };
}

/** Per forecast area: { wet_hours, inches, missing, wet } for the work hours. wet = rainHours or more wet hours; false when
 *  the missing hours could not reach it; null while they could. */
function measureAreas(obs, zones, rainHours) {
  return Object.fromEntries(zones.map((zone) => {
    const t = tallyHours(obs, AREA_STATIONS[zone] || [], WORK_HOURS);
    let wet = null;
    if (t.wet_hours >= rainHours) wet = true;
    else if (t.wet_hours + t.missing < rainHours) wet = false;
    return [zone, { ...t, wet }];
  }));
}

/** The day from its areas: half or more wet = wet day. { wet_areas, unknown, wet_day }: wet_day null while unknown areas
 *  could still flip it. */
function wetDayFrom(areas) {
  const all = Object.values(areas);
  const wetAreas = Object.keys(areas).filter((z) => areas[z].wet === true);
  const unknown = all.filter((a) => a.wet === null).length;
  let wetDay = null;
  if (wetAreas.length * 2 >= all.length) wetDay = true;
  else if ((wetAreas.length + unknown) * 2 < all.length) wetDay = false;
  return { wet_areas: wetAreas, unknown, wet_day: wetDay };
}

const km = (a, b) => Math.hypot((a.lat - b.lat) * 111, (a.lng - b.lng) * 99);

/** The NEAREST_N stations to a point, nearest first. */
function stationsNear(point) {
  return Object.keys(STATIONS).sort((a, b) => km(point, STATIONS[a]) - km(point, STATIONS[b])).slice(0, NEAREST_N);
}

/**
 * Rain over a visit's hours: from the hour its work starts through `afterHours` after it ends (the drying time, rain-fit
 * RAIN_AFTER_HOURS), at the visit's nearest stations. { wet, inches, missing }: wet true when any hour is measurable,
 * false only when every hour was read, null when an unread hour could still hide rain.
 */
function spanWet(obs, point, startMin, endMin, afterHours) {
  const hours = [];
  const last = Math.min(24 * 60, endMin + afterHours * 60);
  for (let m = Math.floor(startMin / 60) * 60; m < last; m += 60) hours.push(m / 60);
  const t = tallyHours(obs, stationsNear(point), hours);
  let wet = null;
  if (t.wet_hours > 0) wet = true;
  else if (t.missing === 0) wet = false;
  return { wet, inches: t.inches, missing: t.missing };
}

/** The forecast's chance for each work hour of `day`, as a compact array (null = no reading). */
function workHourChances(hours, day) {
  return WORK_HOURS.map((h) => {
    const key = `${day}T${String(h).padStart(2, '0')}`;
    const hour = (hours || []).find((x) => String(x?.startTime || '').slice(0, 13) === key);
    return hour && Number.isFinite(hour.rainChance) ? Math.round(hour.rainChance) : null;
  });
}

module.exports = {
  MEASURABLE_IN,
  STATIONS,
  AREA_STATIONS,
  WORK_HOURS,
  parseObs,
  fetchHourlyObs,
  tallyHours,
  measureAreas,
  wetDayFrom,
  stationsNear,
  spanWet,
  workHourChances,
  _clearCache: () => cache.clear(),
};
