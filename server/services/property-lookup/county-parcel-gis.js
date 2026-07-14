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

// ── Stacked-parcel condo/HOA association aggregation ─────────────────────
// A condo association returns DOZENS of unit "parcels" stacked on one shared
// polygon (each unit owns no land — live probe: 1555 Tarpon Center Dr, Venice
// = 118 unit parcels + common elements, 151 stacked at one point). The picker
// can't choose a unit, so these lookups used to defer and the panel came back
// empty even though the roll knows everything. When the stack is clearly an
// association, aggregate it instead: total units, summed living sqft, the
// shared polygon (or roll figure) for land, a building count from distinct
// unit street numbers, and an explicit multifamily land-use so the profile
// routes COMMERCIAL. Small stacks (a paired villa's 2 identical rows) stay on
// the old defer path — aggregating a duplex would misprice it.
const AGGREGATE_MIN_UNITS = 5;

function modalValue(values) {
  const counts = new Map();
  let best = null;
  let bestCount = 0;
  for (const value of values) {
    if (value == null || value === '') continue;
    const count = (counts.get(value) || 0) + 1;
    counts.set(value, count);
    if (count > bestCount) { best = value; bestCount = count; }
  }
  return best;
}

function buildStackedAggregate(county, layer, features, lng, lat) {
  const rows = [];
  for (const feature of features) {
    const rings = feature?.geometry?.rings || null;
    if (!rings || !polygonContainsPoint(rings, lng, lat)) continue;
    rows.push({ parsed: layer.parse(ciAttr(feature.attributes || {})), rings });
  }
  if (rows.length < AGGREGATE_MIN_UNITS) return null;

  const unitRows = rows.filter((row) => (row.parsed.residentialUnits || 0) > 0
    || (row.parsed.livingAreaSqft || 0) > 0);
  // A unit row with living area but no explicit livunits still IS a unit —
  // counting it as zero would reject a valid association whose layer omits
  // the unit-count column on most rows (codex P2 #2721).
  const units = unitRows.reduce(
    (sum, row) => sum + Math.max(row.parsed.residentialUnits || 0, (row.parsed.livingAreaSqft || 0) > 0 ? 1 : 0),
    0,
  );
  if (units < AGGREGATE_MIN_UNITS) return null;

  const livingAreaSqft = unitRows.reduce((sum, row) => sum + (row.parsed.livingAreaSqft || 0), 0);
  const groundAreaSqft = unitRows.reduce((sum, row) => sum + (row.parsed.groundAreaSqft || 0), 0);

  // Distinct leading street numbers among the unit situs addresses — the
  // roll's only building signal ("1535 / 1555 / 1575 Tarpon Center Dr" = 3
  // buildings). Single shared number → 1; satellite vision refines later.
  const streetNumbers = new Set();
  for (const row of unitRows) {
    const m = String(row.parsed.situsAddress || '').match(/^(\d+)\s/);
    if (m) streetNumbers.add(m[1]);
  }
  const buildingCount = Math.max(1, streetNumbers.size);

  // Land: a stacked master/common row carrying a roll land figure wins; else
  // the shared polygon's own area (units all carry lsqft 0 by design). Only a
  // GENUINE common row may key PAO detail fetches — advertising an arbitrary
  // unit's parcel id would let a by-parcel unit record collapse the aggregate
  // back to single-unit dimensions on merge ties (codex P2 #2721).
  const commonRow = rows.find((row) => (row.parsed.lotSqft || 0) > 0 && !(row.parsed.residentialUnits > 0))
    || rows.find((row) => !(row.parsed.residentialUnits > 0) && !(row.parsed.livingAreaSqft > 0))
    || null;
  const masterRow = commonRow || rows[0];
  const polyArea = polygonAreaSqft(masterRow.rings);
  const lotSqft = masterRow.parsed.lotSqft || polyArea;

  const yearBuilt = modalValue(unitRows.map((row) => row.parsed.yearBuilt));
  const stories = unitRows.reduce((max, row) => Math.max(max, row.parsed.stories || 0), 0) || null;
  // Situs without the trailing unit designator — the modal "NUMBER STREET".
  const situsAddress = modalValue(unitRows.map((row) => {
    const m = String(row.parsed.situsAddress || '').match(/^(\d+\s+[^,]*?)(?:\s+\d+)?(?:,|$)/);
    return m ? m[1] : row.parsed.situsAddress;
  })) || masterRow.parsed.situsAddress || null;

  return {
    parcelId: masterRow.parsed.parcelId || unitRows[0]?.parsed.parcelId || null,
    masterIsCommon: Boolean(commonRow),
    // Every building number in the association — the situs-mismatch guard
    // must accept a lookup for ANY of them, not just the modal one
    // (codex P2 #2721: entering 1575 in a 1535/1555/1575 association).
    situsHouseNumbers: [...streetNumbers].sort(),
    situsAddress,
    situsCity: modalValue(rows.map((row) => row.parsed.situsCity)),
    situsZip: modalValue(rows.map((row) => row.parsed.situsZip)),
    lotSqft,
    livingAreaSqft: livingAreaSqft > 0 ? livingAreaSqft : null,
    groundAreaSqft: groundAreaSqft > 0 ? groundAreaSqft : null,
    stories,
    yearBuilt,
    residentialUnits: units,
    dorUseCode: modalValue(unitRows.map((row) => row.parsed.dorUseCode)),
    // Human-readable AND machine-routing: "multifamily" is the token
    // detectCategory/commercialSignalText key on. buildCadastralRecord
    // branches on `aggregated` for the propertyType, so the word
    // "condominium" here can never trip the residential Condo mapping.
    landUseDescription: `Multifamily condo/HOA association — ${units} units, ${buildingCount} building${buildingCount === 1 ? '' : 's'} (county aggregate)`,
    subdivision: modalValue(rows.map((row) => row.parsed.subdivision)),
    poolFlag: rows.some((row) => row.parsed.poolFlag === true) ? true : null,
    rollYear: modalValue(rows.map((row) => row.parsed.rollYear)),
    imperviousAreaSf: masterRow.parsed.imperviousAreaSf ?? null,
    aggregated: true,
    aggregateUnitParcels: unitRows.length,
    buildingCount,
    _masterRings: masterRow.rings,
    _polyArea: polyArea,
  };
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
      'BLDG_C1_SQFTLIVNG', 'BLDG_C1_STORIES', 'BLDG_C1_YRBUILT',
      'BLDGS_LIVINGUNITS', 'CUR_DOR_LUC_CODE', 'CUR_MAN_LUC_DESC',
      'PAR_SUBDIV_NAME', 'PAR_SWIMPOOL_FLAG', 'CUR_ROLL_YEAR', 'FEATS_SQFT_IMPERV',
    ],
    parse: (g) => ({
      parcelId: cleanStr(g('PARID')),
      situsAddress: cleanStr(g('SITUS_ADDRESS')),
      situsCity: cleanStr(g('SITUS_POSTAL_CITY')),
      situsZip: zip5(g('SITUS_POSTAL_ZIP')),
      lotSqft: positiveOrNull(g('LAND_SQFT_CAMA')),
      livingAreaSqft: positiveOrNull(g('BLDGS_SQFT_LIVING')) ?? positiveOrNull(g('BLDG_C1_SQFTLIVNG')),
      // Manatee splits building facts into residential (BLDG_R1_*) and
      // commercial (BLDG_C1_*) blocks; a pure-commercial parcel (warehouse,
      // office) carries only the C1 block, so R1-only reads left stories /
      // year built empty on every commercial lookup.
      stories: positiveOrNull(g('BLDG_R1_STORIES')) ?? positiveOrNull(g('BLDG_C1_STORIES')),
      yearBuilt: positiveOrNull(g('BLDG_R1_YRBUILT')) ?? positiveOrNull(g('BLDG_C1_YRBUILT')),
      residentialUnits: positiveOrNull(g('BLDGS_LIVINGUNITS')),
      dorUseCode: cleanStr(g('CUR_DOR_LUC_CODE')),
      landUseDescription: cleanStr(g('CUR_MAN_LUC_DESC')),
      subdivision: cleanStr(g('PAR_SUBDIV_NAME')),
      poolFlag: yesNoFlag(g('PAR_SWIMPOOL_FLAG')),
      rollYear: positiveOrNull(g('CUR_ROLL_YEAR')),
      // Assessed impervious sqft (driveways, pool decks) — feeds the shadow
      // footprint-turf computation when the GIS layer is the only county hit
      // (new construction). 0 on the roll means not-yet-assessed, not "no
      // hardscape" (live probe: a just-sold 2024 build carried 0) → null.
      imperviousAreaSf: positiveOrNull(g('FEATS_SQFT_IMPERV')),
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
      // Per-unit built ground area (includes lanai/garage) — summed by the
      // stacked-parcel aggregate as a footprint signal for associations.
      groundAreaSqft: positiveOrNull(g('grnd_area')),
      stories: null, // not in the Sarasota layer
      yearBuilt: positiveOrNull(g('yrbl')),
      residentialUnits: positiveOrNull(g('livunits')),
      dorUseCode: cleanStr(g('stcd')),
      landUseDescription: null, // Sarasota carries the numeric code only
      subdivision: cleanStr(g('subd')),
      poolFlag: yesNoFlag(g('pool')),
      rollYear: null,
      imperviousAreaSf: null, // not in the Sarasota layer
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
      imperviousAreaSf: null, // not in the Charlotte ownership layer
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
// FL DOR property-use codes: the major land-use category is the leading two
// digits. FDOR statewide returns a 3-digit form (001) and Manatee a 2-digit
// form (01) that dorUcPropertyType already maps via padStart; Sarasota/Charlotte
// return a 4-digit COUNTY code (0100 SFR, 0405 condo, 0800 multifamily) whose
// trailing sub-class digits would otherwise miss the map — and Sarasota has no
// land-use description to fall back on, so a condo/multifamily would price as a
// detached home. Collapse ONLY the 4-digit form to its 2-digit category so it
// lands on the existing map; shorter codes pass through unchanged (preserving
// the FDOR 3-digit contract, e.g. 011 -> null). (codex P2)
function dorMajorCategory(code) {
  const digits = String(code ?? '').replace(/\D/g, '');
  return digits.length === 4 ? digits.slice(0, 2) : String(code ?? '');
}

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
    // parcel. Identical stacked footprints: an association-sized stack
    // aggregates (units/sqft/land summed); a small stack (paired villa)
    // still returns null and defers to the address search.
    const feature = pickParcelFeature(features, lng, lat);
    if (!feature) {
      const aggregate = buildStackedAggregate(county, layer, features, lng, lat);
      if (aggregate && aggregate.parcelId) {
        const parcel = {
          ...aggregate,
          county,
          paoParcelId: aggregate.masterIsCommon ? paoParcelIdFrom(aggregate.parcelId) : null,
          polygon: aggregate._masterRings,
          polygonAreaSqft: aggregate._polyArea,
          assessmentYear: aggregate.rollYear || null,
          sourceUrl: layer.url.replace(/\/query\/?$/, ''),
          gisProvider: `${county.toLowerCase()}_gis`,
        };
        delete parcel._masterRings;
        delete parcel._polyArea;
        logger.info('[county-parcel-gis] aggregated stacked association', {
          county,
          stacked: features.length,
          units: parcel.residentialUnits,
          buildings: parcel.buildingCount,
          lotSqft: parcel.lotSqft,
          elapsedMs: Date.now() - t0,
        });
        return parcel;
      }
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

// Situs-address field(s) per county for street-level roll queries (the
// house-number audit in ai-property-lookup). Same layers as the
// point-in-polygon path above, so availability and casing stay in lockstep.
// Charlotte populates either FullPropertyAddress or the lowercase fallback —
// mirror the parser's dual-field read or fallback-only parcels vanish.
const SITUS_QUERY_FIELDS = {
  Manatee: ['SITUS_ADDRESS'],
  Sarasota: ['fulladdress'],
  Charlotte: ['FullPropertyAddress', 'propertyaddress'],
};

// Situs ZIP per county, returned alongside each situs string so the audit can
// scope its verdict to the typed ZIP — SWFL grid streets repeat across cities
// ("51ST AVE E" exists in both Bradenton 34203 and Palmetto 34221), so a
// county-wide house-number hit can validate the wrong city's address.
const SITUS_ZIP_FIELDS = {
  Manatee: 'SITUS_POSTAL_ZIP',
  Sarasota: 'loczip',
  Charlotte: 'zipcode',
};

// All situs strings on the county roll whose address contains the given
// street text ("TOBERMORY" → every parcel on Tobermory Way, including
// multi-situs paired-villa rows). Returns { situs, zips, truncated } — zips
// is index-parallel to situs (roll ZIP or null) for ZIP scoping; truncated
// mirrors the ArcGIS exceededTransferLimit flag so the caller knows a "number
// missing" verdict could be an artifact of the page cap on a long street.
// Fail-open null on error/timeout — the audit is a diagnostic hint, never
// worth sinking a lookup for. The street text is stripped to [A-Z0-9 ] before
// interpolation, so no quoting is reachable.
async function queryStreetSitusAddresses(county, streetText, options = {}) {
  if (isDisabled()) return null;
  const layer = COUNTY_LAYERS[county];
  const fields = SITUS_QUERY_FIELDS[county];
  const text = String(streetText || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!layer || !fields || text.length < 3) return null;

  const zipField = SITUS_ZIP_FIELDS[county];
  const params = new URLSearchParams({
    f: 'json',
    where: fields.map((f) => `UPPER(${f}) LIKE '%${text}%'`).join(' OR '),
    outFields: [...fields, ...(zipField ? [zipField] : [])].join(','),
    returnGeometry: 'false',
    resultRecordCount: '2000',
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMsFor(options));
  const t0 = Date.now();
  try {
    const resp = await fetch(`${layer.url}?${params.toString()}`, { signal: controller.signal });
    if (!resp.ok) throw new Error(`${county} street GIS ${resp.status}`);
    const data = await resp.json();
    if (data?.error) throw new Error(`${county} street GIS error: ${data.error.message || data.error.code}`);
    const features = Array.isArray(data?.features) ? data.features : [];
    const situs = [];
    const zips = [];
    for (const f of features) {
      const g = ciAttr(f.attributes || {});
      const line = fields.map((field) => cleanStr(g(field))).filter(Boolean).join(';');
      if (!line) continue;
      situs.push(line);
      // Parallel array: zips[i] is the roll ZIP for situs[i] (null when the
      // layer/row has none — the audit treats unknown as in-scope, fail-open).
      zips.push(zipField ? zip5(g(zipField)) : null);
    }
    const truncated = !!data?.exceededTransferLimit;
    logger.info('[county-parcel-gis] street situs query', {
      county, matches: situs.length, truncated, elapsedMs: Date.now() - t0,
    });
    return { situs, zips, truncated };
  } catch (err) {
    const aborted = err?.name === 'AbortError' || err?.code === 'ABORT_ERR';
    // County + error only — no street/address values in logs (PII rule).
    logger.warn('[county-parcel-gis] street situs query failed', {
      county, aborted, error: err?.message || String(err), elapsedMs: Date.now() - t0,
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  lookupCountyParcelByPoint,
  queryStreetSitusAddresses,
  countyUseDescToPropertyType,
  dorMajorCategory,
  normalizeCountyName,
  _private: {
    COUNTY_LAYERS,
    queryCountyLayer,
    paoParcelIdFrom,
    zip5,
    yesNoFlag,
  },
};
