/**
 * Service-area geography — the ONE bounding box for "is this coordinate
 * plausibly a Waves service address".
 *
 * Waves serves Manatee, Sarasota and Charlotte counties plus the south-
 * Hillsborough towns; DeSoto County is not served (owner ruling 2026-09-30)
 * and neither is the city of Punta Gorda inside Charlotte County (owner ruling
 * 2026-10-22; city / ZIP evidence only, see excluded-localities.js). The
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
const { isExcludedLocality, isExcludedZip, normalizeLocality, isPuntaGordaSharedZip, namesTown } = require('./excluded-localities');
const { parseRawAddress } = require('../utils/address-normalizer');

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
 * Myakka City (27.35, -82.15) and the Charlotte County line (Punta Gorda, 26.93,
 * -82.05, is excluded by city name, not by this box). It is a
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

// Excluded localities (DeSoto County, owner ruling 2026-09-30; Punta Gorda,
// owner ruling 2026-10-22) live in services/excluded-localities.js, the one
// list every text-evidence check reads; callers import it directly. This file
// keeps only the coordinate tests. Punta Gorda has no coordinate rectangle:
// city / ZIP text evidence only.

// Pull a 5-digit ZIP out of free address text ("..., FL 34240, USA",
// "... Sarasota FL 34240-1234", "... 34240"). The ZIP after the state wins;
// otherwise a trailing ZIP, allowing a country suffix. A leading 5-digit
// house number never counts. Null when none is found.
function zipFromAddressText(text) {
  const s = String(text || '');
  const afterState = s.match(/\b(?:FL|Florida)\.?,?\s+(\d{5})(?:-\d{4})?\b/i);
  if (afterState) return afterState[1];
  const trailing = s.match(/[\s,](\d{5})(?:-\d{4})?\s*(?:,\s*(?:USA|US|United States))?\s*$/i);
  return trailing ? trailing[1] : null;
}

/**
 * True when the city, the ZIP or the address text names a place Waves does not serve inside a served county or
 * box: DeSoto, Punta Gorda, or a place held until a second technician is hired (services/excluded-localities.js;
 * none is held now). `text` is one address or a list of them, each read on its own, by comma-separated part
 * ("123 Main St, Port Charlotte, FL 33948") and by its ZIP. The public property lookup's verdict reads it beside the coordinate box, for fresh and cached results.
 */
function namesExcludedPlace({ city = null, zip = null, text = null, places = null } = {}) {
  if (isExcludedLocality(city) || isExcludedZip(zip)) return true;
  // More geocoded or stored { city, zip } pairs, each read on its own.
  if ((places || []).some((p) => isExcludedLocality(p?.city) || isExcludedZip(p?.zip))) return true;
  // Each address text is read on its own, so a served ZIP in one can never mask a held place in another. The parsed
  // city covers "Babcock Ranch FL" (a city sharing its comma part with the state); the parts cover the rest.
  return (Array.isArray(text) ? text : [text]).some((one) => {
    const raw = String(one || '');
    if (!raw) return false;
    const parsedCity = parseRawAddress(raw)?.city;
    return isExcludedZip(zipFromAddressText(raw)) || isExcludedLocality(parsedCity)
      || raw.split(',').some((part) => isExcludedLocality(normalizeLocality(part)));
  });
}

/**
 * True when the evidence carries a ZIP Punta Gorda shares with a served town (33980 / 33982 / 33983) and NO city anywhere
 * (the city, a place, or an address text): the ZIP alone cannot tell the served town from Punta Gorda, so the area is
 * UNKNOWN. The public property lookup answers `inServiceArea: null` for it, fresh and cached alike. Same evidence shape
 * as namesExcludedPlace.
 */
function namesSharedZipWithoutCity({ city = null, zip = null, text = null, places = null } = {}) {
  const texts = (Array.isArray(text) ? text : [text]).map((t) => String(t || '')).filter(Boolean);
  const zips = [zip, ...(places || []).map((p) => p?.zip), ...texts.map(zipFromAddressText)];
  if (!zips.some(isPuntaGordaSharedZip)) return false;
  // City evidence is a structured city (the geocode's, a place's) or a comma-separated PART of an address text after its first
  // (street) part, never an address parse's guess: a parse can take "NE" or "FL 33982" for a city. A part counts only when it
  // names a town (namesTown): no digit, not a direction, unit or state word.
  const textParts = texts.flatMap((t) => t.split(',').slice(1));
  return ![city, ...(places || []).map((p) => p?.city), ...textParts].some(namesTown);
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

// South Hillsborough is served by the Parrish office (config/locations.js
// SOUTH_HILLSBOROUGH_CITIES). The ONE predicate for it: a served town named
// by city, or by a ZIP whose city is a served town. Callers: the inspection
// route, the call pipeline's out-of-area triage, the Intelligence Bar
// address check.
function isServedSouthHillsboroughTown({ cities = [], zips = [] } = {}) {
  const { SOUTH_HILLSBOROUGH_CITIES } = require('../config/locations');
  const towns = [...cities, ...zips.map(zip => zipToCity(String(zip || '').trim().slice(0, 5)))]
    .map(town => String(town || '').toLowerCase().trim());
  return towns.some(town => town && SOUTH_HILLSBOROUGH_CITIES.includes(town));
}

// A Hillsborough County address in a served town is inside the service area.
function servedSouthHillsborough(county, address) {
  if (!/hillsborough/i.test(String(county || ''))) return false;
  return isServedSouthHillsboroughTown({ cities: [address?.city], zips: address?.zip ? [address.zip] : [] });
}

module.exports = {
  isServedSouthHillsboroughTown, servedSouthHillsborough,
  SERVICE_AREA_BOUNDS, DESOTO_EXCLUSION,
  namesExcludedPlace, namesSharedZipWithoutCity,
  isInServiceAreaBox, isInServiceAreaCoarseBox, isInDesotoExclusion,
  zipFromAddressText,
};
