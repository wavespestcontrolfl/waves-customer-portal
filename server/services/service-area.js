/**
 * Service-area geography — the ONE bounding box for "is this coordinate
 * plausibly a Waves service address".
 *
 * Waves serves Manatee, Sarasota, Charlotte and DeSoto counties. The
 * authoritative membership test is the county name
 * (SERVICE_AREA_COUNTIES in services/call-triage-flags.js), which needs a
 * reverse-geocode; this box is the cheap arithmetic backstop for paths that
 * already hold a coordinate and must not accept one from the wrong state.
 *
 * Deliberately generous at the edges: it has to contain Anna Maria and
 * Holmes Beach on the west, Duette and the DeSoto line on the east, Boca
 * Grande on the south, and on the north the served south-Hillsborough
 * cities (SOUTH_HILLSBOROUGH_CITIES in config/locations.js — Riverview and
 * Gibsonton reach past 27.9°N), which is why the top edge sits above the
 * Manatee/Hillsborough county line.
 * It is a sanity check, not a service-area definition — a coordinate inside
 * the box is not thereby servable, it is merely not absurd.
 */

const SERVICE_AREA_BOUNDS = Object.freeze({
  latMin: 26.3,
  latMax: 27.95,
  lngMin: -82.9,
  lngMax: -81.5,
});

/**
 * True when a coordinate falls inside the service-area box. Null/undefined/
 * unparseable coordinates are NOT in the box — callers treat a missing
 * coordinate the same as an implausible one (both mean "do not route on
 * this"), so a half-set pair can never read as valid.
 */
function isInServiceAreaBox(lat, lng) {
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

module.exports = { SERVICE_AREA_BOUNDS, isInServiceAreaBox };
