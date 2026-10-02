/**
 * Owner ruling 2026-10-02: the AI call booker approved two confirmed bookings on
 * 10-01 and then skipped both as `booked_call_without_customer`.
 *
 * FIX 1 (GATE_CALL_FIRST_NAME_ADVISORY): a caller who gave only a LAST name
 *   (plus email, a validated premise address and caller ID) is still a customer
 *   and books; the missing first name is advisory, never a hold.
 * FIX 2 (GATE_CALL_HOUSEHOLD_ADDRESS_MATCH): a caller from a number not on file,
 *   calling about the exact address of ONE existing active residential customer,
 *   links to that account as a household contact.
 *
 * A full processRecording() run cannot be mocked end-to-end (see
 * call-start-before-call-v2-disabled.test.js), so the decision helpers are tested
 * behaviorally (the household lookup against real Postgres when DATABASE_URL is
 * set, as in CI) and the Step 3 wiring is pinned structurally. Synthetic data only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/twilio-numbers', () => ({ isInternalNumber: () => false, isOwnedNumber: () => false }));
let mockCaptured = null;
const mockApplyUpdates = jest.fn(async (args) => { mockCaptured = JSON.parse(JSON.stringify(args.updates)); return { emailApplied: true }; });
jest.mock('../services/customer-email-fanout', () => ({
  applyCustomerUpdatesWithEmailClaimGuard: (...args) => mockApplyUpdates(...args),
  propagateCustomerEmailChange: jest.fn(async () => ({})),
}));

const fs = require('fs');
const knex = require('knex');
const { randomUUID } = require('crypto');
const gates = require('../config/feature-gates');
const { _test } = require('../services/call-recording-processor');

const {
  validatePhoneCallAppointmentCustomer, findHouseholdCustomerByAddress, householdLinkFromCall, householdLinkCompleted,
  backfillCustomerFromAppointmentContact, prelinkedBackfillGate,
} = _test;
const source = fs.readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');

const FIRST_NAME_GATE = 'GATE_CALL_FIRST_NAME_ADVISORY';
const HOUSEHOLD_GATE = 'GATE_CALL_HOUSEHOLD_ADDRESS_MATCH';

describe('gates ship dark and read at call time', () => {
  afterEach(() => { delete process.env[FIRST_NAME_GATE]; delete process.env[HOUSEHOLD_GATE]; });

  test.each([
    [FIRST_NAME_GATE, 'callFirstNameAdvisoryLive'],
    [HOUSEHOLD_GATE, 'callHouseholdAddressMatchLive'],
  ])('%s is off unless exactly "true"', (env, reader) => {
    expect(gates[reader]()).toBe(false);
    for (const v of ['1', 'TRUE', 'on', 'yes', '']) {
      process.env[env] = v;
      expect(gates[reader]()).toBe(false);
    }
    process.env[env] = 'true';
    expect(gates[reader]()).toBe(true);
  });
});

describe('FIX 1: validatePhoneCallAppointmentCustomer with a last name only', () => {
  // The 10-01 prod shape: only "Murphy" heard, email, caller-ID phone, premise address.
  const extracted = {
    first_name: null, last_name: 'Murphy', email: 'caller@example.com',
    address_line1: '100 Example Loop', city: 'Sarasota', state: 'FL', zip: '34240',
  };
  const customerRow = { first_name: '', last_name: 'Murphy', phone: '+19415550142', email: 'caller@example.com',
    address_line1: '100 Example Loop', city: 'Sarasota', state: 'FL', zip: '34240' };
  afterEach(() => { delete process.env[FIRST_NAME_GATE]; });

  test('gate off: first_name is still required (byte-identical hold)', () => {
    const v = validatePhoneCallAppointmentCustomer(customerRow, extracted, '+19415550142');
    expect(v.ok).toBe(false);
    expect(v.missing).toEqual(['first_name']);
    expect(v.advisory).not.toContain('first_name');
  });

  test('gate on: books, and first_name rides the advisory list', () => {
    process.env[FIRST_NAME_GATE] = 'true';
    const v = validatePhoneCallAppointmentCustomer(customerRow, extracted, '+19415550142');
    expect(v.ok).toBe(true);
    expect(v.missing).toEqual([]);
    expect(v.advisory).toEqual(['first_name']);
  });

  test('gate on: every other required field still holds', () => {
    process.env[FIRST_NAME_GATE] = 'true';
    const noAddress = validatePhoneCallAppointmentCustomer({ ...customerRow, address_line1: '' }, { ...extracted, address_line1: null }, '+19415550142');
    expect(noAddress.ok).toBe(false);
    expect(noAddress.missing).toContain('street_address');
    const noPhone = validatePhoneCallAppointmentCustomer({ ...customerRow, phone: '' }, extracted, null);
    expect(noPhone.ok).toBe(false);
    expect(noPhone.missing).toContain('phone');
  });

  test('gate on: a named caller files no first-name advisory', () => {
    process.env[FIRST_NAME_GATE] = 'true';
    const v = validatePhoneCallAppointmentCustomer({ ...customerRow, first_name: 'Sam' }, extracted, '+19415550142');
    expect(v.advisory).not.toContain('first_name');
  });
});

describe('FIX 1 + FIX 2 wiring in processRecording (structural pin)', () => {
  test('the customer-create branch opens only behind the first-name gate and the validated-premise predicate', () => {
    expect(source).toMatch(/\(extracted\.first_name \|\| firstNameAdvisoryCreate\) && phone && !extracted\.is_voicemail && !v2NonCustomerCallNature/);
    const predicate = source.slice(source.indexOf('const firstNameAdvisoryCreate ='), source.indexOf('const sharedPhoneAmbiguity = {}'));
    expect(predicate).toContain('callFirstNameAdvisoryLive()');
    expect(predicate).toContain("String(extracted.last_name || '').trim()");
    expect(predicate).toContain("['validated_accept', 'corrected'].includes(effectiveAddressValidation?.status)");
    expect(predicate).toContain('effectiveAddressValidation?.inServiceArea === true');
  });

  test('customer_creation_failed expectation follows the same predicate', () => {
    expect(source).toMatch(/const customerExpected = !!\(\(extracted\.first_name \|\| firstNameAdvisoryCreate\) && phone/);
  });

  test('the household link runs only for a no-phone-match call, never backfills the account holder, saves the caller as a service contact and files the card', () => {
    const lookupStep = source.slice(source.indexOf('const householdMatch = ('), source.indexOf('if (existing) {', source.indexOf('const householdMatch = (')));
    expect(lookupStep).toContain('!existing && !sharedPhoneAmbiguity.candidates');
    expect(lookupStep).toContain('callHouseholdAddressMatchLive()');
    expect(lookupStep).toContain('!v2ThirdPartyCallNature');
    const branch = source.slice(source.indexOf('} else if (householdMatch?.customer) {'), source.indexOf('} else if (sharedPhoneAmbiguity.candidates) {'));
    expect(lookupStep).toContain('addressValidation: effectiveAddressValidation');
    expect(branch).not.toContain('backfillLinkedCustomerFromExtraction');
    const completion = source.slice(source.indexOf('if (householdLinkedThisPass && customerId && !householdLinkCompleted(call)) {'), source.indexOf('// Pre-linked calls (call.customer_id set at ring time'));
    expect(completion).toContain('persistCallSecondaryContact(customerId, householdContact');
    expect(completion).toContain("flag: 'household_contact_linked'");
    expect(completion).not.toContain('backfillLinkedCustomerFromExtraction');
    expect(source).toContain('phoneMatchedThisPass: phoneMatchedThisPass || householdLinkedThisPass');
    expect(source).toContain('householdContact: householdLinkedThisPass');
  });

  test('the confirmation greeting falls back to "there"', () => {
    expect(source).toContain("const firstName = customerValidation.details.firstName || 'there';");
  });
});

describe('FIX 2: household identity survives reprocess, retry and later backfills', () => {
  const ACCOUNT = '11111111-1111-4111-8111-111111111111';
  const OTHER = '22222222-2222-4222-8222-222222222222';
  const stamped = (customerId = ACCOUNT, asString = false) => {
    const metadata = { household_link: { customer_id: customerId, matched_by: 'service_address' } };
    return { metadata: asString ? JSON.stringify(metadata) : metadata };
  };

  test('householdLinkFromCall reads the persisted stamp for the linked customer only', () => {
    expect(householdLinkFromCall(stamped(), ACCOUNT)).toBe(true);
    expect(householdLinkFromCall(stamped(ACCOUNT, true), ACCOUNT)).toBe(true);
    expect(householdLinkFromCall(stamped(), OTHER)).toBe(false); // an operator relink to someone else is not a household link
    expect(householdLinkFromCall({ metadata: {} }, ACCOUNT)).toBe(false);
    expect(householdLinkFromCall({ metadata: 'not json' }, ACCOUNT)).toBe(false);
    expect(householdLinkFromCall(null, ACCOUNT)).toBe(false);
    expect(householdLinkFromCall(stamped(), null)).toBe(false);
  });

  const extracted = { first_name: 'Sally', last_name: 'Example', email: 'sally@example.com', phone: '+19415550177', address_line1: '1083 Example Shell Loop' };
  const account = { id: ACCOUNT, first_name: '', last_name: null, phone: null, email: null, address_line1: '1083 Example Shell Loop', city: 'Sarasota', state: 'FL', zip: '34240' };

  test('REPROCESS: the pre-linked backfill gate is closed once the stamp is seeded, open without it', () => {
    const base = { customerId: ACCOUNT, createdCustomerFromCall: false, extracted, thirdPartyCallNature: false };
    const reprocessed = { customer_id: ACCOUNT, from_phone: '+19415550177', direction: 'inbound', ...stamped() };
    // processRecording seeds householdLinkedThisPass from the stamp and ORs it into phoneMatchedThisPass.
    expect(prelinkedBackfillGate({ ...base, call: reprocessed, phoneMatchedThisPass: householdLinkFromCall(reprocessed, ACCOUNT) }).eligible).toBe(false);
    const ordinary = { customer_id: ACCOUNT, from_phone: '+19415550177', direction: 'inbound', metadata: {} };
    expect(prelinkedBackfillGate({ ...base, call: ordinary, phoneMatchedThisPass: householdLinkFromCall(ordinary, ACCOUNT) }).eligible).toBe(true);
  });

  test('REPROCESS: the appointment backfill never writes the caller name, phone or email onto the account', async () => {
    mockApplyUpdates.mockClear();
    const out = await backfillCustomerFromAppointmentContact(ACCOUNT, account, extracted, '+19415550177', { householdContact: true });
    expect(out).toBe(account);
    expect(mockApplyUpdates).not.toHaveBeenCalled();
  });

  test('control: without the household flag the same backfill does write them', async () => {
    mockApplyUpdates.mockClear();
    await backfillCustomerFromAppointmentContact(ACCOUNT, account, extracted, '+19415550177', {}).catch(() => {});
    expect(mockApplyUpdates).toHaveBeenCalled();
    expect(mockCaptured).toMatchObject({ first_name: 'Sally', phone: '+19415550177', email: 'sally@example.com' });
  });

  test('RETRY: a persisted link whose contact/card writes never finished is resumed; a completed one is not repeated', () => {
    const half = { customer_id: ACCOUNT, ...stamped() };
    expect(householdLinkFromCall(half, ACCOUNT)).toBe(true);
    expect(householdLinkCompleted(half)).toBe(false);
    const done = { metadata: { household_link: { customer_id: ACCOUNT, completed_at: '2026-10-02T00:00:00.000Z' } } };
    expect(householdLinkCompleted(done)).toBe(true);
    expect(householdLinkCompleted({ metadata: JSON.stringify(done.metadata) })).toBe(true);
    expect(householdLinkCompleted({ metadata: {} })).toBe(false);
    expect(householdLinkCompleted(null)).toBe(false);
    // The completion block runs for ANY household-linked pass that is not yet complete (first pass or retry),
    // checks the card exists before inserting, and only stamps completed_at when the contact write did not error.
    expect(source).toContain('if (householdLinkedThisPass && customerId && !householdLinkCompleted(call)) {');
    expect(source).toContain("{household_link,completed_at}");
    expect(source).toContain("if (householdPersist !== 'error') {");
    expect(source).toContain("reason_code: 'household_contact_linked' }).first('id')");
  });

  test('wiring: stamp + customer link are one token-fenced write, a retry that re-finds the account by the saved slot phone is still protected, and the drip enroll is skipped', () => {
    const branch = source.slice(source.indexOf('} else if (householdMatch?.customer) {'), source.indexOf('} else if (sharedPhoneAmbiguity.candidates) {'));
    expect(branch).toContain("where('processing_token', procToken)");
    expect(branch).toContain("'{household_link}'");
    expect(branch).toContain('customer_id: householdMatch.customer.id');
    expect(source).toContain('if (existing && householdLinkFromCall(call, existing.id)) {');
    expect(source).toContain('let householdLinkedThisPass = householdLinkFromCall(call, customerId);');
    expect(source).toContain("beehiivResult = { skipped: 'household_contact' }");
  });
});

const SKIP = !process.env.DATABASE_URL;
(SKIP ? describe.skip : describe)('FIX 2: findHouseholdCustomerByAddress on PostgreSQL', () => {
  jest.setTimeout(30000);
  let database; let trx;
  const NOT_ON_FILE = '+19415550177';
  beforeAll(() => { database = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 1 } }); });
  beforeEach(async () => {
    trx = await database.transaction();
    await trx.raw('CREATE TEMP TABLE customers (LIKE public.customers INCLUDING DEFAULTS) ON COMMIT DROP');
    await trx.raw('CREATE TEMP TABLE customer_properties (LIKE public.customer_properties INCLUDING DEFAULTS) ON COMMIT DROP');
  });
  afterEach(async () => { await trx.rollback(); });
  afterAll(async () => { await database.destroy(); });

  // The 10-01 prod shape: an active Bronze quarterly member at the stated address.
  const member = (over = {}) => ({
    id: randomUUID(), first_name: 'Pat', last_name: 'Example', phone: '+19415550100',
    address_line1: '1083 Example Shell Loop', address_line2: null, city: 'Sarasota', state: 'FL', zip: '34240',
    active: true, pipeline_stage: 'active_customer', waveguard_tier: 'Bronze', ...over,
  });
  const AV_OK = { status: 'validated_accept', inServiceArea: true, granularity: 'PREMISE' };
  const lookup = (address = {}, extra = {}) => findHouseholdCustomerByAddress({
    phone: NOT_ON_FILE,
    addressValidation: AV_OK,
    address: { address_line1: '1083 Example Shell Loop', address_line2: null, zip: '34240', ...address },
    conn: trx,
    ...extra,
  });

  test('exactly one active member at the address (suffix, case, punctuation, ZIP+4 tolerant) -> match', async () => {
    const row = member();
    await trx('customers').insert(row);
    expect((await lookup()).customer?.id).toBe(row.id);
    expect((await lookup({ address_line1: '1083 example shell loop,', zip: '34240-1234' })).customer?.id).toBe(row.id);
  });

  test('an exact street+ZIP match whose address is NOT validated never links', async () => {
    await trx('customers').insert(member());
    expect((await lookup()).customer).not.toBeNull();
    for (const av of [
      null,
      { status: 'ambiguous', inServiceArea: true, granularity: 'PREMISE' },
      { status: 'unconfirmed', inServiceArea: true, granularity: 'PREMISE' },
      { status: 'validated_accept', inServiceArea: false, granularity: 'PREMISE' },
      { status: 'validated_accept', inServiceArea: null },
      { status: 'validated_accept', inServiceArea: true, granularity: 'ROUTE' },
    ]) {
      expect(await lookup({}, { addressValidation: av })).toEqual({ customer: null, reason: 'address_not_validated' });
    }
    expect((await lookup({}, { addressValidation: { status: 'corrected', inServiceArea: true } })).customer).not.toBeNull();
  });

  test('uniqueness is claimed over the COMPLETE candidate set: nothing can trim a second live household out of the count', async () => {
    const row = member();
    await trx('customers').insert(row);
    // (a) a second household with no ZIP on file
    const noZip = member({ id: randomUUID(), first_name: 'Lee', phone: '+19415550103', zip: null });
    await trx('customers').insert(noZip);
    expect((await lookup()).reason).toBe('multiple_customers_at_address');
    await trx('customers').where({ id: noZip.id }).del();
    // (b) a second household whose active flag is NULL (still live)
    await trx('customers').insert(member({ id: randomUUID(), phone: '+19415550104', active: null }));
    expect((await lookup()).reason).toBe('multiple_customers_at_address');
    await trx('customers').where({ phone: '+19415550104' }).del();
    // (c) a second household known only through an active customer_properties row
    const other = member({ id: randomUUID(), phone: '+19415550105', address_line1: '9 Elsewhere Way', zip: '34241' });
    await trx('customers').insert(other);
    await trx('customer_properties').insert({ customer_id: other.id, address_line1: '1083 Example Shell Loop', zip: '34240', active: true, address_key: 'k1' });
    expect((await lookup()).reason).toBe('multiple_customers_at_address');
    // an INACTIVE property row is a former address, not a household
    await trx('customer_properties').update({ active: false });
    expect((await lookup()).customer?.id).toBe(row.id);
  });

  test('many unrelated customers in the ZIP never push the real second household out of view (no LIMIT)', async () => {
    const row = member();
    const filler = Array.from({ length: 75 }, (_, i) => member({
      id: randomUUID(), phone: `+1941555${String(2000 + i)}`, address_line1: `${2000 + i} Filler Street`,
    }));
    const twin = member({ id: randomUUID(), phone: '+19415550106', first_name: 'Lee' });
    await trx('customers').insert([...filler, row, twin]);
    expect((await lookup()).reason).toBe('multiple_customers_at_address');
  });

  test('soft-deleted and inactive twins are dropped only after counting and never block the live match', async () => {
    const row = member();
    await trx('customers').insert([
      row,
      member({ id: randomUUID(), phone: '+19415550107', deleted_at: new Date() }),
      member({ id: randomUUID(), phone: '+19415550108', active: false }),
    ]);
    expect((await lookup()).customer?.id).toBe(row.id);
  });

  test('a unit-first call line still finds the candidates', async () => {
    const row = member({ address_line2: 'Unit 4' });
    await trx('customers').insert(row);
    expect((await lookup({ address_line1: 'Unit 4 1083 Example Shell Loop' })).customer?.id).toBe(row.id);
    expect((await lookup({ address_line1: 'Unit 5 1083 Example Shell Loop' })).reason).toBe('unit_differs');
    // a stored unit-first twin cannot hide from a clean call line
    await trx('customers').insert(member({ id: randomUUID(), phone: '+19415550109', address_line1: 'Apt 4 1083 Example Shell Loop', address_line2: null }));
    expect((await lookup({ address_line1: '1083 Example Shell Loop', address_line2: 'Unit 4' })).reason).toBe('multiple_customers_at_address');
  });

  test('the sole candidate needs positive EXACT ZIP evidence: a missing or malformed stored ZIP is refused', async () => {
    const noZip = member({ zip: null });
    await trx('customers').insert(noZip);
    expect((await lookup()).reason).toBe('zip_unconfirmed');
    await trx('customers').update({ zip: 'n/a' });
    expect((await lookup()).reason).toBe('zip_unconfirmed');
    await trx('customers').update({ zip: '34240-9999' });
    expect((await lookup()).customer?.id).toBe(noZip.id);
    // a primary line with an unknown ZIP is accepted only when another source of the SAME account carries the exact ZIP
    await trx('customers').update({ zip: null });
    await trx('customer_properties').insert({ customer_id: noZip.id, address_line1: '1083 Example Shell Loop', zip: '34240', active: true, address_key: 'k2' });
    expect((await lookup()).customer?.id).toBe(noZip.id);
  });

  test('more than one customer at the address -> refused', async () => {
    await trx('customers').insert([member(), member({ id: randomUUID(), first_name: 'Lee', phone: '+19415550101' })]);
    expect(await lookup()).toEqual({ customer: null, reason: 'multiple_customers_at_address' });
  });

  test('a unit on either side that differs -> refused', async () => {
    await trx('customers').insert(member({ address_line2: 'Unit 4' }));
    expect((await lookup({ address_line2: 'Unit 5' })).reason).toBe('unit_differs');
    expect((await lookup({ address_line2: null })).reason).toBe('unit_differs');
    expect((await lookup({ address_line2: 'Apt 4' })).customer).not.toBeNull();
  });

  test('a unit on the call only (account has none) -> refused', async () => {
    await trx('customers').insert(member());
    expect((await lookup({ address_line1: '1083 Example Shell Loop Apt 9' })).reason).toBe('unit_differs');
  });

  test('commercial account or commercial call -> refused', async () => {
    await trx('customers').insert(member({ property_type: 'commercial' }));
    expect((await lookup()).reason).toBe('commercial_account');
    expect((await lookup({}, { commercialCall: true })).reason).toBe('commercial_call');
  });

  test('inactive, deleted or non-established (lead) customers never match', async () => {
    await trx('customers').insert([
      member({ active: false }),
      member({ id: randomUUID(), deleted_at: new Date(), phone: '+19415550102' }),
    ]);
    expect((await lookup()).reason).toBe('no_address_match');
    await trx('customers').del();
    await trx('customers').insert(member({ pipeline_stage: 'new_lead' }));
    expect((await lookup()).reason).toBe('not_established_customer');
  });

  test('a number already on file (primary or service-contact slot) is a phone match, not a household match', async () => {
    await trx('customers').insert(member({ phone: NOT_ON_FILE }));
    expect((await lookup()).reason).toBe('phone_on_file');
    await trx('customers').del();
    await trx('customers').insert(member({ service_contact_phone: NOT_ON_FILE }));
    expect((await lookup()).reason).toBe('phone_on_file');
  });

  test('a different street or ZIP -> no match', async () => {
    await trx('customers').insert(member());
    expect((await lookup({ address_line1: '1085 Example Shell Loop' })).reason).toBe('no_address_match');
    expect((await lookup({ zip: '34241' })).reason).toBe('no_address_match');
    expect((await lookup({ address_line1: '' })).reason).toBe('no_phone_or_address');
  });
});
