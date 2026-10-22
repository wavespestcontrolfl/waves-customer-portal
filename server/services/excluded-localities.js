/**
 * Localities Waves does NOT serve, even where the county is otherwise served.
 * The ONE text-evidence list every service-area decision reads (inspection
 * route, call pipeline legacy veto, address validation, triage flags), so a
 * caller naming an excluded place without a county still fails closed.
 *
 * No dependencies on purpose: services/service-area.js and
 * services/call-triage-flags.js both read it, and they require each other.
 *
 *  - DeSoto County (Arcadia): owner ruling 2026-09-30. Whole county.
 *  - Punta Gorda, FL: owner ruling 2026-10-22 ("block punta gorda"). City
 *    only; the rest of Charlotte County (Port Charlotte, Englewood, Rotonda
 *    West, ...) stays served. There is deliberately NO lat/lng box for it:
 *    the city sits beside served Port Charlotte, so only city / ZIP text
 *    evidence decides.
 *
 * Keys are normalized by normalizeLocality (lower-case, punctuation to
 * spaces, "ft"/"ft." -> "fort", single spaces).
 */

const DESOTO_LOCALITIES = Object.freeze(new Set([
  'arcadia', 'southeast arcadia', 'se arcadia', 'nocatee', 'fort ogden',
  'lake suzy', 'brownville', 'pine level', 'hull', 'fort winder', 'owens',
  'joshua', 'liverpool', 'sunnybreeze', 'desoto', 'de soto', 'desoto county',
  'de soto county',
]));
const DESOTO_ZIPS = Object.freeze(new Set(['34265', '34266', '34267', '34268', '34269']));

const PUNTA_GORDA_LOCALITIES = Object.freeze(new Set(['punta gorda', 'punta gorda isles']));
// ZIPs that are Punta Gorda only. 33980 (Charlotte Harbor) and 33983 (Deep
// Creek) are shared with Port Charlotte-area addresses, so they are NOT here:
// the city name decides for those, and the ZIP alone keeps current behavior.
const PUNTA_GORDA_ZIPS = Object.freeze(new Set(['33950', '33951', '33955', '33982']));

function normalizeLocality(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(/\bft\b/g, 'fort')
    .replace(/\s+/g, ' ')
    .trim();
}

const zip5 = (zip) => String(zip || '').trim().slice(0, 5);

function isDesotoLocality(city) {
  return DESOTO_LOCALITIES.has(normalizeLocality(city));
}
function isDesotoZip(zip) {
  return DESOTO_ZIPS.has(zip5(zip));
}
function isPuntaGordaLocality(city) {
  return PUNTA_GORDA_LOCALITIES.has(normalizeLocality(city));
}
function isPuntaGordaZip(zip) {
  return PUNTA_GORDA_ZIPS.has(zip5(zip));
}

// Any excluded place, by city name or by a ZIP that belongs only to one.
function isExcludedLocality(city) {
  return isDesotoLocality(city) || isPuntaGordaLocality(city);
}
function isExcludedZip(zip) {
  return isDesotoZip(zip) || isPuntaGordaZip(zip);
}

module.exports = {
  DESOTO_LOCALITIES, DESOTO_ZIPS, PUNTA_GORDA_LOCALITIES, PUNTA_GORDA_ZIPS,
  normalizeLocality,
  isDesotoLocality, isDesotoZip, isPuntaGordaLocality, isPuntaGordaZip,
  isExcludedLocality, isExcludedZip,
};
