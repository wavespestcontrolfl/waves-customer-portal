/**
 * Intelligence Bar — address check
 * server/services/intelligence-bar/address-tools.js
 *
 * One READ tool, check_address: validates a free-text street address with
 * Google (server/services/address-validation) and returns Google's spelling,
 * city, state, ZIP, county, service-area flag and a plain verdict. The bar
 * runs it before any address write, so a dictated street with no ZIP gets
 * Google's ZIP instead of a guessed one, and a misspelled street name from a
 * call transcript is caught before it is saved (2026-10-12 production use).
 *
 * Reads no rows and writes nothing: no database, no customer lookup. The
 * provider is fail-open (ADDRESS_VALIDATION_ENABLED off, no key, a Google
 * error or a timeout all return not_attempted / api_unavailable); this tool
 * turns those into "could not verify, ask the operator", never a guess.
 */

const { validateAddress, STATUSES } = require('../address-validation');
const {
  parseRawAddress, normalizeStreetLine, normalizeState, splitStreetLineUnit, splitUnitFirstLine, unitAnywhereOnLine, normalizeUnitLine,
} = require('../../utils/address-normalizer');

const CHECK_ADDRESS_TOOL_NAME = 'check_address';
// The provider has its own per-request timeout (default 30 s). The bar's tool
// loop must not wait that long on a hung Google call.
const CHECK_TIMEOUT_MS = 8000;
const DEFAULT_STATE = 'FL';

const ADDRESS_TOOLS = [
  {
    name: CHECK_ADDRESS_TOOL_NAME,
    description: `Check a street address with Google (Address Validation). Returns Google's spelling of the street, the city, state, ZIP and county, whether it is inside the service area, the unit or apartment the operator gave (Google does not check it), and a plain verdict. Read only: it saves nothing and looks up no customer.
Run it BEFORE you save or change any street address (add_customer_property, update_customer, update_customer_property, update_lead_contact, create_customer, create_appointment with an address), and whenever the operator asks whether an address or its spelling is right. Pass the address exactly as heard or typed: the street line alone, or the whole address. Add city, state or zip only when the operator gave them. Never guess a ZIP: use the zip from this tool. If status is not_attempted or api_unavailable, Google could not check it: say so and ask the operator for the ZIP.
Use for: "add 100 Example Way to this customer", "is that street spelled right?", "fix the address using Google", "what ZIP is that?"`,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        address: { type: 'string', minLength: 3, maxLength: 200, description: 'The street line or the whole address, as heard or typed. Do not correct the spelling yourself.' },
        city: { type: 'string', maxLength: 80, description: 'City, only if the operator gave it.' },
        state: { type: 'string', maxLength: 30, description: `State, only if the operator gave it (default ${DEFAULT_STATE}).` },
        zip: { type: 'string', maxLength: 10, description: 'ZIP code, only if the operator gave it. Never guess one.' },
      },
      required: ['address'],
    },
  },
];

const DIRECTIONS = { north: 'n', south: 's', east: 'e', west: 'w', northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw' };
// Case, punctuation and a spelled-out direction ("North" / "N") are not differences.
const compareKey = value => String(value).toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).map(w => DIRECTIONS[w] || w).join('');
const sameText = (a, b) => compareKey(a) === compareKey(b);
const DIRECTION_KEYS = Object.fromEntries(Object.values(DIRECTIONS).map(key => [key, true]));
const cleanText = value => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

// What the operator gave, split into parts. Explicit city/state/zip win over
// anything parsed out of the address text. The unit is peeled with the shared
// address-normalizer grammar (trailing "Apt 4" / "# 4", or a unit-first
// "Apt 4, 100 Example Way"), so a street word such as "Space" is never taken
// for a unit and the unit the operator gave is handed back to be saved.
const TRAILING_STATE = /\s+(fl|florida)$/i;
function givenParts(input) {
  const text = cleanText(input.address);
  // The whole unit is read from the ORIGINAL text first (trailing, its own
  // comma segment, or unit-first; "Bldg 2 Apt 4" stays whole), then taken
  // out before the locality parse, which would file "Apt 4" under the city.
  const rawUnit = unitAnywhereOnLine(text);
  // Each comma segment that is a whole part of the unit ("Bldg 2", "Apt 4") goes.
  const unitWords = ` ${rawUnit.toLowerCase()} `;
  const withoutUnit = (splitUnitFirstLine(text)?.rest || text).split(',').map(cleanText).filter(Boolean)
    .map(segment => splitStreetLineUnit(segment).street || segment)
    .filter(segment => !unitWords.includes(` ${segment.toLowerCase()} `));
  // With the city or ZIP passed separately the text is a street line: the
  // locality parser would file a trailing direction ("17th St W") as a city.
  const streetOnly = Boolean(cleanText(input.city) || cleanText(input.zip));
  const parsed = streetOnly ? { line1: withoutUnit[0] || '' } : parseRawAddress(withoutUnit.join(', '));
  // The locality parser files a trailing direction ("100 17th St W") as the
  // city. A city that is only a direction word is part of the street.
  const directionAsCity = Boolean(parsed.city) && compareKey(parsed.city) in DIRECTION_KEYS;
  const street = [cleanText(parsed.line1) || withoutUnit[0] || text, directionAsCity ? cleanText(parsed.city) : ''].filter(Boolean).join(' ');
  const parsedCity = directionAsCity ? '' : cleanText(parsed.city);
  const stateInCity = !parsed.state && TRAILING_STATE.test(parsedCity);
  return {
    street: normalizeStreetLine(street),
    unit: normalizeUnitLine(rawUnit),
    city: cleanText(input.city) || (stateInCity ? parsedCity.replace(TRAILING_STATE, '') : parsedCity),
    state: normalizeState(cleanText(input.state) || cleanText(parsed.state) || (stateInCity ? 'FL' : '')) || '',
    zip: (cleanText(input.zip) || cleanText(parsed.zip)).slice(0, 5),
  };
}

// The address lines Google gets: the text as given, plus a second line for the
// city, state or ZIP the operator passed separately.
function providerLines(input, given) {
  const separate = [input.city && given.city, input.state && given.state, input.zip && given.zip].filter(Boolean).join(' ');
  return [cleanText(input.address), separate].filter(Boolean);
}

// Components where Google's value differs from what was given. A missing
// input part Google filled in (the ZIP, the city) is listed with input null.
function changedParts(given, normalized) {
  if (!normalized) return [];
  const pairs = [
    ['street', given.street, normalized.street_line_1 && normalizeStreetLine(normalized.street_line_1)],
    ['city', given.city, normalized.city],
    // A state nobody stated (defaulted to FL for the search) is not a change.
    ['state', given.state, given.state && normalizeState(normalized.state)],
    ['zip', given.zip, (normalized.postal_code || '').slice(0, 5)],
  ];
  return pairs
    .filter(([, input, google]) => google && !(input && sameText(input, google)))
    .map(([component, input, google]) => ({ component, input: input || null, google }));
}

const VERDICTS = {
  [STATUSES.VALIDATED_ACCEPT]: 'Google confirmed this address.',
  [STATUSES.CORRECTED]: 'Google confirmed this address but replaced part of what was given.',
  [STATUSES.CONFIRM_NEEDED]: 'Google found a likely match but could not confirm all of it.',
  [STATUSES.MISSING_COMPONENT]: 'Google could not match a full street address: a part is missing.',
  [STATUSES.AMBIGUOUS]: 'Google could not tell which address was meant.',
  [STATUSES.OUT_OF_SERVICE_AREA]: 'Google found the address, but it is outside the service area.',
  [STATUSES.API_UNAVAILABLE]: 'Google could not check this address right now.',
  [STATUSES.NOT_ATTEMPTED]: 'Address checking is off, so this address was not verified.',
};

function noteFor(status, changed, given, result) {
  if (status === STATUSES.NOT_ATTEMPTED || status === STATUSES.API_UNAVAILABLE) {
    return 'The address could NOT be verified. Say so, and ask the operator for the ZIP and the exact spelling. Do not guess a ZIP or fix the spelling yourself.';
  }
  const usable = status === STATUSES.VALIDATED_ACCEPT || status === STATUSES.CORRECTED;
  const parts = [];
  const opaqueCorrection = status === STATUSES.CORRECTED && !changed.some(c => c.input);
  if (opaqueCorrection) parts.push('Google replaced part of this address but the replaced part cannot be shown here (it may be the unit). Do not save yet: read the normalized address and the unit back to the operator and ask if both are right.');
  else if (usable) parts.push('Save Google\'s normalized spelling, city and ZIP, not the input.');
  else if (status === STATUSES.OUT_OF_SERVICE_AREA) parts.push('Tell the operator it is outside the service area, and save nothing until they decide.');
  else parts.push('Do not save this address yet. Show the operator what Google returned and what is missing or unconfirmed, and ask.');
  if (changed.length) parts.push('Google differs from the input: show the operator both versions and ask before saving (the operator\'s own words, or a call transcript, may be the one that is wrong). If the operator insists their spelling is right, run this check again with their exact words.');
  if (changed.some(c => c.component === 'zip' && !c.input)) parts.push('The ZIP comes from Google, not from the operator: tell them which ZIP you are using.');
  if (!given.city && result.normalized?.city) parts.push('No city was given: confirm Google\'s city with the operator.');
  if (given.unit) parts.push(`Google does not check the unit or apartment number: save "${given.unit}" as the second address line.`);
  return parts.join(' ');
}

function shape(result, given) {
  const n = result.normalized;
  const changed = changedParts(given, n);
  const status = result.status;
  return {
    status,
    verdict: VERDICTS[status] || 'Google returned a result this tool does not recognize.',
    normalized: n ? { address_line1: n.street_line_1, city: n.city, state: n.state, zip: n.postal_code } : null,
    unit: given.unit || null,
    county: result.county || null,
    in_service_area: typeof result.inServiceArea === 'boolean' ? result.inServiceArea : null,
    changed,
    unconfirmed: Boolean(result.hasUnconfirmed),
    missing: Array.isArray(result.missingComponents) ? result.missingComponents : [],
    note: noteFor(status, changed, given, result),
  };
}

// ── Evidence that an address was checked (Codex r2 P1 on #6297) ──────────
// A prompt rule alone lets the model skip check_address or guess a ZIP. The
// route keeps one ledger per request: every finished check records the
// address as given and, when Google answered, as normalized. An address
// write whose street and ZIP are not in the ledger is refused with
// address_check_required, so the model must check first and then save what
// was checked: the street and ZIP, and the city and state when sent, must match one ledger entry.
const WRITE_ADDRESS_FIELDS = {
  add_customer_property: input => input,
  create_customer: input => input,
  correct_invoice_address: input => input,
  update_customer: input => input.updates,
  bulk_update_customers: input => input.updates,
  update_lead_contact: input => ({ address_line1: input.address, zip: input.zip, city: input.city, state: input.state }),
};
const streetKey = line => compareKey(normalizeStreetLine(splitStreetLineUnit(cleanText(line)).street || cleanText(line)));
const zipKey = zip => cleanText(String(zip ?? '')).slice(0, 5);
const stateKey = state => normalizeState(cleanText(String(state ?? ''))) || '';
const addressKey = ({ street, city, state, zip }) => ({
  street: streetKey(street), city: compareKey(cleanText(String(city ?? ''))), state: stateKey(state) || DEFAULT_STATE, zip: zipKey(zip),
});

// The address an address-writing call would save, as comparable keys; null
// when the call needs no check. What this rule protects is the street
// spelling and the ZIP, the two things a model guesses:
//  - a street must come with its ZIP, and both (plus the city and state, when
//    the call sends them) must equal one checked entry;
//  - a ZIP with no street is `partial`: it cannot be matched to a check, so
//    the model must send the street it checked with it;
//  - a city or state change alone (filling a missing city) is not held: it
//    carries neither a street nor a ZIP to verify.
function writtenAddress(toolName, input) {
  const fields = WRITE_ADDRESS_FIELDS[toolName]?.(input || {});
  if (!fields) return null;
  const present = key => Boolean(cleanText(String(fields[key] ?? '')));
  if (!present('address_line1') && !present('zip')) return null;
  if (!present('address_line1') || !present('zip')) return { partial: true };
  const key = addressKey({ street: fields.address_line1, city: fields.city, state: fields.state, zip: fields.zip });
  return { ...key, city: present('city') ? key.city : null, state: present('state') ? key.state : null };
}

const ADDRESS_CHECK_REQUIRED = Object.freeze({
  error: 'This address has not been checked. Run check_address on it first, then save the street, city, state and ZIP that check returned (or exactly the address you checked, if the operator confirms it).',
  code: 'address_check_required',
});
const ADDRESS_PARTIAL = Object.freeze({
  error: 'A street change must carry its ZIP, and a ZIP change must carry its street. Run check_address on the whole address first, then save the street and ZIP it returned together.',
  code: 'address_check_required',
});

function createAddressCheckLedger() {
  const checked = [];
  // City and state are compared when the write sends them.
  const same = (entry, written) => entry.street === written.street && entry.zip === written.zip
    && (written.city === null || entry.city === written.city) && (written.state === null || entry.state === written.state);
  return {
    // Called with every tool result; only a finished check_address records:
    // the address as given and, when Google answered, as normalized.
    record(toolName, input, result) {
      if (toolName !== CHECK_ADDRESS_TOOL_NAME || !result?.status || result.status === 'invalid_input') return;
      const given = givenParts({ ...input, address: cleanText(input?.address) });
      checked.push(addressKey(given));
      const n = result.normalized;
      if (n?.address_line1) checked.push(addressKey({ street: n.address_line1, city: n.city, state: n.state, zip: n.zip }));
    },
    // null when the call may proceed; the refusal result otherwise.
    writeRefusal(toolName, input) {
      const written = writtenAddress(toolName, input);
      if (!written) return null;
      if (written.partial) return { ...ADDRESS_PARTIAL };
      return checked.some(entry => same(entry, written)) ? null : { ...ADDRESS_CHECK_REQUIRED };
    },
  };
}

async function executeAddressTool(toolName, input) {
  if (toolName !== CHECK_ADDRESS_TOOL_NAME) return { error: `Unknown tool: ${toolName}` };
  const address = cleanText(input?.address);
  if (address.length < 3) {
    return { status: 'invalid_input', note: 'check_address needs the street address as heard. Ask the operator for it.' };
  }
  if (cleanText(input.state) && !normalizeState(cleanText(input.state))) {
    return { status: 'invalid_input', note: `"${cleanText(input.state).slice(0, 30)}" is not a state this check recognizes. Ask the operator which state it is; do not assume ${DEFAULT_STATE}.` };
  }
  const given = givenParts({ ...input, address });
  const result = await validateAddress({
    addressLines: providerLines({ ...input, address }, given),
    administrativeArea: given.state || DEFAULT_STATE,
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  });
  return shape(result, given);
}

module.exports = {
  ADDRESS_TOOLS, executeAddressTool, CHECK_ADDRESS_TOOL_NAME, CHECK_TIMEOUT_MS,
  createAddressCheckLedger, writtenAddress, WRITE_ADDRESS_FIELDS,
};
