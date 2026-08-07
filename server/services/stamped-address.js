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
  // {0,1} not ? — these snippets are interpolated into knex db.raw() strings,
  // and any literal ? is counted as a positional binding placeholder when the
  // query also passes a bindings array (broke /api/admin/dispatch/board:
  // "Expected 1 bindings, saw 11"). No ? may appear anywhere in helper output.
  expr = `regexp_replace(${expr}, '\\s+(apt|apartment|unit|ste|suite|#)\\.{0,1}\\s*[a-z0-9-]+\\s*$', '')`;
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
  const inlineUnit = `${sLine1} ~* '\\s(apt|apartment|unit|ste|suite|#)\\.{0,1}\\s*[a-z0-9-]+\\s*$'`;
  return `CASE WHEN ${stampedDivergesSql(sAlias, cAlias)} THEN ${sAlias}.service_address_line2`
    + ` WHEN ${sLine1} IS NOT NULL AND ${inlineUnit} THEN ${sAlias}.service_address_line2`
    + ` ELSE COALESCE(${sAlias}.service_address_line2, ${cAlias}.address_line2) END`;
}

// ---------------------------------------------------------------------------
// Stamp-vs-stamp premise identity (both sides service_address_* shaped —
// the customer side can be adapted by mapping address_* onto the same keys).
// Used by the review-cadence trapping series matcher; ONE implementation so
// cadence classification can never disagree with GPS/tracking about whether
// two stamps identify the same premise (codex #3243 r21 P1).
// ---------------------------------------------------------------------------

// Conflict between two stamps, canonical forms throughout. Each leg requires
// BOTH sides present — a missing value is unknown, not different — EXCEPT
// units, where a one-sided unit diverges ("100 Main St Apt 4" vs the
// unitless "100 Main St" is a sub-unit, not the same premise); pair with
// inheritReferenceUnit first when an omitted unit should borrow a
// reference's.
function premiseStampConflicts(a, b) {
  const { streetKey: sk, unitKey, streetEmbeddedUnitKey } = require('./customer-properties');
  const sa = sk(a?.service_address_line1);
  const sb = sk(b?.service_address_line1);
  if (!sa || !sb) return false;
  if (sa !== sb) return true;
  const ua = unitKey(a?.service_address_line2) || streetEmbeddedUnitKey(a?.service_address_line1);
  const ub = unitKey(b?.service_address_line2) || streetEmbeddedUnitKey(b?.service_address_line1);
  if ((ua || ub) && ua !== ub) return true;
  const za = normalizeZip(a?.service_address_zip);
  const zb = normalizeZip(b?.service_address_zip);
  if (za && zb && za !== zb) return true;
  const ca = cityKey(a?.service_address_city);
  const cb = cityKey(b?.service_address_city);
  return !!(ca && cb && ca !== cb);
}

// A stamp matching a reference's street but omitting the unit INHERITS the
// reference's unit (the same phone-extractions-omit-line-2 reality the
// stampedLine2Sql fallback encodes); the reference's unit may live in
// line 2 OR embedded in its street line. A stamp that ADDS a unit the
// reference lacks stays divergent.
function inheritReferenceUnit(row, reference) {
  const { streetKey: sk, unitKey, streetEmbeddedUnitKey } = require('./customer-properties');
  if (!row || !reference) return row;
  const rowUnit = unitKey(row.service_address_line2) || streetEmbeddedUnitKey(row.service_address_line1);
  if (rowUnit) return row;
  const refUnit = unitKey(reference.service_address_line2) || streetEmbeddedUnitKey(reference.service_address_line1);
  if (!refUnit) return row;
  const rs = sk(row.service_address_line1);
  if (!rs || rs !== sk(reference.service_address_line1)) return row;
  return { ...row, service_address_line2: reference.service_address_line2 || refUnit };
}

module.exports = { stampedAddressDiverges, stampedDivergesSql, stampedLine2Sql, sqlZip5, premiseStampConflicts, inheritReferenceUnit };
