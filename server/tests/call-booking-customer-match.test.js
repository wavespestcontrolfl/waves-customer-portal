/**
 * Owner ruling 2026-10-02: the AI call booker approved two confirmed bookings on
 * 10-01 and then skipped both as `booked_call_without_customer`.
 *
 * FIX 1 (GATE_CALL_FIRST_NAME_ADVISORY): a caller who gave only a LAST name
 *   (plus email, a validated premise address and caller ID) is still a customer
 *   and books; the missing first name is advisory, never a hold.
 *
 * A full processRecording() run cannot be mocked end-to-end (see
 * call-start-before-call-v2-disabled.test.js), so the decision helpers are tested
 * behaviorally (the card filer against real Postgres when DATABASE_URL is set, as in
 * CI) and the Step 3 wiring is pinned structurally. Synthetic data only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/twilio-numbers', () => ({ isInternalNumber: () => false, isOwnedNumber: () => false }));
const fs = require('fs');
const knex = require('knex');
const { randomUUID } = require('crypto');
const gates = require('../config/feature-gates');
const { _test } = require('../services/call-recording-processor');

const { validatePhoneCallAppointmentCustomer, advisoryBookingAddressHoldFields,
  fileMissingFirstNameCard, firstNameAdvisoryAddressOk, storedAddressMatchesVerdict, missingFirstNameCardStillOpen } = _test;
const source = fs.readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');

const FIRST_NAME_GATE = 'GATE_CALL_FIRST_NAME_ADVISORY';

describe('gates ship dark and read at call time', () => {
  afterEach(() => { delete process.env[FIRST_NAME_GATE]; });

  test.each([
    [FIRST_NAME_GATE, 'callFirstNameAdvisoryLive'],
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

  test('gate on: a caller with neither name is still held (the waiver needs a surname)', () => {
    process.env[FIRST_NAME_GATE] = 'true';
    const v = validatePhoneCallAppointmentCustomer({ ...customerRow, last_name: '' }, { ...extracted, last_name: null }, '+19415550142');
    expect(v.ok).toBe(false);
    expect(v.missing).toContain('first_name');
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
    // A validated unit (SUB_PREMISE) is premise-level too, as in the canonical validator.
    expect(firstNameAdvisoryAddressOk({ ...AV, granularity: 'SUB_PREMISE' }, stored)).toBe(true);
    expect(firstNameAdvisoryAddressOk({ ...AV, status: 'ambiguous' }, stored)).toBe(false);
    expect(firstNameAdvisoryAddressOk({ ...AV, inServiceArea: false }, stored)).toBe(false);
    expect(firstNameAdvisoryAddressOk(null, stored)).toBe(false);
  });
  test('the FULL subpremise must agree: building + apartment, lot and space; a line-1/line-2 conflict refuses', () => {
    const v2 = (line1, line2 = null) => ({ street_line_1: line1, street_line_2: line2 });
    const at = (line1, line2 = null) => ({ ...stored, address_line1: line1, address_line2: line2 });
    expect(firstNameAdvisoryAddressOk(AV, at('100 Example Loop Bldg 9 Apt 204'), v2('100 Example Loop Bldg 9 Apt 204'))).toBe(true);
    expect(firstNameAdvisoryAddressOk(AV, at('100 Example Loop Bldg 9 Apt 204'), v2('100 Example Loop Bldg 10 Apt 204'))).toBe(false);
    expect(firstNameAdvisoryAddressOk(AV, at('100 Example Loop Lot 12'), v2('100 Example Loop Lot 14'))).toBe(false);
    expect(firstNameAdvisoryAddressOk(AV, at('100 Example Loop Space 7'), v2('100 Example Loop'))).toBe(false);
    expect(firstNameAdvisoryAddressOk(AV, at('100 Example Loop Apt 3', 'Apt 4'), v2('100 Example Loop', 'Apt 4'))).toBe(false);
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

describe('FIX 1: creation and the booking hold share ONE address-agreement predicate', () => {
  const AV = { status: 'validated_accept', inServiceArea: true, granularity: 'PREMISE',
    normalized: { street_line_1: '100 Example Loop', city: 'Sarasota', postal_code: '34240' } };
  const verdictAddr = (unit) => ({ street_line_1: '100 Example Loop', street_line_2: unit });
  // Each input creation ACCEPTS must also be accepted by the booking predicate (and vice versa).
  const cases = [
    ['ZIP+4 vs a 5-digit verdict ZIP', { address_line1: '100 Example Loop', zip: '34240-1111' }, null],
    ['a unit embedded in the street line', { address_line1: '100 Example Loop Apt 3', zip: '34240' }, 'Apt 3'],
    ['Apt 3 vs Unit 3 (same unit, different designator)', { address_line1: '100 Example Loop', address_line2: 'Apt 3', zip: '34240' }, 'Unit 3'],
  ];
  test.each(cases)('%s: accepted by creation AND by the booking predicate', (_label, stored, verdictUnit) => {
    expect(firstNameAdvisoryAddressOk(AV, { ...stored, city: 'Sarasota' }, verdictAddr(verdictUnit))).toBe(true);
    expect(storedAddressMatchesVerdict(stored, AV.normalized, verdictAddr(verdictUnit))).toBe(true);
  });
  test.each([
    ['a different unit', { address_line1: '100 Example Loop', address_line2: 'Apt 3', zip: '34240' }, 'Apt 4'],
    ['a stored unit the verdict address lacks', { address_line1: '100 Example Loop Apt 3', zip: '34240' }, null],
    ['a different ZIP', { address_line1: '100 Example Loop', zip: '34241' }, null],
    ['a missing ZIP', { address_line1: '100 Example Loop', zip: '' }, null],
  ])('%s: refused by both', (_label, stored, verdictUnit) => {
    expect(firstNameAdvisoryAddressOk(AV, { ...stored, city: 'Sarasota' }, verdictAddr(verdictUnit))).toBe(false);
    expect(storedAddressMatchesVerdict(stored, AV.normalized, verdictAddr(verdictUnit))).toBe(false);
  });
  test('the divergent booking-side comparison is gone (rule 19): street, ZIP and unit go through the shared predicate', () => {
    const start = source.indexOf('const avValidatesBookedAddress =');
    const block = source.slice(start, source.indexOf('const avPositiveForBooking', start));
    expect(block).toContain('storedAddressMatchesVerdict(extracted, avNormalized, v2StatedAddress)');
    expect(block).not.toMatch(/streetCompareKey|postal_code \|\| ''\)\.trim\(\)|unitKey\(extracted/);
    expect(source).toContain('const n = av.normalized || {};\n  if (!storedAddressMatchesVerdict(extracted, n, verdictAddress)) return false;');
  });
});

describe('FIX 1 wiring in processRecording (structural pin)', () => {
  test('finalization counts the owed-first-name reason toward review_status only while its card is still open (judged under the triage lock)', () => {
    const start = source.indexOf('await lockTriageCall(trx, call.id);\n      // A street-level hold');
    const block = source.slice(start, source.indexOf('// Keep the established leads -> call_log lock order', start));
    expect(block).toContain("const firstNameStillOwed = !bridgeNeedsConfirmation.includes('missing_first_name')");
    expect(block).toContain('await missingFirstNameCardStillOpen(trx, call.id)');
    expect(block).toContain("(r !== 'missing_first_name' || firstNameStillOwed)");
  });

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

  test('the blank-name customer gets its missing_first_name card at creation (fail-soft, one card per call)', () => {
    const start = source.indexOf('Created customer ${customerId} from call recording');
    const site = source.slice(start, source.indexOf('// Both default rows', start));
    expect(site).toContain("if (!String(extracted.first_name || '').trim()) {");
    expect(site).toContain('fileMissingFirstNameCard(db, { callLogId: call.id, customerId');
    expect(site).toContain('catch (cardErr)');
    // the booking path files through the SAME idempotent helper
    expect(source).toContain('fileMissingFirstNameCard(conn, {');
    expect(source).not.toMatch(/findHouseholdCustomerByAddress|GATE_CALL_HOUSEHOLD|household_address_match/);
  });

  test('the confirmation greeting falls back to "there"', () => {
    expect(source).toContain("const firstName = customerValidation.details.firstName || 'there';");
  });
});

const SKIP = !process.env.DATABASE_URL;
(SKIP ? describe.skip : describe)('FIX 1: fileMissingFirstNameCard on PostgreSQL', () => {
  jest.setTimeout(30000);
  let database; let trx;
  beforeAll(() => { database = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 1 } }); });
  beforeEach(async () => {
    trx = await database.transaction();
    await trx.raw('CREATE TEMP TABLE triage_items (LIKE public.triage_items INCLUDING DEFAULTS INCLUDING INDEXES) ON COMMIT DROP');
  });
  afterEach(async () => { await trx.rollback(); });
  afterAll(async () => { await database.destroy(); });

  test('ONE card per call across the creation site and the booking path, whatever its status', async () => {
    const callLogId = randomUUID();
    const customerId = randomUUID();
    const args = { callLogId, customerId, extracted: { first_name: null, last_name: 'Murphy' } };
    expect(await fileMissingFirstNameCard(trx, args)).toBe(true); // customer-create site
    const [card] = await trx('triage_items').where({ call_log_id: callLogId });
    expect(card).toMatchObject({ reason_code: 'missing_first_name', category: 'name_review', severity: 'advisory', status: 'open' });
    // stamped with the customer it was filed FOR (the auto-resolve rule reads this record, never the call's later link)
    expect(card.payload).toMatchObject({ customer_id: customerId, heard_name_v1: { first_name: null, last_name: 'Murphy' } });
    expect(await fileMissingFirstNameCard(trx, args)).toBe(false); // booking-path site: no duplicate
    await trx('triage_items').update({ status: 'in_progress' });
    expect(await fileMissingFirstNameCard(trx, args)).toBe(false);
    await trx('triage_items').update({ status: 'resolved' }); // a resolved card is not re-opened by the other site
    expect(await fileMissingFirstNameCard(trx, args)).toBe(false);
    expect(await trx('triage_items').where({ call_log_id: callLogId })).toHaveLength(1);
    // the finalization recheck: only an open / claimed card keeps the reason counting toward review_status
    await trx('triage_items').update({ status: 'open' });
    expect(await missingFirstNameCardStillOpen(trx, callLogId)).toBe(true);
    await trx('triage_items').update({ status: 'in_progress' });
    expect(await missingFirstNameCardStillOpen(trx, callLogId)).toBe(true);
    await trx('triage_items').update({ status: 'resolved' });
    expect(await missingFirstNameCardStillOpen(trx, callLogId)).toBe(false);
    await trx('triage_items').update({ status: 'dismissed' });
    expect(await missingFirstNameCardStillOpen(trx, callLogId)).toBe(false);
    expect(await missingFirstNameCardStillOpen(trx, randomUUID())).toBe(false);
    // a different call gets its own card
    expect(await fileMissingFirstNameCard(trx, { ...args, callLogId: randomUUID() })).toBe(true);
  });
});
