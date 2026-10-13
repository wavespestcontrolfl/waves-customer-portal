/**
 * check_address (address-tools.js): Google address check for the Intelligence
 * Bar. validateAddress is mocked. The tool sends the operator's text to Google
 * as given and reports what Google says; it parses nothing. Synthetic
 * addresses only.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/address-validation', () => ({
  validateAddress: jest.fn(),
  STATUSES: {
    NOT_ATTEMPTED: 'not_attempted', VALIDATED_ACCEPT: 'validated_accept', CORRECTED: 'corrected',
    CONFIRM_NEEDED: 'confirm_needed', MISSING_COMPONENT: 'missing_component',
    OUT_OF_SERVICE_AREA: 'out_of_service_area', AMBIGUOUS: 'ambiguous', API_UNAVAILABLE: 'api_unavailable',
  },
}));

const { validateAddress } = require('../services/address-validation');
const { executeAddressTool, ADDRESS_TOOLS } = require('../services/intelligence-bar/address-tools');
const registry = require('../services/intelligence-bar/action-registry');

const google = (overrides = {}) => ({
  status: 'validated_accept',
  inServiceArea: true,
  county: 'Sarasota County',
  granularity: 'PREMISE',
  normalized: { street_line_1: '100 Example Way', city: 'Sarasota', state: 'FL', postal_code: '34236' },
  hasInferred: false, hasReplaced: false, hasUnconfirmed: false, missingComponents: [],
  ...overrides,
});
const UNVERIFIED = { inServiceArea: null, county: null, granularity: null, normalized: null, hasInferred: false, hasReplaced: false, hasUnconfirmed: false, missingComponents: [] };
const run = input => executeAddressTool('check_address', input);

beforeEach(() => validateAddress.mockReset());

const normalized = (overrides = {}) => ({ street_line_1: '100 Example Way', city: 'Sarasota', state: 'FL', postal_code: '34236', ...overrides });

describe('check_address request to Google', () => {
  const lines = async input => { validateAddress.mockResolvedValue(google()); await run(input); return validateAddress.mock.calls[0][0]; };

  test('a whole address goes as one line, with the FL hint and a timeout signal', async () => {
    const arg = await lines({ address: '100 Example Way, Sarasota, FL 34236' });
    expect(arg.addressLines).toEqual(['100 Example Way, Sarasota, FL 34236']);
    expect(arg.administrativeArea).toBe('FL');
    expect(arg.signal).toBeInstanceOf(AbortSignal);
  });

  test('a street line alone goes as given', async () => {
    expect((await lines({ address: '100 Example Way' })).addressLines).toEqual(['100 Example Way']);
  });

  test('separate city, state and ZIP become a second line; the state field sets the area', async () => {
    const arg = await lines({ address: '100 Example Way', city: 'Sarasota', state: 'Georgia', zip: '34236' });
    expect(arg.addressLines).toEqual(['100 Example Way', 'Sarasota Georgia 34236']);
    expect(arg.administrativeArea).toBe('GA');
  });

  test('city and ZIP without a state keep the FL hint', async () => {
    const arg = await lines({ address: '100 Example Way', city: 'Sarasota', zip: '34236' });
    expect(arg.addressLines).toEqual(['100 Example Way', 'Sarasota 34236']);
    expect(arg.administrativeArea).toBe('FL');
  });

  test('the text is cleaned of extra spaces and capped at the schema length', async () => {
    const arg = await lines({ address: `  100   Example Way ${'x'.repeat(300)}`, city: ' Sarasota  ' });
    expect(arg.addressLines[0].startsWith('100 Example Way xxx')).toBe(true);
    expect(arg.addressLines[0]).toHaveLength(200);
    expect(arg.addressLines[1]).toBe('Sarasota');
  });

  test.each([
    '100 Broadway Sarasota FL 34236',
    '100 Example Way Unit PT',
    '100 Example Way Bldg 2 Apt 4 Sarasota FL 34236',
    '100 Space Coast Blvd',
    '100 Example Way, Sarasota, Flordia 34236',
  ])('%s passes through unparsed and comes back as given', async (address) => {
    validateAddress.mockResolvedValue(google());
    const out = await run({ address });
    expect(validateAddress.mock.calls[0][0].addressLines).toEqual([address]);
    expect(out.as_given).toEqual({ address });
    expect(out.note).toMatch(/carry it over exactly as they said it/);
    expect(Object.keys(out)).not.toEqual(expect.arrayContaining(['unit', 'changed']));
  });

  test('a blank address never reaches Google', async () => {
    const out = await run({ address: '   ' });
    expect(out.status).toBe('invalid_input');
    expect(validateAddress).not.toHaveBeenCalled();
  });

  test('an unrecognized state field is refused, not defaulted to FL', async () => {
    const out = await run({ address: '100 Example Way', state: 'Flordia' });
    expect(out.status).toBe('invalid_input');
    expect(validateAddress).not.toHaveBeenCalled();
  });

  test('an unknown tool name is refused', async () => {
    expect(await executeAddressTool('other', {})).toEqual({ error: 'Unknown tool: other' });
  });
});

describe('check_address result', () => {
  test('a confirmed address returns Google\'s version beside the given one', async () => {
    validateAddress.mockResolvedValue(google());
    const out = await run({ address: '100 Example Way, Sarasota, FL 34236' });
    expect(out).toEqual({
      status: 'validated_accept',
      verdict: 'Google confirmed this address.',
      as_given: { address: '100 Example Way, Sarasota, FL 34236' },
      normalized: { address_line1: '100 Example Way', city: 'Sarasota', state: 'FL', zip: '34236' },
      county: 'Sarasota County',
      in_service_area: true,
      google_replaced: false,
      google_inferred: false,
      unconfirmed: false,
      missing: [],
      zip_plus4_given: false,
      service_area_lookup_failed: false,
      state_hint_used: 'FL',
      note: expect.any(String),
    });
    expect(JSON.stringify(out)).not.toMatch(/raw|providerResponseId/);
  });

  test('separately passed fields are echoed in as_given', async () => {
    validateAddress.mockResolvedValue(google());
    const out = await run({ address: '100 Example Way', city: 'Sarasota', state: 'fl', zip: '34236' });
    expect(out.as_given).toEqual({ address: '100 Example Way', city: 'Sarasota', state: 'fl', zip: '34236' });
    expect(out.state_hint_used).toBeNull();
    expect(out.note).not.toMatch(/used as a hint/);
  });

  test('an accepted address is read back next to the operator\'s words, with the unit sentence', async () => {
    validateAddress.mockResolvedValue(google());
    const { note } = await run({ address: '100 Example Way Apt 4' });
    expect(note).toMatch(/Read Google's normalized address back to the operator next to their own words \(as_given\) before saving/);
    expect(note).toMatch(/Save Google's street spelling, city, state and ZIP only after they agree/);
    expect(note).toMatch(/Google does not check a unit, apartment, suite, building, floor or lot/);
    expect(note).toMatch(/if you are not sure what the unit is, ask/);
    expect(note).not.toMatch(/replaced part of what was given/);
  });

  test('a corrected address says Google replaced something and does not say what', async () => {
    validateAddress.mockResolvedValue(google({ status: 'corrected', hasReplaced: true }));
    const out = await run({ address: '100 Exampel Way Apt 4', city: 'Sarasota', zip: '34205' });
    expect(out.status).toBe('corrected');
    expect(out.google_replaced).toBe(true);
    expect(out.note).toMatch(/Google replaced part of what was given; it does not say which part/);
    expect(out.note).toMatch(/save their version and say it is unverified/);
    expect(out.note).toMatch(/Read Google's normalized address back/);
  });

  test('a part Google filled in is reported as inferred', async () => {
    validateAddress.mockResolvedValue(google({ hasInferred: true }));
    const out = await run({ address: '100 Example Way', city: 'Sarasota' });
    expect(out.google_inferred).toBe(true);
    expect(out.google_replaced).toBe(false);
    expect(out.normalized.zip).toBe('34236');
  });

  test('no state field means the FL hint is stated', async () => {
    validateAddress.mockResolvedValue(google());
    const out = await run({ address: '100 Example Way, Sarasota 34236' });
    expect(out.state_hint_used).toBe('FL');
    expect(out.note).toMatch(/No state field was passed, so Florida \(FL\) was used as a hint/);
  });

  test('an address outside the service area says so and saves nothing', async () => {
    validateAddress.mockResolvedValue(google({
      status: 'out_of_service_area', inServiceArea: false, county: 'Lee County',
      normalized: normalized({ city: 'Fort Myers', postal_code: '33901' }),
    }));
    const out = await run({ address: '100 Example Way, Fort Myers, FL' });
    expect(out).toMatchObject({ status: 'out_of_service_area', in_service_area: false, county: 'Lee County' });
    expect(out.note).toMatch(/outside the service area, and save nothing until they decide/);
    expect(out.note).not.toMatch(/Read Google's|carry it over/);
  });

  test.each([
    ['missing_component', { hasUnconfirmed: true, missingComponents: ['street_number'] }],
    ['ambiguous', {}],
    ['confirm_needed', { hasUnconfirmed: true }],
  ])('%s is not accepted: do not save, show what Google returned', async (status, extra) => {
    validateAddress.mockResolvedValue(google({ status, ...extra }));
    const out = await run({ address: 'Example Way, Sarasota, FL' });
    expect(out.status).toBe(status);
    expect(out.unconfirmed).toBe(Boolean(extra.hasUnconfirmed));
    expect(out.missing).toEqual(extra.missingComponents || []);
    expect(out.note).toMatch(/Do not save this address yet. Show the operator what Google returned and what is missing or unconfirmed, and ask/);
    expect(out.note).not.toMatch(/Read Google's|carry it over/);
  });

  test.each(['api_unavailable', 'not_attempted'])('%s means unverified: ask for the ZIP, never guess', async (status) => {
    validateAddress.mockResolvedValue({ status, ...UNVERIFIED });
    const out = await run({ address: '100 Example Way' });
    expect(out).toMatchObject({ status, normalized: null, county: null, in_service_area: null });
    expect(out.note).toMatch(/could NOT be verified/);
    expect(out.note).toMatch(/Do not guess a ZIP/);
    expect(out.note).not.toMatch(/Read Google's|used as a hint/);
  });
});

describe('check_address served south-Hillsborough towns', () => {
  const hills = (overrides = {}) => google({
    status: 'out_of_service_area', inServiceArea: false, county: 'Hillsborough County',
    normalized: normalized({ city: 'Ruskin', postal_code: '33570' }),
    ...overrides,
  });

  test('a served town is inside the service area', async () => {
    validateAddress.mockResolvedValue(hills());
    const out = await run({ address: '100 Example Way, Ruskin, FL 33570' });
    expect(out.status).toBe('validated_accept');
    expect(out.in_service_area).toBe(true);
    expect(out.note).not.toMatch(/outside the service area/);
  });

  test('a replaced part still reads as corrected', async () => {
    validateAddress.mockResolvedValue(hills({ hasReplaced: true }));
    expect((await run({ address: '100 Example Way, Ruskin, FL 33570' })).status).toBe('corrected');
  });

  test('an unconfirmed part still asks for confirmation', async () => {
    validateAddress.mockResolvedValue(hills({ hasUnconfirmed: true }));
    expect((await run({ address: '100 Example Way, Ruskin, FL 33570' })).status).toBe('confirm_needed');
  });

  test('an explicit FL state field still gets the exception', async () => {
    validateAddress.mockResolvedValue(hills());
    expect((await run({ address: '100 Example Way, Ruskin', state: 'FL' })).status).toBe('validated_accept');
  });

  test('an explicit non-Florida state keeps the out-of-area verdict', async () => {
    validateAddress.mockResolvedValue(hills());
    const out = await run({ address: '100 Example Way, Ruskin', state: 'GA' });
    expect(out.status).toBe('out_of_service_area');
    expect(out.in_service_area).toBe(false);
  });

  test('a failed county lookup on a confirmed premise is a provider gap, not an address defect', async () => {
    validateAddress.mockResolvedValue(google({ status: 'confirm_needed', county: null, inServiceArea: null }));
    const out = await run({ address: '100 Example Way, Sarasota, FL 34236' });
    expect(out.service_area_lookup_failed).toBe(true);
    expect(out.note).toMatch(/county lookup/);
    expect(out.note).not.toMatch(/what is missing/);
  });

  test('a missing unit beside a failed county lookup stays a hold', async () => {
    validateAddress.mockResolvedValue(google({ status: 'missing_component', county: null, inServiceArea: null, missingComponents: ['subpremise'] }));
    const out = await run({ address: '100 Example Way, Sarasota, FL 34236' });
    expect(out.service_area_lookup_failed).toBe(false);
    expect(out.note).toMatch(/Do not save this address yet/);
  });

  test.each([[{ address: '100 Example Way, Sarasota, FL 34236-1234' }], [{ address: '100 Example Way, Sarasota, FL', zip: '34236-1234' }]])('a ZIP+4 is reported, not silently shortened', async (input) => {
    validateAddress.mockResolvedValue(google());
    const out = await run(input);
    expect(out.zip_plus4_given).toBe(true);
    expect(out.note).toMatch(/ZIP\+4/);
  });

  test('the tool asks the validator not to read a state from the text; Google and the county rule decide', async () => {
    validateAddress.mockResolvedValue(google({ status: 'out_of_service_area', inServiceArea: false, county: 'Fulton County', normalized: normalized({ city: 'Atlanta', state: 'GA', postal_code: '30303' }) }));
    const out = await run({ address: '100 Example Way, Atlanta, GA 30303' });
    expect(validateAddress.mock.calls[0][0]).toMatchObject({ stateFromText: false, administrativeArea: 'FL' });
    expect(out.status).toBe('out_of_service_area');
    expect(out.normalized.state).toBe('GA');
  });

  test('an ambiguous result beside a failed county lookup is not a lookup gap', async () => {
    validateAddress.mockResolvedValue(google({ status: 'ambiguous', county: null, inServiceArea: null }));
    const out = await run({ address: '100 Example Way, Sarasota, FL 34236' });
    expect(out.service_area_lookup_failed).toBe(false);
    expect(out.note).toMatch(/Do not save this address yet/);
  });

  test('a rejected input is a tool failure with a refusal code', async () => {
    const { isPolicyRefusal } = require('../services/intelligence-bar/outcomes');
    for (const input of [{ address: '' }, { address: '100 Example Way', state: 'Flordia' }]) {
      const out = await run(input);
      expect(out).toMatchObject({ status: 'invalid_input', code: 'invalid_input' });
      expect(typeof out.error).toBe('string');
      expect(isPolicyRefusal(out)).toBe(true);
    }
    expect(validateAddress).not.toHaveBeenCalled();
  });

  test('another Hillsborough city stays outside the service area', async () => {
    validateAddress.mockResolvedValue(hills({ normalized: normalized({ city: 'Tampa', postal_code: '33602' }) }));
    const out = await run({ address: '100 Example Way, Tampa, FL 33602' });
    expect(out.status).toBe('out_of_service_area');
    expect(out.in_service_area).toBe(false);
  });

  test('a served town name in another county stays outside', async () => {
    validateAddress.mockResolvedValue(hills({ county: 'Polk County' }));
    expect((await run({ address: '100 Example Way, Ruskin, FL 33570' })).status).toBe('out_of_service_area');
  });
});

describe('check_address description', () => {
  test('names only tools that accept an address, and no longer promises a unit', () => {
    const text = ADDRESS_TOOLS[0].description;
    expect(text).not.toMatch(/update_customer_property|create_appointment/);
    expect(text).toMatch(/add_customer_property, update_customer, update_lead_contact, create_customer, correct_invoice_address/);
    expect(text).toMatch(/as_given/);
    expect(text).not.toMatch(/the unit or apartment the operator gave/);
  });
});

describe('check_address registry entry', () => {
  const action = () => registry.actions.get('check_address');

  test('is a reviewed admin read with no scope on customer rows', () => {
    expect(registry.policyErrors).not.toContain('check_address');
    expect(action()).toMatchObject({ kind: 'read', role: 'admin', approval: null, scope: 'none', module: 'address-tools.js' });
    expect(ADDRESS_TOOLS[0].input_schema.additionalProperties).toBe(false);
  });

  test('rejects missing, short and extra arguments', () => {
    const scope = { role: 'admin', context: 'customers' };
    expect(registry.validateInput('check_address', { address: '100 Example Way' }, scope)).toBeNull();
    expect(registry.validateInput('check_address', {}, scope)).toMatchObject({ code: 'invalid_input' });
    expect(registry.validateInput('check_address', { address: 'a' }, scope)).toMatchObject({ code: 'invalid_input' });
    expect(registry.validateInput('check_address', { address: '100 Example Way', customer_id: 'x' }, scope)).toMatchObject({ code: 'invalid_input' });
  });

  test('is offered on every admin page and never to technicians or the tech portal', () => {
    const names = list => list.map(t => t.name);
    for (const context of ['customers', 'dashboard', 'revenue', 'schedule']) {
      expect(names(registry.initialTools(context, { role: 'admin', context }))).toContain('check_address');
    }
    expect(names(registry.initialTools('tech', { role: 'admin', context: 'tech' }))).not.toContain('check_address');
    expect(names(registry.initialTools('tech', { role: 'technician', context: 'tech' }))).not.toContain('check_address');
    expect(names(registry.initialTools('customers', { role: 'technician', context: 'customers' }))).not.toContain('check_address');
  });

  test('refuses a technician call', async () => {
    const out = await registry.execute('check_address', { address: '100 Example Way' }, { role: 'technician', context: 'customers', techContext: { techId: 't1' } });
    expect(out).toMatchObject({ code: 'permission_denied' });
    expect(validateAddress).not.toHaveBeenCalled();
  });

  test('runs for an admin through the registry', async () => {
    validateAddress.mockResolvedValue(google());
    const out = await registry.execute('check_address', { address: '100 Example Way, Sarasota, FL' }, { role: 'admin', context: 'customers' });
    expect(out.status).toBe('validated_accept');
  });
});

// #6297: a write that changes any part of a street address keeps its card.
describe('changesAddress', () => {
  const { changesAddress } = require('../services/intelligence-bar/address-tools');
  const { executesWithoutCard } = require('../services/intelligence-bar/owner-direct');

  test.each([
    ['add_customer_property', { customer_id: 'c1', address_line1: '100 Example Way', city: 'Sarasota', zip: '34236' }],
    ['update_customer', { customer_id: 'c1', updates: { zip: '34236' } }],
    ['update_customer', { customer_id: 'c1', updates: { city: 'Venice' } }],
    ['update_customer', { customer_id: 'c1', updates: { address_line2: 'Apt 4' } }],
    ['bulk_update_customers', { customer_ids: ['c1'], updates: { state: 'FL' } }],
    ['update_lead_contact', { lead_id: 'l1', address: '100 Example Way' }],
    ['create_customer', { first_name: 'Pat', address_line1: '100 Example Way' }],
    ['correct_invoice_address', { invoice_id: 'i1', address_line1: '100 Example Way' }],
  ])('%s with an address field changes an address', (tool, input) => {
    expect(changesAddress(tool, input)).toBe(true);
    expect(executesWithoutCard(tool, input, { notes_replaced: { before: '' } })).toBe(false);
  });

  test.each([
    ['update_customer', { customer_id: 'c1', updates: { lead_source: 'Referral' } }],
    ['update_lead_contact', { lead_id: 'l1', first_name: 'Pat' }],
    ['add_customer_property', { customer_id: 'c1' }],
    ['query_customers', { search: '100 Example Way' }],
    // Chooses among saved properties by id: no address text comes in.
    ['set_primary_property', { customer_id: 'c1', property_id: 'p1' }],
  ])('%s without an address field does not', (tool, input) => {
    expect(changesAddress(tool, input)).toBe(false);
  });

  test('a non-address internal edit still runs without a card on the owner login', () => {
    expect(executesWithoutCard('update_customer', { customer_id: 'c1', updates: { lead_source: 'Referral' } })).toBe(true);
    expect(executesWithoutCard('update_lead_contact', { lead_id: 'l1', first_name: 'Pat' })).toBe(true);
  });
});

