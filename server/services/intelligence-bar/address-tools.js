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
  const parsed = parseRawAddress(withoutUnit.join(', '));
  // The locality parser files a trailing direction ("100 17th St W") as the
  // city. A city that is only a direction word is part of the street.
  const directionAsCity = Boolean(parsed.city) && compareKey(parsed.city) in DIRECTION_KEYS;
  // A comma-free whole address ("100 Main St Apt 4 Sarasota FL 34236") only
  // shows its unit once the locality is parsed off the end.
  const parsedLine = splitStreetLineUnit(cleanText(parsed.line1) || withoutUnit[0] || text);
  const unitText = rawUnit || parsedLine.unit;
  const street = [parsedLine.street || cleanText(parsed.line1) || withoutUnit[0] || text, directionAsCity ? cleanText(parsed.city) : ''].filter(Boolean).join(' ');
  const parsedCity = directionAsCity ? '' : cleanText(parsed.city);
  const stateInCity = !parsed.state && TRAILING_STATE.test(parsedCity);
  return {
    street: normalizeStreetLine(street),
    unit: normalizeUnitLine(unitText),
    city: cleanText(input.city) || (stateInCity ? parsedCity.replace(TRAILING_STATE, '') : parsedCity),
    state: normalizeState(cleanText(input.state) || cleanText(parsed.state) || (stateInCity ? 'FL' : '')) || '',
    zip: (cleanText(input.zip) || cleanText(parsed.zip)).slice(0, 5),
    // Google returns a five-digit ZIP, so a ZIP+4 suffix cannot be checked.
    zipPlus4: (`${cleanText(input.zip)} ${text}`.match(/\b\d{5}-(\d{4})\b/) || [])[1] || '',
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
  // No rule can tell a misspelled state from a city word in free text
  // ("Sarasota Flordia"), so the assumption is always stated instead.
  if (!given.state) parts.push(`No state was read from the input, so ${DEFAULT_STATE} was assumed: tell the operator, and ask if any word of the input could be another state.`);
  if (given.zipPlus4) parts.push(`The ZIP+4 suffix "-${given.zipPlus4}" was not checked and is not in the normalized ZIP: save the five-digit ZIP and tell the operator the suffix was left out.`);
  if (given.unit) parts.push(`Google does not check the unit or apartment number: keep "${given.unit}". Put it in the second address line when the tool has one; otherwise add it at the end of the street line.`);
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
    state_assumed: given.state ? null : DEFAULT_STATE,
    zip_plus4_unchecked: given.zipPlus4 || null,
    county: result.county || null,
    in_service_area: typeof result.inServiceArea === 'boolean' ? result.inServiceArea : null,
    changed,
    unconfirmed: Boolean(result.hasUnconfirmed),
    missing: Array.isArray(result.missingComponents) ? result.missingComponents : [],
    note: noteFor(status, changed, given, result),
  };
}

// ── Address changes always show a card ─────────────────────────────────
// Rounds 2 and 3 of the review on #6297 showed that proving "this write was
// checked" from a ledger of earlier tool calls does not hold (ordering in
// one model message, partial updates, units, states). The rule is simpler
// and total: a write that carries address text (street, unit, city, state or
// ZIP) is never committed without a confirm card (owner-direct.js asks changesAddress), so
// the operator sees the exact address before it is saved. check_address
// supplies Google's spelling and ZIP for that card; the prompt tells the
// model to run it first.
const WRITE_ADDRESS_FIELDS = {
  add_customer_property: input => input,
  update_customer_property: input => input,
  create_customer: input => input,
  correct_invoice_address: input => input,
  update_customer: input => input.updates,
  bulk_update_customers: input => input.updates,
  update_lead_contact: input => ({ ...input, address_line1: input.address }),
};
const ADDRESS_FIELD_NAMES = ['address_line1', 'address_line2', 'city', 'state', 'zip'];
// set_primary_property is deliberately not an address writer here: it takes
// ids only and chooses among the customer's SAVED properties, so it brings in
// no new address text (no spelling, no ZIP to guess). Each saved property's
// address already went through its own card. It stays an owner-direct edit,
// as the owner-ratified W4 workflow records (docs/intelligence-bar-operator-workflows.md).

// True when the call carries address text to save.
function changesAddress(toolName, input) {
  const fields = WRITE_ADDRESS_FIELDS[toolName]?.(input || {});
  if (!fields || typeof fields !== 'object') return false;
  return ADDRESS_FIELD_NAMES.some(name => cleanText(String(fields[name] ?? '')) !== '');
}

// A state-like word the normalizer does not know, written into the address
// text itself ("100 Example Way, Sarasota, Flordia 34236"). With three or more
// comma parts (street, city, state) the last part, minus its ZIP, must be a
// state; otherwise the check would silently fall back to the FL hint.
const COUNTRY_TAIL_RE = /^(?:usa|u\.s\.a\.?|u\.s\.?|us|united states(?: of america)?)[.,;:!?]?$/i;
function embeddedStateProblem(text) {
  const rawUnit = unitAnywhereOnLine(text).toLowerCase();
  const parts = (splitUnitFirstLine(text)?.rest || text).split(',').map(cleanText).filter(Boolean)
    .filter(part => !(rawUnit && ` ${rawUnit} `.includes(` ${part.toLowerCase()} `)));
  // A pasted address may end with a country ("…, FL 34236, USA"); the shared
  // parser strips it, so it is not the state part.
  while (parts.length && COUNTRY_TAIL_RE.test(parts[parts.length - 1])) parts.pop();
  if (parts.length < 3) return null;
  const candidate = parts[parts.length - 1].replace(/\b\d{5}(?:-\d{4})?\b/g, '').replace(/\s+(?:usa|u\.s\.a\.?|u\.s\.?|us|united states(?: of america)?)[.,;:!?]?$/i, '').trim();
  if (!candidate || !/^[A-Za-z .]+$/.test(candidate)) return null;
  return normalizeState(candidate) ? null : candidate;
}

async function executeAddressTool(toolName, input) {
  if (toolName !== CHECK_ADDRESS_TOOL_NAME) return { error: `Unknown tool: ${toolName}` };
  const address = cleanText(input?.address);
  if (address.length < 3) {
    return { status: 'invalid_input', note: 'check_address needs the street address as heard. Ask the operator for it.' };
  }
  const badState = cleanText(input.state) && !normalizeState(cleanText(input.state)) ? cleanText(input.state) : (!cleanText(input.state) && embeddedStateProblem(address));
  if (badState) {
    return { status: 'invalid_input', note: `"${String(badState).slice(0, 30)}" is not a state this check recognizes. Ask the operator which state it is; do not assume ${DEFAULT_STATE}.` };
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
  changesAddress, WRITE_ADDRESS_FIELDS,
};
