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

const { validatePhoneCallAppointmentCustomer, findHouseholdCustomerByAddress, advisoryBookingAddressHoldFields,
  fileHouseholdSuggestionCard, firstNameAdvisoryAddressOk } = _test;
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

describe('FIX 1: a first-name-less booking needs the BOOKED address validated (shadow mode)', () => {
  const ok = (advisory) => ({ ok: true, missing: [], advisory });
  test('outside enforce mode, a first_name advisory holds unless the verdict validates the address being booked (V1/V2 disagreement keeps avPositiveForBooking false)', () => {
    expect(advisoryBookingAddressHoldFields({ enforceModeActive: false, customerValidation: ok(['first_name']), avPositiveForBooking: false })).toEqual(['first_name']);
    expect(advisoryBookingAddressHoldFields({ enforceModeActive: false, customerValidation: ok(['email', 'first_name', 'last_name']), avPositiveForBooking: false })).toEqual(['email', 'first_name']);
    // an email on file does NOT lift the hold for a first-name-less booking
    expect(advisoryBookingAddressHoldFields({ enforceModeActive: false, customerValidation: ok(['first_name', 'last_name']), avPositiveForBooking: false })).toEqual(['first_name']);
  });
  test('no hold when the verdict validates the booked address, in enforce mode (canAutoRoute owns it), for a named caller, or when the customer is already not ok', () => {
    expect(advisoryBookingAddressHoldFields({ enforceModeActive: false, customerValidation: ok(['first_name']), avPositiveForBooking: true })).toEqual([]);
    expect(advisoryBookingAddressHoldFields({ enforceModeActive: true, customerValidation: ok(['first_name']), avPositiveForBooking: false })).toEqual([]);
    expect(advisoryBookingAddressHoldFields({ enforceModeActive: false, customerValidation: ok(['last_name']), avPositiveForBooking: false })).toEqual([]);
    expect(advisoryBookingAddressHoldFields({ enforceModeActive: false, customerValidation: { ok: false, missing: ['phone'], advisory: ['first_name'] }, avPositiveForBooking: false })).toEqual([]);
    expect(advisoryBookingAddressHoldFields({})).toEqual([]);
  });
  test('wiring: the hold decision uses the helper and reports the advisory fields', () => {
    expect(source).toContain('advisoryBookingAddressHoldFields({ enforceModeActive, customerValidation, avPositiveForBooking })');
    expect(source).toContain('customerValidation.ok ? advisoryHoldFields : customerValidation.missing');
  });
});

describe('FIX 1: the address a first-name-less customer is created at must be the validated premise', () => {
  const AV = { status: 'validated_accept', inServiceArea: true, granularity: 'PREMISE',
    normalized: { street_line_1: '100 Example Loop', city: 'Sarasota', postal_code: '34240' } };
  const stored = { address_line1: '100 Example Lp', city: 'Sarasota', zip: '34240-1111' };
  test('explicit PREMISE granularity is required; a missing one no longer passes', () => {
    expect(firstNameAdvisoryAddressOk(AV, stored)).toBe(true);
    expect(firstNameAdvisoryAddressOk({ ...AV, granularity: undefined }, stored)).toBe(false);
    expect(firstNameAdvisoryAddressOk({ ...AV, granularity: 'ROUTE' }, stored)).toBe(false);
    expect(firstNameAdvisoryAddressOk({ ...AV, status: 'ambiguous' }, stored)).toBe(false);
    expect(firstNameAdvisoryAddressOk({ ...AV, inServiceArea: false }, stored)).toBe(false);
    expect(firstNameAdvisoryAddressOk(null, stored)).toBe(false);
  });
  test('the unit must agree with the address the verdict was computed on (none = none)', () => {
    const v2 = (unit) => ({ street_line_1: '100 Example Loop', street_line_2: unit });
    expect(firstNameAdvisoryAddressOk(AV, { ...stored, address_line2: 'Apt 3' }, v2('Unit 3'))).toBe(true);
    expect(firstNameAdvisoryAddressOk(AV, { ...stored, address_line2: 'Apt 3' }, v2('Apt 4'))).toBe(false);
    expect(firstNameAdvisoryAddressOk(AV, { ...stored, address_line2: 'Apt 3' }, v2(null))).toBe(false);
    expect(firstNameAdvisoryAddressOk(AV, stored, v2('Apt 4'))).toBe(false);
    expect(firstNameAdvisoryAddressOk(AV, stored, v2(null))).toBe(true);
    expect(firstNameAdvisoryAddressOk(AV, stored)).toBe(true);
    // a unit riding inside the stored street line counts
    expect(firstNameAdvisoryAddressOk(AV, { ...stored, address_line1: '100 Example Loop Apt 3' }, v2('Apt 4'))).toBe(false);
    expect(source).toContain('firstNameAdvisoryAddressOk(effectiveAddressValidation, extracted, v2CanonicalExtraction?.property?.service_address)');
  });

  test('shadow mode: a verdict for a DIFFERENT street, ZIP or city than the V1 address being inserted means no creation', () => {
    expect(firstNameAdvisoryAddressOk(AV, { ...stored, address_line1: '102 Example Loop' })).toBe(false);
    expect(firstNameAdvisoryAddressOk(AV, { ...stored, zip: '34241' })).toBe(false);
    expect(firstNameAdvisoryAddressOk(AV, { ...stored, city: 'Parrish' })).toBe(false);
    expect(firstNameAdvisoryAddressOk(AV, { ...stored, address_line1: '' })).toBe(false);
    expect(firstNameAdvisoryAddressOk(AV, { ...stored, zip: '' })).toBe(false);
    expect(firstNameAdvisoryAddressOk({ ...AV, normalized: {} }, stored)).toBe(false);
    // a missing city on either side is silent; suffix aliases are equivalent
    expect(firstNameAdvisoryAddressOk(AV, { ...stored, city: '' })).toBe(true);
    expect(firstNameAdvisoryAddressOk(AV, { ...stored, address_line1: '100 Example Loop Apt 3' }, { street_line_1: '100 Example Loop', street_line_2: 'Apt 3' })).toBe(true);
  });
});

describe('FIX 1 + FIX 2 wiring in processRecording (structural pin)', () => {
  test('the customer-create branch opens only behind the first-name gate and the validated-premise predicate', () => {
    expect(source).toMatch(/\(extracted\.first_name \|\| firstNameAdvisoryCreate\) && phone && !extracted\.is_voicemail && !v2NonCustomerCallNature/);
    const predicate = source.slice(source.indexOf('const firstNameAdvisoryCreate ='), source.indexOf('const sharedPhoneAmbiguity = {}'));
    expect(predicate).toContain('callFirstNameAdvisoryLive()');
    expect(predicate).toContain("String(extracted.last_name || '').trim()");
    expect(predicate).toContain('firstNameAdvisoryAddressOk(effectiveAddressValidation, extracted, v2CanonicalExtraction?.property?.service_address)');
  });

  test('customer_creation_failed expectation follows the same predicate', () => {
    expect(source).toMatch(/const customerExpected = !!\(\(extracted\.first_name \|\| firstNameAdvisoryCreate\) && phone/);
  });

  test('FIX 2 is a SUGGESTION: a no-phone-match call files ONE card and links, writes and books nothing', () => {
    const start = source.indexOf('if (!existing && !sharedPhoneAmbiguity.candidates');
    const step = source.slice(start, source.indexOf('if (existing) {', start));
    expect(step).toContain('callHouseholdAddressMatchLive()');
    expect(step).toContain('!v2ThirdPartyCallNature');
    expect(step).toContain('findHouseholdCustomerByAddress({');
    expect(step).toContain('addressValidation: effectiveAddressValidation');
    expect(step).toContain('service_address?.street_line_2');
    expect(step).toContain('effectiveAddressValidation?.normalized?.street_line_1');
    expect(step).toContain('fileHouseholdSuggestionCard({');
    expect(step).toContain("if (cardOpen && !bridgeNeedsConfirmation.includes('household_address_match')) bridgeNeedsConfirmation.push('household_address_match');");
    // read-only: no link, no contact write, no stamp, no backfill, no consent change
    for (const forbidden of ['customerId =', 'persistCallSecondaryContact', 'household_link', 'backfill', 'update(', "db('call_log')"]) {
      expect(step).not.toContain(forbidden);
    }
    // every obsolete auto-link piece is gone (CLAUDE.md rule 19)
    for (const gone of ['householdLinkFromCall', 'householdLinkCompleted', 'slotOnlyCaller', 'householdIdentityProtected',
      'protectedServiceContactCaller', 'serviceContactOnlyPhone', 'householdContactWouldRevokeConsent', 'preserveExistingConsent',
      'suppressEmail', 'household_contact_linked', "skipped: 'household_contact'"]) {
      expect(source).not.toContain(gone);
    }
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

  test('V2-primary OFF: a unit that only the V2 service_address carries still refuses a unit-less account; disagreeing renderings refuse', async () => {
    const row = member();
    await trx('customers').insert(row);
    const v2Unit4 = { address_line1: '1083 Example Shell Loop', address_line2: 'Unit 4', zip: '34240' };
    // the legacy extraction has no unit; V2 heard Unit 4 -> a different door than the unit-less account
    expect((await lookup({ address_line2: null }, { alternateAddresses: [v2Unit4] })).reason).toBe('unit_differs');
    // a unit-bearing account matches only the same unit, whichever rendering carries it
    await trx('customers').update({ address_line2: 'Unit 4' });
    expect((await lookup({ address_line2: null }, { alternateAddresses: [v2Unit4] })).customer?.id).toBe(row.id);
    expect((await lookup({ address_line2: 'Unit 5' }, { alternateAddresses: [v2Unit4] })).reason).toBe('unit_conflict');
    // V2 or Address Validation names a different street / ZIP than the legacy extraction
    expect((await lookup({}, { alternateAddresses: [{ address_line1: '1085 Example Shell Loop', zip: '34240' }] })).reason).toBe('address_disagrees');
    expect((await lookup({}, { alternateAddresses: [{ address_line1: '1083 Example Shell Loop', zip: '34241' }] })).reason).toBe('address_disagrees');
    expect((await lookup({ address_line2: 'Unit 4' }, { alternateAddresses: [null, { address_line1: '1083 Example Shell Loop', zip: '34240' }, { address_line1: '' }] })).customer?.id).toBe(row.id);
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

  test('a commercial customer_properties row (property_type or occupancy_type) refuses the match even when the customer row is residential', async () => {
    const row = member({ property_type: 'single_family' });
    await trx('customers').insert(row);
    await trx('customer_properties').insert({ customer_id: row.id, address_line1: '1083 Example Shell Loop', zip: '34240', active: true, address_key: 'k9', property_type: 'single_family', occupancy_type: 'owner_occupied' });
    expect((await lookup()).customer?.id).toBe(row.id);
    await trx('customer_properties').update({ property_type: 'commercial' });
    expect((await lookup()).reason).toBe('commercial_account');
    await trx('customer_properties').update({ property_type: 'single_family', occupancy_type: 'commercial' });
    expect((await lookup()).reason).toBe('commercial_account');
    // an INACTIVE commercial row is a former use, not a classification of this address
    await trx('customer_properties').update({ active: false });
    expect((await lookup()).customer?.id).toBe(row.id);
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

  test('street equivalence is the shared helper: loop vs lp, directionals, on the call side and the stored rows', async () => {
    const row = member({ address_line1: '1083 N Example Shell Lp' });
    await trx('customers').insert(row);
    expect((await lookup({ address_line1: '1083 North Example Shell Loop' })).customer?.id).toBe(row.id);
    expect((await lookup({ address_line1: '1083 N Example Shell Lp' })).customer?.id).toBe(row.id);
    // a different street type is a different street
    expect((await lookup({ address_line1: '1083 N Example Shell Ave' })).reason).toBe('no_address_match');
    // a stored twin spelled the other way still counts toward uniqueness
    await trx('customers').insert(member({ id: randomUUID(), phone: '+19415550111', address_line1: '1083 North Example Shell Loop' }));
    expect((await lookup({ address_line1: '1083 N Example Shell Loop' })).reason).toBe('multiple_customers_at_address');
  });

  test('the suggestion card: filed once, reported open on every retry, never re-opened once resolved', async () => {
    await trx.raw('CREATE TEMP TABLE triage_items (LIKE public.triage_items INCLUDING DEFAULTS INCLUDING INDEXES) ON COMMIT DROP');
    const callLogId = randomUUID();
    const account = member();
    const args = { conn: trx, callLogId, account, extracted: { address_line1: '1083 Example Shell Loop', city: 'Sarasota', zip: '34240' }, phone: NOT_ON_FILE };
    expect(await fileHouseholdSuggestionCard(args)).toBe(true);
    const [card] = await trx('triage_items').where({ call_log_id: callLogId });
    expect(card.reason_code).toBe('household_address_match');
    expect(card.summary).toBe("Caller at Pat Example's address — book on that account?");
    expect(card.payload).toMatchObject({ suggested_customer_id: account.id, suggested_customer_name: 'Pat Example' });
    // RETRY with the card still open: no second card, but the caller is told it is open (re-adds the bridge reason)
    expect(await fileHouseholdSuggestionCard(args)).toBe(true);
    expect(await trx('triage_items').where({ call_log_id: callLogId })).toHaveLength(1);
    await trx('triage_items').update({ status: 'in_progress' });
    expect(await fileHouseholdSuggestionCard(args)).toBe(true);
    // resolved: not re-opened, not re-added
    await trx('triage_items').update({ status: 'resolved' });
    expect(await fileHouseholdSuggestionCard(args)).toBe(false);
    expect(await trx('triage_items').where({ call_log_id: callLogId })).toHaveLength(1);
  });

  test('a number stored only in secondary_phone is identity evidence, never "unknown"', async () => {
    await trx('customers').insert(member());
    await trx('customers').insert(member({ id: randomUUID(), phone: '+19415550110', address_line1: '7 Elsewhere Way', zip: '34241', secondary_phone: NOT_ON_FILE }));
    expect((await lookup()).reason).toBe('phone_on_file');
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
