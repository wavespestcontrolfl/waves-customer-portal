/**
 * Address validation — provider abstraction over Google Address Validation API.
 *
 * Routing code consumes only the provider-neutral AddressValidationResult below;
 * swap to Smarty/Melissa/Loqate later by writing another provider. Behind the
 * ADDRESS_VALIDATION_ENABLED flag (default off) — when off or no key, returns
 * { status: 'not_attempted' } and the gate falls back to model/deterministic
 * address signals exactly as before.
 *
 * Service area: Manatee, Sarasota, Charlotte, DeSoto (FL). An address that
 * resolves outside these counties is out_of_service_area.
 *
 * AddressValidationResult:
 *   {
 *     status,            // see STATUSES below
 *     inServiceArea,     // boolean | null
 *     county,            // normalized county name | null
 *     granularity,       // PREMISE | SUB_PREMISE | ROUTE | ... | null
 *     normalized: { street_line_1, city, state, postal_code } | null,
 *     hasInferred, hasReplaced, hasUnconfirmed,  // booleans
 *     providerResponseId,                         // for audit
 *     raw,               // trimmed provider payload (debug; not persisted whole)
 *   }
 */

const logger = require('../logger');
const { isInServiceAreaCounty } = require('../call-triage-flags');

const GOOGLE_KEY = () => process.env.GOOGLE_ADDRESS_VALIDATION_API_KEY
  || process.env.GOOGLE_API_KEY
  || process.env.GOOGLE_MAPS_API_KEY;

const ENABLED = () => process.env.ADDRESS_VALIDATION_ENABLED === 'true';

const STATUSES = {
  NOT_ATTEMPTED: 'not_attempted',       // flag off / no key / no address
  VALIDATED_ACCEPT: 'validated_accept', // PREMISE/SUB_PREMISE, in-area, no material inference/replacement
  CONFIRM_NEEDED: 'confirm_needed',     // resolved but unconfirmed/inferred/replaced material component
  MISSING_COMPONENT: 'missing_component', // street_number/route/postal missing, can't resolve to premise
  OUT_OF_SERVICE_AREA: 'out_of_service_area',
  AMBIGUOUS: 'ambiguous',
  API_UNAVAILABLE: 'api_unavailable',
};

const VERSION = 'google-av-v1';

function pickComponent(components, type) {
  const c = (components || []).find((x) => x.componentType === type);
  return c ? c.componentName?.text || null : null;
}

// Google Address Validation does NOT return administrative_area_level_2 (county)
// in addressComponents — only street/route/locality/state/postal/country. It
// does return geocode.location (lat/lng), so we reverse-geocode that through the
// Geocoding API (which DOES return county) to determine service area.
async function reverseGeocodeCounty(location, key) {
  if (!location || typeof location.latitude !== 'number') return null;
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${location.latitude},${location.longitude}`
      + `&result_type=administrative_area_level_2&key=${key}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    for (const r of data.results || []) {
      const comp = (r.address_components || []).find((c) => (c.types || []).includes('administrative_area_level_2'));
      if (comp) return comp.long_name || comp.short_name || null;
    }
    return null;
  } catch {
    return null;
  }
}

// Pure status derivation — testable without the network. `county` is supplied
// by the caller (reverse-geocoded). The cardinal safety rule: VALIDATED_ACCEPT
// requires inServiceArea === true. Unknown county (null) is NOT good enough —
// it downgrades to confirm_needed so an unverifiable-area address never
// auto-routes; out-of-area resolves to OUT_OF_SERVICE_AREA.
function deriveStatus(result, county) {
  const verdict = result?.verdict || {};
  const address = result?.address || {};
  const components = address.addressComponents || [];
  const inServiceArea = county ? isInServiceAreaCounty(county) : null;
  const granularity = verdict.validationGranularity || null;
  const premiseLevel = granularity === 'PREMISE' || granularity === 'SUB_PREMISE';

  const normalized = {
    street_line_1: [pickComponent(components, 'street_number'), pickComponent(components, 'route')].filter(Boolean).join(' ') || null,
    city: pickComponent(components, 'locality') || null,
    state: pickComponent(components, 'administrative_area_level_1') || null,
    postal_code: pickComponent(components, 'postal_code') || null,
  };

  const base = {
    inServiceArea,
    county: county || null,
    granularity,
    normalized,
    hasInferred: !!verdict.hasInferredComponents,
    hasReplaced: !!verdict.hasReplacedComponents,
    hasUnconfirmed: !!verdict.hasUnconfirmedComponents,
  };

  // Incompleteness first, so garbage that geocodes to some random out-of-area
  // county is labeled missing_component/ambiguous (accurate) rather than
  // out_of_service_area. Both still block auto-route — this is about giving
  // Virginia the right triage reason.
  if (!verdict.addressComplete || !premiseLevel) {
    return { status: premiseLevel ? STATUSES.AMBIGUOUS : STATUSES.MISSING_COMPONENT, ...base };
  }
  if (inServiceArea === false) return { status: STATUSES.OUT_OF_SERVICE_AREA, ...base };
  // Premise-level + in-area required for accept. Replaced/unconfirmed material
  // (Google rewrote the caller's input) OR unknown county → human confirm.
  if (verdict.hasReplacedComponents || verdict.hasUnconfirmedComponents || inServiceArea !== true) {
    return { status: STATUSES.CONFIRM_NEEDED, ...base };
  }
  return { status: STATUSES.VALIDATED_ACCEPT, ...base };
}

async function validateAddress({ addressLines, regionCode = 'US' } = {}) {
  const lines = (addressLines || []).filter(Boolean);
  if (!ENABLED() || lines.length === 0) {
    return { status: STATUSES.NOT_ATTEMPTED, inServiceArea: null, county: null, granularity: null, normalized: null, hasInferred: false, hasReplaced: false, hasUnconfirmed: false };
  }
  const key = GOOGLE_KEY();
  if (!key) {
    logger.warn('[address-validation] no Google API key configured');
    return { status: STATUSES.API_UNAVAILABLE, inServiceArea: null, county: null, granularity: null, normalized: null, hasInferred: false, hasReplaced: false, hasUnconfirmed: false };
  }

  try {
    const res = await fetch(`https://addressvalidation.googleapis.com/v1:validateAddress?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: { regionCode, addressLines: lines } }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn(`[address-validation] HTTP ${res.status}: ${body.slice(0, 200)}`);
      return { status: STATUSES.API_UNAVAILABLE, inServiceArea: null, county: null, granularity: null, normalized: null, hasInferred: false, hasReplaced: false, hasUnconfirmed: false };
    }
    const data = await res.json();
    const county = await reverseGeocodeCounty(data.result?.geocode?.location, key);
    const out = deriveStatus(data.result, county);
    out.providerResponseId = data.responseId || null;
    return out;
  } catch (err) {
    logger.error(`[address-validation] error: ${err.message}`);
    return { status: STATUSES.API_UNAVAILABLE, inServiceArea: null, county: null, granularity: null, normalized: null, hasInferred: false, hasReplaced: false, hasUnconfirmed: false };
  }
}

module.exports = { validateAddress, deriveStatus, STATUSES, VERSION };
