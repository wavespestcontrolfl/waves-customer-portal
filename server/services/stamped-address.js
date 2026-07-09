/**
 * Stamped service-address divergence rule.
 *
 * Call bookings stamp the visit's own service_address_* onto
 * scheduled_services — and EVERY phone booking stamps, including ordinary
 * bookings at the customer's primary address. So "the visit is stamped"
 * alone must never suppress primary-coordinate/geocode fallbacks: for a
 * primary-address booking with no visit coords, the primary IS the correct
 * destination (codex round-4 P1). The wrong-house rule only applies when
 * the stamp DIVERGES from the primary address on file.
 *
 * "Diverges" compares CANONICAL forms, not raw strings — "123 Main St."
 * and "123 Main Street" are the same property, and "34219-1234" is ZIP
 * "34219" (codex round-5 P2). The JS form reuses the exact street/ZIP
 * canonicalization the property-dedup addressKey uses; the SQL form
 * mirrors it (lowercase, punctuation → space, suffix abbreviations
 * expanded to one canonical spelling, non-alphanumerics stripped,
 * ZIP = first 5 digits).
 *
 * Divergent + no visit coords => no pin / no ETA / no auto-arrival —
 * "no pin beats a wrong pin". Non-divergent => primary fallbacks allowed.
 */

const { streetKey, normalizeZip } = require('./customer-properties');

// JS form. Expects row keys: service_address_line1, service_address_zip,
// customer_address_line1, customer_zip.
function stampedAddressDiverges(row = {}) {
  const stamped = streetKey(row.service_address_line1);
  if (!stamped) return false;
  if (stamped !== streetKey(row.customer_address_line1)) return true;
  const sZip = normalizeZip(row.service_address_zip);
  const cZip = normalizeZip(row.customer_zip);
  return !!(sZip && cZip && sZip !== cZip);
}

// SQL mirror of streetKey's suffix canonicalization: abbreviations EXPAND to
// one canonical spelling ("st" -> "street") so formats key identically, but
// suffixes are never stripped ("Main St" != "Main Ave"). Keep this list in
// sync with STREET_SUFFIX_CANON in customer-properties.js.
const SQL_SUFFIX_CANON = [
  ['st', 'street'], ['ave', 'avenue'], ['rd', 'road'], ['dr', 'drive'],
  ['ln', 'lane'], ['ct', 'court'], ['blvd', 'boulevard'], ['cir', 'circle'],
  ['pl', 'place'], ['ter', 'terrace'], ['trl', 'trail'], ['pkwy', 'parkway'],
  ['hwy', 'highway'],
];

function sqlStreetKey(col) {
  // lowercase + punctuation to spaces, matching canonicalizeAddress()
  let expr = `LOWER(regexp_replace(COALESCE(${col}, ''), '[.,#]', ' ', 'g'))`;
  for (const [abbr, full] of SQL_SUFFIX_CANON) {
    // \m / \M are Postgres word boundaries — "st" the word, not "st" in "castle"
    expr = `regexp_replace(${expr}, '\\m${abbr}\\M', '${full}', 'g')`;
  }
  return `regexp_replace(${expr}, '[^a-z0-9]', '', 'g')`;
}

const sqlZip5 = (col) => `substring(regexp_replace(COALESCE(${col}, ''), '[^0-9]', '', 'g') from 1 for 5)`;

// SQL form of the same predicate, for query-time coordinate guards.
// sAlias/cAlias are the scheduled_services / customers table aliases.
function stampedDivergesSql(sAlias, cAlias) {
  const sLine1 = `${sAlias}.service_address_line1`;
  const cLine1 = `${cAlias}.address_line1`;
  const sZip = `${sAlias}.service_address_zip`;
  const cZip = `${cAlias}.zip`;
  return `(${sLine1} IS NOT NULL AND NULLIF(${sqlStreetKey(sLine1)}, '') IS NOT NULL AND (`
    + `${sqlStreetKey(sLine1)} <> ${sqlStreetKey(cLine1)}`
    + ` OR (NULLIF(${sqlZip5(sZip)}, '') IS NOT NULL AND NULLIF(${sqlZip5(cZip)}, '') IS NOT NULL AND ${sqlZip5(sZip)} <> ${sqlZip5(cZip)})`
    + `))`;
}

// The visit's unit line. A divergent stamp shows ONLY its own line2 (the
// primary's unit belongs to a different property); a non-divergent stamp
// falls back to the primary's unit — phone extractions often omit the unit
// the customer record already knows (codex round-5 P2).
function stampedLine2Sql(sAlias, cAlias) {
  return `CASE WHEN ${stampedDivergesSql(sAlias, cAlias)} THEN ${sAlias}.service_address_line2`
    + ` ELSE COALESCE(${sAlias}.service_address_line2, ${cAlias}.address_line2) END`;
}

module.exports = { stampedAddressDiverges, stampedDivergesSql, stampedLine2Sql };
