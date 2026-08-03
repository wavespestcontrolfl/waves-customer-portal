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
  const lat = Number.isFinite(Number(latitude)) ? Number(latitude) : null;
  const lon = Number.isFinite(Number(longitude)) ? Number(longitude) : null;
  const range = rainWindowEndingOn(serviceDate, 7);
  // Whether the 7-day window has SETTLED. A window ending today is still
  // accumulating, so its value is not yet a fact about the week — callers that
  // persist a week (the report freeze) must not pin a partial day. Unknown
  // range counts as unsettled: never freeze what we cannot date.
  const windowClosed = !!range && range.end < etTodayYmd();
  if (lat == null || lon == null || !range) return { ...empty, windowClosed };
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
  // windowClosed is recomputed, never replayed from the entry: a week cached
  // just before ET midnight would otherwise keep reporting an open window for
  // the rest of its TTL and delay the freeze by up to that long.
  if (cached && Date.now() - cached.at < (cached.ttlMs ?? RAIN_TTL_MS)) return { ...cached.value, windowClosed };

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
    _rainCache.set(key, { at: Date.now(), ttlMs: effectiveTtlMs, value });
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
  nextEtMidnight,
  fetchApplicationConditions,
  fetchOpenMeteoConditions,
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
