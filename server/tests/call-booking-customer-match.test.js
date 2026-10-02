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
  fileMissingFirstNameCard, firstNameAdvisoryAddressOk, addressesExactlyMatch, missingFirstNameCardStillOpen } = _test;
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
    expect(advisoryBookingAddressHoldFields({ enforceModeActive: false, customerValidation: ok(['first_name']), avPositiveForBooking: true, exactAddressForBooking: false })).toEqual(['first_name']);
    expect(advisoryBookingAddressHoldFields({ enforceModeActive: false, customerValidation: ok(['email', 'first_name', 'last_name']), avPositiveForBooking: false, exactAddressForBooking: false })).toEqual(['email', 'first_name']);
    // an email on file does NOT lift the hold for a first-name-less booking
    expect(advisoryBookingAddressHoldFields({ enforceModeActive: false, customerValidation: ok(['first_name', 'last_name']), avPositiveForBooking: true })).toEqual(['first_name']);
  });
  test('no hold when the verdict validates the booked address, for a named caller, or when the customer is already not ok', () => {
    expect(advisoryBookingAddressHoldFields({ enforceModeActive: false, customerValidation: ok(['first_name']), avPositiveForBooking: false, exactAddressForBooking: true })).toEqual([]);
    // enforce mode exempts only the EMAIL advisory; the first-name exact-match rule holds in every mode
    expect(advisoryBookingAddressHoldFields({ enforceModeActive: true, customerValidation: ok(['email']), avPositiveForBooking: false })).toEqual([]);
    expect(advisoryBookingAddressHoldFields({ enforceModeActive: true, customerValidation: ok(['email', 'first_name']), avPositiveForBooking: false, exactAddressForBooking: false })).toEqual(['first_name']);
    expect(advisoryBookingAddressHoldFields({ enforceModeActive: true, customerValidation: ok(['first_name']), exactAddressForBooking: true })).toEqual([]);
    expect(advisoryBookingAddressHoldFields({ enforceModeActive: false, customerValidation: ok(['last_name']), avPositiveForBooking: false })).toEqual([]);
    expect(advisoryBookingAddressHoldFields({ enforceModeActive: false, customerValidation: { ok: false, missing: ['phone'], advisory: ['first_name'] }, avPositiveForBooking: false })).toEqual([]);
    expect(advisoryBookingAddressHoldFields({})).toEqual([]);
  });
  test('wiring: the hold decision uses the helper and reports the advisory fields', () => {
    expect(source).toContain('advisoryBookingAddressHoldFields({ enforceModeActive, customerValidation, avPositiveForBooking, exactAddressForBooking })');
    expect(source).toContain('customerValidation.ok ? advisoryHoldFields : customerValidation.missing');
  });
});

describe('FIX 1: "book only on an exact match" — ONE predicate for creation and the booking hold', () => {
  const AV = { status: 'validated_accept', inServiceArea: true, granularity: 'PREMISE' };
  const V2 = { street_line_1: '100 Example Loop', street_line_2: null, city: 'Sarasota', postal_code: '34240' };
  const stored = { address_line1: '100 Example Loop', address_line2: null, city: 'Sarasota', zip: '34240' };
  const ok = (st, v2 = V2) => firstNameAdvisoryAddressOk(AV, st, v2);

  test('an exact match passes; case, whitespace, punctuation, ZIP+4 and the suffix alias table are the only cleanup', () => {
    expect(ok(stored)).toBe(true);
    expect(ok({ ...stored, address_line1: ' 100  example LOOP. ', city: 'sarasota', zip: '34240-1111' })).toBe(true);
    expect(ok({ ...stored, address_line1: '100 Example Lp' })).toBe(true);
    expect(ok(stored, { ...V2, street_line_1: '100 Example Lp' })).toBe(true);
    expect(ok({ ...stored, address_line1: '100 Example Ln' }, { ...V2, street_line_1: '100 Example Lane' })).toBe(true);
    expect(ok({ ...stored, address_line1: '100 Example Apt 3' }, { ...V2, street_line_1: '100 Example Apt 3' })).toBe(true);
    expect(addressesExactlyMatch(stored, V2)).toBe(true);
  });

  test.each([
    ['Apt 3 vs Unit 3', { address_line2: 'Apt 3' }, { street_line_2: 'Unit 3' }],
    ['Apt 3 vs a bare 3', { address_line2: 'Apt 3' }, { street_line_2: '3' }],
    ['a unit on one side only', { address_line2: 'Apt 3' }, {}],
    ['a unit on the verdict side only', {}, { street_line_2: 'Apt 3' }],
    ['differing units', { address_line2: 'Apt 3' }, { street_line_2: 'Apt 4' }],
    ['Bldg 9 + 204 split across lines vs Bldg 9 Apt 204', { address_line1: '100 Example Loop Bldg 9', address_line2: '204' }, { street_line_1: '100 Example Loop Bldg 9 Apt 204' }],
    ['Bldg 9 / Apt 204 vs Bldg 9 Apt 204', { address_line1: '100 Example Loop Bldg 9', address_line2: 'Apt 204' }, { street_line_1: '100 Example Loop Bldg 9 Apt 204' }],
    ['a different street', { address_line1: '102 Example Loop' }, {}],
    ['a different street type', { address_line1: '100 Example Ave' }, {}],
    ['a different city', { city: 'Parrish' }, {}],
    ['a different ZIP', { zip: '34241' }, {}],
    ['a missing ZIP', { zip: '' }, {}],
    ['a missing city', { city: '' }, {}],
    ['a missing street', { address_line1: '' }, {}],
    ['a missing verdict input piece', {}, { postal_code: '' }],
  ])('%s holds (no auto-create, no auto-book)', (_label, storedOver, v2Over) => {
    expect(ok({ ...stored, ...storedOver }, { ...V2, ...v2Over })).toBe(false);
  });

  test('no verdict input (V2 invalid or absent) is never exact', () => {
    expect(firstNameAdvisoryAddressOk(AV, stored, null)).toBe(false);
    expect(firstNameAdvisoryAddressOk(AV, stored, undefined)).toBe(false);
  });

  test('the verdict must be an accepted in-area PREMISE / SUB_PREMISE address', () => {
    expect(firstNameAdvisoryAddressOk({ ...AV, granularity: 'SUB_PREMISE' }, stored, V2)).toBe(true);
    expect(firstNameAdvisoryAddressOk({ ...AV, status: 'corrected' }, stored, V2)).toBe(true);
    expect(firstNameAdvisoryAddressOk({ ...AV, granularity: undefined }, stored, V2)).toBe(false);
    expect(firstNameAdvisoryAddressOk({ ...AV, granularity: 'ROUTE' }, stored, V2)).toBe(false);
    expect(firstNameAdvisoryAddressOk({ ...AV, status: 'ambiguous' }, stored, V2)).toBe(false);
    expect(firstNameAdvisoryAddressOk({ ...AV, inServiceArea: false }, stored, V2)).toBe(false);
    expect(firstNameAdvisoryAddressOk(null, stored, V2)).toBe(false);
  });

  test('wiring: creation and the booking hold call the same predicate, a recovery-rewritten input is never exact, and the superseded unit machinery is gone (rule 19)', () => {
    expect(source).toContain('firstNameAdvisoryAddressOk(effectiveAddressValidation, extracted, v2CanonicalExtraction?.property?.service_address)');
    expect(source).toContain('firstNameAdvisoryAddressOk(effectiveAddressValidation, extracted, v2StatedAddress)');
    expect(source.match(/!addressRecovery\?\.recovered/g).length).toBeGreaterThanOrEqual(2);
    for (const gone of ['storedAddressMatchesVerdict', 'function addressLineUnit', 'function addressRenderingsAgree', 'addressZip5']) {
      expect(source).not.toContain(gone);
    }
  });

  test('wiring: the booking path marks the call for review while the first-name card is open', () => {
    expect(source).toContain("if (await missingFirstNameCardStillOpen(db, call.id).catch(() => false)");
  });

  test('wiring: the fenced re-read that files the card late also counts it toward review while it stays open', () => {
    const start = source.indexOf("if (freshValidation.advisory?.includes('first_name')) {");
    const block = source.slice(start, start + 700);
    expect(block).toContain('await missingFirstNameCardStillOpen(trx, call.id)');
    expect(block).toContain("bridgeNeedsConfirmation.push('missing_first_name')");
  });

  test('wiring: the fenced re-read re-applies the advisory address hold when the fresh row lost its first name', () => {
    const start = source.indexOf('const freshHoldFields = advisoryBookingAddressHoldFields({');
    const block = source.slice(start, start + 900);
    expect(block).toContain('customerValidation: freshValidation');
    expect(block).toContain("freshHoldFields.includes('first_name')");
    expect(block).toContain('throw new Error(');
    // the same decision the pre-fence hold makes: a fresh first_name advisory without an exact address holds; with one it does not
    const fresh = { ok: true, missing: [], advisory: ['first_name'] };
    expect(advisoryBookingAddressHoldFields({ enforceModeActive: false, customerValidation: fresh, avPositiveForBooking: true, exactAddressForBooking: false })).toEqual(['first_name']);
    expect(advisoryBookingAddressHoldFields({ enforceModeActive: false, customerValidation: fresh, avPositiveForBooking: true, exactAddressForBooking: true })).toEqual([]);
  });

  test('the list append takes the per-call triage lock before the row lock, so it serializes with Resolve / Dismiss / the sweep', () => {
    const start = source.indexOf('async function fileMissingFirstNameCard(');
    const block = source.slice(start, source.indexOf('async function missingFirstNameCardStillOpen', start));
    expect(block.indexOf('await lockTriageCall(trx, callLogId);')).toBeGreaterThan(-1);
    expect(block.indexOf('await lockTriageCall(trx, callLogId);')).toBeLessThan(block.indexOf('.forUpdate()'));
  });

  test('the card text states the durable fact, not a booking', () => {
    expect(source).toContain('missing_first_name: "customer created without a first name — get it"');
    expect(source).not.toContain('booked on the last name alone');
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

  test('the customer-create branch opens only behind the first-name gate and the exact-match predicate', () => {
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
    expect(card.payload).toMatchObject({ customer_ids: [customerId], heard_name_v1: { first_name: null, last_name: 'Murphy' } });
    expect(await fileMissingFirstNameCard(trx, args)).toBe(false); // booking-path site: no duplicate
    await trx('triage_items').update({ status: 'in_progress' });
    expect(await fileMissingFirstNameCard(trx, args)).toBe(false);
    await trx('triage_items').update({ status: 'resolved' }); // a resolved card is not re-opened by the other site
    expect(await fileMissingFirstNameCard(trx, args)).toBe(false);
    expect(await trx('triage_items').where({ call_log_id: callLogId })).toHaveLength(1);
    // RELINK / REBOOK: the call now owes a first name on a DIFFERENT blank-name customer B while A's
    // card is open. ONE open card per call (the unique index), so B is APPENDED to its list — A is never dropped.
    const other = randomUUID();
    await trx('triage_items').update({ status: 'open' });
    expect(await fileMissingFirstNameCard(trx, { ...args, customerId: other })).toBe(true);
    let rows = await trx('triage_items').where({ call_log_id: callLogId });
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.customer_ids).toEqual([customerId, other]);
    // listing either customer again never duplicates or reorders
    expect(await fileMissingFirstNameCard(trx, { ...args, customerId: other })).toBe(false);
    expect(await fileMissingFirstNameCard(trx, args)).toBe(false);
    // a third owed customer appends too
    const third = randomUUID();
    expect(await fileMissingFirstNameCard(trx, { ...args, customerId: third })).toBe(true);
    expect((await trx('triage_items').where({ call_log_id: callLogId }))[0].payload.customer_ids).toEqual([customerId, other, third]);
    // a card filed BEFORE the list shape (scalar customer_id) is read as a one-element list and appended to
    await trx('triage_items').where({ call_log_id: callLogId }).update({ payload: JSON.stringify({ customer_id: customerId }) });
    expect(await fileMissingFirstNameCard(trx, args)).toBe(false);
    expect(await fileMissingFirstNameCard(trx, { ...args, customerId: other })).toBe(true);
    expect((await trx('triage_items').where({ call_log_id: callLogId }))[0].payload.customer_ids).toEqual([customerId, other]);
    // when the call's cards are ALL terminal, a newly owed customer gets a FRESH card; a listed one is not re-opened
    await trx('triage_items').update({ status: 'resolved' });
    expect(await fileMissingFirstNameCard(trx, args)).toBe(false);
    expect(await fileMissingFirstNameCard(trx, { ...args, customerId: third })).toBe(true);
    rows = await trx('triage_items').where({ call_log_id: callLogId }).orderBy('created_at');
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.status === 'open')).toHaveLength(1);
    expect(rows.find((r) => r.status === 'open').payload.customer_ids).toEqual([third]);
    await trx('triage_items').where({ call_log_id: callLogId }).del();
    await fileMissingFirstNameCard(trx, args);
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
