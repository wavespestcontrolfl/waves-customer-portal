/**
 * Lawn Report V2 — area water calibration (Phase 2 service).
 *
 * Assigns a customer to a `lawn_water_areas` row by lat/lng (polygon, else nearest
 * center), reads that area's daily rainfall, and computes the per-service water
 * intake snapshot (rain + irrigation vs grass×season target → status +
 * interpretation + confidence). Lets the report say "your AREA received X" with a
 * confidence level, instead of guessing per property.
 *
 * Pure geometry + arithmetic; the only I/O is reading areas/rainfall/customer and
 * upserting the snapshot. Fail-soft: returns a low-confidence/unknown snapshot when
 * no area or no rainfall is on file, never throws into the report path.
 */

const db = require('../models/db');

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const round2 = (v) => (v == null ? null : Math.round(Number(v) * 100) / 100);

// Ray-casting point-in-polygon on a GeoJSON outer ring ([[lng,lat], ...]).
function pointInRing(lng, lat, ring) {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect = (yi > lat) !== (yj > lat)
      && lng < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function polygonOuterRing(geojson) {
  const g = typeof geojson === 'string' ? safeParse(geojson) : geojson;
  if (!g) return null;
  if (g.type === 'Polygon' && Array.isArray(g.coordinates)) return g.coordinates[0] || null;
  if (g.type === 'MultiPolygon' && Array.isArray(g.coordinates)) return g.coordinates[0]?.[0] || null;
  return null;
}
function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

function haversineKm(aLat, aLng, bLat, bLng) {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

const MAX_NEAREST_KM = 40; // beyond this, no area is a reasonable match

/** Resolve the best area for a point: polygon containment first, else nearest center. */
async function findAreaForPoint(lat, lng, knex = db) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  let areas = [];
  try { areas = await knex('lawn_water_areas').where({ active: true }); } catch { return null; }
  for (const a of areas) {
    const ring = polygonOuterRing(a.polygon_geojson);
    if (ring && pointInRing(lng, lat, ring)) return a.id;
  }
  let best = null;
  let bestKm = Infinity;
  for (const a of areas) {
    if (a.center_lat == null || a.center_lng == null) continue;
    const km = haversineKm(lat, lng, Number(a.center_lat), Number(a.center_lng));
    if (km < bestKm) { bestKm = km; best = a.id; }
  }
  return bestKm <= MAX_NEAREST_KM ? best : null;
}

/** Assign (and persist) a customer's area from their geocoded lat/lng. */
async function assignLawnWaterAreaForCustomer(customerId, knex = db) {
  const cust = await knex('customers').where({ id: customerId }).first('id', 'latitude', 'longitude').catch(() => null);
  if (!cust) return null;
  let { latitude, longitude } = cust;
  if (latitude == null || longitude == null) {
    try {
      const { ensureCustomerGeocoded } = require('./geocoder');
      const geo = await ensureCustomerGeocoded(customerId, knex);
      if (geo) { latitude = geo.lat; longitude = geo.lng; }
    } catch { /* geocoder optional */ }
  }
  const areaId = await findAreaForPoint(Number(latitude), Number(longitude), knex);
  if (areaId) await knex('customers').where({ id: customerId }).update({ lawn_water_area_id: areaId }).catch(() => {});
  return areaId;
}

/** Sum calibrated-source daily rainfall (inches) for an area over [start, end] (YYYY-MM-DD). */
async function getAreaRainfall(areaId, startDate, endDate, knex = db) {
  if (!areaId) return null;
  try {
    const row = await knex('lawn_area_weather_daily')
      .where({ area_id: areaId })
      .andWhere('date', '>=', startDate)
      .andWhere('date', '<=', endDate)
      .select(knex.raw('SUM(rain_inches) AS total'), knex.raw('COUNT(DISTINCT date) AS days'))
      .first();
    if (!row || row.total == null) return null;
    // A partial window (the sync or upstream API missed a day) undercounts rain. Treat
    // it as UNKNOWN rather than persisting a bogus low/balanced/high reading — the
    // snapshot's rainKnown then flips false and the report falls back to live advice.
    const expectedDays = Math.round(
      (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000,
    ) + 1;
    if (Number.isFinite(expectedDays) && Number(row.days) < expectedDays) return null;
    return round2(Number(row.total));
  } catch { return null; }
}

/** Per-day calibrated rainfall (inches) for an area over [start, end] (for the report's 7-day chart). */
async function getAreaDailyRainfall(areaId, startDate, endDate, knex = db) {
  if (!areaId) return [];
  try {
    const area = await knex('lawn_water_areas').where({ id: areaId }).first('rain_adjustment_factor').catch(() => null);
    const factor = Number(area?.rain_adjustment_factor || 1) || 1;
    const rows = await knex('lawn_area_weather_daily')
      .where({ area_id: areaId })
      .andWhere('date', '>=', startDate)
      .andWhere('date', '<=', endDate)
      .orderBy('date', 'asc')
      .select('date', 'rain_inches');
    return rows.map((r) => ({ date: r.date, rain: round2(Number(r.rain_inches || 0) * factor) }));
  } catch { return []; }
}

function interpret(status, signals = {}, known = {}) {
  if (!known.rainKnown && !known.irrigationKnown) return 'rain_unknown';
  if (!known.rainKnown) return 'rain_unknown';
  if (!known.irrigationKnown) return 'irrigation_unknown';
  if (status === 'high') return 'wet_condition_watch';
  if (status === 'low') return 'water_deficit_likely';
  // Balanced total but a localized dry read → coverage, not "water more".
  if (status === 'balanced' && signals.localizedDry) return 'coverage_issue_possible';
  return 'water_balance_ok';
}

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Compute (and, when a service_record_id is given, persist) the water-intake snapshot.
 * @param {object} input { customerId, serviceId?, serviceRecordId?, serviceDate,
 *                         irrigationInchesPerWeek?, targetWaterInchesPerWeek?, signals? }
 * @returns {object} the snapshot row (also upserted when serviceRecordId present)
 */
async function computeLawnWaterIntakeSnapshot(input = {}, knex = db) {
  const { customerId, serviceId = null, serviceRecordId = null, serviceDate = null,
    irrigationInchesPerWeek = null, targetWaterInchesPerWeek = null, signals = {} } = input;

  const cust = customerId
    ? await knex('customers').where({ id: customerId }).first('lawn_water_area_id', 'latitude', 'longitude').catch(() => null)
    : null;
  let areaId = cust?.lawn_water_area_id || null;
  if (!areaId && cust && cust.latitude != null && cust.longitude != null) {
    areaId = await findAreaForPoint(Number(cust.latitude), Number(cust.longitude), knex);
  }
  const area = areaId ? await knex('lawn_water_areas').where({ id: areaId }).first().catch(() => null) : null;

  const date = serviceDate ? new Date(serviceDate) : null;
  let rain7 = null;
  let rain14 = null;
  let rainToday = null;
  let adjusted7 = null;
  if (area && date && !Number.isNaN(date.getTime())) {
    const s7 = new Date(date); s7.setDate(s7.getDate() - 6);
    const s14 = new Date(date); s14.setDate(s14.getDate() - 13);
    rain7 = await getAreaRainfall(area.id, ymd(s7), ymd(date), knex);
    rain14 = await getAreaRainfall(area.id, ymd(s14), ymd(date), knex);
    rainToday = await getAreaRainfall(area.id, ymd(date), ymd(date), knex);
    adjusted7 = rain7 == null ? null : round2(rain7 * Number(area.rain_adjustment_factor || 1));
  }

  const irr = num(irrigationInchesPerWeek);
  const baseTarget = num(targetWaterInchesPerWeek);
  const target = baseTarget == null ? null : round2(baseTarget * Number(area?.water_demand_factor || 1));
  const total = (adjusted7 != null || irr != null) ? round2((adjusted7 || 0) + (irr || 0)) : null;
  const gap = (total != null && target != null) ? round2(total - target) : null;

  let status = 'unknown';
  if (gap != null) status = gap < -0.25 ? 'low' : gap > 0.25 ? 'high' : 'balanced';

  const known = { rainKnown: adjusted7 != null, irrigationKnown: irr != null };
  const confidence = !area ? 'low' : (known.rainKnown && known.irrigationKnown ? (area.confidence || 'medium') : 'low');
  const interpretation = interpret(status, signals, known);

  const row = {
    service_record_id: serviceRecordId,
    service_id: serviceId,
    customer_id: customerId || null,
    area_id: area ? area.id : null,
    service_date: serviceDate || null,
    irrigation_inches_per_week: irr,
    rain_today_inches: rainToday,
    rain_7day_inches: rain7,
    rain_14day_inches: rain14,
    adjusted_rain_7day_inches: adjusted7,
    total_water_7day_inches: total,
    target_water_inches_per_week: target,
    water_gap_inches: gap,
    status,
    interpretation,
    confidence,
  };

  if (serviceRecordId) {
    try {
      await knex('lawn_water_intake_snapshots')
        .insert({ ...row, updated_at: knex.fn.now() })
        .onConflict('service_record_id')
        .merge();
    } catch { /* best-effort persistence */ }
  }
  return row;
}

module.exports = {
  findAreaForPoint,
  assignLawnWaterAreaForCustomer,
  getAreaRainfall,
  getAreaDailyRainfall,
  computeLawnWaterIntakeSnapshot,
  // exported for tests
  _test: { pointInRing, polygonOuterRing, haversineKm, interpret },
};
