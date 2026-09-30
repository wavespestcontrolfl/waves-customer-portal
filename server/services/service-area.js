/**
 * Service-area geography — the ONE bounding box for "is this coordinate
 * plausibly a Waves service address".
 *
 * Waves serves Manatee, Sarasota and Charlotte counties plus the south-
 * Hillsborough towns; DeSoto is not served (owner ruling 2026-09-30). The
 * authoritative membership test is the county name
 * (SERVICE_AREA_COUNTIES in services/call-triage-flags.js), which needs a
 * reverse-geocode; this box is the cheap arithmetic backstop for paths that
 * already hold a coordinate and must not accept one from the wrong state.
 *
 * Deliberately generous at the edges: it has to contain Anna Maria and
 * Holmes Beach on the west, Duette and the DeSoto county line on the east, Boca
 * Grande on the south, and on the north the served south-Hillsborough
 * cities (SOUTH_HILLSBOROUGH_CITIES in config/locations.js — Riverview and
 * Gibsonton reach past 27.9°N), which is why the top edge sits above the
 * Manatee/Hillsborough county line.
 * It is a sanity check, not a service-area definition — a coordinate inside
 * the box is not thereby servable, it is merely not absurd.
 */

const { isInServiceAreaCounty } = require('./call-triage-flags');
const { zipToCity } = require('../utils/zip-to-city');

const SERVICE_AREA_BOUNDS = Object.freeze({
  latMin: 26.3,
  latMax: 27.95,
  lngMin: -82.9,
  lngMax: -81.5,
});

/**
 * DeSoto County (Arcadia) is NOT served (owner ruling 2026-09-30), but it sits
 * inside the generous box above. This rectangle carves it out: DeSoto's
 * northern edge is ~27.40 (Manatee line), its southern edge ~27.03 (Charlotte
 * line), its western edge ~-82.06 (Sarasota/Manatee line) and its eastern edge
 * ~-81.55. Served neighbours stay outside it: North Port (27.04, -82.20),
 * Myakka City (27.35, -82.15) and Punta Gorda (26.93, -82.05). It is a
 * rectangle, so it can clip a sliver of a neighbouring county at a corner; the
 * county name therefore wins over it wherever county evidence exists (see
 * isInServiceAreaBox), and the rectangle only decides when no county is known.
 */
const DESOTO_EXCLUSION = Object.freeze({
  latMin: 27.03,
  latMax: 27.4,
  lngMin: -82.06,
  lngMax: -81.55,
});

// DeSoto County localities and ZIPs (owner ruling 2026-09-30: not served).
// The one list every text-evidence check reads, so a caller naming a DeSoto
// place without a ZIP or county still fails closed. Keys are normalized by
// normalizeDesotoLocality (lower-case, "ft"/"ft." -> "fort", single spaces).
const DESOTO_LOCALITIES = Object.freeze(new Set([
  'arcadia', 'southeast arcadia', 'se arcadia', 'nocatee', 'fort ogden',
  'lake suzy', 'brownville', 'pine level', 'hull', 'fort winder', 'owens',
  'joshua', 'liverpool', 'sunnybreeze', 'desoto', 'de soto', 'desoto county',
  'de soto county',
]));
const DESOTO_ZIPS = Object.freeze(new Set(['34265', '34266', '34267', '34268', '34269']));

function normalizeDesotoLocality(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(/\bft\b/g, 'fort')
    .replace(/\s+/g, ' ')
    .trim();
}

function isDesotoLocality(city) {
  return DESOTO_LOCALITIES.has(normalizeDesotoLocality(city));
}

function isDesotoZip(zip) {
  return DESOTO_ZIPS.has(String(zip || '').trim().slice(0, 5));
}

function isInDesotoExclusion(lat, lng) {
  return (
    lat >= DESOTO_EXCLUSION.latMin &&
    lat <= DESOTO_EXCLUSION.latMax &&
    lng >= DESOTO_EXCLUSION.lngMin &&
    lng <= DESOTO_EXCLUSION.lngMax
  );
}

/**
 * True when a coordinate falls inside the coarse box, with NO DeSoto carve-out.
 * Use only where a county lookup follows and decides (inspection-public with a
 * Google key); everything else calls isInServiceAreaBox.
 */
function isInServiceAreaCoarseBox(lat, lng) {
  const a = Number(lat);
  const b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return (
    a >= SERVICE_AREA_BOUNDS.latMin &&
    a <= SERVICE_AREA_BOUNDS.latMax &&
    b >= SERVICE_AREA_BOUNDS.lngMin &&
    b <= SERVICE_AREA_BOUNDS.lngMax
  );
}

/**
 * True when a coordinate falls inside the service-area box. Null/undefined/
 * unparseable coordinates are NOT in the box — callers treat a missing
 * coordinate the same as an implausible one (both mean "do not route on
 * this"), so a half-set pair can never read as valid.
 *
 * Inside the DeSoto rectangle the coordinate alone cannot decide (the
 * rectangle clips a sliver of the served neighbours), so the caller's own
 * evidence does, county first:
 *   - `county` known: that county's name wins — served county in, anything
 *     else (DeSoto, Hardee, ...) out.
 *   - no county but a `zip` in the served ZIP map (utils/zip-to-city, which
 *     holds no DeSoto ZIP): in.
 *   - no evidence: out (fail closed — never accept an unknown point in
 *     DeSoto's rectangle).
 * Outside the rectangle the evidence is ignored; the coarse box decides.
 */
function isInServiceAreaBox(lat, lng, evidence = {}) {
  if (!isInServiceAreaCoarseBox(lat, lng)) return false;
  if (!isInDesotoExclusion(Number(lat), Number(lng))) return true;
  const { county = null, zip = null } = evidence || {};
  if (county) return isInServiceAreaCounty(county);
  return !!zipToCity(zip);
}

module.exports = {
  SERVICE_AREA_BOUNDS, DESOTO_EXCLUSION, DESOTO_LOCALITIES, DESOTO_ZIPS,
  isInServiceAreaBox, isInServiceAreaCoarseBox, isInDesotoExclusion, isDesotoLocality, isDesotoZip,
};
