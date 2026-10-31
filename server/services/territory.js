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
 */
const defaultDb = require('../models/db');
const { areaLabel } = require('../config/territory-areas');

/** A 5-digit ZIP from a ZIP field ('34219', ' 34219-1234 '), or null. */
function normalizeZip(value) {
  if (value === null || value === undefined) return null;
  const match = String(value).match(/^\s*(\d{5})(?:-\d{4})?\s*$/);
  return match ? match[1] : null;
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

module.exports = {
  normalizeZip,
  territoryForZip,
};
