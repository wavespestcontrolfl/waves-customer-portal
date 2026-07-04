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

// Bare fetch() has no response deadline, so a stalled Google connection would
// hang whatever run called validateAddress (e.g. the call-recording processor,
// which otherwise sits in processing_status='processing' until the 10-min
// stale reclaim). Every fetch below runs under an AbortSignal that fires after
// this per-call cap, combined with any caller-supplied run deadline.
const ADDRESS_VALIDATION_TIMEOUT_MS = Number(process.env.ADDRESS_VALIDATION_TIMEOUT_MS) || 30000;

function requestSignal(signal) {
  const timeout = AbortSignal.timeout(ADDRESS_VALIDATION_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

const STATUSES = {
  NOT_ATTEMPTED: 'not_attempted',       // flag off / no key / no address
  VALIDATED_ACCEPT: 'validated_accept', // PREMISE/SUB_PREMISE, in-area, no caller value overridden (benign normalization/fill ok) — auto-routable
  CORRECTED: 'corrected',               // PREMISE/SUB_PREMISE, in-area, Google OVERRODE a caller-given value (e.g. bad zip) — trust the correction, auto-routable
  CONFIRM_NEEDED: 'confirm_needed',     // resolved but a component is UNCONFIRMED, or county is unknown — needs a human
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
async function reverseGeocodeCounty(location, key, signal = null) {
  if (!location || typeof location.latitude !== 'number') return null;
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${location.latitude},${location.longitude}`
      + `&result_type=administrative_area_level_2&key=${key}`;
    const res = await fetch(url, { signal });
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
  // Genuinely unverifiable: Google couldn't confirm a component, or we can't
  // establish the county. Never auto-route these — hand to a human.
  if (verdict.hasUnconfirmedComponents || inServiceArea !== true) {
    return { status: STATUSES.CONFIRM_NEEDED, ...base };
  }
  // hasReplaced = Google OVERRODE a value the caller gave (e.g. bad zip 61419 →
  // 34219). That's a real correction — policy is to trust it and auto-route on
  // the normalized address, but the status records that the input was rewritten.
  // (hasInferred alone is benign: Google expands "Ave W"→"Avenue West" and fills
  // a missing zip on essentially every address — that stays validated_accept.)
  if (verdict.hasReplacedComponents) {
    return { status: STATUSES.CORRECTED, ...base };
  }
  return { status: STATUSES.VALIDATED_ACCEPT, ...base };
}

async function validateAddress({ addressLines, regionCode = 'US', signal = null } = {}) {
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
    const abortSignal = requestSignal(signal);
    const res = await fetch(`https://addressvalidation.googleapis.com/v1:validateAddress?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: { regionCode, addressLines: lines } }),
      signal: abortSignal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn(`[address-validation] HTTP ${res.status}: ${body.slice(0, 200)}`);
      return { status: STATUSES.API_UNAVAILABLE, inServiceArea: null, county: null, granularity: null, normalized: null, hasInferred: false, hasReplaced: false, hasUnconfirmed: false };
    }
    const data = await res.json();
    // Fresh requestSignal, NOT the abortSignal above: that timer started
    // before the validateAddress POST, so by now most of its 30s may be
    // spent and the reverse geocode would abort near-instantly — swallowed
    // as county=null, which downgrades otherwise-valid in-area addresses to
    // confirm_needed. Reverse geocoding gets its own per-call cap; the
    // caller's run deadline still applies through `signal`.
    const county = await reverseGeocodeCounty(data.result?.geocode?.location, key, requestSignal(signal));
    const out = deriveStatus(data.result, county);
    out.providerResponseId = data.responseId || null;
    return out;
  } catch (err) {
    logger.error(`[address-validation] error: ${err.message}`);
    return { status: STATUSES.API_UNAVAILABLE, inServiceArea: null, county: null, granularity: null, normalized: null, hasInferred: false, hasReplaced: false, hasUnconfirmed: false };
  }
}

// Build Google AV `addressLines` from the extraction's nested service_address.
// Two lines (street, then "city ST zip") so AV parses locality/postal cleanly.
// Returns [] when there's no street AND no city — nothing worth validating.
function buildAddressLines(serviceAddress) {
  const sa = serviceAddress || {};
  const line1 = [sa.street_line_1, sa.street_line_2].filter(Boolean).join(' ').trim();
  const line2 = [sa.city, sa.state, sa.postal_code].filter(Boolean).join(' ').trim();
  if (!line1 && !sa.city) return [];
  return [line1, line2].filter(Boolean);
}

module.exports = { validateAddress, deriveStatus, buildAddressLines, STATUSES, VERSION };
