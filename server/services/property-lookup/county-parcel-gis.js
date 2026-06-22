/**
 * County parcel GIS lookup (Manatee / Sarasota / Charlotte).
 *
 * The FDOR statewide cadastral layer (parcel-gis.js) is an ANNUAL vintage, so
 * brand-new plats in master-planned communities (the exact addresses Waves is
 * quoting in Lakewood Ranch / Parrish / North River Ranch) aren't in it yet.
 * Each county publishes its OWN continuously-maintained parcel polygon layer —
 * the live CAMA roll — which carries new lots months sooner AND exposes the
 * county land-use DESCRIPTION ("Half Duplex/Paired Villa", "Condominia") that
 * the conservative numeric DOR-code map can't distinguish from a detached home.
 *
 * Resolved by GEOCODED POINT (point-in-polygon), not an address string — that
 * sidesteps the PAO address-search/city-match miss that returns 0/100 on a
 * parcel that genuinely exists.
 *
 * Returns the SAME normalized parcel shape as parcel-gis.lookupParcelByPoint
 * (parcelId / paoParcelId / situs* / polygon / polygonAreaSqft / lotSqft /
 * dorUseCode / residentialUnits) plus the richer county-roll fields
 * (livingAreaSqft / yearBuilt / stories / landUseDescription / subdivision /
 * poolFlag / rollYear), so the existing orchestration consumes it unchanged.
 *
 * Live-probe findings (2026-06-21, curl-verified against each layer):
 *   - Manatee : gis.manateepao.gov .../Website/WebLayers/MapServer/0 (polygon),
 *               CUR_ROLL_YEAR=2026 live; type text in CUR_MAN_LUC_DESC.
 *   - Sarasota: ags3.scgov.net .../Hosted/Parcels/FeatureServer/0 (polygon);
 *               numeric DOR code in stcd, no stories field.
 *   - Charlotte: agis3.charlottecountyfl.gov .../CCGISLayers/MapServer/27
 *               (Ownership polygon); type text in description, usecode = DOR;
 *               no living/year/stories (those stay with the PAO scraper).
 *
 * Tunables:
 *   COUNTY_PARCEL_GIS_DISABLED=1  — kill switch (returns null)
 *   COUNTY_PARCEL_GIS_TIMEOUT_MS  — per-request timeout (default 3500)
 *
 * Fail-open: any error/timeout returns null and the caller degrades to the
 * FDOR statewide layer and then the address search. Logs are prefixed
 * `[county-parcel-gis]` and never include the parcel id or a precise address
 * (PII rule) — coordinates are coarsened to ~1km.
 */

const logger = require('../logger');

const DEFAULT_TIMEOUT_MS = 3500;
const METERS_PER_DEGREE_LAT = 111320;
const SQ_METERS_TO_SQFT = 10.76391041671;

// ── Geometry (self-contained; mirrors parcel-gis.js so a jest.mock of that
// module can't break this one). WGS84 [lng, lat] rings. ──

// Signed shoelace area of one ring in sqft via an equirectangular projection at
// the ring's mean latitude — well under 1% error at parcel scale.
function ringSignedAreaSqft(ring) {
  if (!Array.isArray(ring) || ring.length < 4) return 0;
  const pts = ring.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (pts.length < 4) return 0;
  const meanLat = pts.reduce((sum, p) => sum + p[1], 0) / pts.length;
  const mPerLng = METERS_PER_DEGREE_LAT * Math.cos((meanLat * Math.PI) / 180);
  let doubleArea = 0;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    doubleArea += (x1 * mPerLng) * (y2 * METERS_PER_DEGREE_LAT) - (x2 * mPerLng) * (y1 * METERS_PER_DEGREE_LAT);
  }
  return (doubleArea / 2) * SQ_METERS_TO_SQFT;
}

// Total polygon area: holes wind opposite the outer ring, so signed-area summing
// subtracts them naturally.
function polygonAreaSqft(rings) {
  if (!Array.isArray(rings) || !rings.length) return null;
  const total = Math.abs(rings.reduce((sum, ring) => sum + ringSignedAreaSqft(ring), 0));
  return Number.isFinite(total) && total > 0 ? Math.round(total) : null;
}

function pointInRing(ring, x, y) {
  if (!Array.isArray(ring) || ring.length < 4) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i] || [];
    const [xj, yj] = ring[j] || [];
    if (!Number.isFinite(xi) || !Number.isFinite(yi) || !Number.isFinite(xj) || !Number.isFinite(yj)) continue;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function polygonContainsPoint(rings, lng, lat) {
  return Array.isArray(rings) && rings.some((ring) => pointInRing(ring, lng, lat));
}

// Smallest polygon actually containing the point = the unit's own parcel, not a
// master/common-area parcel. Identical-footprint candidates (stacked units) are
// indistinguishable by area — return null so the caller falls back rather than
// picking an arbitrary unit.
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
  if (pool.length >= 2 && Math.abs(pool[0].areaSqft - pool[1].areaSqft) < 1) return null;
  return pool[0]?.feature || null;
}

// ArcGIS servers can return attribute keys in a different case than the field
// definitions / requested outFields (hosted FeatureServers especially), and a
// silent case mismatch would zero out a whole county's parse and quietly fall
// back to FDOR. `parse` receives a case-INSENSITIVE getter g(name) so a casing
// quirk can never disable a county. Geometry-derived lotSqft is filled by the
// caller when the roll's own land figure is absent.
function ciAttr(attrs) {
  const map = {};
  for (const [k, v] of Object.entries(attrs || {})) map[k.toLowerCase()] = v;
  return (name) => map[String(name).toLowerCase()];
}

const COUNTY_LAYERS = {
  Manatee: {
    url: 'https://gis.manateepao.gov/arcgis/rest/services/Website/WebLayers/MapServer/0/query',
    outFields: [
      'PARID', 'SITUS_ADDRESS', 'SITUS_POSTAL_CITY', 'SITUS_POSTAL_ZIP',
      'LAND_SQFT_CAMA', 'BLDGS_SQFT_LIVING', 'BLDG_R1_STORIES', 'BLDG_R1_YRBUILT',
      'BLDGS_LIVINGUNITS', 'CUR_DOR_LUC_CODE', 'CUR_MAN_LUC_DESC',
      'PAR_SUBDIV_NAME', 'PAR_SWIMPOOL_FLAG', 'CUR_ROLL_YEAR',
    ],
    parse: (g) => ({
      parcelId: cleanStr(g('PARID')),
      situsAddress: cleanStr(g('SITUS_ADDRESS')),
      situsCity: cleanStr(g('SITUS_POSTAL_CITY')),
      situsZip: zip5(g('SITUS_POSTAL_ZIP')),
      lotSqft: positiveOrNull(g('LAND_SQFT_CAMA')),
      livingAreaSqft: positiveOrNull(g('BLDGS_SQFT_LIVING')),
      stories: positiveOrNull(g('BLDG_R1_STORIES')),
      yearBuilt: positiveOrNull(g('BLDG_R1_YRBUILT')),
      residentialUnits: positiveOrNull(g('BLDGS_LIVINGUNITS')),
      dorUseCode: cleanStr(g('CUR_DOR_LUC_CODE')),
      landUseDescription: cleanStr(g('CUR_MAN_LUC_DESC')),
      subdivision: cleanStr(g('PAR_SUBDIV_NAME')),
      poolFlag: yesNoFlag(g('PAR_SWIMPOOL_FLAG')),
      rollYear: positiveOrNull(g('CUR_ROLL_YEAR')),
    }),
  },
  Sarasota: {
    url: 'https://ags3.scgov.net/server/rest/services/Hosted/Parcels/FeatureServer/0/query',
    outFields: [
      'account', 'id', 'fulladdress', 'loccity', 'loczip', 'subd',
      'pool', 'grnd_area', 'living', 'livunits', 'yrbl', 'lsqft', 'stcd',
    ],
    parse: (g) => ({
      // PAO detail (/propertysearch/parcel/details) keys on the digit id.
      parcelId: cleanStr(g('id')) || cleanStr(g('account')),
      situsAddress: cleanStr(g('fulladdress')),
      situsCity: cleanStr(g('loccity')),
      situsZip: zip5(g('loczip')),
      lotSqft: positiveOrNull(g('lsqft')),
      livingAreaSqft: positiveOrNull(g('living')),
      stories: null, // not in the Sarasota layer
      yearBuilt: positiveOrNull(g('yrbl')),
      residentialUnits: positiveOrNull(g('livunits')),
      dorUseCode: cleanStr(g('stcd')),
      landUseDescription: null, // Sarasota carries the numeric code only
      subdivision: cleanStr(g('subd')),
      poolFlag: yesNoFlag(g('pool')),
      rollYear: null,
    }),
  },
  Charlotte: {
    url: 'https://agis3.charlottecountyfl.gov/arcgis/rest/services/Essentials/CCGISLayers/MapServer/27/query',
    outFields: [
      'ACCOUNT', 'FullPropertyAddress', 'propertyaddress', 'city', 'zipcode',
      'usecode', 'description', 'landuse', 'subneighborhood', 'CONDOID',
    ],
    parse: (g) => ({
      parcelId: cleanStr(g('ACCOUNT')),
      situsAddress: cleanStr(g('FullPropertyAddress')) || cleanStr(g('propertyaddress')),
      situsCity: cleanStr(g('city')),
      situsZip: zip5(g('zipcode')),
      lotSqft: null, // no land figure in the ownership layer — use polygon area
      livingAreaSqft: null,
      stories: null,
      yearBuilt: null,
      residentialUnits: null,
      dorUseCode: cleanStr(g('usecode')),
      landUseDescription: cleanStr(g('description')) || cleanStr(g('landuse')),
      subdivision: cleanStr(g('subneighborhood')),
      poolFlag: null,
      rollYear: null,
    }),
  },
};

function cleanStr(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function positiveOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function zip5(value) {
  const digits = String(value ?? '').replace(/\.0+$/, '').trim().slice(0, 5);
  return /^\d{5}$/.test(digits) ? digits : null;
}

function yesNoFlag(value) {
  const s = String(value ?? '').trim().toUpperCase();
  if (['Y', 'YES', 'TRUE', '1'].includes(s)) return true;
  if (['N', 'NO', 'FALSE', '0'].includes(s)) return false;
  return null;
}

function coarseCoord(value) {
  return Number.isFinite(value) ? Number(value.toFixed(2)) : null;
}

// Normalize a Google-geocoder county ("Manatee County") to our config key.
function normalizeCountyName(county) {
  const s = String(county || '').trim().replace(/\s+county$/i, '').toLowerCase();
  if (s === 'manatee') return 'Manatee';
  if (s === 'sarasota') return 'Sarasota';
  if (s === 'charlotte') return 'Charlotte';
  return null;
}

// County land-use DESCRIPTION → estimator property type. Each county words
// attached/condo product differently (Manatee never says "townhouse": paired
// homes are "Half Duplex/Paired Villa", stacked are "Condominia"). Returns a
// string the pricing normalizer tokenizes (townhome_end / townhome_interior /
// condo_*), or null for non-residential / vacant / ambiguous so other sources
// and the commercial path decide. Numeric-only codes return null here — the
// DOR-code map handles those.
function countyUseDescToPropertyType(description) {
  const s = String(description || '').toLowerCase();
  if (!s) return null;
  if (/vacant|common area|municipal|right of way|agricultur|utility|institution/.test(s)) return null;
  if (/condominia|condominium|\bcondo\b/.test(s)) return 'Condo';
  if (/interior\s+(town|row)/.test(s)) return 'Interior Townhome';
  if (/town\s*h(ome|ouse)|row\s*h(ome|ouse)/.test(s)) return 'Townhome';
  if (/paired\s+villa|half\s+duplex|attached\s+villa|villa/.test(s)) return 'Townhome';
  if (/duplex|two\s+family/.test(s)) return 'Duplex';
  if (/triplex|quadr|multi\s*family|multifamily|apartment/.test(s)) return 'Multifamily';
  if (/single\s+family|sfr\b|single-family/.test(s)) return 'Single Family';
  return null;
}

function timeoutMsFor(options) {
  if (Number.isFinite(options?.timeoutMs) && options.timeoutMs > 0) return Math.floor(options.timeoutMs);
  const n = Number(process.env.COUNTY_PARCEL_GIS_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_TIMEOUT_MS;
}

function isDisabled() {
  return process.env.COUNTY_PARCEL_GIS_DISABLED === '1'
    || process.env.COUNTY_PARCEL_GIS_DISABLED === 'true';
}

// A digit-only parcel id is what every county's PAO detail fetch keys on; a
// non-numeric id (rare condo/legacy formats) fails closed to the address search
// rather than building a wrong by-parcel URL.
function paoParcelIdFrom(parcelId) {
  const raw = String(parcelId || '').trim();
  return /^\d+$/.test(raw) ? raw : null;
}

async function queryCountyLayer(county, lat, lng, timeoutMs) {
  const layer = COUNTY_LAYERS[county];
  if (!layer) return null;

  const params = new URLSearchParams({
    f: 'json',
    geometry: JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }),
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: layer.outFields.join(','),
    returnGeometry: 'true',
    outSR: '4326',
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const resp = await fetch(`${layer.url}?${params.toString()}`, { signal: controller.signal });
    if (!resp.ok) throw new Error(`${county} parcel GIS ${resp.status}`);
    const data = await resp.json();
    if (data?.error) throw new Error(`${county} parcel GIS error: ${data.error.message || data.error.code}`);

    const features = Array.isArray(data?.features) ? data.features : [];
    if (!features.length) return null;

    // Smallest containing polygon = the unit's own parcel, not a master/common
    // parcel; identical stacked footprints return null (defer to address search).
    const feature = pickParcelFeature(features, lng, lat);
    if (!feature) {
      logger.info('[county-parcel-gis] ambiguous stacked parcels at point — deferring', {
        county, count: features.length, elapsedMs: Date.now() - t0,
      });
      return null;
    }

    const polygon = Array.isArray(feature?.geometry?.rings) && feature.geometry.rings.length
      ? feature.geometry.rings
      : null;
    const parsed = layer.parse(ciAttr(feature.attributes || {}));
    if (!parsed.parcelId) return null;

    const polyArea = polygonAreaSqft(polygon);
    const parcel = {
      ...parsed,
      county,
      paoParcelId: paoParcelIdFrom(parsed.parcelId),
      // Roll land figure when present (more accurate than the drawn polygon),
      // else the geometry area so new lots without a land record still price.
      lotSqft: parsed.lotSqft || polyArea,
      polygon,
      polygonAreaSqft: polyArea,
      assessmentYear: parsed.rollYear || null, // attachParcelMeta reads `vintage`
      sourceUrl: layer.url.replace(/\/query\/?$/, ''),
      gisProvider: `${county.toLowerCase()}_gis`,
    };

    logger.info('[county-parcel-gis] matched parcel', {
      county,
      lotSqft: parcel.lotSqft,
      hasType: Boolean(parcel.landUseDescription || parcel.dorUseCode),
      elapsedMs: Date.now() - t0,
    });
    return parcel;
  } catch (err) {
    const aborted = err?.name === 'AbortError' || err?.code === 'ABORT_ERR';
    logger.warn('[county-parcel-gis] lookup failed', {
      county,
      latApprox: coarseCoord(lat),
      lngApprox: coarseCoord(lng),
      aborted,
      error: err?.message || String(err),
      elapsedMs: Date.now() - t0,
    });
    return null; // fail-open: caller degrades to FDOR statewide + address search
  } finally {
    clearTimeout(timer);
  }
}

// Don't start a county query with less than this much budget left — too little
// time to land a result, and the caller needs the remainder for the FDOR
// statewide layer and the PAO address search.
const MIN_COUNTY_GIS_QUERY_MS = 500;

// Resolve a geocoded point to a county parcel. With a county hint (from the
// geocoder) only that county's layer is queried; without one, the three
// serviced counties are tried in order until one matches — but the WHOLE loop
// shares a single deadline (timeoutMs total, not per county) so a missing
// county hint can't spend 3x the GIS budget and starve the FDOR/PAO fallbacks.
async function lookupCountyParcelByPoint(lat, lng, options = {}) {
  if (isDisabled()) {
    logger.info('[county-parcel-gis] skipped — COUNTY_PARCEL_GIS_DISABLED');
    return null;
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const hinted = normalizeCountyName(options.county);
  const order = hinted ? [hinted] : ['Manatee', 'Sarasota', 'Charlotte'];
  const deadline = Date.now() + timeoutMsFor(options);

  for (const county of order) {
    const remainingMs = deadline - Date.now();
    if (remainingMs < MIN_COUNTY_GIS_QUERY_MS) {
      logger.info('[county-parcel-gis] budget exhausted before all counties tried — degrading', {
        remainingMs,
      });
      break;
    }
    const parcel = await queryCountyLayer(county, lat, lng, remainingMs).catch(() => null);
    if (parcel) return parcel;
  }
  return null;
}

module.exports = {
  lookupCountyParcelByPoint,
  countyUseDescToPropertyType,
  normalizeCountyName,
  _private: {
    COUNTY_LAYERS,
    queryCountyLayer,
    paoParcelIdFrom,
    zip5,
    yesNoFlag,
  },
};
