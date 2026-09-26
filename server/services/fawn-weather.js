/**
 * FAWN Weather Service
 *
 * Fetches current + trailing weather data from the Florida Automated
 * Weather Network for the SWFL stations nearest Waves' service area
 * (North Port, Arcadia). Used by lawn assessments, treatment outcomes,
 * content engine, and seasonal expectation displays.
 */

const logger = require('./logger');

// `lastObservation/summary/` is not a real FAWN endpoint (confirmed live
// 2026-09-26: it 400s). The documented, working "all stations" feed is
// `{period}/summary/json`. Two different periods, two different jobs:
// lastHour is near-real-time (~15-45min old) and is what "current
// conditions" (getCurrent, used by application-conditions.js's live
// service-report snapshot, lawn-intelligence.js, etc.) means; lastDay is
// the most recent COMPLETE day's totals, which is what "recent rainfall"
// (getRecentRainfall, used by the public pest forecast to judge "has it
// been wet lately") actually needs — an hour's rain_sum is almost always
// zero unless it happens to be raining at fetch time.
const FAWN_LAST_HOUR_URL = 'https://fawn.ifas.ufl.edu/controller.php/lastHour/summary/json';
const FAWN_LAST_DAY_URL = 'https://fawn.ifas.ufl.edu/controller.php/lastDay/summary/json';

// The real API's summary rows carry ONLY a numeric `StationID` — no name,
// county, or lat/lng field (confirmed live 2026-09-26). There is also no
// FAWN station literally named "Myakka"/"Manatee"/"Sarasota". The two real
// stations nearest Waves' SWFL service area (Manatee/Sarasota/Charlotte
// counties) are North Port (Sarasota Co.) and Arcadia (DeSoto Co.); ids and
// coordinates are from fawn.ifas.ufl.edu/station.php?id=<id>.
const STATION_HINTS = [
  { key: 'north_port', id: '480', label: 'North Port', names: ['north port'], latitude: 27.1434, longitude: -82.33741 },
  { key: 'arcadia', id: '490', label: 'Arcadia', names: ['arcadia'], latitude: 27.22621, longitude: -81.83838 },
];

// Cache for 15 minutes to avoid hammering FAWN. Separate slots per period —
// lastHour and lastDay are different datasets and must not overwrite one
// another's cache.
const _stationCache = { lastHour: null, lastDay: null };
const _stationCacheTime = { lastHour: 0, lastDay: 0 };
let _lastSnapshot = null;
const CACHE_TTL = 15 * 60 * 1000;

// getRecentRainfall()'s last-good fallback, keyed per requested coordinate
// (not a single global) so a failure for one location never serves another
// location's station reading, and bounded by age so a multi-hour FAWN
// outage doesn't preserve a stale wet/dry signal indefinitely (Codex
// review, 2026-09-26).
const _recentRainfallCache = new Map(); // key -> { at, snapshot }
const RAIN_FALLBACK_MAX_AGE = 6 * 60 * 60 * 1000; // 6h

function coordKey({ latitude, longitude } = {}) {
  const lat = Number(latitude);
  const lon = Number(longitude);
  return Number.isFinite(lat) && Number.isFinite(lon) ? `${lat.toFixed(2)},${lon.toFixed(2)}` : 'unknown';
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function numberOrNull(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stationName(station = {}) {
  return firstDefined(station.StationName, station.station_name, station.name, station.NAME, station.station);
}

function stationId(station = {}) {
  const raw = firstDefined(station.StationID, station.station_id, station.stationId, station.id);
  return raw != null ? String(raw) : null;
}

function stationLatitude(station = {}) {
  return numberOrNull(firstDefined(
    station.Latitude,
    station.latitude,
    station.LATITUDE,
    station.lat,
    station.Lat,
    station.LAT,
    station.StationLatitude,
  ));
}

function stationLongitude(station = {}) {
  return numberOrNull(firstDefined(
    station.Longitude,
    station.longitude,
    station.LONGITUDE,
    station.lon,
    station.lng,
    station.Lon,
    station.LON,
    station.StationLongitude,
  ));
}

// Match a station row to a known SWFL hint. The live API gives us only a
// numeric StationID (no name), so that's the primary key; name-substring
// matching stays as a fallback for any fixture/shape that does carry a name.
function hintForStation(station = {}) {
  const id = stationId(station);
  if (id != null) {
    const byId = STATION_HINTS.find((hint) => hint.id === id);
    if (byId) return byId;
  }
  const normalized = String(stationName(station) || '').toLowerCase();
  if (!normalized) return null;
  return STATION_HINTS.find((hint) => hint.names.some((candidate) => normalized.includes(candidate)));
}

function stationCoordinates(station = {}) {
  const lat = stationLatitude(station);
  const lon = stationLongitude(station);
  if (lat != null && lon != null) return { latitude: lat, longitude: lon };
  const hint = hintForStation(station);
  return hint ? { latitude: hint.latitude, longitude: hint.longitude } : null;
}

// FAWN's documented `rain_sum` field (lastDay/summary) is a SUM in
// centimeters, not inches (confirmed live 2026-09-26). `Rain_Tot` /
// `rainfall_in` / `precipitation` are defensive fallbacks for any shape
// that already reports inches (e.g. test fixtures) — never seen on the
// live API, so never double-converted.
function rainfallInches(station = {}) {
  const cm = numberOrNull(station.rain_sum);
  if (cm != null) return cm / 2.54;
  return numberOrNull(firstDefined(station.Rain_Tot, station.rainfall_in, station.precipitation));
}

// FAWN's documented temperature fields (t2m_avg, tsoil_avg) are °C, and wind
// (ws_avg) is km/hr — confirmed live 2026-09-26 against the columns doc.
// AirTemp_Avg / SoilTemp4_Avg / Wind_Avg / *_f / *_mph are defensive
// fallbacks for any shape that already reports imperial units (e.g. test
// fixtures) — never seen on the live API, so never double-converted.
function celsiusToF(value) {
  const c = numberOrNull(value);
  return c != null ? (c * 9) / 5 + 32 : null;
}

function kmhToMph(value) {
  const kmh = numberOrNull(value);
  return kmh != null ? kmh / 1.60934 : null;
}

function tempF(station = {}) {
  const direct = numberOrNull(firstDefined(station.AirTemp_Avg, station.air_temp, station.temp_f));
  return direct != null ? direct : celsiusToF(station.t2m_avg);
}

function soilTempF(station = {}) {
  const direct = numberOrNull(firstDefined(station.SoilTemp4_Avg, station.soil_temp_f));
  return direct != null ? direct : celsiusToF(station.tsoil_avg);
}

function windMph(station = {}) {
  const direct = numberOrNull(firstDefined(station.Wind_Avg, station.wind_mph, station.wind_speed));
  return direct != null ? direct : kmhToMph(station.ws_avg);
}

function distanceMiles(from, to) {
  if (!from || !to) return null;
  if ([from.latitude, from.longitude, to.latitude, to.longitude].some((value) => !Number.isFinite(Number(value)))) return null;
  const R = 3959;
  const dLat = (Number(to.latitude) - Number(from.latitude)) * Math.PI / 180;
  const dLon = (Number(to.longitude) - Number(from.longitude)) * Math.PI / 180;
  const lat1 = Number(from.latitude) * Math.PI / 180;
  const lat2 = Number(to.latitude) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function fetchStationRows(period) {
  const url = period === 'lastDay' ? FAWN_LAST_DAY_URL : FAWN_LAST_HOUR_URL;
  const slot = period === 'lastDay' ? 'lastDay' : 'lastHour';

  if (_stationCache[slot] && Date.now() - _stationCacheTime[slot] < CACHE_TTL) return _stationCache[slot];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`FAWN HTTP ${res.status}`);

    const data = await res.json();
    const rows = Array.isArray(data) ? data : [];
    _stationCache[slot] = rows;
    _stationCacheTime[slot] = Date.now();
    return rows;
  } finally {
    clearTimeout(timeout);
  }
}

function selectStation(stations = [], { latitude, longitude } = {}) {
  const swflStations = stations.filter((station) => !!hintForStation(station));
  const candidates = swflStations.length ? swflStations : stations;
  const target = Number.isFinite(Number(latitude)) && Number.isFinite(Number(longitude))
    ? { latitude: Number(latitude), longitude: Number(longitude) }
    : null;

  if (target) {
    const nearest = candidates
      .map((station) => ({
        station,
        distance: distanceMiles(target, stationCoordinates(station)),
      }))
      .filter((entry) => entry.distance != null)
      .sort((a, b) => a.distance - b.distance)[0];
    if (nearest) return nearest.station;
  }

  return candidates[0] || null;
}

function normalizeStationSnapshot(station) {
  const hint = hintForStation(station);
  const name = stationName(station) || hint?.label || 'FAWN SWFL';
  const coords = stationCoordinates(station);
  return {
    temp_f: tempF(station),
    humidity_pct: numberOrNull(firstDefined(station.RelHum_Avg, station.rh_avg, station.relative_humidity, station.humidity_pct)),
    rainfall_in: rainfallInches(station),
    soil_temp_f: soilTempF(station),
    wind_mph: windMph(station),
    station: name,
    station_key: hint?.key || null,
    observation_time: firstDefined(station.ObservationTime, station.observation_time, station.startTime, station.DateTime, station.datetime, station.timestamp),
    timestamp: new Date().toISOString(),
    latitude: coords?.latitude ?? null,
    longitude: coords?.longitude ?? null,
  };
}

const FawnWeather = {

  /**
   * Get current (near-real-time, ~15-45min old) FAWN observation for the
   * nearest SWFL station. This is "current conditions" — application
   * snapshots, lawn assessments, seasonal displays.
   * Returns: { temp_f, humidity_pct, rainfall_in, soil_temp_f, station, timestamp }
   */
  async getCurrent(options = {}) {
    try {
      const data = await fetchStationRows('lastHour');
      const station = selectStation(data, options);

      if (!station) throw new Error('No FAWN station found');

      const snapshot = normalizeStationSnapshot(station);
      _lastSnapshot = snapshot;

      return snapshot;
    } catch (err) {
      logger.error(`[fawn-weather] Fetch failed: ${err.message}`);
      return _lastSnapshot || {
        temp_f: null, humidity_pct: null, rainfall_in: null,
        soil_temp_f: null, wind_mph: null, station: 'unavailable', timestamp: new Date().toISOString(),
        error: err.message,
      };
    }
  },

  /**
   * Get the most recent COMPLETE day's rainfall total for the nearest SWFL
   * station — a meaningfully-sized "has it been wet lately" reading, unlike
   * getCurrent()'s near-real-time (and almost always zero) hourly rain_sum.
   * Used by the public pest forecast's SWFL enrichment; kept separate from
   * getCurrent() so a stale day-total never masquerades as "current
   * conditions" for application-conditions.js and other current-weather
   * consumers (Codex review, 2026-09-26).
   * Returns: { rainfall_in, station, station_key, observation_time }
   */
  async getRecentRainfall(options = {}) {
    const key = coordKey(options);
    try {
      const data = await fetchStationRows('lastDay');
      const station = selectStation(data, options);

      if (!station) throw new Error('No FAWN station found');

      const hint = hintForStation(station);
      const snapshot = {
        rainfall_in: rainfallInches(station),
        station: stationName(station) || hint?.label || 'FAWN SWFL',
        station_key: hint?.key || null,
        observation_time: firstDefined(station.ObservationTime, station.observation_time, station.startTime, station.DateTime, station.datetime, station.timestamp),
      };
      _recentRainfallCache.set(key, { at: Date.now(), snapshot });

      return snapshot;
    } catch (err) {
      logger.error(`[fawn-weather] Recent-rainfall fetch failed: ${err.message}`);
      const cached = _recentRainfallCache.get(key);
      if (cached && Date.now() - cached.at < RAIN_FALLBACK_MAX_AGE) return cached.snapshot;
      return {
        rainfall_in: null, station: 'unavailable', station_key: null, observation_time: null,
        error: err.message,
      };
    }
  },

  /**
   * Get seasonal context for customer-facing display.
   * Returns human-readable explanation of current conditions.
   */
  getSeasonalContext(month, weather) {
    const m = month || (new Date().getMonth() + 1);
    const temp = weather?.temp_f || weather?.fawn_temp_f;
    const soil = weather?.soil_temp_f || weather?.fawn_soil_temp_f;
    const rain = weather?.rainfall_in || weather?.fawn_rainfall_7d;

    let seasonName, explanation, expectation;

    if (m >= 5 && m <= 9) {
      seasonName = 'Summer peak season';
      explanation = 'This is prime growing season for St. Augustine grass in Southwest Florida.';
      expectation = 'Expect the highest scores of the year. Rapid growth means more mowing but also faster recovery from treatments.';
      if (temp && temp > 95) explanation += ` Current temps of ${Math.round(temp)}°F may cause some heat stress — this is normal.`;
    } else if (m >= 3 && m <= 4) {
      seasonName = 'Spring green-up';
      explanation = 'Your lawn is transitioning out of dormancy. Green-up typically takes 4-6 weeks.';
      expectation = 'Scores will improve rapidly over the next few visits as the turf fills in. Some patchiness is normal during this transition.';
      if (soil && soil < 65) explanation += ` Soil temp is ${Math.round(soil)}°F — full green-up starts above 65°F.`;
    } else if (m >= 10 && m <= 11) {
      seasonName = 'Fall transition';
      explanation = 'Growth is slowing as temperatures cool. This is the ideal window for fall pre-emergent applications.';
      expectation = 'Slight score decreases are normal. Focus shifts from growth to root strength and weed prevention.';
    } else {
      seasonName = 'Winter dormancy';
      explanation = 'St. Augustine grass naturally slows or goes semi-dormant in SWFL winters.';
      expectation = 'Lower scores are completely normal and expected. Your lawn will bounce back in spring.';
      if (temp && temp < 50) explanation += ` At ${Math.round(temp)}°F, some browning is expected — this is not damage.`;
    }

    if (rain != null && rain < 0.1 && m >= 3 && m <= 10) {
      explanation += ' Rainfall has been low — if you have irrigation, ensure it\'s running 2-3 times per week.';
    }

    return {
      seasonName,
      explanation,
      expectation,
      month: m,
      weather: { temp_f: temp, soil_temp_f: soil, rainfall_in: rain },
    };
  },

  /**
   * Get pest/disease pressure signals for the current month.
   */
  getPressureSignals(month) {
    const m = month || (new Date().getMonth() + 1);
    const signals = [];

    if (m >= 4 && m <= 9) signals.push({ type: 'chinch_bug', level: 'high', note: 'Peak chinch bug pressure — monitor sunny areas' });
    if (m >= 5 && m <= 10) signals.push({ type: 'sod_webworm', level: 'moderate', note: 'Sod webworm active — look for notched grass blades' });
    if (m >= 6 && m <= 9) signals.push({ type: 'gray_leaf_spot', level: 'high', note: 'Gray leaf spot risk elevated with humidity >80%' });
    if (m >= 5 && m <= 8) signals.push({ type: 'large_patch', level: 'moderate', note: 'Large patch (Rhizoctonia) may appear in shaded areas' });
    if (m >= 3 && m <= 5) signals.push({ type: 'dollar_weed', level: 'high', note: 'Dollar weed spreading — pre/post emergent window' });
    if (m >= 10 || m <= 2) signals.push({ type: 'annual_bluegrass', level: 'high', note: 'Poa annua germination — pre-emergent critical' });
    if (m >= 5 && m <= 8) signals.push({ type: 'nitrogen_blackout', level: 'regulatory', note: 'Sarasota/Manatee county nitrogen blackout in effect' });

    return signals;
  },
};

module.exports = FawnWeather;
