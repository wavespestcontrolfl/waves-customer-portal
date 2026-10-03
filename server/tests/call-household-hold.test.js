/**
 * GATE_CALL_HOUSEHOLD_HOLD: a caller from a number NOT on file whose validated service address
 * belongs to exactly ONE live residential customer is HELD for the office. No new customer, no
 * auto-booking, ONE household_address_match card, nothing written to any customer.
 *
 * A full processRecording() run cannot be mocked end-to-end (see
 * call-booking-customer-match.test.js), so the decision helpers are tested behaviorally (the
 * finder and the card filer against real Postgres TEMP tables when DATABASE_URL is set, as in CI)
 * and the Step 3 / booking / finalization wiring is pinned structurally. Synthetic data only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/twilio-numbers', () => ({ isInternalNumber: () => false, isOwnedNumber: () => false }));
const fs = require('fs');
const knex = require('knex');
const { randomUUID } = require('crypto');
const gates = require('../config/feature-gates');
const { _test } = require('../services/call-recording-processor');

const {
  householdHoldEligible, classifyHouseholdCandidates, loadHouseholdCandidates, householdPhoneOnFile,
  findHouseholdCustomerByAddress, fileHouseholdHoldCard, triageCardStillOpen, firstNameAdvisoryAddressOk,
} = _test;
const source = fs.readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');
const GATE = 'GATE_CALL_HOUSEHOLD_HOLD';

describe('the gate ships dark and is read at call time', () => {
  afterEach(() => { delete process.env[GATE]; });

  test('callHouseholdHoldLive is off unless exactly "true", and re-reads the environment on every call', () => {
    expect(gates.callHouseholdHoldLive()).toBe(false);
    for (const v of ['1', 'TRUE', 'on', 'yes', '', ' true']) {
      process.env[GATE] = v;
      expect(gates.callHouseholdHoldLive()).toBe(false);
    }
    process.env[GATE] = 'true';
    expect(gates.callHouseholdHoldLive()).toBe(true);
    delete process.env[GATE];
    expect(gates.callHouseholdHoldLive()).toBe(false);
  });

  test('it is documented in the header list and exported on its OWN line', () => {
    const src = fs.readFileSync(require.resolve('../config/feature-gates'), 'utf8');
    expect(src).toMatch(/^ \*   GATE_CALL_HOUSEHOLD_HOLD=true \(/m);
    expect(src).toMatch(/^module\.exports\.callHouseholdHoldLive = callHouseholdHoldLive;$/m);
    expect(src).toContain("callHouseholdHold: process.env.GATE_CALL_HOUSEHOLD_HOLD === 'true',");
  });
});

describe('householdHoldEligible: every trigger condition that needs no database read', () => {
  const ok = {
    gateLive: true, customerId: null, hasLinkOverride: false, explicitUnlink: false, phone: '+19415550123',
    isVoicemail: false, isSpam: false, nonCustomerNature: false, commercialCall: false, createBranchOpen: true, addressOk: true,
  };
  test('all conditions met holds', () => {
    expect(householdHoldEligible(ok)).toBe(true);
  });
  test.each([
    ['the gate is off', { gateLive: false }],
    ['the call already has a customer', { customerId: 'cust-1' }],
    ['an operator link override is set', { hasLinkOverride: true }],
    ['the operator explicitly unlinked the call', { explicitUnlink: true }],
    ['there is no caller phone', { phone: null }],
    ['the customer-create branch would not have run (no first name)', { createBranchOpen: false }],
    ['it is a voicemail', { isVoicemail: true }],
    ['it is spam', { isSpam: true }],
    ['it is a non-customer call nature', { nonCustomerNature: true }],
    ['it is a commercial call or HOA common area', { commercialCall: true }],
    ['the address verdict / exact match failed', { addressOk: false }],
  ])('%s: no hold', (_label, over) => {
    expect(householdHoldEligible({ ...ok, ...over })).toBe(false);
  });
  test('an empty context never holds', () => {
    expect(householdHoldEligible()).toBe(false);
    expect(householdHoldEligible({})).toBe(false);
  });
});

describe('the address check is the first-name advisory predicate, validated_accept only', () => {
  const AV = { status: 'validated_accept', inServiceArea: true, granularity: 'PREMISE',
    normalized: { street_line_1: '100 Example Loop', city: 'Sarasota', state: 'FL', postal_code: '34240-1234' } };
  const V2 = { street_line_1: '100 Example Loop', street_line_2: null, city: 'Sarasota', postal_code: '34240' };
  const stored = { address_line1: '100 Example Loop', address_line2: null, city: 'Sarasota', zip: '34240' };
  test('only an accepted, in-area, premise-level, exactly matching verdict qualifies; a corrected one never does', () => {
    expect(firstNameAdvisoryAddressOk(AV, stored, V2)).toBe(true);
    expect(firstNameAdvisoryAddressOk({ ...AV, granularity: 'SUB_PREMISE' }, stored, V2)).toBe(true);
    expect(firstNameAdvisoryAddressOk({ ...AV, status: 'corrected' }, stored, V2)).toBe(false);
    expect(firstNameAdvisoryAddressOk({ ...AV, inServiceArea: false }, stored, V2)).toBe(false);
    expect(firstNameAdvisoryAddressOk({ ...AV, granularity: 'ROUTE' }, stored, V2)).toBe(false);
    expect(firstNameAdvisoryAddressOk(AV, { ...stored, address_line1: '102 Example Loop' }, V2)).toBe(false);
    expect(firstNameAdvisoryAddressOk(AV, stored, null)).toBe(false);
  });
  test('wiring: the hold calls the SAME predicate as customer creation, never a second matcher, and refuses a street recovery', () => {
    const block = source.slice(source.indexOf('&& require(\'../config/feature-gates\').callHouseholdHoldLive()'), source.indexOf('const householdMatch = await findHouseholdCustomerByAddress'));
    expect(block).toContain('!addressRecovery?.recovered');
    expect(block).toContain('firstNameAdvisoryAddressOk(effectiveAddressValidation, extracted, v2CanonicalExtraction ? v2StatedServiceAddressRaw : null)');
    expect(block).toContain('callHouseholdHoldLive()');
    expect(block).toContain('hasLinkOverride: !!customerLinkOverride');
    expect(block).toContain('explicitUnlink,');
    expect(block).toContain("v2CanonicalExtraction?.property?.property_type === 'commercial'");
    expect(block).toContain('hoa_common_area_service === true');
    expect(block).toContain('createBranchOpen: !!(extracted.first_name || firstNameAdvisoryCreate)');
  });
});

describe('classifyHouseholdCandidates: exactly ONE live residential customer at the address', () => {
  const call = { address_line1: '100 Example Loop', address_line2: null, city: 'Sarasota', zip: '34240' };
  const src = (over = {}) => ({ address_line1: '100 Example Loop', address_line2: null, city: 'Sarasota', zip: '34240', commercial: false, ...over });
  const cust = (id, over = {}) => ({ id, first_name: 'Sample', last_name: 'Customer', active: true, property_type: 'residential', waveguard_tier: 'Bronze', ...over });
  const set = (entries) => ({
    customers: entries.map(([c]) => c),
    sourcesById: new Map(entries.map(([c, sources]) => [c.id, sources])),
  });

  test('zero candidates: no hold', () => {
    expect(classifyHouseholdCandidates({ customers: [], sourcesById: new Map() }, call)).toEqual({ customer: null, reason: 'no_address_match' });
  });

  test('exactly one: the hold names that customer', () => {
    const a = cust('a');
    expect(classifyHouseholdCandidates(set([[a, [src()]]]), call)).toEqual({ customer: a, reason: 'address_match' });
  });

  test('two or more matching customers: no hold, however they match (row or property source)', () => {
    const [a, b] = [cust('a'), cust('b')];
    expect(classifyHouseholdCandidates(set([[a, [src()]], [b, [src()]]]), call).reason).toBe('multiple_customers_at_address');
    // a second account that holds the address as a property row counts too
    expect(classifyHouseholdCandidates(set([[a, [src({ address_line1: '7 Elsewhere Way' }), src()]], [b, [src()]]]), call).reason).toBe('multiple_customers_at_address');
  });

  test('a customer with the address on BOTH its row and a property row is still one customer', () => {
    const a = cust('a');
    expect(classifyHouseholdCandidates(set([[a, [src(), src()]]]), call).customer).toBe(a);
  });

  test.each([
    ['a unit on the stored side only', { address_line2: 'Apt 3' }, {}],
    ['a unit on the call side only', {}, { address_line2: 'Apt 3' }],
    ['differing units', { address_line2: 'Apt 3' }, { address_line2: 'Apt 4' }],
    ['a different city', { city: 'Parrish' }, {}],
    ['a different ZIP', { zip: '34241' }, {}],
    ['a missing ZIP on the stored side', { zip: '' }, {}],
    ['a missing city on the stored side', { city: '' }, {}],
    ['a different house number', { address_line1: '102 Example Loop' }, {}],
    ['a different street type', { address_line1: '100 Example Ave' }, {}],
  ])('%s: not a match, no hold', (_label, storedOver, callOver) => {
    expect(classifyHouseholdCandidates(set([[cust('a'), [src(storedOver)]]]), { ...call, ...callOver }).reason).toBe('no_address_match');
  });

  test('the basic cleanup only: case, punctuation, whitespace, ZIP+4 and the suffix alias table match', () => {
    const a = cust('a');
    expect(classifyHouseholdCandidates(set([[a, [src({ address_line1: ' 100  example LP. ', city: 'sarasota', zip: '34240-1111' })]]]), call).customer).toBe(a);
    expect(classifyHouseholdCandidates(set([[a, [src({ address_line1: '100 Example Lp' })]]]), { ...call, address_line1: '100 Example Loop' }).customer).toBe(a);
    // the same unit on both sides, after the same cleanup
    expect(classifyHouseholdCandidates(set([[a, [src({ address_line2: 'Apt 3' })]]]), { ...call, address_line2: ' apt  3 ' }).customer).toBe(a);
  });

  test('an explicitly inactive customer is not counted (and so cannot make a second household); a NULL flag is', () => {
    const [a, inactive] = [cust('a'), cust('b', { active: false })];
    expect(classifyHouseholdCandidates(set([[a, [src()]], [inactive, [src()]]]), call).customer).toBe(a);
    expect(classifyHouseholdCandidates(set([[inactive, [src()]]]), call).reason).toBe('no_address_match');
    // active NULL still counts toward "more than one", then fails the active requirement on its own
    expect(classifyHouseholdCandidates(set([[cust('a'), [src()]], [cust('n', { active: null }), [src()]]]), call).reason).toBe('multiple_customers_at_address');
    expect(classifyHouseholdCandidates(set([[cust('n', { active: null }), [src()]]]), call).reason).toBe('not_active');
  });

  test.each([
    ['a commercial customer row', { property_type: 'commercial' }, [src()]],
    ['a business customer row', { property_type: 'Business' }, [src()]],
    ['a Commercial-tier customer', { waveguard_tier: 'Commercial' }, [src()]],
    ['a commercial property source (occupancy/property type)', {}, [src({ commercial: true })]],
  ])('%s: refused, no hold', (_label, over, sources) => {
    expect(classifyHouseholdCandidates(set([[cust('a', over), sources]]), call)).toEqual({ customer: null, reason: 'commercial_account' });
  });

  test('an UNRELATED commercial property on a residential customer does not waive the hold (codex #5700 r1 P1)', () => {
    const a = cust('a');
    const elsewhere = src({ address_line1: '7 Elsewhere Way', commercial: true });
    expect(classifyHouseholdCandidates(set([[a, [src(), elsewhere]]]), call)).toEqual({ customer: a, reason: 'address_match' });
  });
});

// A real Postgres: the loader, the phone check, the finder and the card filer, on TEMP tables
// shadowing the real ones (the pattern of the fileMissingFirstNameCard suite).
const SKIP = !process.env.DATABASE_URL;
(SKIP ? describe.skip : describe)('household hold on PostgreSQL', () => {
  jest.setTimeout(30000);
  let database; let trx;
  beforeAll(() => { database = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 1 } }); });
  beforeEach(async () => {
    trx = await database.transaction();
    for (const table of ['customers', 'customer_properties', 'triage_items', 'call_log']) {
      await trx.raw(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING DEFAULTS INCLUDING INDEXES) ON COMMIT DROP`);
    }
  });
  afterEach(async () => { await trx.rollback(); });
  afterAll(async () => { await database.destroy(); });

  const CALL = { address_line1: '100 Example Loop', address_line2: null, city: 'Sarasota', zip: '34240' };
  const newCustomer = async (over = {}) => {
    const [row] = await trx('customers').insert({
      first_name: 'Sample', last_name: 'Customer', phone: '+19415550100', address_line1: '100 Example Loop',
      city: 'Sarasota', state: 'FL', zip: '34240', active: true, ...over,
    }).returning('*');
    return row;
  };

  test('the finder: one live residential customer at the address is found; the number must be on no live customer', async () => {
    const owner = await newCustomer();
    const found = await findHouseholdCustomerByAddress({ phone: '+19415550999', address: CALL, conn: trx });
    expect(found.reason).toBe('address_match');
    expect(found.customer.id).toBe(owner.id);
    // the caller's number is the owner's primary, a service-contact slot, or the secondary phone: not a stranger
    for (const [col, value] of [['phone', '+19415550999'], ['service_contact_phone', '(941) 555-0999'], ['service_contact2_phone', '+19415550999'],
      ['service_contact3_phone', '19415550999'], ['secondary_phone', '941-555-0999']]) {
      await trx('customers').where({ id: owner.id }).update({ phone: '+19415550100', service_contact_phone: null, service_contact2_phone: null, service_contact3_phone: null, secondary_phone: null });
      await trx('customers').where({ id: owner.id }).update({ [col]: value });
      expect((await findHouseholdCustomerByAddress({ phone: '+19415550999', address: CALL, conn: trx })).reason).toBe('phone_on_file');
    }
    // ANOTHER live customer elsewhere holding the number also blocks the hold
    await trx('customers').where({ id: owner.id }).update({ secondary_phone: null });
    await newCustomer({ phone: '+19415550999', address_line1: '7 Elsewhere Way', zip: '34241' });
    expect((await findHouseholdCustomerByAddress({ phone: '+19415550999', address: CALL, conn: trx })).reason).toBe('phone_on_file');
    expect((await findHouseholdCustomerByAddress({ phone: null, address: CALL, conn: trx })).reason).toBe('no_phone');
  });

  test('a soft-deleted customer owns neither the number nor the address', async () => {
    const gone = await newCustomer({ phone: '+19415550999', deleted_at: new Date() });
    expect(await householdPhoneOnFile(trx, '9415550999')).toBe(false);
    expect((await findHouseholdCustomerByAddress({ phone: '+19415550999', address: CALL, conn: trx })).reason).toBe('no_address_match');
    // …and a deleted second account cannot turn one household into two
    const live = await newCustomer({ phone: '+19415550100' });
    const found = await findHouseholdCustomerByAddress({ phone: '+19415550999', address: CALL, conn: trx });
    expect(found.customer.id).toBe(live.id);
    expect(found.customer.id).not.toBe(gone.id);
  });

  test('two live customers at the address: no hold; a second at another door or city is not a second household', async () => {
    await newCustomer();
    const apt3 = await newCustomer({ phone: '+19415550101', address_line2: 'Apt 3' });
    await newCustomer({ phone: '+19415550102', city: 'Parrish' });
    // the unit-less call only matches the unit-less account (a unit on one side only is another door)
    expect((await findHouseholdCustomerByAddress({ phone: '+19415550999', address: CALL, conn: trx })).reason).toBe('address_match');
    await newCustomer({ phone: '+19415550103' });
    expect((await findHouseholdCustomerByAddress({ phone: '+19415550999', address: CALL, conn: trx })).reason).toBe('multiple_customers_at_address');
    // the Apt 3 caller matches only the Apt 3 account
    const unit = await findHouseholdCustomerByAddress({ phone: '+19415550999', address: { ...CALL, address_line2: 'apt 3' }, conn: trx });
    expect(unit.reason).toBe('address_match');
    expect(unit.customer.id).toBe(apt3.id);
  });

  test('the address may live on an ACTIVE property row; an inactive row or a commercial property row never counts as residential', async () => {
    const owner = await newCustomer({ address_line1: '7 Elsewhere Way', zip: '34241' });
    await trx('customer_properties').insert({ customer_id: owner.id, address_line1: '100 Example Loop', city: 'Sarasota', zip: '34240', active: true });
    const viaProperty = await findHouseholdCustomerByAddress({ phone: '+19415550999', address: CALL, conn: trx });
    expect(viaProperty.customer.id).toBe(owner.id);
    await trx('customer_properties').where({ customer_id: owner.id }).update({ active: false });
    expect((await findHouseholdCustomerByAddress({ phone: '+19415550999', address: CALL, conn: trx })).reason).toBe('no_address_match');
    await trx('customer_properties').where({ customer_id: owner.id }).update({ active: true, occupancy_type: 'commercial' });
    expect((await findHouseholdCustomerByAddress({ phone: '+19415550999', address: CALL, conn: trx })).reason).toBe('commercial_account');
    // a second account's property row counts toward "more than one"
    const other = await newCustomer({ phone: '+19415550101', address_line1: '9 Another Rd', zip: '34242' });
    await trx('customer_properties').where({ customer_id: owner.id }).update({ occupancy_type: 'owner_occupied' });
    await trx('customer_properties').insert({ customer_id: other.id, address_line1: '100 Example Lp', city: 'sarasota', zip: '34240-0001', active: true });
    expect((await findHouseholdCustomerByAddress({ phone: '+19415550999', address: CALL, conn: trx })).reason).toBe('multiple_customers_at_address');
  });

  test('the loader reads only whole-token house-number candidates and never limits the count', async () => {
    for (let i = 0; i < 25; i += 1) await newCustomer({ phone: `+1941555${String(2000 + i)}` });
    await newCustomer({ phone: '+19415558000', address_line1: '1100 Example Loop' });
    const { customers } = await loadHouseholdCandidates(trx, CALL);
    expect(customers).toHaveLength(25);
    expect((await loadHouseholdCandidates(trx, { ...CALL, address_line1: 'Example Ranch' })).customers).toEqual([]);
  });

  test('the card filer: ONE card per call with the full payload; open/claimed dedup; a dismissed card waives; a resolved one re-files', async () => {
    const callLogId = randomUUID();
    const customerId = randomUUID();
    const args = {
      callLogId, customerId, phone: '+19415550999', service: 'Pest Control',
      extracted: { first_name: 'Sample', last_name: 'Caller', address_line1: '100 Example Loop', address_line2: null, city: 'Sarasota', zip: '34240', preferred_date_time: 'Tuesday at 10 AM' },
    };
    expect(await fileHouseholdHoldCard(trx, args)).toBe('open');
    const [card] = await trx('triage_items').where({ call_log_id: callLogId });
    expect(card).toMatchObject({ reason_code: 'household_address_match', category: 'customer_field_conflict', severity: 'blocking', status: 'open' });
    expect(card.payload).toMatchObject({
      suggested_customer_id: customerId,
      heard_name_v1: { first_name: 'Sample', last_name: 'Caller' },
      caller_phone: '+19415550999',
      address: '100 Example Loop, Sarasota, 34240',
      preferred_date_time: 'Tuesday at 10 AM',
      service: 'Pest Control',
    });
    // a reprocess that still triggers files nothing more — whether the card is open or claimed
    expect(await fileHouseholdHoldCard(trx, args)).toBe('open');
    // unchanged evidence leaves the card's version untouched
    const [same] = await trx('triage_items').where({ call_log_id: callLogId });
    expect(new Date(same.updated_at).getTime()).toBe(new Date(card.updated_at).getTime());
    await trx('triage_items').update({ status: 'in_progress' });
    expect(await fileHouseholdHoldCard(trx, args)).toBe('open');
    expect(await trx('triage_items').where({ call_log_id: callLogId })).toHaveLength(1);
    // a reprocess whose match MOVED to another customer / address refreshes the standing card (codex #5700 r1 P1)
    const otherCustomer = randomUUID();
    expect(await fileHouseholdHoldCard(trx, {
      ...args, customerId: otherCustomer, extracted: { ...args.extracted, address_line1: '200 Sample Way' },
    })).toBe('open');
    const moved = await trx('triage_items').where({ call_log_id: callLogId });
    expect(moved).toHaveLength(1);
    expect(moved[0].status).toBe('in_progress');
    expect(moved[0].payload).toMatchObject({ suggested_customer_id: otherCustomer, address: '200 Sample Way, Sarasota, 34240', flag: 'household_address_match' });
    expect(new Date(moved[0].updated_at).getTime()).toBeGreaterThan(new Date(card.updated_at).getTime());
    // the office DISMISSED it ("really someone new"): not re-filed, and the hold is waived
    await trx('triage_items').update({ status: 'dismissed' });
    expect(await fileHouseholdHoldCard(trx, args)).toBe('waived');
    expect(await trx('triage_items').where({ call_log_id: callLogId })).toHaveLength(1);
    // a RESOLVED card (booked by hand, call still unlinked and still triggering) may be re-filed, once
    await trx('triage_items').update({ status: 'resolved' });
    expect(await fileHouseholdHoldCard(trx, args)).toBe('open');
    expect(await fileHouseholdHoldCard(trx, args)).toBe('open');
    const rows = await trx('triage_items').where({ call_log_id: callLogId });
    expect(rows.map((r) => r.status).sort()).toEqual(['open', 'resolved']);
    // a different call gets its own card
    expect(await fileHouseholdHoldCard(trx, { ...args, callLogId: randomUUID() })).toBe('open');
  });

  test('the card filer re-checks the call under the lock: a linked call or a lost claim files nothing', async () => {
    const [call] = await trx('call_log').insert({ twilio_call_sid: `CA${'9'.repeat(30)}h1`, direction: 'inbound', processing_token: 'tok-1' }).returning('id');
    const args = { callLogId: call.id, procToken: 'tok-1', customerId: randomUUID(), phone: '+19415550999', extracted: { first_name: 'Sample' } };
    expect(await fileHouseholdHoldCard(trx, { ...args, procToken: 'someone-else' })).toBe('moved');
    await trx('call_log').where({ id: call.id }).update({ customer_id: (await newCustomer()).id });
    expect(await fileHouseholdHoldCard(trx, args)).toBe('moved'); // the office linked it meanwhile
    expect(await trx('triage_items').where({ call_log_id: call.id })).toHaveLength(0);
    await trx('call_log').where({ id: call.id }).update({ customer_id: null });
    expect(await fileHouseholdHoldCard(trx, args)).toBe('open');
    expect(await trx('triage_items').where({ call_log_id: call.id })).toHaveLength(1);
  });

  test('the finalization recheck: only an open / claimed card keeps the reason counting toward review_status', async () => {
    const callLogId = randomUUID();
    await fileHouseholdHoldCard(trx, { callLogId, customerId: randomUUID(), phone: '+19415550999', extracted: {} });
    for (const [status, expected] of [['open', true], ['in_progress', true], ['resolved', false], ['dismissed', false]]) {
      await trx('triage_items').update({ status });
      expect(await triageCardStillOpen(trx, callLogId, 'household_address_match')).toBe(expected);
    }
    expect(await triageCardStillOpen(trx, randomUUID(), 'household_address_match')).toBe(false);
  });

  test('the Open customer target follows an active merge chain to the live survivor', async () => {
    const { suggestedCustomerOpenTarget, suggestedCustomerId } = require('../utils/missing-first-name-card');
    await trx.raw('CREATE TEMP TABLE customer_merge_journal (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), winner_customer_id uuid, loser_customer_id uuid, created_at timestamptz DEFAULT clock_timestamp(), undone_at timestamptz) ON COMMIT DROP');
    const [loser, mid, winner, live] = [await newCustomer({ deleted_at: new Date() }), await newCustomer({ deleted_at: new Date() }), await newCustomer(), await newCustomer()];
    await trx('customer_merge_journal').insert([{ winner_customer_id: mid.id, loser_customer_id: loser.id }, { winner_customer_id: winner.id, loser_customer_id: mid.id }]);
    expect(await suggestedCustomerOpenTarget(trx, { suggested_customer_id: live.id })).toEqual({ id: live.id, open_id: live.id });
    expect(await suggestedCustomerOpenTarget(trx, { suggested_customer_id: loser.id })).toEqual({ id: loser.id, open_id: winner.id });
    // an undone hop is not followed; a gone id with no merge is returned unchanged; a malformed id yields nothing
    await trx('customer_merge_journal').where({ loser_customer_id: mid.id }).update({ undone_at: new Date() });
    expect(await suggestedCustomerOpenTarget(trx, { suggested_customer_id: loser.id })).toEqual({ id: loser.id, open_id: loser.id });
    expect(await suggestedCustomerOpenTarget(trx, { suggested_customer_id: 'not-a-uuid' })).toBeNull();
    expect(suggestedCustomerId({ suggested_customer_id: 'not-a-uuid' })).toBeNull();
    expect(suggestedCustomerId(JSON.stringify({ suggested_customer_id: live.id }))).toBe(live.id);
  });
});

describe('wiring in processRecording (structural pin)', () => {
  const step3 = source.slice(source.indexOf('let householdHoldActive = false;'), source.indexOf('// Update with any new info (email + address; shared with the'));

  test('the hold is decided where the customer would be created: after the phone cascade found nobody, never for a shared-phone ambiguity', () => {
    expect(step3).toContain('if (!existing && !sharedPhoneAmbiguity.candidates\n        && require(\'../config/feature-gates\').callHouseholdHoldLive()\n        && householdHoldEligible({');
    expect(step3.indexOf('findCustomerForCallContact')).toBeGreaterThan(-1);
    expect(step3.indexOf('findHouseholdCustomerByAddress')).toBeGreaterThan(step3.indexOf('const existing = await findCustomerForCallContact'));
  });

  test('the create branch is skipped for a hold, and a hold is never a customer_creation_failed', () => {
    expect(source).toMatch(/\} else if \(householdHoldActive\) \{[\s\S]{0,400}\} else if \(\(extracted\.first_name \|\| firstNameAdvisoryCreate\) && phone && !extracted\.is_voicemail && !v2NonCustomerCallNature\) \{/);
    expect(source).toMatch(/const customerExpected = !householdHoldActive && !!\(\(extracted\.first_name \|\| firstNameAdvisoryCreate\) && phone[^;]*&& !explicitUnlink\);/);
  });

  test('ONE card, filed through the locked filer; a failure fails the pass (retry) instead of falling through to create the customer', () => {
    expect(step3).toContain('fileHouseholdHoldCard(db, {');
    expect(step3).toContain('procToken,');
    expect(step3).toContain("throw new Error('household_hold_card_unavailable');");
    expect(step3).toContain("throw new Error('household_hold_lookup_unavailable');");
    expect(step3).toContain("cardState === 'waived'");
    expect(step3).toContain("if (cardState === 'open' && !bridgeNeedsConfirmation.includes('household_address_match')) bridgeNeedsConfirmation.push('household_address_match');");
    // the filer takes the per-call lock before its first read, inside one transaction, and never inside a booking transaction
    const filer = source.slice(source.indexOf('async function fileHouseholdHoldCard'), source.indexOf('async function findCustomerForCallContact'));
    expect(filer.indexOf('conn.transaction')).toBeLessThan(filer.indexOf('lockTriageCall(trx, callLogId)'));
    expect(filer.indexOf('lockTriageCall(trx, callLogId)')).toBeLessThan(filer.indexOf("trx('call_log')"));
    expect(filer.indexOf("trx('call_log')")).toBeLessThan(filer.indexOf("trx('triage_items')"));
  });

  test('nothing is written to any customer: the hold block touches no customers / contact / consent writer', () => {
    for (const forbidden of ["db('customers')", 'backfillLinkedCustomerFromExtraction', 'ensureCustomerAccount', 'saveContact', 'update(']) {
      expect(step3).not.toContain(forbidden);
    }
    const helpers = source.slice(source.indexOf('// ── Household hold (GATE_CALL_HOUSEHOLD_HOLD)'), source.indexOf('async function findCustomerForCallContact'));
    // the ONLY update is the card's own evidence refresh on triage_items (codex #5700 r1); no deletes
    expect(helpers).not.toMatch(/\.(del|delete)\(/);
    expect(helpers.match(/\.update\(/g)).toHaveLength(1);
    expect(helpers).toContain("await trx('triage_items').where({ id: live.id }).update({");
    expect(helpers.match(/\.insert\(/g)).toHaveLength(1);
    expect(helpers).not.toMatch(/trx\('customers'\)|conn\('customers'\)\.(insert|update)/);
  });

  test('no booking in ANY routing mode: the hold result names itself, and the enforce fallback does not pile a second card on it', () => {
    expect(source).toMatch(/if \(householdHoldActive\) \{[\s\S]{0,900}skippedReason: 'household_address_match',[\s\S]{0,200}\} else if \(v2RoutingBlocked\) \{/);
    const held = source.slice(source.indexOf('if (householdHoldActive) {\n      // GATE_CALL_HOUSEHOLD_HOLD: no customer exists'));
    expect(held.slice(0, 900)).toContain('scheduleCreated: false,\n        smsSent: false,');
    expect(source).toMatch(/const heldReasons = new Set\(\[[^\]]*'household_address_match'\]\);/);
    // every booking branch below keys on a customer, which a hold never has
    for (const branch of [
      'extracted.appointment_confirmed && extracted.preferred_date_time && customerId && hasSpecificTime && canCreateAppointmentFromCall',
    ]) expect(source).toContain(branch);
  });

  test('review_status counts the reason only while its card is open, judged under the finalization lock', () => {
    const start = source.indexOf('await lockTriageCall(trx, call.id);\n      // A street-level hold');
    const block = source.slice(start, source.indexOf('// Keep the established leads -> call_log lock order', start));
    expect(block).toContain("const householdStillOpen = !bridgeNeedsConfirmation.includes('household_address_match')");
    expect(block).toContain("await triageCardStillOpen(trx, call.id, 'household_address_match')");
    expect(block).toContain("(r !== 'household_address_match' || householdStillOpen)");
  });

  test('lead handling is untouched: nothing in the hold block creates, links or suppresses a lead', () => {
    expect(step3).not.toMatch(/lead/i);
  });

  test('the card has a category, review text, and survives a recording swap (a person decides, not a transcript)', () => {
    const { SUPERSEDE_KEPT_REASON_CODES, SUPERSEDE_KEPT_CARD_SQL, buildTriageItem } = require('../services/call-routing-gates');
    expect(buildTriageItem({ callLogId: 'c1', flag: 'household_address_match' }).category).toBe('customer_field_conflict');
    expect(source).toMatch(/household_address_match: "caller's number is not on file but the address belongs to one existing customer — confirm before booking",/);
    expect(SUPERSEDE_KEPT_REASON_CODES).toContain('household_address_match');
    expect(SUPERSEDE_KEPT_CARD_SQL).toContain("reason_code = 'household_address_match'");
  });
});

describe('the sweep and the verdict route leave the card to a person', () => {
  test('triage-auto-resolve: only household_linked closes it, and no generic rule matches its reason', () => {
    const { classifyTriageItem, RULE_NOTES } = require('../services/triage-auto-resolve');
    const A = '55555555-5555-4555-8555-555555555555';
    const B = '66666666-6666-4666-8666-666666666666';
    const card = (over = {}) => ({
      id: 't1', call_log_id: 'call-1', reason_code: 'household_address_match', status: 'open', severity: 'blocking',
      created_at: '2026-08-01T00:00:00Z', call_created_at: '2026-08-01T00:00:00Z', payload: { flag: 'household_address_match', suggested_customer_id: A },
      household_suggested_id: A, household_open_id: A, call_customer_id: null, ...over,
    });
    const now = new Date('2026-10-02T00:00:00Z');
    const classify = (item) => classifyTriageItem(item, { evidence: new Map() }, { now });
    expect(classify(card())).toBeNull(); // unlinked, however old: never aged out
    expect(classify(card({ call_customer_id: A }))).toEqual({ action: 'resolve', rule: 'household_linked' });
    // the suggested customer was merged away: a link to its live survivor settles it
    expect(classify(card({ household_suggested_id: A, household_open_id: B, call_customer_id: B }))).toEqual({ action: 'resolve', rule: 'household_linked' });
    // a link to anyone else, or a moot customer field, never does
    expect(classify(card({ call_customer_id: B }))).toBeNull();
    expect(classify(card({ call_customer_id: B, customer_address_line1: '100 Example Loop', customer_zip: '34240', customer_pipeline_stage: 'active_customer', customer_last_name: 'Sample' }))).toBeNull();
    expect(classify(card({ household_suggested_id: null, household_open_id: null, call_customer_id: A }))).toBeNull();
    expect(classify(card({ call_customer_id: A, status: 'in_progress' }))).toBeNull();
    expect(RULE_NOTES.household_linked).toBeTruthy();
    // wiring: the one rule is the only CLASSIFY rule that names this reason
    const src = fs.readFileSync(require.resolve('../services/triage-auto-resolve'), 'utf8');
    expect(src.match(/household_address_match/g).filter(Boolean).length).toBeGreaterThan(0);
    const rules = src.slice(src.indexOf('const CLASSIFY_RULES = ['), src.indexOf('// Pure classifier, exported for tests.'));
    expect(rules.match(/rule: '/g).length).toBeGreaterThan(5);
    expect(rules.match(/household_address_match/g)).toHaveLength(2);
    expect(src).not.toMatch(/ADVISORY_AGE_CODES = new Set\(\[[^\]]*household_address_match/);
  });

  test('admin-triage: /verdict 400, bulk verdict sweeps exclude it, non-admin Resolve AND Dismiss are 403', () => {
    const route = fs.readFileSync(require.resolve('../routes/admin-triage'), 'utf8');
    expect(route).toMatch(/if \(item\.reason_code === 'household_address_match'\) \{\s+return res\.status\(400\)/);
    expect(route).toMatch(/'missing_first_name', 'household_address_match',/);
    expect(route).toMatch(/guarded\.reason_code === 'household_address_match'\) \{\s+return res\.status\(403\)/);
  });
});
