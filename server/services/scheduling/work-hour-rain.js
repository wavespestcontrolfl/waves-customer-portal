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
 *
 * Day edges, checked: the request runs from 00:00 ET of the day through 00:30 ET of the next (hour2/minute2), so a report at
 * 00:00 to 00:29 reaches the day's 23:00 bucket; one at 00:30 or later belongs to the next day's hour 0 and the bucket-date
 * filter drops it. A report before 00:30 on the day itself belongs to the previous day's 23:00 and is dropped the same way.
 * Hour 0 of the day comes from a report between 00:30 and 01:29. On the fall-back night two reports share a local
 * HH:MM; they land in one bucket and the larger stays (no work hour is affected). Nothing here reads a time zone offset.
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
  // CRLF or LF; every field trimmed, so a stray carriage return or space never turns 'T' or a station name into a miss.
  const lines = String(csv || '').trim().split(/\r?\n/);
  if (!lines[0].trim().startsWith('station,valid,p01i')) return null;
  const obs = Object.fromEntries(Object.keys(STATIONS).map((s) => [s, {}]));
  for (const line of lines.slice(1)) {
    const [station, valid, raw] = line.split(',').map((f) => f.trim());
    const bucket = obs[station] && bucketOf(String(valid || ''));
    if (!bucket || bucket.date !== day) continue;
    const inches = raw === 'T' ? 0 : raw === 'M' || raw === '' || raw == null ? null : Number(raw);
    if (!Number.isFinite(inches)) continue;
    obs[station][bucket.hour] = Math.max(inches, obs[station][bucket.hour] ?? 0);
  }
  return obs;
}

const cache = new Map(); // day -> { at, promise }

// IEM throttles about 1 request a second per IP (2026-11-26: a 429 with the 'Too many requests' text). Distinct-day requests
// of this process start at least PACE_MS apart; a day already read is served from the cache and never waits.
const PACE_MS = 1100;
let paceChain = Promise.resolve();
let lastStartAt = 0;
function paced(task, { now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), paceMs = PACE_MS } = {}) {
  const run = paceChain.then(async () => {
    const wait = lastStartAt + paceMs - now();
    if (wait > 0) await sleep(wait);
    lastStartAt = now();
    return task();
  });
  paceChain = run.catch(() => {});
  return run;
}

/**
 * The day's hourly readings at every station, or null when the read FAILED (a 429, a timeout, a bad reply): null means "not
 * read this run", never "no rain" and never a reason to give up on a score. An object (even one with missing hours) is a
 * successful read. Kept 10 minutes; a failure is never kept.
 */
function fetchHourlyObs(day, { fetchFn = fetch, timeoutMs = FETCH_MS, now = Date.now, sleep, paceMs } = {}) {
  const hit = cache.get(day);
  if (hit && now() - hit.at < CACHE_MS) return hit.promise;
  const [y1, m1, d1] = day.split('-');
  const [y2, m2, d2] = dayAfter(day).split('-');
  const stations = Object.keys(STATIONS).map((s) => `station=${s}`).join('&');
  const url = `${ASOS_URL}?${stations}&data=p01i&year1=${y1}&month1=${Number(m1)}&day1=${Number(d1)}`
    + `&year2=${y2}&month2=${Number(m2)}&day2=${Number(d2)}&hour2=0&minute2=30&tz=America%2FNew_York&format=onlycomma&latlon=no&missing=M&trace=T&report_type=3`;
  const promise = paced(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchFn(url, { signal: controller.signal });
      if (!res.ok) {
        logger.warn(`[work-hour-rain] ${day} read refused: HTTP ${res.status}`);
        return null;
      }
      return parseObs(await res.text(), day);
    } catch (err) {
      logger.warn(`[work-hour-rain] ${day} read failed: ${err.message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }, { now, sleep, paceMs }).catch(() => null);
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

/**
 * { wet_hours, inches, missing } over `hours`: wet = MEASURABLE_IN or more; a missing hour is null, never dry. `inches` is the
 * total of the hours READ, null when none was read (never 0 for a span nobody measured); with `missing` above 0 it is a
 * partial total, and `missing` is its coverage gap.
 */
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
  return { wet_hours: wet, inches: missing === hours.length ? null : Math.round(inches * 100) / 100, missing };
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

/**
 * The day from its areas, the one rule both graders use. Half or more of all areas wet = wet day. { wet_areas, unknown,
 * wet_day, partial }. While unknown areas could still flip it, wet_day is null and `partial` is true. With `final` (the
 * give-up deadline, after a SUCCESSFUL read) the settled areas decide, still marked partial: wet day = half or more of the
 * settled areas wet; null only when no area settled.
 */
function wetDayFrom(areas, { final = false } = {}) {
  const all = Object.values(areas);
  const wetAreas = Object.keys(areas).filter((z) => areas[z].wet === true);
  const unknown = all.filter((a) => a.wet === null).length;
  let wetDay = null;
  if (wetAreas.length * 2 >= all.length) wetDay = true;
  else if ((wetAreas.length + unknown) * 2 < all.length) wetDay = false;
  const partial = wetDay === null;
  if (partial && final) {
    const settled = all.length - unknown;
    wetDay = settled ? wetAreas.length * 2 >= settled : null;
  }
  return { wet_areas: wetAreas, unknown, wet_day: wetDay, partial };
}

const km = (a, b) => Math.hypot((a.lat - b.lat) * 111, (a.lng - b.lng) * 99);

/** The NEAREST_N stations to a point, nearest first. */
function stationsNear(point) {
  return Object.keys(STATIONS).sort((a, b) => km(point, STATIONS[a]) - km(point, STATIONS[b])).slice(0, NEAREST_N);
}

/**
 * Rain over a visit's hours: from the hour its work starts through `afterHours` after it ends (the drying time, rain-fit
 * RAIN_AFTER_HOURS), at the visit's nearest stations. { wet, inches, missing }: wet true when any hour is measurable,
 * false only when every hour was read, null when an unread hour could still hide rain. `inches` is null for a span with no
 * reading, else the total of the hours read (see `missing`).
 */
function spanWet(obs, point, startMin, endMin, afterHours) {
  return spanWetAt(obs, stationsNear(point), startMin, endMin, afterHours);
}

/** The hours of a visit's span plus its drying hours: from the hour the work starts to afterHours past its end, to midnight. */
function spanHours(startMin, endMin, afterHours) {
  const hours = [];
  const last = Math.min(24 * 60, endMin + afterHours * 60);
  for (let m = Math.floor(startMin / 60) * 60; m < last; m += 60) hours.push(m / 60);
  return hours;
}

/** spanWet from stored gauge IDs (stationsNear, nearest first): grading never needs the visit's point again. */
function spanWetAt(obs, stations, startMin, endMin, afterHours) {
  const t = tallyHours(obs, stations, spanHours(startMin, endMin, afterHours));
  let wet = null;
  if (t.wet_hours > 0) wet = true;
  else if (t.missing === 0) wet = false;
  return { wet, inches: t.inches, missing: t.missing };
}

/** The forecast's chance for each work hour of `day`, as a compact array (null = no reading). Stored as read, never rounded:
 *  a replay compares these against the rule's thresholds (70, 40). */
function workHourChances(hours, day) {
  return chancesFor(hours, day, WORK_HOURS);
}

function chancesFor(hours, day, hourNumbers) {
  return hourNumbers.map((h) => {
    const key = `${day}T${String(h).padStart(2, '0')}`;
    const hour = (hours || []).find((x) => String(x?.startTime || '').slice(0, 13) === key);
    return hour && Number.isFinite(hour.rainChance) ? hour.rainChance : null;
  });
}

/** The chance for each hour of a visit's span plus drying hours (from the hour its work starts), as read; null = no reading. */
function spanChances(hours, day, startMin, endMin, afterHours) {
  return chancesFor(hours, day, spanHours(startMin, endMin, afterHours));
}

/** The chance for every hour a same-day slot can use at the visit's point: the work hours plus the drying hours after
 *  close, as read (null = no reading). A reorder's span lies inside it, so the decision can be replayed. */
function dayChances(hours, day, afterHours) {
  const last = DAY_CLOSE / 60 + afterHours;
  const hourNumbers = [];
  for (let h = DAY_OPEN / 60; h < Math.min(24, last); h += 1) hourNumbers.push(h);
  return chancesFor(hours, day, hourNumbers);
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
  spanWetAt,
  spanChances,
  workHourChances,
  dayChances,
  _clearCache: () => cache.clear(),
};
