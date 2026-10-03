const logger = require('../logger');
const { parseETDateTime, etDateString, addETDays } = require('../../utils/datetime-et');

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

// ── Property forecast (P29) ─────────────────────────────────────────────────────
// ONE Open-Meteo forecast client + cache for "what is the weather at this
// property". Callers pass the property's coordinates and a time window and get
// hourly precipitation (INCHES — quantitative, never only a probability),
// temperature and humidity back, with the source and the fetch time. Wind and
// the provider's rain probability ride along for callers that already judge on
// them (tech spray check, dispatch board). Every failure is a typed
// `{ status: 'unavailable', reason }` result — the function never throws and
// never outlives the caller's own `timeoutMs` (default 3.5 s), so a forecast
// outage cannot break or block any caller.
//
// Cache: keyed on the property coordinates rounded to 3 decimals (~110 m)
// plus the fetch shape. Open-Meteo's own cells are ~3 km (HRRR/NBM), so this is
// finer than the provider's data: properties that share a model cell may share
// a result only when they are within ~110 m of each other, and two properties a
// block apart never read each other's rain. The coordinates sent to the
// provider are the rounded ones, so a cached result is a pure function of its
// key. TTL 10 min; entries hold only the normalized hourly rows (not the raw
// payload) and the map is capped.
//
// MRMS radar rain is NOT part of this module: the observed-rain engine
// (fetchServiceWeekWeather / mrms-qpe) keeps its own mode-scoped cache and
// behavior untouched.

// The point tech-tools, the dispatch board header and a property-less
// fetchOpenMeteoConditions have always used (Lakewood Ranch service area).
// Callers with no property pass it EXPLICITLY, so which place a tile reports on
// is visible at the call site rather than defaulted inside the module.
const SERVICE_AREA_DEFAULT_LOCATION = Object.freeze({ latitude: 27.40, longitude: -82.40 });

const HOUR_MS = 3600000;
const FORECAST_TIMEOUT_MS = 3500;
const FORECAST_CACHE_TTL_MS = 10 * 60 * 1000;
const FORECAST_CACHE_MAX = 300;
const FORECAST_KEY_DECIMALS = 3;
const FORECAST_MAX_WINDOW_MS = 16 * 24 * 60 * 60 * 1000; // Open-Meteo's own horizon
const _forecastCache = new Map();

function forecastUnavailable(reason, extra = {}) {
  return {
    status: 'unavailable',
    reason,
    source: 'open_meteo',
    checkedAt: new Date().toISOString(),
    ...extra,
  };
}

// One HTTP call with a hard deadline that also covers a body that never
// finishes and a fetch that ignores its abort signal. Never throws.
async function openMeteoJson(url, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, reason: 'timeout' });
    }, timeoutMs);
  });
  const work = (async () => {
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) return { ok: false, reason: 'http_error' };
      return { ok: true, payload: await response.json() };
    } catch {
      return { ok: false, reason: controller.signal.aborted ? 'timeout' : 'network_error' };
    }
  })();
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function toInstantMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return parseETDateTime(value).getTime();
  return NaN;
}

// The ET calendar day `ymd` as a { from, to } window (ET midnight to the next
// ET midnight). null for anything that is not a YYYY-MM-DD date.
function etDayWindow(ymd) {
  const s = String(ymd || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const from = parseETDateTime(`${s}T00:00`);
  const next = new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10) + 1)).toISOString().slice(0, 10);
  const to = parseETDateTime(`${next}T00:00`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  return { from, to };
}

function normalizeForecastPayload(payload) {
  const h = payload?.hourly || {};
  const times = Array.isArray(h.time) ? h.time : [];
  const column = (name) => (Array.isArray(h[name]) ? h[name] : []);
  const precip = column('precipitation');
  const prob = column('precipitation_probability');
  const temp = column('temperature_2m');
  const rh = column('relative_humidity_2m');
  const wind = column('wind_speed_10m');
  const gust = column('wind_gusts_10m');
  const hourly = [];
  let prevMs = null;
  times.forEach((time, i) => {
    let ms = parseETDateTime(String(time)).getTime();
    if (!Number.isFinite(ms)) return;
    // The fall-back day repeats the 01:00 wall time; parseETDateTime resolves both
    // to the first (EDT) instant. Rows are chronological, so a stamp that does not
    // advance is the repeated hour: place it one hour after the previous row.
    if (prevMs != null && ms <= prevMs) ms = prevMs + HOUR_MS;
    prevMs = ms;
    hourly.push({
      ms,
      time: String(time),
      precipitation_in: roundedNumber(precip[i], 3),
      precipitation_probability_pct: roundedNumber(prob[i]),
      temperature_f: roundedNumber(temp[i], 1),
      humidity_pct: roundedNumber(rh[i]),
      wind_mph: roundedNumber(wind[i], 1),
      wind_gust_mph: roundedNumber(gust[i], 1),
    });
  });
  const c = payload?.current;
  let current = null;
  if (c && typeof c === 'object') {
    const ms = c.time ? parseETDateTime(String(c.time)).getTime() : NaN;
    current = {
      time: c.time ? String(c.time) : null,
      at: Number.isFinite(ms) ? new Date(ms).toISOString() : null,
      temperature_f: roundedNumber(c.temperature_2m, 1),
      humidity_pct: roundedNumber(c.relative_humidity_2m),
      wind_mph: roundedNumber(c.wind_speed_10m, 1),
      wind_gust_mph: roundedNumber(c.wind_gusts_10m, 1),
      precipitation_probability_pct: roundedNumber(c.precipitation_probability),
      weather_code: finiteNumber(c.weather_code),
    };
    const anyValue = [current.temperature_f, current.humidity_pct, current.wind_mph, current.wind_gust_mph,
      current.precipitation_probability_pct, current.weather_code].some((v) => v != null);
    if (!anyValue) current = null;
  }
  if (!hourly.length && !current) return null;
  return { hourly, current };
}

// The standard shape (yesterday through six days ahead) serves almost every
// window, so callers share one cache entry per property; a window outside it
// (a dated report row, a far-future day) is fetched by date range.
function planForecastFetch(nowMs, fromMs, toMs) {
  const nowDate = new Date(nowMs);
  const stdFrom = parseETDateTime(`${etDateString(addETDays(nowDate, -1))}T00:00`).getTime();
  const stdTo = parseETDateTime(`${etDateString(addETDays(nowDate, 7))}T00:00`).getTime();
  // Precipitation is stamped at the END of its hour, so a window's rain total
  // needs the slot stamped exactly `toMs`. `firstSlot`/`lastSlot` are the first
  // and last hour stamps a fetch of this shape returns; a window is served from
  // it only when [fromMs, toMs] sits inside them (otherwise the total would be
  // short, so the window goes to a date-range fetch instead).
  const standard = fromMs >= stdFrom && toMs <= stdTo - HOUR_MS;
  const startDate = etDateString(new Date(fromMs));
  const endDate = etDateString(new Date(toMs));
  const coverage = standard
    ? { firstSlot: stdFrom, lastSlot: stdTo - HOUR_MS }
    : {
      firstSlot: parseETDateTime(`${startDate}T00:00`).getTime(),
      lastSlot: parseETDateTime(`${etDateString(addETDays(new Date(toMs), 1))}T00:00`).getTime() - HOUR_MS,
    };
  return { standard, startDate, endDate, coverage };
}

function propertyForecastUrl({ keyLat, keyLon, standard, startDate, endDate }) {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(keyLat));
  url.searchParams.set('longitude', String(keyLon));
  url.searchParams.set('current', 'temperature_2m,relative_humidity_2m,wind_speed_10m,wind_gusts_10m,precipitation_probability,weather_code');
  url.searchParams.set('hourly', 'precipitation,precipitation_probability,temperature_2m,relative_humidity_2m,wind_speed_10m,wind_gusts_10m');
  if (standard) {
    url.searchParams.set('past_days', '1');
    url.searchParams.set('forecast_days', '7');
  } else {
    url.searchParams.set('start_date', startDate);
    url.searchParams.set('end_date', endDate);
  }
  url.searchParams.set('temperature_unit', 'fahrenheit');
  url.searchParams.set('wind_speed_unit', 'mph');
  url.searchParams.set('precipitation_unit', 'inch');
  url.searchParams.set('timezone', 'America/New_York');
  return url;
}

// 0,0 is only ever what a failed geocode looks like (see fetchServiceWeekWeather).
function usablePropertyPoint(lat, lon) {
  return lat != null && lon != null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
}

function sliceForecast(entry, cached, { fromMs, toMs, keyLat, keyLon }) {
  // Instantaneous readings (temperature, humidity, wind) are the hour stamps in [from, to).
  const rows = entry.hourly.filter((r) => r.ms >= fromMs && r.ms < toMs);
  // Open-Meteo's hourly `precipitation` is "sum of the preceding hour": the value
  // stamped 13:00 is the rain that fell 12:00-13:00. The total counts the
  // intervals that lie wholly INSIDE the window: a slot stamped S counts only
  // when S - 1h >= from and S <= to, so on-the-hour edges take the slots stamped
  // in (from, to], and an edge off the hour drops the partly-outside interval
  // (from 12:30 the first counted slot is 14:00; to 14:30 the last is 14:00). A
  // total is only stated when EVERY counted slot has a reading: a payload that
  // stops short of the window (including the final slot), or skips hours, would
  // otherwise read as a smaller (or zero) total. No whole interval inside the
  // window (e.g. 12:10-12:50) -> null. Slots are whole hours in UTC, which ET
  // hours always align to.
  const byMs = new Map(entry.hourly.map((r) => [r.ms, r]));
  let total = 0;
  let complete = false;
  for (let slot = Math.ceil(fromMs / HOUR_MS) * HOUR_MS + HOUR_MS; slot <= toMs; slot += HOUR_MS) {
    const r = byMs.get(slot);
    if (!r || r.precipitation_in == null) { complete = false; break; }
    complete = true;
    total += r.precipitation_in;
  }
  return {
    status: 'ok',
    source: 'open_meteo',
    fetchedAt: new Date(entry.fetchedAtMs).toISOString(),
    cached,
    latitude: keyLat,
    longitude: keyLon,
    window: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
    current: entry.current,
    hourly: rows.map(({ ms, ...rest }) => ({ ...rest, at: new Date(ms).toISOString() })),
    precipitationInTotal: complete ? roundedNumber(total, 2) : null,
  };
}

// Property forecast. Returns
//   { status: 'ok', source: 'open_meteo', fetchedAt, cached, latitude, longitude,
//     window: { from, to },                       // ISO instants
//     current: { time, at, temperature_f, humidity_pct, wind_mph, wind_gust_mph,
//                precipitation_probability_pct, weather_code } | null,
//     hourly: [{ time, at, precipitation_in, precipitation_probability_pct,
//                temperature_f, humidity_pct, wind_mph, wind_gust_mph }],
//             // rows are the hour stamps in [from, to). precipitation_in is the rain
//             // in the hour ENDING at that stamp (Open-Meteo "sum of the preceding
//             // hour"); the other fields are readings AT the stamp.
//     precipitationInTotal }                      // inches that fell INSIDE the window: the whole-hour
//                                                 // intervals fully inside [from, to] (slots stamped S
//                                                 // with S-1h >= from and S <= to). Edges off the hour
//                                                 // drop the partly-outside interval. null if there is
//                                                 // no whole interval or any needed slot is missing.
//   { status: 'unavailable', reason, source: 'open_meteo', checkedAt }
// `from`/`to` are Dates, epoch ms, or ISO strings (a zone-less string is ET);
// the default window is the current hour through the next 24 h. `timeoutMs` is
// the CALLER's deadline. `maxAgeMs` is how stale a cached result may be (0 =
// always fetch, the result is still cached for others).
async function fetchPropertyForecast({
  latitude, longitude, from, to, timeoutMs = FORECAST_TIMEOUT_MS, maxAgeMs = FORECAST_CACHE_TTL_MS, now,
} = {}) {
  try {
    const lat = toCoordinate(latitude);
    const lon = toCoordinate(longitude);
    if (!usablePropertyPoint(lat, lon)) {
      return forecastUnavailable('no_coordinates');
    }
    const nowMs = now == null ? Date.now() : toInstantMs(now);
    const fromMs = from == null ? Math.floor(nowMs / 3600000) * 3600000 : toInstantMs(from);
    const toMs = to == null ? fromMs + 24 * 3600000 : toInstantMs(to);
    if (!Number.isFinite(nowMs) || !Number.isFinite(fromMs) || !Number.isFinite(toMs)
      || toMs <= fromMs || toMs - fromMs > FORECAST_MAX_WINDOW_MS) {
      return forecastUnavailable('bad_window');
    }

    const { standard, startDate, endDate, coverage } = planForecastFetch(nowMs, fromMs, toMs);
    const keyLat = Number(lat.toFixed(FORECAST_KEY_DECIMALS));
    const keyLon = Number(lon.toFixed(FORECAST_KEY_DECIMALS));
    const key = `${keyLat.toFixed(FORECAST_KEY_DECIMALS)},${keyLon.toFixed(FORECAST_KEY_DECIMALS)}|${standard ? 'std' : `${startDate}..${endDate}`}`;

    const slice = (entry, cached) => sliceForecast(entry, cached, { fromMs, toMs, keyLat, keyLon });

    const hit = _forecastCache.get(key);
    if (hit && maxAgeMs > 0 && nowMs - hit.fetchedAtMs < maxAgeMs && nowMs >= hit.fetchedAtMs
      && hit.coverage.firstSlot <= fromMs && toMs <= hit.coverage.lastSlot) {
      return slice(hit, true);
    }

    const url = propertyForecastUrl({ keyLat, keyLon, standard, startDate, endDate });

    const res = await openMeteoJson(url, timeoutMs);
    if (!res.ok) {
      logger.warn(`[application-conditions] property forecast unavailable: ${res.reason}`);
      return forecastUnavailable(res.reason);
    }
    const normalized = normalizeForecastPayload(res.payload);
    if (!normalized) {
      logger.warn('[application-conditions] property forecast unavailable: bad_payload');
      return forecastUnavailable('bad_payload');
    }
    const entry = { ...normalized, fetchedAtMs: nowMs, coverage };
    _forecastCache.delete(key);
    _forecastCache.set(key, entry);
    while (_forecastCache.size > FORECAST_CACHE_MAX) _forecastCache.delete(_forecastCache.keys().next().value);
    return slice(entry, false);
  } catch (err) {
    logger.warn(`[application-conditions] property forecast failed: ${err.message}`);
    return forecastUnavailable('error');
  }
}

// Current conditions + trailing rain for the FDACS ledger and the service
// report, built on the property forecast (same client, same cache). Always a
// fresh fetch (maxAgeMs 0): these are "conditions at the visit". No coordinates
// → the named service-area default, as before.
//
// Legacy rain window, preserved on purpose: the 24 hourly slots ending at the
// hour matching current.time, and when current.time (a :15-grid instant) matches
// no hourly slot, ending at the LAST slot of that ET day. In practice that makes
// rain_24h_in "the whole ET day so far plus the rest of today's model" rather
// than a true trailing 24 h; changing it would change report copy, so it is
// left for an owner decision.
async function fetchOpenMeteoConditions({ latitude, longitude } = {}) {
  const lat = toCoordinate(latitude) ?? SERVICE_AREA_DEFAULT_LOCATION.latitude;
  const lon = toCoordinate(longitude) ?? SERVICE_AREA_DEFAULT_LOCATION.longitude;
  const nowDate = new Date();
  const forecast = await fetchPropertyForecast({
    latitude: lat,
    longitude: lon,
    from: parseETDateTime(`${etDateString(addETDays(nowDate, -1))}T00:00`),
    to: parseETDateTime(`${etDateString(addETDays(nowDate, 1))}T00:00`),
    maxAgeMs: 0,
  });
  if (forecast.status !== 'ok') return null;
  const current = forecast.current || {};
  const hourly = forecast.hourly;
  let currentIndex = hourly.length - 1;
  if (current.time) {
    const exact = hourly.findIndex((r) => r.time === current.time);
    if (exact >= 0) {
      currentIndex = exact;
    } else {
      const day = current.time.slice(0, 10);
      for (let i = hourly.length - 1; i >= 0; i -= 1) {
        if (hourly[i].time.slice(0, 10) === day) { currentIndex = i; break; }
      }
    }
  }
  const rain24h = hourly.slice(Math.max(0, currentIndex - 23), currentIndex + 1)
    .reduce((sum, r) => (r.precipitation_in == null ? sum : sum + r.precipitation_in), 0);
  const conditions = {
    temp_f: roundedNumber(current.temperature_f),
    humidity_pct: roundedNumber(current.humidity_pct),
    wind_mph: roundedNumber(current.wind_mph),
    rain_24h_in: roundedNumber(rain24h, 2),
    sky: weatherCodeLabel(current.weather_code),
    source: 'Open-Meteo',
    provider: 'open_meteo',
    captured_at: forecast.fetchedAt,
    latitude: lat,
    longitude: lon,
  };
  return hasUsefulConditionValue(conditions) ? conditions : null;
}

// Open-Meteo only. A FAWN-first branch sat here, but FAWN's feed URL 400'd,
// so every report and FDACS ledger row has always come from Open-Meteo.
// Now that FAWN works (fawn-weather.js), it stays off this path on purpose:
// FAWN has no trailing-24h rain or sky, and its nearest station can be up to
// 35 mi from the property — whether application records should use station
// data is an owner decision, not a side effect of the FAWN fix (2026-09-26).
async function fetchApplicationConditions({ latitude, longitude } = {}) {
  return fetchOpenMeteoConditions({ latitude, longitude });
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

// ── City-collective rainfall (single-cell model-spike guard) ────────────────────
// Open-Meteo's daily precipitation_sum is a per-grid-cell modelled value. On summer
// convective days a single cell can carry a spurious 3–8" bullseye its own neighbours
// (and the real rain gauges) don't share — e.g. a Nokomis property reading 8.29" when
// the town got ~0.5". We can't trust one pinpoint cell for that, so we sample a small
// grid across the customer's CITY (the property cell + an 8-neighbour ring) and, when
// the property cell is a sharp outlier vs the city median on any day, fall back to the
// city-collective series for the whole week and flag it 'limited data'. Normal weeks —
// where the property cell agrees with its neighbours — keep the precise property read.
const CITY_SAMPLE_RING_DEG = 0.045; // ≈3 mi cell spacing → property cell + ring ≈ "the city"
const RAIN_OUTLIER_MIN_INCHES = 1.0; // ignore small days; only large single-cell spikes matter
const RAIN_OUTLIER_FACTOR = 2.5; // property-cell day ≥ this × the city median = a model spike
const RAIN_MEDIAN_FLOOR_INCHES = 0.25; // divisor floor so a near-zero median can't blow up the ratio

// property cell first (index 0), then an 8-point ring one CITY_SAMPLE_RING_DEG step out.
function citySampleGrid(lat, lon) {
  const d = CITY_SAMPLE_RING_DEG;
  const offsets = [
    [0, 0],
    [d, 0], [-d, 0], [0, d], [0, -d],
    [d, d], [d, -d], [-d, d], [-d, -d],
  ];
  return offsets.map(([dLat, dLon]) => ({ lat: lat + dLat, lon: lon + dLon }));
}

function medianOf(values) {
  const arr = values.filter((n) => Number.isFinite(n)).slice().sort((a, b) => a - b);
  if (!arr.length) return null;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

// Decide the trusted weekly rain series. Given the property cell's daily inches and the
// per-day series for every sampled cell (INCLUDING the property cell), return the
// property series unchanged when it tracks its neighbours, else the city-median series
// flagged as a fallback. Pure + exported for tests — no I/O.
function resolveWeekRain(propSeries = [], cellSeriesList = []) {
  const days = propSeries.length;
  const cityMedian = [];
  for (let i = 0; i < days; i += 1) {
    cityMedian.push(medianOf(cellSeriesList.map((s) => Number(s?.[i]))));
  }
  const isOutlierDay = (i) => {
    const p = Number(propSeries[i]);
    const m = cityMedian[i];
    if (!Number.isFinite(p) || m == null) return false;
    return p >= RAIN_OUTLIER_MIN_INCHES && p >= RAIN_OUTLIER_FACTOR * Math.max(m, RAIN_MEDIAN_FLOOR_INCHES);
  };
  const suspect = propSeries.some((_, i) => isOutlierDay(i));
  if (!suspect) {
    return { suspect: false, source: 'property_point', series: propSeries.map(Number) };
  }
  // Use the city-collective; keep the property value only on a day the median is unknown.
  const series = cityMedian.map((m, i) => (m == null ? Number(propSeries[i]) : m));
  return { suspect: true, source: 'city_collective', series };
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
// ── Rain engine mode (GATE_RAIN_MRMS) ───────────────────────────────────────────
// 'off'    (unset/anything else): Open-Meteo only — the pre-engine behavior,
//          zero extra external calls.
// 'shadow' : fetch MRMS too, log the weekly delta vs Open-Meteo, but RETURN
//            the Open-Meteo result — a week of these logs is the flip evidence.
// 'live'   ('true'): MRMS-primary ladder is what reports/emails consume.
// Kill switch = unset the var.
function rainMrmsMode() {
  const raw = String(process.env.GATE_RAIN_MRMS || '').toLowerCase();
  if (raw === 'true') return 'live';
  if (raw === 'shadow') return 'shadow';
  return 'off';
}

// Number(null), Number(undefined) and Number('') are 0 — so a missing geocode
// coerced to a VALID coordinate at the equator. Reject the empty values before
// converting; a literal 0 from the database still passes here and is caught by
// the 0,0 check at the call site.
function toCoordinate(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function etTodayYmd() {
  // en-CA formats as YYYY-MM-DD; the ET calendar day decides whether the
  // window's last day is still accumulating.
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// The next instant at which the ET calendar day has rolled over — i.e. when a
// window ending "today" has SETTLED and can be frozen. Stepping the formatter
// forward rather than doing offset arithmetic keeps this correct across the
// DST boundaries where a fixed -4/-5 would land an hour wrong twice a year.
// Bounded at 26 hours so a formatter surprise can never spin.
function nextEtMidnight(now = new Date()) {
  const today = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  for (let i = 1; i <= 4 * 26; i += 1) {
    const t = new Date(now.getTime() + i * 15 * 60 * 1000);
    if (t.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) !== today) return t;
  }
  return new Date(now.getTime() + 26 * 60 * 60 * 1000);
}

// Merge an MRMS daily series into the Open-Meteo week. Pure — exported for
// tests. Returns the merged value or null when MRMS adds nothing usable
// (caller keeps the Open-Meteo result).
//
// Per-day ladder: a CLOSED day takes the MRMS observation when present and
// falls back to the Open-Meteo estimate on a gap; the UNCLOSED visit day
// takes the larger of MRMS-so-far and the Open-Meteo day value (the model
// includes hours that haven't happened yet — the observation is a floor,
// never a cap). A day with neither source fails the whole merge: partial
// windows are never trusted as weekly totals (same rule as the OM path).
function mergeMrmsIntoWeek({ om, mrms, todayYmd } = {}) {
  if (!mrms || !Array.isArray(mrms.days) || !mrms.days.length) return null;
  const round2 = (n) => (Number.isFinite(Number(n)) ? Math.round(Number(n) * 100) / 100 : null);
  const omByDate = new Map((om?.dailyRain || []).map((d) => [d.date, d.inches]));
  const days = [];
  let mrmsDays = 0;
  for (const day of mrms.days) {
    const omVal = Number.isFinite(Number(omByDate.get(day.date))) ? Number(omByDate.get(day.date)) : null;
    const mrmsVal = day.inches;
    let inches = null;
    let provider = null;
    if (day.date === todayYmd) {
      // The unclosed day NEEDS the model value: MRMS alone is an explicitly
      // partial "so far" accumulation, and accepting it as a full day would
      // understate the week (codex P2 #3096 r2). Only a missing MODEL value
      // fails the merge — a missing MRMS row for today (delayed IEM
      // backfill) just uses the model for that day and keeps the closed-day
      // measurements (codex P2 r3: the inverse outage must not discard six
      // good MRMS days).
      if (omVal == null) return null;
      if (mrmsVal != null) {
        inches = Math.max(mrmsVal, omVal);
        provider = mrmsVal >= omVal ? 'mrms' : 'open_meteo';
      } else {
        inches = omVal;
        provider = 'open_meteo';
      }
    } else if (mrmsVal != null) {
      inches = mrmsVal;
      provider = 'mrms';
    } else if (omVal != null) {
      inches = omVal;
      provider = 'open_meteo';
    } else {
      return null;
    }
    if (provider === 'mrms') mrmsDays += 1;
    days.push({ date: day.date, inches: round2(inches), provider });
  }
  if (!mrmsDays) return null;
  return {
    rainInches: round2(days.reduce((sum, d) => sum + (d.inches || 0), 0)),
    // MRMS carries no evapotranspiration — ET₀ stays the Open-Meteo value.
    et0Inches: om?.et0Inches ?? null,
    dailyRain: days,
    // Measured days are high-trust by nature; the 'low' city-collective badge
    // only survives when Open-Meteo days that used it are still in the mix.
    rainConfidence: days.some((d) => d.provider === 'open_meteo') && om?.rainConfidence === 'low' ? 'low' : null,
    rainSource: mrmsDays === days.length ? 'mrms' : 'mrms+open_meteo',
  };
}

async function fetchServiceWeekWeather({ latitude, longitude, serviceDate } = {}) {
  const empty = { rainInches: null, et0Inches: null, dailyRain: null, rainConfidence: null, rainSource: null };
  const lat = toCoordinate(latitude);
  const lon = toCoordinate(longitude);
  const range = rainWindowEndingOn(serviceDate, 7);
  // Whether the 7-day window has SETTLED. A window ending today is still
  // accumulating, so its value is not yet a fact about the week — callers that
  // persist a week (the report freeze) must not pin a partial day. Unknown
  // range counts as unsettled: never freeze what we cannot date.
  const windowClosed = !!range && range.end < etTodayYmd();
  // 0,0 is the Gulf of Guinea — never a Waves property, only what a failed
  // geocode looks like once it reaches this far. Now that a resolved week gets
  // FROZEN onto the record, fetching it would make that garbage permanent
  // rather than merely wrong until the next view.
  if (lat == null || lon == null || !range || (lat === 0 && lon === 0)) return { ...empty, windowClosed };
  const mode = rainMrmsMode();
  // Mode participates in the key so a gate flip never serves the other
  // mode's cached week for up to 6h. A window ending TODAY is still
  // accumulating — cache it briefly (30 min) so afternoon convection shows
  // up instead of being pinned behind the 6h TTL (codex P2 #3096 r2);
  // closed windows keep the full TTL.
  // Key precision is MODE-SCOPED (codex P2 #3096 r4+r5): shadow/live use
  // four decimals (~11 m) because MRMS resolves ~1 km cells and two-decimal
  // keys collide neighbouring properties into one cached week; OFF mode
  // keeps the legacy two-decimal (~1.1 km) key — that coarseness is what
  // batches the Monday sweep's ~500 sequential Open-Meteo lookups for
  // nearby customers, and off-mode results are city-grid data anyway.
  const keyCoords = mode === 'off'
    ? `${lat.toFixed(2)},${lon.toFixed(2)}`
    : `${lat.toFixed(4)},${lon.toFixed(4)}`;
  const key = `${mode}|${keyCoords},${range.end}`;
  const windowUnclosed = range.end >= etTodayYmd();
  // TTL is decided at WRITE time and stored with the entry — recomputing at
  // read let an entry cached just before ET midnight inherit the 6h TTL
  // after midnight and pin the partial visit-day value (codex P2 #3096 r3).
  const ttlMs = windowUnclosed ? 30 * 60 * 1000 : RAIN_TTL_MS;
  const cached = _rainCache.get(key);
  // The entry carries the closure state it was WRITTEN under. An entry written
  // while the window was still open holds partial days and a forecast tail;
  // those numbers do not become settled just because the ET day rolled over, so
  // reporting them as closed would freeze a forecast as the permanent record.
  // The open→closed transition invalidates the entry instead.
  const cacheFresh = cached && Date.now() - cached.at < (cached.ttlMs ?? RAIN_TTL_MS);
  if (cacheFresh && !(windowClosed && cached.windowClosed === false)) {
    return { ...cached.value, windowClosed: cached.windowClosed ?? windowClosed };
  }

  // The two sources are independent — fetch concurrently so a slow pair
  // costs max(timeouts), not their sum (codex P2 #3096).
  const mrmsPromise = mode !== 'off'
    ? require('../mrms-qpe').fetchMrmsDailyRain({ latitude: lat, longitude: lon, start: range.start, end: range.end }).catch(() => null)
    : Promise.resolve(null);
  const [om, mrms] = await Promise.all([
    fetchOpenMeteoServiceWeek({ lat, lon, range, empty }),
    mrmsPromise,
  ]);
  let value = om;
  if (mode !== 'off') {
    const merged = mergeMrmsIntoWeek({ om, mrms, todayYmd: etTodayYmd() });
    // Coordinates are location PII and must not land in persistent logs
    // (codex P1 #3096) — an opaque hash still lets a week of shadow lines
    // be grouped per property.
    const loc = require('crypto').createHash('sha256').update(`${lat.toFixed(4)},${lon.toFixed(4)}`).digest('hex').slice(0, 8);
    // Telemetry must not bias the shadow experiment (codex P2 r2): missing
    // sources are logged as explicit 'unavailable' outcomes — never as a
    // numeric delta against zero, and never silently skipped — so the
    // live-flip evidence includes availability, not just agreement.
    const omWeek = om.rainInches;
    const mrmsWeek = merged ? merged.rainInches : null;
    const delta = (mrmsWeek != null && omWeek != null)
      ? Math.round((mrmsWeek - omWeek) * 100) / 100
      : null;
    logger.info(`[rain-engine] mode=${mode} mrms=${mrmsWeek ?? 'unavailable'} om=${omWeek ?? 'unavailable'} delta=${delta ?? 'n/a'} source=${merged ? merged.rainSource : 'open_meteo_only'} loc=${loc} end=${range.end}`);
    if (merged && mode === 'live') value = merged;
    if (!merged && mode === 'live') {
      logger.warn(`[rain-engine] mode=live but MRMS unusable for ${range.start}..${range.end} loc=${loc} — Open-Meteo fallback`);
    }
  }
  if (value.rainInches != null || value.et0Inches != null) {
    // Short retry TTL whenever an independent input is missing (codex P2
    // r5+r6): et0Inches null (Open-Meteo outage survived by MRMS) retries
    // ET₀ once the model recovers; in LIVE mode a week that isn't pure MRMS
    // (merge failed → modeled, or gap days filled by the model) retries the
    // primary source so IEM's late backfills upgrade it instead of being
    // pinned behind the 6h TTL.
    const missingIndependentInput = value.et0Inches == null
      || (mode === 'live' && value.rainSource !== 'mrms');
    const effectiveTtlMs = missingIndependentInput ? Math.min(ttlMs, 30 * 60 * 1000) : ttlMs;
    _rainCache.set(key, { at: Date.now(), ttlMs: effectiveTtlMs, value, windowClosed });
  }
  return { ...value, windowClosed };
}

// The pre-engine Open-Meteo week fetch, verbatim behavior (city-grid spike
// guard, full-window trust rule). Returns `empty` on any miss.
// The service week is always a COMPLETED window, so the reanalysis archive is
// the right endpoint for it — /v1/forecast serves model output for past dates
// and demonstrably zeroes real rain days. Measured across one SWFL service
// week (2026-08-01): /v1/forecast reported 0.00" on two days the archive
// scored at 0.055" and 0.382", weekly totals 1.12" vs 2.67". A volunteer rain
// gauge a few miles away caught 1.28" in the same window, so the archive is
// much closer to what actually fell. Verified same-day that the archive spans
// through today (no reanalysis lag to design around) and supports BOTH the
// multi-location grid and et0_fao_evapotranspiration, so the city-median spike
// guard and the ET₀ target are unaffected. /v1/forecast stays as the fallback:
// if the archive ever fails or returns an untrusted window we degrade to
// exactly the previous behaviour rather than to nothing.
const OPEN_METEO_ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';
const OPEN_METEO_FORECAST = 'https://api.open-meteo.com/v1/forecast';

function openMeteoWeekUrl(base, grid, range) {
  const url = new URL(base);
  url.searchParams.set('latitude', grid.map((p) => p.lat.toFixed(4)).join(','));
  url.searchParams.set('longitude', grid.map((p) => p.lon.toFixed(4)).join(','));
  url.searchParams.set('daily', 'precipitation_sum,et0_fao_evapotranspiration');
  url.searchParams.set('start_date', range.start);
  url.searchParams.set('end_date', range.end);
  url.searchParams.set('precipitation_unit', 'inch');
  url.searchParams.set('timezone', 'America/New_York');
  return url;
}

async function fetchOpenMeteoServiceWeek({ lat, lon, range, empty }) {
  // Sample the whole city (property cell + neighbour ring) in ONE multi-location call
  // so a single spiked grid cell can be caught against the city median (see notes above).
  const grid = citySampleGrid(lat, lon);
  // The archive is only right for a CLOSED window. When the window's last day
  // is still today, reanalysis has only the hours that have already been
  // assimilated, so it understates a day that is still raining — the exact
  // reason mergeMrmsIntoWeek refuses to let an MRMS "so far" total cap the
  // model on the unclosed day. Same rule here: a window ending today keeps the
  // forecast endpoint, which carries a full-day model value (codex #3153 P1).
  const windowClosed = range.end < etTodayYmd();
  const attempts = windowClosed
    ? [
      { endpoint: 'archive', url: openMeteoWeekUrl(OPEN_METEO_ARCHIVE, grid, range) },
      { endpoint: 'forecast', url: openMeteoWeekUrl(OPEN_METEO_FORECAST, grid, range) },
    ]
    : [
      { endpoint: 'forecast', url: openMeteoWeekUrl(OPEN_METEO_FORECAST, grid, range) },
    ];

  for (let i = 0; i < attempts.length; i += 1) {
    const { endpoint, url } = attempts[i];
    const isLast = i === attempts.length - 1;
    const result = await fetchOpenMeteoWeekFrom({ url, range, empty, endpoint });
    // An untrusted window from the archive is a reason to try the forecast
    // endpoint, not a reason to give up — `empty` is only final on the last one.
    if (result !== empty || isLast) return result;
    logger.info(`[rain-engine] open-meteo ${endpoint} window unusable for ${range.start}..${range.end} — falling back`);
  }
  return empty;
}

async function fetchOpenMeteoWeekFrom({ url, range, empty, endpoint }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return empty;
    const payload = await response.json();
    // A multi-location request returns an array in input order (property cell first);
    // a single-location fall-through returns a bare object.
    const results = Array.isArray(payload) ? payload : [payload];
    const expectedDays = Math.round(
      (Date.parse(`${range.end}T00:00:00Z`) - Date.parse(`${range.start}T00:00:00Z`)) / 86400000,
    ) + 1;
    const round2 = (n) => (Number.isFinite(Number(n)) ? Math.round(Number(n) * 100) / 100 : null);
    // A cell is usable only when its window spans the full date range AND every day is
    // a real number (a partial/short window can't be trusted as a weekly total).
    const cellFrom = (result) => {
      const daily = result?.daily || {};
      const times = daily.time;
      const windowOk = Array.isArray(times) && times.length === expectedDays
        && times[0] === range.start && times[times.length - 1] === range.end;
      if (!windowOk) return null;
      const precip = daily.precipitation_sum;
      if (!Array.isArray(precip) || precip.length !== expectedDays) return null;
      // Reject the whole cell if ANY day is missing — a partial window can't be trusted
      // as a weekly total (matches sumPrecipInches: null/'' is a gap, not a zero, and
      // Number(null) === 0 would silently undercount).
      const nums = [];
      for (const v of precip) {
        if (v == null || v === '') return null;
        const n = Number(v);
        if (!Number.isFinite(n)) return null;
        nums.push(n);
      }
      return { times, precip: nums, et0: daily.et0_fao_evapotranspiration, et0Unit: result?.daily_units?.et0_fao_evapotranspiration };
    };
    const cells = results.map(cellFrom);
    const property = cells[0];
    // No trustworthy property window → degrade exactly as before (no chart, rain_unknown).
    if (!property) return empty;

    const cellSeriesList = cells.filter(Boolean).map((c) => c.precip);
    const { series, source, suspect } = resolveWeekRain(property.precip, cellSeriesList);
    const dailyInches = series.map(round2);
    const rainInches = round2(dailyInches.reduce((sum, n) => sum + (n || 0), 0));
    const value = {
      rainInches,
      // ET₀ stays the property-cell value — it's a smooth field, not prone to the
      // single-cell convective spikes the rain guard targets. Require the FULL window
      // (like the old sumIfFull guard): sumPrecipInches only rejects gaps, not a short
      // array, so a truncated et0 series would otherwise understate ET₀ and drag the
      // water target down for that week. Short/missing → null → grass×season fallback.
      et0Inches: (Array.isArray(property.et0) && property.et0.length === expectedDays)
        ? et0SumToInches(sumPrecipInches(property.et0), property.et0Unit)
        : null,
      // Per-day rainfall (inches) over the trusted window. On a normal week this is the
      // property cell; on a spiked week it's the city-collective (median) series, so the
      // 7-day chart and the weekly total always reconcile and never show a phantom spike.
      dailyRain: property.times.map((date, i) => ({ date, inches: dailyInches[i] })),
      // 'low' → the UI shows "Limited data this week"; the value came from the city, not
      // the address cell. null on normal weeks (precise property read, normal confidence).
      rainConfidence: suspect ? 'low' : null,
      rainSource: source,
    };
    // Caching moved to fetchServiceWeekWeather — the cache key carries the
    // engine mode, which this extracted fetcher doesn't know about.
    return value;
  } catch (err) {
    logger.warn(`[application-conditions] service-week weather fetch failed (${endpoint}): ${err.message}`);
    return empty;
  } finally {
    clearTimeout(timeout);
  }
}

// Lowest recent overnight temp (°F) for dormancy reasoning — the min of the daily
// temperature_2m_min over the trailing window. Returns null on any miss so callers
// fall back to the calendar season. Best-effort, cached with the rain cache TTL.
async function fetchRecentMinTempF({ latitude, longitude, pastDays = 7 } = {}) {
  const lat = Number.isFinite(Number(latitude)) ? Number(latitude) : null;
  const lon = Number.isFinite(Number(longitude)) ? Number(longitude) : null;
  if (lat == null || lon == null) return null;
  const key = `mintemp:${lat.toFixed(3)},${lon.toFixed(3)}:${pastDays}`;
  const cached = _rainCache.get(key);
  if (cached && Date.now() - cached.at < RAIN_TTL_MS) return cached.value;

  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(lat));
  url.searchParams.set('longitude', String(lon));
  url.searchParams.set('daily', 'temperature_2m_min');
  url.searchParams.set('past_days', String(Math.max(1, Math.min(14, pastDays))));
  url.searchParams.set('forecast_days', '1');
  url.searchParams.set('temperature_unit', 'fahrenheit');
  url.searchParams.set('timezone', 'America/New_York');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    const payload = await response.json();
    const mins = (payload?.daily?.temperature_2m_min || []).map(Number).filter((n) => Number.isFinite(n));
    const value = mins.length ? Math.min(...mins) : null;
    _rainCache.set(key, { at: Date.now(), value });
    return value;
  } catch (err) {
    logger.warn(`[application-conditions] recent min temp fetch failed: ${err.message}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  toCoordinate,
  nextEtMidnight,
  fetchApplicationConditions,
  fetchOpenMeteoConditions,
  fetchPropertyForecast,
  etDayWindow,
  SERVICE_AREA_DEFAULT_LOCATION,
  fetchServiceWeekWeather,
  fetchRecentMinTempF,
  sumPrecipInches,
  et0SumToInches,
  rainWindowEndingOn,
  resolveWeekRain,
  mergeMrmsIntoWeek,
  rainMrmsMode,
  normalizeFawnConditions,
  weatherCodeLabel,
};
