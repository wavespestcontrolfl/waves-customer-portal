/**
 * check_address (address-tools.js): Google address check for the Intelligence
 * Bar. validateAddress is mocked; the tool shapes its result. Synthetic
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

describe('check_address result', () => {
  test('a clean address comes back confirmed with nothing changed', async () => {
    validateAddress.mockResolvedValue(google());
    const out = await run({ address: '100 Example Way, Sarasota, FL 34236' });
    expect(out).toMatchObject({
      status: 'validated_accept',
      normalized: { address_line1: '100 Example Way', city: 'Sarasota', state: 'FL', zip: '34236' },
      county: 'Sarasota County', in_service_area: true, changed: [], unconfirmed: false, missing: [],
    });
    expect(out.verdict).toMatch(/confirmed/);
    expect(JSON.stringify(out)).not.toMatch(/raw|providerResponseId/);
  });

  test('a misspelled street is reported as a changed street with both spellings', async () => {
    validateAddress.mockResolvedValue(google({ status: 'corrected', hasReplaced: true }));
    const out = await run({ address: '100 Exampel Way', city: 'Sarasota', zip: '34236' });
    expect(out.status).toBe('corrected');
    expect(out.changed).toEqual([{ component: 'street', input: '100 Exampel Way', google: '100 Example Way' }]);
    expect(out.note).toMatch(/show the operator both versions/);
    expect(out.note).toMatch(/insists/);
  });

  test('a wrong ZIP is reported as a changed zip', async () => {
    validateAddress.mockResolvedValue(google({ status: 'corrected', hasReplaced: true }));
    const out = await run({ address: '100 Example Way', city: 'Sarasota', zip: '34205' });
    expect(out.changed).toEqual([{ component: 'zip', input: '34205', google: '34236' }]);
  });

  test('a missing ZIP is filled from Google and the operator is told so', async () => {
    validateAddress.mockResolvedValue(google({ hasInferred: true }));
    const out = await run({ address: '100 Example Way', city: 'Sarasota' });
    expect(out.normalized.zip).toBe('34236');
    expect(out.changed).toEqual([{ component: 'zip', input: null, google: '34236' }]);
    expect(out.note).toMatch(/ZIP comes from Google/);
  });

  test('suffix, case and unit differences are not reported as changes', async () => {
    validateAddress.mockResolvedValue(google({ normalized: { street_line_1: '100 North Example Street', city: 'Sarasota', state: 'FL', postal_code: '34236' } }));
    const out = await run({ address: '100 n example st apt 4, sarasota, fl 34236' });
    expect(out.changed).toEqual([]);
    expect(out.note).toMatch(/unit/);
  });

  test('an address outside the service area says so and saves nothing', async () => {
    validateAddress.mockResolvedValue(google({
      status: 'out_of_service_area', inServiceArea: false, county: 'Lee County',
      normalized: { street_line_1: '100 Example Way', city: 'Fort Myers', state: 'FL', postal_code: '33901' },
    }));
    const out = await run({ address: '100 Example Way, Fort Myers, FL' });
    expect(out).toMatchObject({ status: 'out_of_service_area', in_service_area: false, county: 'Lee County' });
    expect(out.note).toMatch(/outside the service area/);
    expect(out.note).not.toMatch(/Save Google/);
  });

  test('an incomplete match lists what is missing and is not safe to save', async () => {
    validateAddress.mockResolvedValue(google({ status: 'missing_component', hasUnconfirmed: true, missingComponents: ['street_number'] }));
    const out = await run({ address: 'Example Way, Sarasota' });
    expect(out).toMatchObject({ status: 'missing_component', unconfirmed: true, missing: ['street_number'] });
    expect(out.note).toMatch(/Do not save this address yet/);
  });

  test.each(['api_unavailable', 'not_attempted'])('%s means unverified: ask for the ZIP, never guess', async (status) => {
    validateAddress.mockResolvedValue({ status, ...UNVERIFIED });
    const out = await run({ address: '100 Example Way' });
    expect(out).toMatchObject({ status, normalized: null, county: null, in_service_area: null, changed: [] });
    expect(out.note).toMatch(/could NOT be verified/);
    expect(out.note).toMatch(/Do not guess a ZIP/);
  });
});

describe('check_address request to Google', () => {
  test('sends the text as given, defaults the state to FL, and carries a timeout signal', async () => {
    validateAddress.mockResolvedValue(google());
    await run({ address: '100 Example Way', city: 'Sarasota', zip: '34236' });
    const arg = validateAddress.mock.calls[0][0];
    expect(arg.addressLines).toEqual(['100 Example Way', 'Sarasota 34236']);
    expect(arg.administrativeArea).toBe('FL');
    expect(arg.signal).toBeInstanceOf(AbortSignal);
  });

  test('a whole address is sent as one line', async () => {
    validateAddress.mockResolvedValue(google());
    await run({ address: '100 Example Way, Sarasota, FL 34236' });
    expect(validateAddress.mock.calls[0][0].addressLines).toEqual(['100 Example Way, Sarasota, FL 34236']);
  });

  test('a stated state is passed on', async () => {
    validateAddress.mockResolvedValue(google());
    await run({ address: '100 Example Way', city: 'Sarasota', state: 'Georgia' });
    expect(validateAddress.mock.calls[0][0].administrativeArea).toBe('GA');
  });

  test('a blank address never reaches Google', async () => {
    const out = await run({ address: '   ' });
    expect(out.status).toBe('invalid_input');
    expect(validateAddress).not.toHaveBeenCalled();
  });

  test('an unknown tool name is refused', async () => {
    expect(await executeAddressTool('other', {})).toEqual({ error: 'Unknown tool: other' });
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

// Pre-push audit P1 on #6297: a hand-written unit regex missed "# 4", lost a
// comma-separated "Apt 4" into the city, and cut "100 Space Coast Blvd" to
// "100". The unit is now peeled with the shared address-normalizer grammar.
describe('check_address keeps the unit the operator gave', () => {
  test.each([
    ['100 Example Way Apt 4', 'Apt 4'],
    ['100 Example Way # 4', 'Unit 4'],
    ['100 Example Way, Apt 4, Sarasota FL', 'Apt 4'],
    ['Apt 204, 100 Example Way, Sarasota, FL 34236', 'Apt 204'],
    ['100 Example Way, Apt 4', 'Apt 4'],
    ['100 Example Way Bldg 2 Apt 4', 'Bldg 2 Apt 4'],
  ])('%s returns its unit and reports no street change', async (address, unit) => {
    validateAddress.mockResolvedValue(google());
    const out = await run({ address });
    expect(out.unit).toBe(unit);
    expect(out.changed.filter(c => c.component === 'street' || c.input)).toEqual([]);
    expect(out.note).toContain(`save "${unit}" as the second address line`);
  });

  test('a street name that contains a unit word is not cut', async () => {
    validateAddress.mockResolvedValue(google({ normalized: { street_line_1: '100 Space Coast Blvd', city: 'Sarasota', state: 'FL', postal_code: '34236' } }));
    const out = await run({ address: '100 Space Coast Blvd, Sarasota, FL 34236' });
    expect(out.unit).toBeNull();
    expect(out.changed).toEqual([]);
  });
});

test('a unit in its own comma segment is kept when the city is passed separately', async () => {
  validateAddress.mockResolvedValue(google());
  const out = await run({ address: '100 Example Way, Apt 4', city: 'Sarasota', zip: '34236' });
  expect(out.unit).toBe('Apt 4');
  expect(out.changed).toEqual([]);
});

// Codex r2 on #6297: evidence, not a prompt rule, links a check to a write.
describe('address check ledger', () => {
  const { createAddressCheckLedger, writtenAddress } = require('../services/intelligence-bar/address-tools');
  const checked = async (ledger, input, result = google()) => {
    validateAddress.mockResolvedValue(result);
    ledger.record('check_address', input, await run(input));
  };

  test('an unchecked address write is refused; a non-address write is not', () => {
    const ledger = createAddressCheckLedger();
    expect(ledger.writeRefusal('add_customer_property', { address_line1: '100 Example Way', zip: '34236' })).toMatchObject({ code: 'address_check_required' });
    expect(ledger.writeRefusal('update_customer', { updates: { notes: 'x' } })).toBeNull();
    expect(ledger.writeRefusal('query_customers', { search: '100 Example Way' })).toBeNull();
  });

  test('the normalized address passes after a check; a guessed ZIP on the given street does not', async () => {
    const ledger = createAddressCheckLedger();
    await checked(ledger, { address: '100 example wy' }, google({ status: 'corrected' }));
    expect(ledger.writeRefusal('add_customer_property', { address_line1: '100 Example Way', zip: '34236' })).toBeNull();
    expect(ledger.writeRefusal('create_customer', { address_line1: '100 Example Way Apt 4', zip: '34236' })).toBeNull();
    expect(ledger.writeRefusal('add_customer_property', { address_line1: '100 example wy', zip: '34999' })).toMatchObject({ code: 'address_check_required' });
    expect(ledger.writeRefusal('add_customer_property', { address_line1: '200 Other Rd', zip: '34236' })).toMatchObject({ code: 'address_check_required' });
  });

  test('when Google could not check, only the exact address the operator gave passes', async () => {
    const ledger = createAddressCheckLedger();
    await checked(ledger, { address: '100 Example Way', zip: '34236' }, { status: 'api_unavailable', ...UNVERIFIED });
    expect(ledger.writeRefusal('update_customer', { updates: { address_line1: '100 Example Way', zip: '34236' } })).toBeNull();
    expect(ledger.writeRefusal('update_customer', { updates: { address_line1: '100 Example Way', zip: '34237' } })).toMatchObject({ code: 'address_check_required' });
  });

  test('each address-writing tool is read through its own fields', () => {
    expect(writtenAddress('update_lead_contact', { address: '100 Example Way', zip: '34236' })).toEqual({ street: expect.any(String), zip: '34236' });
    expect(writtenAddress('update_lead_contact', { first_name: 'Pat' })).toBeNull();
    expect(writtenAddress('correct_invoice_address', { address_line1: '100 Example Way' })).toMatchObject({ zip: '' });
  });
});

describe('check_address round 2 cases', () => {
  test('a compound unit in two comma segments is removed whole', async () => {
    validateAddress.mockResolvedValue(google());
    const out = await run({ address: '100 Example Way, Bldg 2, Apt 4, Sarasota, FL 34236' });
    expect(out.unit).toBe('Bldg 2 Apt 4');
    expect(out.changed).toEqual([]);
  });
  test('a floor is kept as the unit', async () => {
    validateAddress.mockResolvedValue(google());
    expect((await run({ address: '100 Example Way Floor 2' })).unit).toBe('Floor 2');
  });
  test('a trailing direction stays in the street when the city is passed separately', async () => {
    validateAddress.mockResolvedValue(google({ normalized: { street_line_1: '100 17th Street West', city: 'Bradenton', state: 'FL', postal_code: '34205' } }));
    const out = await run({ address: '100 17th St W', city: 'Bradenton', zip: '34205' });
    expect(out.changed).toEqual([]);
  });
  test('an unrecognized state is refused, not defaulted to FL', async () => {
    const out = await run({ address: '100 Example Way', state: 'Flordia' });
    expect(out.status).toBe('invalid_input');
    expect(validateAddress).not.toHaveBeenCalled();
  });
  test('a corrected result with no visible difference asks before saving', async () => {
    validateAddress.mockResolvedValue(google({ status: 'corrected', hasReplaced: true }));
    const out = await run({ address: '100 Example Way Apt 4, Sarasota, FL 34236' });
    expect(out.note).toMatch(/Do not save yet/);
    expect(out.note).not.toMatch(/^Save Google/);
  });
});
