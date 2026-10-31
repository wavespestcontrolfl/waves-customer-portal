/**
 * Territories by ZIP (owner 2026-10-30): which area a ZIP is in and whose
 * territory it is. Reads only.
 *
 * territory_zips holds one row per service ZIP (migration
 * 20261031000000_territory_zips.js): its area and the technician who owns the
 * territory. A ZIP that is not in the table, or has no technician, adds no
 * routing rule; callers then keep today's choice.
 *
 * A ZIP is 5 digits here: normalizeZip accepts the ZIP+4 and padded values the
 * address normalizer (utils/address-normalizer.js) stores on leads and customers.
 * zipForPoint finds the ZIP from a map position (the Census 2020 ZIP areas in
 * data/territory-zip-shapes.json): /book has coordinates before it has a ZIP.
 */
const defaultDb = require('../models/db');
const { areaLabel } = require('../config/territory-areas');

/** A 5-digit ZIP from a ZIP field ('34219', ' 34219-1234 '), or null. */
function normalizeZip(value) {
  if (value === null || value === undefined) return null;
  const match = String(value).match(/^\s*(\d{5})(?:-\d{4})?\s*$/);
  return match ? match[1] : null;
}

// The lines a territory routes: general pest, mosquito, rodent, termite / WDO. Lawn and
// tree & shrub (line 'lawn') stay with the service-line map (owner 2026-10-30).
const TERRITORY_LINES = Object.freeze(['general', 'mosquito', 'rodent', 'termite']);

let shapes = null;
// [{ zip, box: [minLng, minLat, maxLng, maxLat], polygons }], read once on first use.
function zipShapes() {
  if (shapes) return shapes;
  const { zips } = require('../data/territory-zip-shapes.json');
  shapes = Object.entries(zips).map(([zip, polygons]) => {
    const outer = polygons.flatMap((polygon) => polygon[0]);
    const lngs = outer.map((point) => point[0]);
    const lats = outer.map((point) => point[1]);
    return { zip, box: [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)], polygons };
  });
  return shapes;
}

// Ray casting: whether [x, y] lies inside one ring of [lng, lat] points.
function insideRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const insidePolygon = (x, y, [outer, ...holes]) => insideRing(x, y, outer) && !holes.some((hole) => insideRing(x, y, hole));

/** The service ZIP whose Census ZIP area holds the point, or null (no point, or outside all 52). */
function zipForPoint(lat, lng) {
  if (lat === null || lat === undefined || lng === null || lng === undefined || lat === '' || lng === '') return null;
  const y = Number(lat);
  const x = Number(lng);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const hit = zipShapes().find(({ box, polygons }) => x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3]
    && polygons.some((polygon) => insidePolygon(x, y, polygon)));
  return hit ? hit.zip : null;
}

const toTerritory = (row) => ({
  zip: row.zip,
  area: row.area,
  areaLabel: areaLabel(row.area),
  technicianId: row.technician_id || null,
});

/**
 * The territory row for a ZIP: { zip, area, areaLabel, technicianId }, or null
 * when the ZIP is blank, malformed or not a service ZIP. technicianId is null
 * while the ZIP has no territory technician. Throws only on an unreadable database.
 */
async function territoryForZip(conn, zip) {
  const value = normalizeZip(zip);
  if (!value) return null;
  const db = conn || defaultDb;
  const row = await db('territory_zips').where({ zip: value }).first('zip', 'area', 'technician_id');
  return row ? toTerritory(row) : null;
}

/**
 * The ZIP of a place: { zip, lat, lng, customerId }. The place's own ZIP first, else its
 * map position, else the customer row's ZIP, else that row's map position. null when
 * none resolves. Throws only on an unreadable database.
 */
async function placeZip(conn, { zip = null, lat = null, lng = null, customerId = null } = {}) {
  const own = normalizeZip(zip) || zipForPoint(lat, lng);
  if (own || !customerId) return own;
  const db = conn || defaultDb;
  const row = await db('customers').where({ id: customerId }).first('zip', 'latitude', 'longitude');
  return row ? (normalizeZip(row.zip) || zipForPoint(row.latitude, row.longitude)) : null;
}

/** The technician whose territory holds the place (see placeZip), or null. Throws only on an unreadable database. */
async function territoryTechnicianFor(conn, place = {}) {
  const zip = await placeZip(conn, place);
  const territory = zip ? await territoryForZip(conn, zip) : null;
  return territory ? territory.technicianId : null;
}

module.exports = {
  TERRITORY_LINES,
  normalizeZip,
  zipForPoint,
  territoryForZip,
  territoryTechnicianFor,
};
