/**
 * Intelligence Bar — address check
 * server/services/intelligence-bar/address-tools.js
 *
 * One READ tool, check_address: sends the operator's address text to Google
 * (server/services/address-validation) and reports what Google says: its
 * spelling of the street, city, state, ZIP and county, the service-area flag
 * and a plain verdict. The bar runs it before any address write, so a dictated
 * street with no ZIP gets Google's ZIP instead of a guessed one, and a
 * misspelled street name from a call transcript is caught before it is saved
 * (2026-10-12 production use).
 *
 * The tool does NOT parse the operator's text. Fourteen review rounds on #6297
 * showed that no rule splits free text into street / unit / city / state / ZIP
 * without a new miss ("Unit PT", "100 Broadway Sarasota FL 34236"), so the
 * text goes to Google as given, comes back as `as_given` beside Google's
 * version, and the operator compares the two.
 *
 * Reads no rows and writes nothing: no database, no customer lookup. The
 * provider is fail-open (ADDRESS_VALIDATION_ENABLED off, no key, a Google
 * error or a timeout all return not_attempted / api_unavailable); this tool
 * turns those into "could not verify, ask the operator", never a guess.
 */

const { validateAddress, STATUSES } = require('../address-validation');
const { servedSouthHillsborough } = require('../service-area');
const { isCountyGap } = require('../property-lookup/address-status');
const { normalizeState } = require('../../utils/address-normalizer');

const CHECK_ADDRESS_TOOL_NAME = 'check_address';
// The provider has its own per-request timeout (default 30 s). The bar's tool
// loop must not wait that long on a hung Google call.
const CHECK_TIMEOUT_MS = 8000;
const DEFAULT_STATE = 'FL';

const ADDRESS_TOOLS = [
  {
    name: CHECK_ADDRESS_TOOL_NAME,
    description: `Check a street address with Google (Address Validation). Returns the address exactly as given (as_given) beside Google's version (normalized: street line, city, state, ZIP), the county, whether it is inside the service area, whether Google replaced or added a part, and a plain verdict. Google does not check a unit, apartment, suite, building, floor or lot, and this tool does not read one out: carry the unit over from the operator's own words. Read only: it saves nothing and looks up no customer.
Run it BEFORE you save or change any street address (add_customer_property, update_customer, update_lead_contact, create_customer, correct_invoice_address), and whenever the operator asks whether an address or its spelling is right. Pass the address exactly as heard or typed: the street line alone, or the whole address. Add city, state or zip only when the operator gave them. Never guess a ZIP: use the zip from this tool. If status is not_attempted or api_unavailable, Google could not check it: say so and ask the operator for the ZIP.
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

const cleanText = (value, max = Infinity) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');

// What the operator gave, cleaned and capped to the schema lengths; only the
// fields that were passed.
function asGiven(input) {
  const fields = { address: cleanText(input?.address, 200), city: cleanText(input?.city, 80), state: cleanText(input?.state, 30), zip: cleanText(input?.zip, 10) };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value));
}

// The address lines Google gets: the text as given, plus a second line for the
// city, state or ZIP the operator passed separately.
function providerLines(given) {
  const separate = [given.city, given.state, given.zip].filter(Boolean).join(' ');
  return [given.address, separate].filter(Boolean);
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

const UNVERIFIED_STATUSES = new Set([STATUSES.NOT_ATTEMPTED, STATUSES.API_UNAVAILABLE]);
const ACCEPTED_STATUSES = new Set([STATUSES.VALIDATED_ACCEPT, STATUSES.CORRECTED]);

// The note is built from the status and two booleans only; it never reads the
// operator's text. Each entry is [applies, sentence], in the order told.
const ADVICE = [
  [f => f.unverified,
    'The address could NOT be verified. Say so, and ask the operator for the ZIP and the exact spelling. Do not guess a ZIP or fix the spelling yourself.'],
  [f => f.status === STATUSES.OUT_OF_SERVICE_AREA,
    'Tell the operator it is outside the service area, and save nothing until they decide.'],
  [f => !f.unverified && !f.accepted && f.status !== STATUSES.OUT_OF_SERVICE_AREA,
    'Do not save this address yet. Show the operator what Google returned and what is missing or unconfirmed, and ask.'],
  [f => f.accepted,
    'Read Google\'s normalized address back to the operator next to their own words (as_given) before saving. Save Google\'s street spelling, city, state and ZIP only after they agree.'],
  [f => f.accepted && f.replaced,
    'Google replaced part of what was given; it does not say which part. If the operator insists their version is right, save their version and say it is unverified.'],
  [f => f.accepted,
    'Google does not check a unit, apartment, suite, building, floor or lot. If the operator\'s words contain one, carry it over exactly as they said it; if you are not sure what the unit is, ask.'],
  [f => f.hintUsed && !f.unverified,
    `No state field was passed, so Florida (${DEFAULT_STATE}) was used as a hint: if Google's state is not the one the operator meant, ask.`],
];

function noteFor(status, result, hintUsed) {
  const flags = { status, unverified: UNVERIFIED_STATUSES.has(status), accepted: ACCEPTED_STATUSES.has(status), replaced: Boolean(result.hasReplaced), hintUsed };
  return ADVICE.filter(([applies]) => applies(flags)).map(([, text]) => text).join(' ');
}

// The provider's county rule knows Manatee, Sarasota and Charlotte only, so it
// reports the six served south-Hillsborough towns as outside the service area.
// The shared predicate (service-area.js servedSouthHillsborough) decides:
// Hillsborough County AND a served town, by Google's city or ZIP. The status is
// re-derived the way the provider derives it for an in-area address.
function servedHillsborough(result, state) {
  // An explicit non-Florida state from the operator is the provider's veto; keep it.
  if (state && state !== DEFAULT_STATE) return result;
  if (result.status !== STATUSES.OUT_OF_SERVICE_AREA) return result;
  const n = result.normalized || {};
  if (normalizeState(n.state) !== DEFAULT_STATE) return result;
  if (!servedSouthHillsborough(result.county, { city: n.city, zip: n.postal_code })) return result;
  let status = STATUSES.VALIDATED_ACCEPT;
  if (result.hasUnconfirmed) status = STATUSES.CONFIRM_NEEDED;
  else if (result.hasReplaced) status = STATUSES.CORRECTED;
  return { ...result, status, inServiceArea: true };
}

// Google confirmed a complete premise and only the separate county lookup
// failed (shared rule: property-lookup/address-status.js isCountyGap). That is
// a provider gap, not an address defect.
const COUNTY_GAP_NOTE = 'Google matched this address, but the county lookup that decides the service area failed just now. The address itself is not in doubt: read Google\'s normalized address back to the operator next to their own words before saving, and say the service area could not be checked. Google does not check a unit, apartment, suite, building, floor or lot: carry any unit over exactly as the operator said it.';

// Google returns a five-digit ZIP. A ZIP+4 the operator gave is never dropped
// silently: the result says so (a format test on the input, not a parse).
const ZIP_PLUS4_RE = /\b\d{5}-\d{4}\b/;
const ZIP_PLUS4_NOTE = 'The operator gave a ZIP+4. Google\'s ZIP has five digits and the four-digit suffix was not checked: tell the operator the suffix is left out, or keep their ZIP+4 if they ask for it.';

// The service area is in Florida. The provider's county rule matches county
// NAMES (a "Charlotte County" exists in Virginia), and this tool asks it not
// to read a state from the text, so the state Google itself resolved decides:
// any resolved state other than Florida is outside the service area.
function outsideFlorida(result) {
  const googleState = normalizeState(result.normalized?.state);
  if (!googleState || googleState === DEFAULT_STATE) return result;
  return { ...result, status: STATUSES.OUT_OF_SERVICE_AREA, inServiceArea: false };
}

// The state FIELD is a hard constraint: when the operator passed one and
// Google resolved the address in a different state, the result is held for
// confirmation, whatever Google's own verdict was. (No state is read from the
// address text; that is Google's job.)
function heldOnStateMismatch(result, state) {
  const googleState = normalizeState(result.normalized?.state);
  // An out-of-area verdict is already a hold and stays as it is.
  if (!state || !googleState || googleState === state || result.status === STATUSES.OUT_OF_SERVICE_AREA) return result;
  return { ...result, status: STATUSES.CONFIRM_NEEDED, inServiceArea: null, stateMismatch: true };
}
const STATE_MISMATCH_NOTE = 'Google resolved this address in a different state than the state the operator gave. Do not save it: tell the operator both states and ask which is right.';

function shape(providerResult, given, state) {
  const result = heldOnStateMismatch(servedHillsborough(outsideFlorida(providerResult), state), state);
  // isCountyGap also covers "only the unit is missing"; that stays an
  // explicit hold, so only a result with nothing missing is a pure lookup gap.
  const missing = Array.isArray(result.missingComponents) ? result.missingComponents : [];
  const countyGap = !result.stateMismatch && isCountyGap(result) && missing.length === 0 && result.status === STATUSES.CONFIRM_NEEDED;
  const zipPlus4 = ZIP_PLUS4_RE.test(`${given.address || ''} ${given.zip || ''}`);
  const n = result.normalized;
  // The tool asks the validator not to read a state from the text, so the FL
  // hint is in use exactly when no state field was passed.
  const hintUsed = !state;
  return {
    status: result.status,
    verdict: countyGap ? 'Google matched the address; the service-area lookup is unavailable.' : (VERDICTS[result.status] || 'Google returned a result this tool does not recognize.'),
    service_area_lookup_failed: countyGap,
    as_given: given,
    normalized: n ? { address_line1: n.street_line_1, city: n.city, state: n.state, zip: n.postal_code } : null,
    county: result.county || null,
    in_service_area: typeof result.inServiceArea === 'boolean' ? result.inServiceArea : null,
    google_replaced: Boolean(result.hasReplaced),
    google_inferred: Boolean(result.hasInferred),
    unconfirmed: Boolean(result.hasUnconfirmed),
    missing,
    zip_plus4_given: zipPlus4,
    state_hint_used: hintUsed ? DEFAULT_STATE : null,
    note: [result.stateMismatch ? STATE_MISMATCH_NOTE : '', countyGap ? COUNTY_GAP_NOTE : noteFor(result.status, result, hintUsed), zipPlus4 ? ZIP_PLUS4_NOTE : ''].filter(Boolean).join(' '),
    state_mismatch: Boolean(result.stateMismatch),
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

// A rejected input is a tool failure in the standard shape (the check never
// ran), with a refusal code so it is not counted as a system fault.
const invalidInput = message => ({ status: 'invalid_input', error: message, code: 'invalid_input', note: message });

async function executeAddressTool(toolName, input) {
  if (toolName !== CHECK_ADDRESS_TOOL_NAME) return { error: `Unknown tool: ${toolName}` };
  const given = asGiven(input);
  if (!given.address || given.address.length < 3) {
    return invalidInput('check_address needs the street address as heard. Ask the operator for it.');
  }
  // Only an explicit state field is checked; the address text is never read.
  const state = given.state ? normalizeState(given.state) : '';
  if (given.state && !state) {
    // The rejected value is not echoed: a misplaced street or name in this
    // field must not reach a log or a health event.
    return invalidInput(`The state field is not a state this check recognizes. Ask the operator which state it is; do not assume ${DEFAULT_STATE}.`);
  }
  const result = await validateAddress({
    addressLines: providerLines(given),
    administrativeArea: state || DEFAULT_STATE,
    stateFromText: false,
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  });
  return shape(result, given, state);
}

module.exports = {
  ADDRESS_TOOLS, executeAddressTool, CHECK_ADDRESS_TOOL_NAME, CHECK_TIMEOUT_MS,
  changesAddress, WRITE_ADDRESS_FIELDS,
};
