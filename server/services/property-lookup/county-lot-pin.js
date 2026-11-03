/**
 * County lot pin: a free map pin for an address Google only half-matches.
 *
 * Google answers a brand-new plat (Parrish, Lakewood Ranch, Duette) or a
 * misheard street ("Sample Lp" for SAMPLE CREEK LOOP) with a partial or coarse
 * result, which the geocoder rejects on purpose. The county roll carries the
 * lot, so the roll's own situs line finds it: house number plus one street
 * word in a single LIKE (county-parcel-gis lookupCountyParcelsByAddress),
 * kept only where the situs ZIP equals the address ZIP and the situs street
 * name holds that word as a whole word (situsNamesAddress). The polygon center
 * is the home. Manatee and Sarasota only: they alone publish a situs ZIP,
 * and without it a SWFL grid street that repeats across cities could pin the
 * wrong city's house.
 *
 * Behind GATE_GEOCODE_COUNTY_FALLBACK at every caller. Throws on a county
 * outage so a caller never reads an outage as "no lot". No address text in
 * logs (PII rule).
 */
const { lookupCountyParcelsByAddress, normalizeCountyName } = require('./county-parcel-gis');
const { resolveAddressCounty } = require('../../config/address-county');
const { isInServiceAreaBox } = require('../service-area');

const PIN_COUNTIES = new Set(['Manatee', 'Sarasota']);
// Lots whose centers lie this close are one building (a paired villa).
const SAME_BUILDING_METERS = 60;
const METERS_PER_DEGREE_LAT = 111320;

const DIRECTIONALS = new Set(['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW', 'NORTH', 'SOUTH', 'EAST', 'WEST']);
const STREET_TYPES = new Set([
  'ST', 'STREET', 'AVE', 'AVENUE', 'RD', 'ROAD', 'DR', 'DRIVE', 'LN', 'LANE', 'CT', 'COURT', 'PL', 'PLACE',
  'TER', 'TERR', 'TERRACE', 'TRL', 'TRAIL', 'WAY', 'BLVD', 'BOULEVARD', 'CIR', 'CIRCLE', 'LOOP', 'PKWY',
  'PARKWAY', 'HWY', 'HIGHWAY', 'RUN', 'PATH', 'PASS', 'XING', 'CROSSING',
]);

/**
 * { houseNumber, streetWord } for the roll's LIKE query, or null.
 * House number = leading digits. Street word = first token of the street name
 * with 3 or more letters or digits after dropping initials ("T."), directionals
 * and street-type words.
 */
function parseCountyLotAddress(addressLine1) {
  const match = /^\s*(\d{1,7})\s+(.+)$/.exec(String(addressLine1 || ''));
  if (!match) return null;
  for (const token of match[2].split(/\s+/)) {
    const word = token.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (word.length < 3 || DIRECTIONALS.has(word) || STREET_TYPES.has(word)) continue;
    return { houseNumber: match[1], streetWord: word };
  }
  return null;
}

// The roll's situs line names the asked address: the same house number, and the street word as a whole
// word of the street name (the words before the first street-type word after it starts, so a leading
// "ST" is Saint). The county LIKE also matches a
// substring ("104 %PINE%" finds 104 ALPINE WAY), and a Sarasota situs runs on into the city
// ("0 GIBBS RD VENICE FL, 34285"), so neither may stand in for the street.
function situsNamesAddress(situs, { houseNumber, streetWord }) {
  const tokens = String(situs || '').split(',')[0].toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  if (tokens[0] !== String(houseNumber)) return false;
  const name = [];
  for (const token of tokens.slice(1)) {
    if (name.length && STREET_TYPES.has(token)) break;
    name.push(token);
  }
  return name.includes(streetWord);
}

// Pin counties only; a ZIP on a county line (34228, 34243, 34223) resolves to
// no county in address-county.js, so it fails closed here too.
function pinCountyForZip(zip) {
  const county = normalizeCountyName(resolveAddressCounty({ zip }));
  return PIN_COUNTIES.has(county) ? county : null;
}

// Area-weighted centroid of the largest ring (the outer boundary); the
// bounding-box center when the ring has no area. WGS84 [lng, lat] rings.
function ringCenter(rings) {
  let best = null;
  for (const ring of Array.isArray(rings) ? rings : []) {
    const pts = (Array.isArray(ring) ? ring : []).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (pts.length < 4) continue;
    // Relative to the first vertex: raw degrees would lose the area to rounding.
    const [x0, y0] = pts[0];
    let doubleArea = 0; let cx = 0; let cy = 0;
    for (let i = 0; i < pts.length - 1; i += 1) {
      const [xa, ya] = [pts[i][0] - x0, pts[i][1] - y0];
      const [xb, yb] = [pts[i + 1][0] - x0, pts[i + 1][1] - y0];
      const cross = xa * yb - xb * ya;
      doubleArea += cross;
      cx += (xa + xb) * cross;
      cy += (ya + yb) * cross;
    }
    cx = x0 * 3 * doubleArea + cx;
    cy = y0 * 3 * doubleArea + cy;
    if (!best || Math.abs(doubleArea) > Math.abs(best.doubleArea)) best = { pts, doubleArea, cx, cy };
  }
  if (!best) return null;
  if (best.doubleArea !== 0) return { lng: best.cx / (3 * best.doubleArea), lat: best.cy / (3 * best.doubleArea) };
  const lngs = best.pts.map((p) => p[0]);
  const lats = best.pts.map((p) => p[1]);
  return { lng: (Math.min(...lngs) + Math.max(...lngs)) / 2, lat: (Math.min(...lats) + Math.max(...lats)) / 2 };
}

function metersBetween(a, b) {
  const dLat = (a.lat - b.lat) * METERS_PER_DEGREE_LAT;
  const dLng = (a.lng - b.lng) * METERS_PER_DEGREE_LAT * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
}

// One building: every center within SAME_BUILDING_METERS of every other.
function oneBuilding(centers) {
  return centers.every((a) => centers.every((b) => metersBetween(a, b) <= SAME_BUILDING_METERS));
}

/**
 * { lat, lng, parcelId, county } for the one lot (or one building's lots) at
 * houseNumber + streetWord whose situs ZIP equals zip, else null. Throws when
 * the county cannot answer.
 */
async function lookupCountyLotPin({ county, houseNumber, streetWord, zip } = {}) {
  const name = normalizeCountyName(county);
  const zip5 = String(zip || '').trim().slice(0, 5);
  if (!PIN_COUNTIES.has(name) || !/^\d{5}$/.test(zip5)) return null;
  const lots = (await lookupCountyParcelsByAddress(name, { houseNumber, streetWord }, { withGeometry: true }))
    .filter((lot) => lot.situsZip === zip5 && situsNamesAddress(lot.situsAddress, { houseNumber, streetWord }));
  const centers = lots.map((lot) => ringCenter(lot.rings));
  if (!lots.length || centers.some((center) => !center) || !oneBuilding(centers)) return null;
  const lat = Number((centers.reduce((sum, c) => sum + c.lat, 0) / centers.length).toFixed(7));
  const lng = Number((centers.reduce((sum, c) => sum + c.lng, 0) / centers.length).toFixed(7));
  if (!isInServiceAreaBox(lat, lng, { zip: zip5 })) return null;
  return { lat, lng, parcelId: lots[0].parcelId, county: name };
}

/** The lot pin for an address row (address_line1 + zip), or null. Throws on an outage. */
async function countyLotPinForAddress(address) {
  const parsed = parseCountyLotAddress(address?.address_line1);
  const county = parsed && pinCountyForZip(String(address.zip || '').trim().slice(0, 5));
  return county ? lookupCountyLotPin({ county, ...parsed, zip: address.zip }) : null;
}

module.exports = { parseCountyLotAddress, situsNamesAddress, pinCountyForZip, lookupCountyLotPin, countyLotPinForAddress };
