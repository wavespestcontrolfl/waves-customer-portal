/**
 * On-file address assist for phone-call address validation.
 *
 * Two rescues, both keyed on the caller's ON-FILE address and both requiring
 * the spoken HOUSE NUMBER to equal the on-file house number (a house number
 * that differs means the caller is talking about another property, and the
 * on-file address says nothing about it). Everything is behind
 * GATE_CALL_ADDRESS_ONFILE_ASSIST (callAddressOnFileAssistLive) and is a no-op
 * when the gate is off.
 *
 *   Item 3 — misheard street. "4306 Boone Blade" spoken, "4306 Spoon Blade" on
 *     file: onFileStreetCandidates() hands the on-file street to
 *     recoverStreetAddress() as one more extra candidate. It is NOT trusted on
 *     its own: recovery still needs exactly ONE premise that Google confirms
 *     (house number + the caller's stated ZIP/city), and the office read-back
 *     card is filed exactly as for any other recovery.
 *
 *   Item 4 — street with no city. "7417 Monteverdi" alone made Google resolve
 *     to New Jersey. validateWithOnFileAssist() adds the on-file city + ZIP as
 *     line 2 of that lookup when the request is street-only and the house
 *     number matches. Independently of any match, a street-only request whose
 *     result normalizes to a known NON-Florida state is missing_component (the
 *     street was not resolved), not out_of_service_area (nobody said the
 *     address was out of state).
 */

const { validateAddress, buildAddressLines, STATUSES, SERVICE_STATE } = require('./index');
const { normalizeState } = require('../../utils/address-normalizer');
const { callAddressOnFileAssistLive } = require('../../config/feature-gates');

// The COMPLETE house-number token, not just its leading digit run: "4306A" and
// "4306B", or "12-34" and "12-56", are different premises. Only a plain
// all-digit first token counts; anything else (a letter suffix, a hyphenated
// number) never matches, so the assist stays out of it.
const houseNumberOf = (street) => {
  const first = String(street || '').trim().split(/\s+/)[0].replace(/[.,;]+$/, '');
  return /^\d+$/.test(first) ? first : null;
};
const hasLetters = (s) => /[a-z]/i.test(String(s || ''));
const streetKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// The on-file street is usable only with a house number and a street name, and
// only when the stored state (if any) is the service state.
function onFileStreetParts(knownCaller) {
  const line1 = String(knownCaller?.addressLine1 || '').trim();
  const houseNumber = houseNumberOf(line1);
  const streetName = line1.replace(/^\d+\s*/, '').trim();
  if (!houseNumber || !hasLetters(streetName)) return null;
  const state = String(knownCaller?.addressState || '').trim();
  if (state && normalizeState(state) !== SERVICE_STATE) return null;
  return { houseNumber, streetName };
}

/**
 * Item 3. Street-name candidates from the caller's on-file address for
 * recoverStreetAddress({ extraStreetCandidates }). [] when the gate is off,
 * there is no usable on-file address, the house numbers differ, or the on-file
 * street is the street the caller already gave.
 */
function onFileStreetCandidates({ spokenStreet, knownCaller } = {}) {
  if (!callAddressOnFileAssistLive()) return [];
  const onFile = onFileStreetParts(knownCaller);
  if (!onFile) return [];
  const spoken = String(spokenStreet || '').trim();
  if (!houseNumberOf(spoken) || houseNumberOf(spoken) !== onFile.houseNumber) return [];
  const spokenName = spoken.replace(/^\d+\s*/, '').trim();
  if (streetKey(spokenName) === streetKey(onFile.streetName)) return [];
  return [onFile.streetName];
}

const tokensOf = (text) => String(text || '').toLowerCase().replace(/['\u2019]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);

// Suffix / direction abbreviations read as their long form, so "Monteverdi Wy"
// resembles "Monteverdi Way".
const CANON = {
  st: 'street', ave: 'avenue', av: 'avenue', dr: 'drive', rd: 'road', ln: 'lane', ct: 'court', blvd: 'boulevard',
  cir: 'circle', pl: 'place', trl: 'trail', tr: 'trail', wy: 'way', pkwy: 'parkway', ter: 'terrace', terr: 'terrace',
  n: 'north', s: 'south', e: 'east', w: 'west',
};
const canon = (t) => CANON[t] || t;

function editDistanceAtMost1(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  const [long, short] = a.length > b.length ? [a, b] : [b, a];
  return long.slice(i + 1) === short.slice(i);
}

const tokenMatches = (spoken, onFile) => spoken === onFile || (spoken.length >= 5 && onFile.length >= 5 && editDistanceAtMost1(spoken, onFile));

/**
 * Does the spoken street name plausibly name the on-file street? The spoken
 * name may leave off the on-file suffix / direction ("Monteverdi" for
 * "Monteverdi Way") but must otherwise agree token for token (a one-letter
 * slip is tolerated in words of five letters or more). A bare ordinal ("4th")
 * does not resemble "4th Avenue East": numbered grids repeat the number across
 * streets and avenues.
 */
function streetResemblesOnFile(spokenName, onFileName) {
  const spoken = tokensOf(spokenName).map(canon);
  const onFile = tokensOf(onFileName).map(canon);
  if (!spoken.length || spoken.length > onFile.length) return false;
  if (spoken.length === 1 && /^\d/.test(spoken[0]) && onFile.length > 1) return false;
  return spoken.every((t, i) => tokenMatches(t, onFile[i]));
}

// Words a caller says around an address that carry no geography.
const RAW_FILLER = new Set(['fl', 'florida', 'its', 'it', 'is', 'the', 'at', 'my', 'address', 'a', 'an', 'um', 'uh', 'and', 'yeah', 'yes', 'okay', 'ok', 'so', 'thats', 'that']);

// The structured city / postal_code can be null while raw_text still carries a
// spoken locality ("7417 Monteverdi in Sarasota"). Any raw_text word the
// structured street does not account for (bar filler and the state Florida)
// counts as possible locality evidence, so the request is not street-only.
function rawTextAddsLocality(serviceAddress) {
  const sa = serviceAddress || {};
  const raw = tokensOf(sa.raw_text);
  if (!raw.length) return false;
  const street = new Set(tokensOf(`${sa.street_line_1 || ''} ${sa.street_line_2 || ''}`).flatMap((t) => [t, canon(t)]));
  return raw.some((t) => !street.has(t) && !street.has(canon(t)) && !RAW_FILLER.has(t));
}

/**
 * Extra street candidates for recoverStreetAddress: the decoder's alternatives
 * stay first and untouched (recovery evaluates only the first five, so the
 * on-file street is appended and can never displace a decoder hypothesis).
 */
function withOnFileStreetCandidate({ spokenStreet, knownCaller, decoderCandidates } = {}) {
  const decoder = Array.isArray(decoderCandidates) ? decoderCandidates : [];
  const seen = new Set(decoder.map((c) => streetKey(c)));
  return [...decoder, ...onFileStreetCandidates({ spokenStreet, knownCaller }).filter((c) => !seen.has(streetKey(c)))];
}

/**
 * The on-file address may only vouch for the customer the call finally
 * resolves to, and knownCaller is only the phone-only pre-lookup. Returns
 * knownCaller when Step 3's own inputs agree with it, else null (which makes
 * both assist paths no-ops):
 *   - operator link override: the linked customer (call.customer_id) must be it;
 *   - a call already linked to a DIFFERENT customer: null;
 *   - otherwise the name-aware phone resolution Step 3 runs (`resolveCustomer`,
 *     given an ambiguity out-object) must land on this customer, unambiguously.
 * Gate off: null, and no lookup is made.
 */
async function bindAssistCaller({ knownCaller, callCustomerId = null, hasLinkOverride = false, resolveCustomer } = {}) {
  if (!callAddressOnFileAssistLive() || !knownCaller?.id) return null;
  if (hasLinkOverride) return knownCaller.id === callCustomerId ? knownCaller : null;
  if (callCustomerId && callCustomerId !== knownCaller.id) return null;
  const ambiguity = {};
  const resolved = await Promise.resolve().then(() => resolveCustomer(ambiguity)).catch(() => null);
  return resolved?.id === knownCaller.id && !ambiguity.candidates ? knownCaller : null;
}

const STATE_ONLY_LINE = /^(?:fl|florida)\.?$/i;

// A street-only request: a named street (letters) with no city, no ZIP and no
// stated non-Florida state. `lines` is buildAddressLines' output, so a state
// stated in raw_text ("Main Street CT") shows up as a line-2 state and is NOT
// street-only.
function isStreetOnlyRequest(serviceAddress, lines) {
  const sa = serviceAddress || {};
  if (!hasLetters(sa.street_line_1)) return false;
  if (String(sa.city || '').trim() || String(sa.postal_code || '').trim()) return false;
  if (rawTextAddsLocality(sa)) return false;
  if (!Array.isArray(lines) || lines.length === 0) return false;
  if (lines.length === 1) return true;
  return lines.length === 2 && STATE_ONLY_LINE.test(String(lines[1]).trim());
}

// Line 2 for a street-only lookup: the on-file city + ZIP, only when the spoken
// house number equals the on-file house number. null otherwise.
function onFileLocalityLine(serviceAddress, knownCaller) {
  const onFile = onFileStreetParts(knownCaller);
  const city = String(knownCaller?.addressCity || '').trim();
  const zip = String(knownCaller?.addressZip || '').trim();
  const spokenHouse = houseNumberOf(serviceAddress?.street_line_1);
  if (!onFile || !spokenHouse || spokenHouse !== onFile.houseNumber || !(city || zip)) return null;
  // The on-file geography only vouches for the street the caller is naming.
  const spokenName = String(serviceAddress?.street_line_1 || '').trim().replace(/^\d+\s*/, '');
  if (!streetResemblesOnFile(spokenName, onFile.streetName)) return null;
  return [city, SERVICE_STATE, zip].filter(Boolean).join(' ');
}

/**
 * Item 4. Run address validation for a call's service_address.
 *
 * Gate off: exactly `validate({ addressLines: buildAddressLines(sa), administrativeArea })`,
 * the call the processor made before this module existed.
 *
 * Gate on: a street-only request whose house number matches the on-file house
 * number gets the on-file city + ZIP as line 2 (result stamped
 * `onFileAssist: 'city_zip'`), and a street-only request that still resolves to
 * a known non-Florida state is reclassified out_of_service_area ->
 * missing_component (`reclassifiedFrom` records it; inServiceArea becomes
 * null = unknown).
 */
async function validateWithOnFileAssist({
  serviceAddress, knownCaller = null, outOfServiceFlagged = false, validate = validateAddress,
} = {}) {
  const lines = buildAddressLines(serviceAddress);
  // The validator preserves an explicit state over this hint.
  // Contrary model geography also disables the fallback hint.
  const administrativeArea = outOfServiceFlagged ? null : SERVICE_STATE;
  if (!callAddressOnFileAssistLive() || !isStreetOnlyRequest(serviceAddress, lines)) {
    return validate({ addressLines: lines, administrativeArea });
  }

  const localityLine = !outOfServiceFlagged ? onFileLocalityLine(serviceAddress, knownCaller) : null;
  const sendLines = localityLine ? [lines[0], localityLine] : lines;

  const av = await validate({ addressLines: sendLines, administrativeArea });
  let out = av;
  if (av && av.status === STATUSES.OUT_OF_SERVICE_AREA) {
    const state = normalizeState(av.normalized?.state);
    if (state && state !== SERVICE_STATE) {
      out = { ...av, status: STATUSES.MISSING_COMPONENT, inServiceArea: null, reclassifiedFrom: STATUSES.OUT_OF_SERVICE_AREA };
    }
  }
  return localityLine && out ? { ...out, onFileAssist: 'city_zip' } : out;
}

module.exports = {
  bindAssistCaller,
  onFileStreetCandidates,
  withOnFileStreetCandidate,
  streetResemblesOnFile,
  rawTextAddsLocality,
  validateWithOnFileAssist,
  isStreetOnlyRequest,
};
