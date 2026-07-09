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

const cityKey = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/[^a-z0-9]/g, '');

// JS form. Expects row keys: service_address_line1, service_address_zip,
// service_address_city, customer_address_line1, customer_zip, customer_city.
// ZIP and city legs each require BOTH sides present — a missing value is
// unknown, not different. City matters when ZIPs can't disambiguate:
// "100 Main St, Sarasota" vs "100 Main St, Bradenton" are different houses
// (codex round-6 P2).
function stampedAddressDiverges(row = {}) {
  const stamped = streetKey(row.service_address_line1);
  if (!stamped) return false;
  if (stamped !== streetKey(row.customer_address_line1)) return true;
  const sZip = normalizeZip(row.service_address_zip);
  const cZip = normalizeZip(row.customer_zip);
  if (sZip && cZip && sZip !== cZip) return true;
  const sCity = cityKey(row.service_address_city);
  const cCity = cityKey(row.customer_city);
  return !!(sCity && cCity && sCity !== cCity);
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
  // lowercase, then strip a trailing inline unit BEFORE punctuation folds —
  // mirrors streetKey()'s stripTrailingUnit so "100 Main St Apt 4" keys the
  // same street as "100 Main St" (codex round-6 P2: JS/SQL drift here
  // suppressed fallbacks for ordinary primary-unit bookings).
  let expr = `LOWER(COALESCE(${col}, ''))`;
  expr = `regexp_replace(${expr}, '\\s+(apt|apartment|unit|ste|suite|#)\\.?\\s*[a-z0-9-]+\\s*$', '')`;
  // punctuation to spaces, matching canonicalizeAddress()
  expr = `regexp_replace(${expr}, '[.,#]', ' ', 'g')`;
  for (const [abbr, full] of SQL_SUFFIX_CANON) {
    // \m / \M are Postgres word boundaries — "st" the word, not "st" in "castle"
    expr = `regexp_replace(${expr}, '\\m${abbr}\\M', '${full}', 'g')`;
  }
  return `regexp_replace(${expr}, '[^a-z0-9]', '', 'g')`;
}

const sqlZip5 = (col) => `substring(regexp_replace(COALESCE(${col}, ''), '[^0-9]', '', 'g') from 1 for 5)`;
const sqlCityKey = (col) => `regexp_replace(LOWER(COALESCE(${col}, '')), '[^a-z0-9]', '', 'g')`;

// SQL form of the same predicate, for query-time coordinate guards.
// sAlias/cAlias are the scheduled_services / customers table aliases.
function stampedDivergesSql(sAlias, cAlias) {
  const sLine1 = `${sAlias}.service_address_line1`;
  const cLine1 = `${cAlias}.address_line1`;
  const sZip = `${sAlias}.service_address_zip`;
  const cZip = `${cAlias}.zip`;
  const sCity = `${sAlias}.service_address_city`;
  const cCity = `${cAlias}.city`;
  return `(${sLine1} IS NOT NULL AND NULLIF(${sqlStreetKey(sLine1)}, '') IS NOT NULL AND (`
    + `${sqlStreetKey(sLine1)} <> ${sqlStreetKey(cLine1)}`
    + ` OR (NULLIF(${sqlZip5(sZip)}, '') IS NOT NULL AND NULLIF(${sqlZip5(cZip)}, '') IS NOT NULL AND ${sqlZip5(sZip)} <> ${sqlZip5(cZip)})`
    + ` OR (NULLIF(${sqlCityKey(sCity)}, '') IS NOT NULL AND NULLIF(${sqlCityKey(cCity)}, '') IS NOT NULL AND ${sqlCityKey(sCity)} <> ${sqlCityKey(cCity)})`
    + `))`;
}

// The visit's unit line. A divergent stamp shows ONLY its own line2 (the
// primary's unit belongs to a different property); a non-divergent stamp
// falls back to the primary's unit — phone extractions often omit the unit
// the customer record already knows (codex round-5 P2). EXCEPT when the
// stamp already carries its unit inline in line1 ("100 Main St Apt 4"):
// the divergence check strips that unit, so the primary's "Apt 3" would
// otherwise append onto the wrong door (codex round-7 P2).
function stampedLine2Sql(sAlias, cAlias) {
  const sLine1 = `${sAlias}.service_address_line1`;
  const inlineUnit = `${sLine1} ~* '\\s(apt|apartment|unit|ste|suite|#)\\.?\\s*[a-z0-9-]+\\s*$'`;
  return `CASE WHEN ${stampedDivergesSql(sAlias, cAlias)} THEN ${sAlias}.service_address_line2`
    + ` WHEN ${sLine1} IS NOT NULL AND ${inlineUnit} THEN ${sAlias}.service_address_line2`
    + ` ELSE COALESCE(${sAlias}.service_address_line2, ${cAlias}.address_line2) END`;
}

module.exports = { stampedAddressDiverges, stampedDivergesSql, stampedLine2Sql };
