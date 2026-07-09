/**
 * Stamped service-address divergence rule.
 *
 * Call bookings stamp the visit's own service_address_* onto
 * scheduled_services — and EVERY phone booking stamps, including ordinary
 * bookings at the customer's primary address. So "the visit is stamped"
 * alone must never suppress primary-coordinate/geocode fallbacks: for a
 * primary-address booking with no visit coords, the primary IS the correct
 * destination (codex round-4 P1). The wrong-house rule only applies when
 * the stamp DIVERGES from the primary address on file: same street line
 * (case/space-insensitive) plus, when both sides have one, the same ZIP.
 *
 * Divergent + no visit coords => no pin / no ETA / no auto-arrival —
 * "no pin beats a wrong pin". Non-divergent => primary fallbacks allowed.
 */

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ');

// JS form. Expects row keys: service_address_line1, service_address_zip,
// customer_address_line1, customer_zip.
function stampedAddressDiverges(row = {}) {
  if (!norm(row.service_address_line1)) return false;
  if (norm(row.service_address_line1) !== norm(row.customer_address_line1)) return true;
  const sZip = norm(row.service_address_zip);
  const cZip = norm(row.customer_zip);
  return !!(sZip && cZip && sZip !== cZip);
}

// SQL form of the same predicate, for query-time coordinate guards.
// sAlias/cAlias are the scheduled_services / customers table aliases.
function stampedDivergesSql(sAlias, cAlias) {
  const sLine1 = `${sAlias}.service_address_line1`;
  const cLine1 = `${cAlias}.address_line1`;
  const sZip = `${sAlias}.service_address_zip`;
  const cZip = `${cAlias}.zip`;
  return `(${sLine1} IS NOT NULL AND (`
    + `LOWER(regexp_replace(TRIM(${sLine1}), '\\s+', ' ', 'g')) <> LOWER(regexp_replace(TRIM(COALESCE(${cLine1}, '')), '\\s+', ' ', 'g'))`
    + ` OR (NULLIF(TRIM(${sZip}), '') IS NOT NULL AND NULLIF(TRIM(${cZip}), '') IS NOT NULL AND TRIM(${sZip}) <> TRIM(${cZip}))`
    + `))`;
}

module.exports = { stampedAddressDiverges, stampedDivergesSql };
