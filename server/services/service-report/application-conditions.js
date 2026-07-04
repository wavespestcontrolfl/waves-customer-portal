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

function rainCacheKey(lat, lon, end) {
  return `${Number(lat).toFixed(2)},${Number(lon).toFixed(2)},${end}`;
}

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
async function fetchServiceWeekWeather({ latitude, longitude, serviceDate } = {}) {
  const empty = { rainInches: null, et0Inches: null, dailyRain: null, rainConfidence: null, rainSource: null };
  const lat = Number.isFinite(Number(latitude)) ? Number(latitude) : null;
  const lon = Number.isFinite(Number(longitude)) ? Number(longitude) : null;
  const range = rainWindowEndingOn(serviceDate, 7);
  if (lat == null || lon == null || !range) return empty;
  const key = rainCacheKey(lat, lon, range.end);
  const cached = _rainCache.get(key);
  if (cached && Date.now() - cached.at < RAIN_TTL_MS) return cached.value;

  // Sample the whole city (property cell + neighbour ring) in ONE multi-location call
  // so a single spiked grid cell can be caught against the city median (see notes above).
  const grid = citySampleGrid(lat, lon);
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', grid.map((p) => p.lat.toFixed(4)).join(','));
  url.searchParams.set('longitude', grid.map((p) => p.lon.toFixed(4)).join(','));
  url.searchParams.set('daily', 'precipitation_sum,et0_fao_evapotranspiration');
  url.searchParams.set('start_date', range.start);
  url.searchParams.set('end_date', range.end);
  url.searchParams.set('precipitation_unit', 'inch');
  url.searchParams.set('timezone', 'America/New_York');

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
      // single-cell convective spikes the rain guard targets.
      et0Inches: et0SumToInches(sumPrecipInches(property.et0), property.et0Unit),
      // Per-day rainfall (inches) over the trusted window. On a normal week this is the
      // property cell; on a spiked week it's the city-collective (median) series, so the
      // 7-day chart and the weekly total always reconcile and never show a phantom spike.
      dailyRain: property.times.map((date, i) => ({ date, inches: dailyInches[i] })),
      // 'low' → the UI shows "Limited data this week"; the value came from the city, not
      // the address cell. null on normal weeks (precise property read, normal confidence).
      rainConfidence: suspect ? 'low' : null,
      rainSource: source,
    };
    _rainCache.set(key, { at: Date.now(), value });
    return value;
  } catch (err) {
    logger.warn(`[application-conditions] service-week weather fetch failed: ${err.message}`);
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
  fetchApplicationConditions,
  fetchOpenMeteoConditions,
  fetchServiceWeekWeather,
  fetchRecentMinTempF,
  sumPrecipInches,
  et0SumToInches,
  rainWindowEndingOn,
  resolveWeekRain,
  normalizeFawnConditions,
  weatherCodeLabel,
};
