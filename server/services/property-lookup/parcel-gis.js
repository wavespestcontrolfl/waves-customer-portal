/**
 * FDOR statewide cadastral parcel lookup.
 *
 * Resolves a geocoded point to the parcel polygon + Department of Revenue
 * roll attributes via the Florida Statewide Cadastral hosted layer, replacing
 * brittle typed-address → PAO string matching with point-in-polygon. The
 * parcel ID feeds the existing county PAO detail fetchers directly.
 *
 * Live-probe findings (2026-06-11, verified with curl against the layer and
 * each county's PAO detail endpoint — keep these in sync if the layer moves):
 *   - CO_NO county codes: Manatee = 51, Sarasota = 68, Charlotte = 18.
 *   - PARCEL_ID maps to the PAO detail key UNMODIFIED in all three counties:
 *       Manatee  "3331410104"   → pao-model-land.php?parid=3331410104 ✓
 *       Sarasota "2027070025"   → /propertysearch/parcel/details/2027070025 ✓
 *       Charlotte "402217351013" → ownership layer ACCOUNT + Show_Parcel.asp ✓
 *   - Native spatial reference is wkid 3086 (FL Albers); pass inSR/outSR 4326
 *     explicitly so geometry comes back in WGS84 for area math and overlays.
 *   - Attribute (string) where-clauses 400 on this hosted layer; spatial
 *     queries are the supported path.
 *   - PHY_ZIPCD is numeric; PHY_CITY is the postal city and can disagree with
 *     the county (34243 probe: PHY_CITY=SARASOTA, CO_NO=51 Manatee).
 *   - The roll is an annual vintage (ASMNT_YR) — cadastral facts support the
 *     merge as evidence but must never short-circuit live PAO / AI lookups.
 *
 * Tunables:
 *   PARCEL_GIS_URL        — layer query endpoint override
 *   PARCEL_GIS_TIMEOUT_MS — request timeout (default 3500)
 *   PARCEL_GIS_DISABLED=1 — kill switch (lookups return null)
 *
 * All logs are prefixed `[parcel-gis]` so they're greppable in Railway.
 */

const logger = require('../logger');

const DEFAULT_PARCEL_GIS_URL = 'https://services9.arcgis.com/Gh9awoU677aKree0/arcgis/rest/services/Florida_Statewide_Cadastral/FeatureServer/0/query';
const DEFAULT_PARCEL_GIS_TIMEOUT_MS = 3500;

// FDOR roll county numbers for the three serviced counties (probe-verified).
const CO_NO_COUNTIES = {
  51: 'Manatee',
  68: 'Sarasota',
  18: 'Charlotte',
};

const PARCEL_OUT_FIELDS = [
  'PARCEL_ID', 'PARCELNO', 'CO_NO', 'ASMNT_YR',
  'PHY_ADDR1', 'PHY_ADDR2', 'PHY_CITY', 'PHY_ZIPCD',
  'LND_SQFOOT', 'TOT_LVG_AR', 'ACT_YR_BLT', 'EFF_YR_BLT',
  'NO_BULDNG', 'NO_RES_UNT', 'DOR_UC',
];

const METERS_PER_DEGREE_LAT = 111320;
const SQ_METERS_TO_SQFT = 10.76391041671;

function parcelGisUrl() {
  return process.env.PARCEL_GIS_URL || DEFAULT_PARCEL_GIS_URL;
}

function parcelGisTimeoutMs() {
  const n = Number(process.env.PARCEL_GIS_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_PARCEL_GIS_TIMEOUT_MS;
}

function isParcelGisDisabled() {
  return process.env.PARCEL_GIS_DISABLED === '1' || process.env.PARCEL_GIS_DISABLED === 'true';
}

function countyFromCoNo(coNo) {
  return CO_NO_COUNTIES[Number(coNo)] || null;
}

// Probe-verified: FDOR PARCEL_ID is the PAO detail key as-is in all three
// counties. Sarasota's detail route only accepts digits, so anything else
// fails closed to the address-search path rather than 404ing downstream.
function normalizeParcelIdForPao(county, attrs) {
  const raw = String(attrs?.PARCEL_ID ?? attrs?.PARCELNO ?? '').trim();
  if (!raw) return null;
  if (county === 'Sarasota' && !/^\d+$/.test(raw)) return null;
  return raw;
}

function cleanAttr(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function positiveOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function zipFromPhyZipcd(value) {
  const digits = String(value ?? '').replace(/\.0+$/, '').trim();
  return /^\d{5}$/.test(digits) ? digits : null;
}

// Logs must not identify the customer's property (AGENTS.md non-card PII
// rule): no parcel IDs, and coordinates coarsened to ~1km so failures stay
// debuggable without pinpointing an address.
function coarseCoord(value) {
  return Number.isFinite(value) ? Number(value.toFixed(2)) : null;
}

// Signed shoelace area of one ring in square feet via an equirectangular
// projection at the ring's mean latitude — accurate to well under 1% at
// parcel scale, which is all the turf math needs.
function ringSignedAreaSqft(ring) {
  if (!Array.isArray(ring) || ring.length < 4) return 0;
  const points = ring.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (points.length < 4) return 0;
  const meanLat = points.reduce((sum, p) => sum + p[1], 0) / points.length;
  const metersPerDegreeLng = METERS_PER_DEGREE_LAT * Math.cos(meanLat * Math.PI / 180);
  let doubleArea = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[i + 1];
    doubleArea += (x1 * metersPerDegreeLng) * (y2 * METERS_PER_DEGREE_LAT)
      - (x2 * metersPerDegreeLng) * (y1 * METERS_PER_DEGREE_LAT);
  }
  return (doubleArea / 2) * SQ_METERS_TO_SQFT;
}

// Total polygon area: rings wound opposite the outer ring (holes) carry the
// opposite sign, so summing signed areas subtracts them naturally.
function polygonAreaSqft(rings) {
  if (!Array.isArray(rings) || !rings.length) return null;
  const total = Math.abs(rings.reduce((sum, ring) => sum + ringSignedAreaSqft(ring), 0));
  return Number.isFinite(total) && total > 0 ? Math.round(total) : null;
}

// Ray-casting point-in-ring test (WGS84 [lng, lat] pairs).
function pointInRing(ring, x, y) {
  if (!Array.isArray(ring) || ring.length < 4) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i] || [];
    const [xj, yj] = ring[j] || [];
    if (!Number.isFinite(xi) || !Number.isFinite(yi) || !Number.isFinite(xj) || !Number.isFinite(yj)) continue;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function polygonContainsPoint(rings, lng, lat) {
  return Array.isArray(rings) && rings.some((ring) => pointInRing(ring, lng, lat));
}

// Decimate a ring to at most maxPoints vertices, always keeping the first
// and last (Static Maps path overlays cap out on URL length — PR3).
function simplifyRing(ring, maxPoints) {
  if (!Array.isArray(ring) || !Number.isFinite(maxPoints) || maxPoints < 3) return [];
  if (ring.length <= maxPoints) return ring;
  const step = (ring.length - 1) / (maxPoints - 1);
  const simplified = [];
  for (let i = 0; i < maxPoints; i += 1) {
    simplified.push(ring[Math.round(i * step)]);
  }
  return simplified;
}

// Condo towers and other stacked parcels can intersect one point with several
// features; the smallest polygon actually containing the point is the unit's
// own parcel rather than a master/common-area parcel. Identical-footprint
// candidates (stacked units sharing one outline) are indistinguishable by
// area — return null so the caller falls back to the address search instead
// of fetching an arbitrary unit's record.
function pickParcelFeature(features, lng, lat) {
  const scored = features
    .map((feature) => ({
      feature,
      rings: feature?.geometry?.rings || null,
      areaSqft: polygonAreaSqft(feature?.geometry?.rings) ?? Number.POSITIVE_INFINITY,
    }))
    .sort((a, b) => a.areaSqft - b.areaSqft);

  const containing = scored.filter((item) => item.rings && polygonContainsPoint(item.rings, lng, lat));
  const pool = containing.length ? containing : scored;
  if (pool.length >= 2 && Math.abs(pool[0].areaSqft - pool[1].areaSqft) < 1) {
    return null;
  }
  return pool[0]?.feature || null;
}

async function lookupParcelByPoint(lat, lng, options = {}) {
  if (isParcelGisDisabled()) {
    logger.info('[parcel-gis] skipped — PARCEL_GIS_DISABLED');
    return null;
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.floor(options.timeoutMs)
    : parcelGisTimeoutMs();

  const params = new URLSearchParams({
    f: 'json',
    geometry: JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }),
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: PARCEL_OUT_FIELDS.join(','),
    returnGeometry: 'true',
    outSR: '4326',
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();

  try {
    const resp = await fetch(`${parcelGisUrl()}?${params.toString()}`, { signal: controller.signal });
    if (!resp.ok) throw new Error(`FDOR cadastral ${resp.status}`);
    const data = await resp.json();
    if (data?.error) throw new Error(`FDOR cadastral error: ${data.error.message || data.error.code}`);

    const features = Array.isArray(data?.features) ? data.features : [];
    if (!features.length) {
      logger.info('[parcel-gis] no parcel at point', {
        latApprox: coarseCoord(lat), lngApprox: coarseCoord(lng), elapsedMs: Date.now() - t0,
      });
      return null;
    }
    if (features.length > 1) {
      logger.info('[parcel-gis] multiple parcels at point — picking smallest containing polygon', {
        count: features.length,
      });
    }

    const feature = pickParcelFeature(features, lng, lat);
    if (!feature) {
      logger.info('[parcel-gis] ambiguous stacked parcels at point — deferring to address search', {
        count: features.length,
        elapsedMs: Date.now() - t0,
      });
      return null;
    }
    const attrs = feature?.attributes || {};
    const county = countyFromCoNo(attrs.CO_NO);
    if (!county) {
      logger.info('[parcel-gis] parcel outside serviced counties', {
        latApprox: coarseCoord(lat), lngApprox: coarseCoord(lng), coNo: attrs.CO_NO ?? null, elapsedMs: Date.now() - t0,
      });
      return null;
    }

    const polygon = Array.isArray(feature?.geometry?.rings) && feature.geometry.rings.length
      ? feature.geometry.rings
      : null;
    const parcelId = cleanAttr(attrs.PARCEL_ID) || cleanAttr(attrs.PARCELNO);
    if (!parcelId) return null;

    const parcel = {
      parcelId,
      paoParcelId: normalizeParcelIdForPao(county, attrs),
      // Layer URL (sans /query) — classifyPropertySource keys the cadastral
      // evidence weight off this host/path.
      sourceUrl: parcelGisUrl().replace(/\/query\/?$/, ''),
      county,
      countyCode: Number(attrs.CO_NO),
      situsAddress: cleanAttr(attrs.PHY_ADDR1),
      situsCity: cleanAttr(attrs.PHY_CITY),
      situsZip: zipFromPhyZipcd(attrs.PHY_ZIPCD),
      lotSqft: positiveOrNull(attrs.LND_SQFOOT),
      livingAreaSqft: positiveOrNull(attrs.TOT_LVG_AR),
      yearBuilt: positiveOrNull(attrs.ACT_YR_BLT) || positiveOrNull(attrs.EFF_YR_BLT),
      buildingCount: positiveOrNull(attrs.NO_BULDNG),
      residentialUnits: positiveOrNull(attrs.NO_RES_UNT),
      dorUseCode: cleanAttr(attrs.DOR_UC),
      assessmentYear: positiveOrNull(attrs.ASMNT_YR),
      polygon,
      polygonAreaSqft: polygonAreaSqft(polygon),
    };

    logger.info('[parcel-gis] matched parcel', {
      county,
      lotSqft: parcel.lotSqft,
      polygonAreaSqft: parcel.polygonAreaSqft,
      elapsedMs: Date.now() - t0,
    });
    return parcel;
  } catch (err) {
    const aborted = err?.name === 'AbortError' || err?.code === 'ABORT_ERR';
    logger.warn('[parcel-gis] lookup failed', {
      latApprox: coarseCoord(lat),
      lngApprox: coarseCoord(lng),
      timeoutMs,
      aborted,
      error: err?.message || String(err),
      elapsedMs: Date.now() - t0,
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  lookupParcelByPoint,
  countyFromCoNo,
  normalizeParcelIdForPao,
  polygonAreaSqft,
  simplifyRing,
  isParcelGisDisabled,
  parcelGisTimeoutMs,
  _private: {
    pickParcelFeature,
    pointInRing,
    polygonContainsPoint,
    ringSignedAreaSqft,
    zipFromPhyZipcd,
    PARCEL_OUT_FIELDS,
    CO_NO_COUNTIES,
  },
};
