'use strict';

/**
 * Business identity at an address (address-match PR 5, dark behind
 * GATE_LOOKUP_BUSINESS_IDENTITY, server/config/feature-gates.js).
 *
 * The county point-parcel is dropped by the situs guard when a storefront
 * with its own street number sits inside a plaza parcel whose situs is a
 * different address, so the lookup had no record and no unit signal for it.
 * Google Places can say WHICH operating business sits at the street number,
 * what kind it is, and how many operating places share the number — signals
 * the scope decision (./business-scope.js) turns into suite / whole building
 * / ask-the-CSR.
 *
 * Deterministic end to end: a code table and string/number comparisons, no
 * model anywhere (AGENTS.md: an LLM never reaches a price or size field).
 * Fail-open: a timeout, an HTTP error, a missing key or a malformed reply is
 * `null` (no signal), never a thrown error and never a guess.
 *
 * Privacy: the Places request carries only coordinates and a field mask with
 * no reviews, phone numbers or hours (cost tier + privacy). Nothing here logs
 * a business name or an address — counts and elapsed time only.
 */

const logger = require('../logger');

const PLACES_SEARCH_NEARBY_URL = 'https://places.googleapis.com/v1/places:searchNearby';
// Fields the decision needs and nothing else (no reviews, phones, hours).
const PLACES_FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.primaryType',
  'places.types',
  'places.businessStatus',
  'places.addressComponents',
  'places.location',
].join(',');
const SEARCH_RADIUS_M = 60;
const MAX_RESULT_COUNT = 20;
const DEFAULT_TIMEOUT_MS = 2500;
// A stamp on the cached property_record is reused for this long, like the
// DBPR-sourced suite-size stamp (property-lookup-v2.js).
const IDENTITY_FRESH_MS = 30 * 24 * 60 * 60 * 1000;

function timeoutMsFromEnv() {
  const n = Number(process.env.LOOKUP_BUSINESS_IDENTITY_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_TIMEOUT_MS;
}

// ── Type table ──────────────────────────────────────────────────────
// Google place type → the commercial subtype vocabulary the rest of the
// lookup already speaks (property-lookup-v2.js resolveCommercialSubtype and
// commercial-suite-size/type-defaults.js SUBTYPE_CATEGORIES decide on the
// strings below). Exact types first, then a suffix pattern for the long tail
// of "<cuisine>_restaurant" style types. Anything else is the generic
// storefront bucket.
const SUBTYPE_RESTAURANT = 'restaurant_food_service';
const SUBTYPE_SALON = 'salon_spa';
const SUBTYPE_MEDICAL = 'medical_office';
const SUBTYPE_VETERINARY = 'veterinary_clinic';
const SUBTYPE_SCHOOL = 'school_daycare';
const SUBTYPE_GENERIC = 'office_retail';

const TYPE_TO_SUBTYPE = Object.freeze({
  restaurant: SUBTYPE_RESTAURANT,
  cafe: SUBTYPE_RESTAURANT,
  coffee_shop: SUBTYPE_RESTAURANT,
  bakery: SUBTYPE_RESTAURANT,
  bar: SUBTYPE_RESTAURANT,
  pub: SUBTYPE_RESTAURANT,
  wine_bar: SUBTYPE_RESTAURANT,
  cocktail_bar: SUBTYPE_RESTAURANT,
  brewery: SUBTYPE_RESTAURANT,
  meal_takeaway: SUBTYPE_RESTAURANT,
  meal_delivery: SUBTYPE_RESTAURANT,
  fast_food_restaurant: SUBTYPE_RESTAURANT,
  ice_cream_shop: SUBTYPE_RESTAURANT,
  sandwich_shop: SUBTYPE_RESTAURANT,
  juice_shop: SUBTYPE_RESTAURANT,
  dessert_shop: SUBTYPE_RESTAURANT,
  food_court: SUBTYPE_RESTAURANT,
  beauty_salon: SUBTYPE_SALON,
  hair_salon: SUBTYPE_SALON,
  hair_care: SUBTYPE_SALON,
  barber_shop: SUBTYPE_SALON,
  nail_salon: SUBTYPE_SALON,
  spa: SUBTYPE_SALON,
  day_spa: SUBTYPE_SALON,
  massage: SUBTYPE_SALON,
  massage_spa: SUBTYPE_SALON,
  sauna: SUBTYPE_SALON,
  tanning_studio: SUBTYPE_SALON,
  skin_care_clinic: SUBTYPE_SALON,
  doctor: SUBTYPE_MEDICAL,
  dentist: SUBTYPE_MEDICAL,
  dental_clinic: SUBTYPE_MEDICAL,
  hospital: SUBTYPE_MEDICAL,
  medical_clinic: SUBTYPE_MEDICAL,
  medical_lab: SUBTYPE_MEDICAL,
  physiotherapist: SUBTYPE_MEDICAL,
  chiropractor: SUBTYPE_MEDICAL,
  urgent_care_facility: SUBTYPE_MEDICAL,
  veterinary_care: SUBTYPE_VETERINARY,
  school: SUBTYPE_SCHOOL,
  primary_school: SUBTYPE_SCHOOL,
  secondary_school: SUBTYPE_SCHOOL,
  preschool: SUBTYPE_SCHOOL,
  child_care_agency: SUBTYPE_SCHOOL,
});
const RESTAURANT_SUFFIX_RE = /_(?:restaurant|cafe)$/;

function subtypeForType(type) {
  const t = String(type || '').toLowerCase();
  if (!t) return null;
  if (Object.prototype.hasOwnProperty.call(TYPE_TO_SUBTYPE, t)) return TYPE_TO_SUBTYPE[t];
  if (RESTAURANT_SUFFIX_RE.test(t)) return SUBTYPE_RESTAURANT;
  return null;
}

// primaryType decides when the table knows it; otherwise the first of the
// place's other types the table knows; otherwise the generic bucket.
function businessTypeFor(primaryType, types = []) {
  const fromPrimary = subtypeForType(primaryType);
  if (fromPrimary) return fromPrimary;
  for (const t of Array.isArray(types) ? types : []) {
    const hit = subtypeForType(t);
    if (hit) return hit;
  }
  return SUBTYPE_GENERIC;
}

// Types that are an address, an area or a residence — not an operating
// business a customer would call us from. A place whose primary type or any
// type is here is not counted as a tenant (a parking lot, an ATM or an
// apartment complex sharing the street number must not make a stand-alone
// storefront look multi-tenant, or a residence look commercial).
const NON_BUSINESS_TYPES = new Set([
  'street_address', 'premise', 'subpremise', 'route', 'intersection', 'locality',
  'sublocality', 'neighborhood', 'political', 'postal_code', 'plus_code', 'country',
  'administrative_area_level_1', 'administrative_area_level_2', 'colloquial_area',
  'parking', 'parking_lot', 'atm', 'electric_vehicle_charging_station', 'public_bathroom',
  'apartment_building', 'apartment_complex', 'housing_complex', 'condominium_complex',
  'mobile_home_park', 'gated_community', 'residential',
]);

// ── Parsing ─────────────────────────────────────────────────────────

function componentText(components, type) {
  const c = (Array.isArray(components) ? components : [])
    .find((x) => Array.isArray(x?.types) && x.types.includes(type));
  const text = c?.longText ?? c?.shortText ?? c?.long_name ?? c?.short_name ?? null;
  return text == null ? null : String(text).trim() || null;
}

function parsePlace(place) {
  if (!place || typeof place !== 'object') return null;
  const types = Array.isArray(place.types) ? place.types.map(String) : [];
  const primaryType = place.primaryType ? String(place.primaryType) : null;
  return {
    id: place.id ? String(place.id) : null,
    name: place.displayName?.text ? String(place.displayName.text) : null,
    primaryType,
    types,
    operational: place.businessStatus === 'OPERATIONAL',
    isBusiness: ![primaryType, ...types].some((t) => t && NON_BUSINESS_TYPES.has(t)),
    number: componentText(place.addressComponents, 'street_number'),
    route: componentText(place.addressComponents, 'route'),
    subpremise: componentText(place.addressComponents, 'subpremise'),
  };
}

// "100 Example Plaza Dr" → { number: '100', street: <county-normalized
// "100 EXAMPLE PLAZA DR"> }. Reuses the county street normalizer so
// "Drive"/"Dr", "State Road 70"/"SR 70" and directionals compare the way the
// county matchers compare them. Null when the address has no leading number.
function streetKeyFor(number, route) {
  try {
    const { normalizeCountyStreetLine } = require('./ai-property-lookup');
    return normalizeCountyStreetLine(`${number} ${route}`);
  } catch {
    return `${number} ${route}`.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

function typedStreetParts(address) {
  let streetLine = '';
  try {
    const { suiteAddressParts } = require('../commercial-suite-size/address-parts');
    streetLine = String(suiteAddressParts(address).street || '');
  } catch {
    streetLine = String(address || '').split(',')[0];
  }
  const m = /^\s*(\d+[A-Za-z]?)\s+(\S.*)$/.exec(streetLine);
  if (!m) return null;
  return { number: m[1].toUpperCase(), route: m[2].trim(), key: streetKeyFor(m[1], m[2]) };
}

function typedUnitOf(address) {
  try {
    const { suiteAddressParts } = require('../commercial-suite-size/address-parts');
    return suiteAddressParts(address).unit || null;
  } catch {
    return null;
  }
}

function unitToken(value) {
  return String(value || '').toUpperCase().replace(/^(?:SUITE|STE|UNIT|BAY|SPACE|SPC|#)\.?\s*/i, '').replace(/[^A-Z0-9]/g, '');
}

function placeIsAtStreetNumber(p, typed) {
  if (!p.number || !p.route) return false;
  if (p.number.toUpperCase() !== typed.number) return false;
  return streetKeyFor(p.number, p.route) === typed.key;
}

// The distinct operational businesses at the typed street number, narrowed
// to one place by the typed unit when several share the number.
function pickMatched(atNumber, typedUnit) {
  if (atNumber.length === 1) return { matched: atNumber[0], ambiguous: false };
  if (atNumber.length > 1 && typedUnit) {
    const token = unitToken(typedUnit);
    const byUnit = token ? atNumber.filter((p) => unitToken(p.subpremise) === token) : [];
    if (byUnit.length === 1) return { matched: byUnit[0], ambiguous: false };
  }
  return { matched: null, ambiguous: atNumber.length > 1 };
}

// One subtype for a multi-tenant address with no single match: the tenants'
// shared subtype when they all agree, else the generic storefront bucket.
function sharedSubtype(places) {
  const subtypes = new Set(places.map((p) => businessTypeFor(p.primaryType, p.types)));
  return subtypes.size === 1 ? [...subtypes][0] : SUBTYPE_GENERIC;
}

/**
 * Pure: reduce a Places searchNearby reply to the identity signals. Never
 * throws; a reply with no usable places is a real "nobody here" answer.
 * @returns {object|null} null only when the typed address has no street number
 */
function buildBusinessIdentity({ places, address, now = new Date() }) {
  const typed = typedStreetParts(address);
  if (!typed) return null;
  const parsed = (Array.isArray(places) ? places : [])
    .map(parsePlace)
    .filter((p) => p && p.operational && p.isBusiness);
  const atNumber = parsed.filter((p) => placeIsAtStreetNumber(p, typed));
  const { matched, ambiguous } = pickMatched(atNumber, typedUnitOf(address));
  const neighbors = parsed.length - atNumber.length;
  return {
    source: 'google_places',
    fetchedAt: now.toISOString(),
    radiusM: SEARCH_RADIUS_M,
    matched: matched ? {
      placeId: matched.id,
      name: matched.name,
      primaryType: matched.primaryType,
      type: businessTypeFor(matched.primaryType, matched.types),
      subpremise: matched.subpremise,
    } : null,
    matchedCount: atNumber.length,
    ambiguous,
    ambiguousType: ambiguous ? sharedSubtype(atNumber) : null,
    // Stable key for a multi-tenant address with no single match, so a
    // persisted suite stamp is reused for the same set of tenants only.
    tenantPlaceKey: ambiguous ? atNumber.map((p) => p.id).filter(Boolean).sort().join('|') || null : null,
    tenantsAtNumber: atNumber.length,
    neighbors,
  };
}

/** True while a stamped identity is young enough to reuse with no network. */
function businessIdentityIsFresh(stamp, now = Date.now()) {
  if (!stamp || typeof stamp !== 'object') return false;
  const at = Date.parse(stamp.fetchedAt);
  return Number.isFinite(at) && (now - at) < IDENTITY_FRESH_MS;
}

// The request inputs, or null when there is nothing usable to ask with.
function placesRequestInputs({ address, lat, lng }) {
  const key = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_API_KEY;
  const latN = Number(lat);
  const lngN = Number(lng);
  const haveCoords = lat != null && lng != null && Number.isFinite(latN) && Number.isFinite(lngN);
  if (!key || !haveCoords || !typedStreetParts(address)) return null;
  return { key, latN, lngN };
}

// One bounded POST; the parsed reply, or null on any failure (logged as a
// status code or error class and elapsed time only).
async function fetchPlacesNearby({ key, latN, lngN, timeoutMs, fetchImpl, started }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(timeoutMs) > 0 ? Number(timeoutMs) : timeoutMsFromEnv());
  try {
    const resp = await (fetchImpl || globalThis.fetch)(PLACES_SEARCH_NEARBY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': PLACES_FIELD_MASK,
      },
      body: JSON.stringify({
        maxResultCount: MAX_RESULT_COUNT,
        locationRestriction: {
          circle: { center: { latitude: latN, longitude: lngN }, radius: SEARCH_RADIUS_M },
        },
      }),
      signal: controller.signal,
    });
    if (!resp || resp.ok === false) {
      logger.warn('[business-identity] places request failed', { status: resp?.status ?? null, elapsedMs: Date.now() - started });
      return null;
    }
    return await resp.json();
  } catch (err) {
    logger.warn('[business-identity] places request errored', { reason: err?.name || 'error', elapsedMs: Date.now() - started });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask Google Places (New) which operating businesses sit within 60 m of the
 * geocoded point and reduce the answer. Fail-open: null on a missing key or
 * coordinates, timeout, HTTP error or unreadable reply.
 *
 * @param {object} input
 *   address   — the typed/canonical address (house number + street + optional unit)
 *   lat, lng  — the geocode point
 *   timeoutMs — default 2500 (LOOKUP_BUSINESS_IDENTITY_TIMEOUT_MS overrides)
 *   fetchImpl — test seam
 */
async function identifyBusinessAtAddress({ address, lat, lng, timeoutMs, fetchImpl } = {}) {
  const inputs = placesRequestInputs({ address, lat, lng });
  if (!inputs) return null;
  const started = Date.now();
  const data = await fetchPlacesNearby({ ...inputs, timeoutMs, fetchImpl, started });
  if (!data) return null;
  const identity = buildBusinessIdentity({ places: data.places, address });
  if (identity) {
    logger.info('[business-identity] lookup', {
      places: Array.isArray(data.places) ? data.places.length : 0,
      matched: Boolean(identity.matched),
      tenantsAtNumber: identity.tenantsAtNumber,
      neighbors: identity.neighbors,
      elapsedMs: Date.now() - started,
    });
  }
  return identity;
}

module.exports = {
  identifyBusinessAtAddress,
  buildBusinessIdentity,
  businessIdentityIsFresh,
  businessTypeFor,
  typedStreetParts,
  PLACES_SEARCH_NEARBY_URL,
  PLACES_FIELD_MASK,
  SEARCH_RADIUS_M,
  MAX_RESULT_COUNT,
  DEFAULT_TIMEOUT_MS,
  IDENTITY_FRESH_MS,
  TYPE_TO_SUBTYPE,
  SUBTYPE_GENERIC,
};
