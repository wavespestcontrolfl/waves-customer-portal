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
 *    only at the time. There is deliberately NO lat/lng box for it: the city
 *    sits beside Port Charlotte, so only city / ZIP text evidence decides.
 *  - NOT YET SERVED (owner ruling 2026-11-23, narrowed the same day): Rotonda
 *    (Rotonda West), Placida, Boca Grande, Babcock Ranch, Gulf Cove, El Jobean,
 *    Charlotte Harbor and Deep Creek are held until a second technician is
 *    hired ("soon"). Englewood and Port Charlotte were held for a few hours and
 *    are served again (owner "ok do this", 2026-11-23). New leads and new
 *    bookings only: an existing customer's visits, reschedules and re-service
 *    never read this list. North Port is NOT on it (owner 2026-11-23: every
 *    North Port ZIP, 34286-34291, stays served). Remove a place from
 *    NOT_YET_SERVED_LOCALITIES / NOT_YET_SERVED_ZIPS when it opens.
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
// ZIPs that are Punta Gorda only. 33980 (Charlotte Harbor), 33982 (Babcock
// Ranch) and 33983 (Deep Creek) are shared with Port Charlotte-area addresses;
// the towns named on them are held (owner ruling 2026-11-23), so they live in
// NOT_YET_SERVED_ZIPS below and the ZIP alone decides.
const PUNTA_GORDA_ZIPS = Object.freeze(new Set(['33950', '33951', '33955']));

// Held until a second technician is hired (owner ruling 2026-11-23). By place:
//  - Rotonda (Rotonda West): 33947. 'rotunda west' is a typo seen on file.
//  - Placida: 33946, 33927. Boca Grande: 33921.
//  - Babcock Ranch: 33982 (shared with Punta Gorda).
//  - Gulf Cove / El Jobean: 33981. Charlotte Harbor: 33980. Deep Creek: 33983.
//    33980, 33981 and 33983 are shared with Punta Gorda or with Port Charlotte-area
//    addresses; Port Charlotte itself is served, so these three ZIPs hold by ZIP:
//    an address that says "Port Charlotte" on 33980 / 33981 / 33983 is held.
// Served again (owner "ok do this", 2026-11-23): Englewood (34223, 34224, 34295)
// and Port Charlotte (33938, 33948, 33949, 33952, 33953, 33954).
// North Port (34286-34291) was never here: it stays served.
const NOT_YET_SERVED_LOCALITIES = Object.freeze(new Set([
  'rotonda', 'rotonda west', 'rotunda west',
  'placida',
  'boca grande',
  'gulf cove', 'el jobean', 'charlotte harbor', 'deep creek',
  'babcock ranch',
]));
const NOT_YET_SERVED_ZIPS = Object.freeze(new Set([
  '33947',
  '33946', '33927',
  '33921',
  '33982',
  '33981', '33980', '33983',
]));

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
// Port Charlotte is served, but the held shared ZIPs 33980 / 33981 / 33983 carry the name too (owner ruling
// 2026-11-23): a "Port Charlotte" address with no usable ZIP is UNVERIFIED, never out of area and never auto-accepted.
function isPortCharlotteLocality(city) {
  return normalizeLocality(city) === 'port charlotte';
}
function isNotYetServedLocality(city) {
  return NOT_YET_SERVED_LOCALITIES.has(normalizeLocality(city));
}
function isNotYetServedZip(zip) {
  return NOT_YET_SERVED_ZIPS.has(zip5(zip));
}

// Any excluded place (DeSoto, Punta Gorda, the 2026-11-23 not-yet-served places), by city name or by a ZIP that belongs only to one.
function isExcludedLocality(city) {
  return isDesotoLocality(city) || isPuntaGordaLocality(city) || isNotYetServedLocality(city);
}
function isExcludedZip(zip) {
  return isDesotoZip(zip) || isPuntaGordaZip(zip) || isNotYetServedZip(zip);
}

module.exports = {
  DESOTO_LOCALITIES, DESOTO_ZIPS, PUNTA_GORDA_LOCALITIES, PUNTA_GORDA_ZIPS,
  NOT_YET_SERVED_LOCALITIES, NOT_YET_SERVED_ZIPS,
  normalizeLocality,
  isDesotoLocality, isDesotoZip, isPuntaGordaLocality, isPuntaGordaZip,
  isNotYetServedLocality, isNotYetServedZip, isPortCharlotteLocality,
  isExcludedLocality, isExcludedZip,
};
