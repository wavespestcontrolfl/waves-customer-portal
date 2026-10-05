/**
 * Address status line for the admin property lookup (address-match round 1,
 * PR 4; dark behind GATE_LOOKUP_ADDRESS_STATUS). NO scope effect: it changes
 * no measurement, flag, cache row or price. It tells staff what the address
 * itself is, apart from what the county roll says about it:
 *
 *   confirmed              Google Address Validation resolved it to a premise
 *                          in the service area (corrected = Google rewrote a
 *                          typed component, e.g. a wrong ZIP)
 *   unit_missing           the building is confirmed, the only thing missing
 *                          is the unit / suite number
 *   needs_confirmation     incomplete, unconfirmed or ambiguous
 *   outside_service_area   resolved outside Manatee / Sarasota / Charlotte
 *   unavailable            validation off, no key, timeout or provider error:
 *                          never an address failure
 *
 * plus Google's own business / residential classification of the address
 * (its result.metadata, NOT USPS data; null when it gave none). The county roll's own answer ("not on the roll") is a separate
 * line the route adds from the lookup result.
 *
 * Reuses server/services/address-validation (the provider abstraction the
 * call pipeline already uses; needs ADDRESS_VALIDATION_ENABLED). One call per
 * address per 24 h (in-process memo), bounded: at the cap the provider call is
 * ABORTED, and a second request for the same address joins the call in
 * flight instead of starting another. Fail-open to `unavailable`.
 * Logs carry the state only, never the address.
 */

const logger = require('../logger');
const { lookupAddressStatusLive } = require('../../config/feature-gates');

const STATES = {
  CONFIRMED: 'confirmed',
  UNIT_MISSING: 'unit_missing',
  NEEDS_CONFIRMATION: 'needs_confirmation',
  OUTSIDE_SERVICE_AREA: 'outside_service_area',
  UNAVAILABLE: 'unavailable',
};

const DEFAULT_TIMEOUT_MS = 4000;
const MEMO_TTL_MS = 24 * 60 * 60 * 1000;
const MEMO_MAX = 500;
const memo = new Map();
const inFlight = new Map();

function memoKey(address) {
  return String(address || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function boolOrNull(v) {
  return v === true ? true : (v === false ? false : null);
}

/**
 * Provider-neutral AddressValidationResult -> the status line. Pure.
 */
function addressStatusFromValidation(av) {
  const use = { business: boolOrNull(av?.addressUse?.business), residential: boolOrNull(av?.addressUse?.residential) };
  const status = av?.status;
  if (!av || status === 'api_unavailable' || status === 'not_attempted') return { state: STATES.UNAVAILABLE, use: { business: null, residential: null } };
  if (status === 'validated_accept') return { state: STATES.CONFIRMED, use };
  if (status === 'corrected') return { state: STATES.CONFIRMED, corrected: true, use };
  if (status === 'out_of_service_area') return { state: STATES.OUTSIDE_SERVICE_AREA, use };
  // Google resolved a complete premise with nothing unconfirmed, and the ONLY
  // open point is the county: its reverse-geocode failed or returned none.
  // That is a provider gap, not an address problem — unavailable, so it is
  // not remembered and the next lookup asks again. (The call pipeline keeps
  // its own fail-closed confirm_needed for this case; nothing there changes.)
  if (status === 'confirm_needed' && av.county == null && av.inServiceArea == null && av.hasUnconfirmed !== true
    && (av.granularity === 'PREMISE' || av.granularity === 'SUB_PREMISE')
    && !(Array.isArray(av.missingComponents) && av.missingComponents.length)) {
    return { state: STATES.UNAVAILABLE, use: { business: null, residential: null } };
  }
  // The building resolved to a premise and the ONLY thing Google misses is
  // the unit: a plaza or condo address typed without its suite.
  const missing = Array.isArray(av.missingComponents) ? av.missingComponents : [];
  const premise = av.granularity === 'PREMISE' || av.granularity === 'SUB_PREMISE';
  if (premise && missing.length === 1 && missing[0] === 'subpremise' && av.hasUnconfirmed !== true && av.inServiceArea !== false) {
    return { state: STATES.UNIT_MISSING, use };
  }
  return { state: STATES.NEEDS_CONFIRMATION, use };
}

/**
 * @param {string} address  the typed lookup address
 * @param {{validate?:Function, timeoutMs?:number, now?:Function}} opts
 * @returns {Promise<{state:string, corrected?:boolean, use:{business:boolean|null,residential:boolean|null}, checkedAt:string}|null>}
 *   null while the gate is off (the response is exactly what it was).
 */
async function resolveAddressStatus(address, opts = {}) {
  if (!lookupAddressStatusLive()) return null;
  const now = opts.now || Date.now;
  const key = memoKey(address);
  if (!key) return null;
  const hit = memo.get(key);
  if (hit && now() - hit.at < MEMO_TTL_MS) return hit.value;
  // One provider call per address at a time: a second lookup of the same
  // address while the first is still asking joins it.
  if (inFlight.has(key)) return inFlight.get(key);
  const pending = askProvider(address, key, opts, now).finally(() => inFlight.delete(key));
  inFlight.set(key, pending);
  return pending;
}

async function askProvider(address, key, opts, now) {
  const validate = opts.validate || ((lines, { signal } = {}) => require('../address-validation').validateAddress({ addressLines: lines, administrativeArea: 'FL', signal }));
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  // At the cap the provider call is aborted, never left running under its
  // own longer timeout.
  const controller = new AbortController();
  let av = null;
  let timer = null;
  try {
    av = await Promise.race([
      validate([String(address).trim()], { signal: controller.signal }),
      new Promise((resolve) => { timer = setTimeout(() => { controller.abort(); resolve(null); }, timeoutMs); }),
    ]);
  } catch (err) {
    logger.warn(`[address-status] validation failed: ${err.message}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
  const value = { ...addressStatusFromValidation(av), checkedAt: new Date(now()).toISOString() };
  // An unavailable answer is not remembered: the next lookup tries again.
  if (value.state !== STATES.UNAVAILABLE) {
    if (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value);
    memo.set(key, { at: now(), value });
  }
  logger.info(`[address-status] ${value.state}`);
  return value;
}

module.exports = { STATES, resolveAddressStatus, addressStatusFromValidation, _private: { memo, inFlight, memoKey, DEFAULT_TIMEOUT_MS } };
