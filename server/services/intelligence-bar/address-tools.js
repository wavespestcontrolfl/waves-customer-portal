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
  parseRawAddress, normalizeStreetLine, normalizeState, splitStreetLineUnit, splitUnitFirstLine, normalizeUnitLine,
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
const cleanText = value => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

// What the operator gave, split into parts. Explicit city/state/zip win over
// anything parsed out of the address text. The unit is peeled with the shared
// address-normalizer grammar (trailing "Apt 4" / "# 4", or a unit-first
// "Apt 4, 100 Example Way"), so a street word such as "Space" is never taken
// for a unit and the unit the operator gave is handed back to be saved.
const TRAILING_STATE = /\s+(fl|florida)$/i;
function givenParts(input) {
  const text = cleanText(input.address);
  const unitFirst = splitUnitFirstLine(text);
  const parsed = parseRawAddress(unitFirst ? unitFirst.rest : text);
  const { street, unit } = splitStreetLineUnit(cleanText(parsed.line1) || text);
  const parsedCity = cleanText(parsed.city);
  const stateInCity = !parsed.state && TRAILING_STATE.test(parsedCity);
  return {
    street: normalizeStreetLine(street),
    unit: normalizeUnitLine(unitFirst ? unitFirst.unit : unit),
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
  if (usable) parts.push('Save Google\'s normalized spelling, city and ZIP, not the input.');
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

async function executeAddressTool(toolName, input) {
  if (toolName !== CHECK_ADDRESS_TOOL_NAME) return { error: `Unknown tool: ${toolName}` };
  const address = cleanText(input?.address);
  if (address.length < 3) {
    return { status: 'invalid_input', note: 'check_address needs the street address as heard. Ask the operator for it.' };
  }
  const given = givenParts({ ...input, address });
  const result = await validateAddress({
    addressLines: providerLines({ ...input, address }, given),
    administrativeArea: given.state || DEFAULT_STATE,
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  });
  return shape(result, given);
}

module.exports = { ADDRESS_TOOLS, executeAddressTool, CHECK_ADDRESS_TOOL_NAME, CHECK_TIMEOUT_MS };
