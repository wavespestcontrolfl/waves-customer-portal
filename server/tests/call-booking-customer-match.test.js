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

const fs = require('fs');
const knex = require('knex');
const { randomUUID } = require('crypto');
const gates = require('../config/feature-gates');
const { _test } = require('../services/call-recording-processor');

const { validatePhoneCallAppointmentCustomer, findHouseholdCustomerByAddress } = _test;
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
    expect(branch).toContain('persistCallSecondaryContact(customerId, householdContact');
    expect(branch).toContain("flag: 'household_contact_linked'");
    expect(branch).not.toContain('backfillLinkedCustomerFromExtraction');
    expect(source).toContain('phoneMatchedThisPass: phoneMatchedThisPass || householdLinkedThisPass');
    expect(source).toContain('suppressEmail: householdLinkedThisPass');
  });

  test('the confirmation greeting falls back to "there"', () => {
    expect(source).toContain("const firstName = customerValidation.details.firstName || 'there';");
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
  });
  afterEach(async () => { await trx.rollback(); });
  afterAll(async () => { await database.destroy(); });

  // The 10-01 prod shape: an active Bronze quarterly member at the stated address.
  const member = (over = {}) => ({
    id: randomUUID(), first_name: 'Pat', last_name: 'Example', phone: '+19415550100',
    address_line1: '1083 Example Shell Loop', address_line2: null, city: 'Sarasota', state: 'FL', zip: '34240',
    active: true, pipeline_stage: 'active_customer', waveguard_tier: 'Bronze', ...over,
  });
  const lookup = (address = {}, extra = {}) => findHouseholdCustomerByAddress({
    phone: NOT_ON_FILE,
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
