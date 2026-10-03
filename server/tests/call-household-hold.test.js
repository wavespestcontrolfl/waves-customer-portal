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
jest.mock('../services/conversations', () => ({ syncVoiceMessageForCall: jest.fn(async () => null) }));
const fs = require('fs');
const knex = require('knex');
const { randomUUID } = require('crypto');
const gates = require('../config/feature-gates');
const { _test } = require('../services/call-recording-processor');

const {
  householdHoldEligible, classifyHouseholdCandidates, householdPhoneOnFile, retireHouseholdHoldCard,
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
    expect(block).toContain('commercialCall: !!commercialCategoryConflict({ extraction: v2CanonicalExtraction, intent: null })');
    expect(block).not.toContain("property_type === 'commercial'");
    expect(block).toContain('createBranchOpen: !!(extracted.first_name || firstNameAdvisoryCreate)');
  });
});

describe('commercial calls (the repo\'s one extraction classifier) never become a household hold', () => {
  const { commercialCategoryConflict } = require('../services/estimator-engine/unit-scope-model');
  const commercial = (property) => !!commercialCategoryConflict({ extraction: { property }, intent: null });
  test.each([
    ['literal commercial', { property_type: 'commercial' }],
    ['an HOA common-area service', { property_type: 'single_family', hoa_common_area_service: true }],
    ['office', { property_type: 'office' }],
    ['a populated commercial_subtype on a residential-looking type', { property_type: 'multi_family', commercial_subtype: 'multi_unit_residential' }],
    ['retail', { property_type: 'retail store' }],
  ])('%s: commercial, so no hold', (_label, property) => {
    expect(commercial(property)).toBe(true);
    expect(householdHoldEligible({
      gateLive: true, phone: '+19415550123', createBranchOpen: true, addressOk: true, commercialCall: commercial(property),
    })).toBe(false);
  });
  test('an ordinary single-family call is not commercial and no extraction is not commercial', () => {
    expect(commercial({ property_type: 'single_family' })).toBe(false);
    expect(commercialCategoryConflict({ extraction: null, intent: null })).toBeFalsy();
  });
});

describe('classifyHouseholdCandidates: exactly ONE live residential customer at the address', () => {
  const call = { address_line1: '100 Example Loop', address_line2: null, city: 'Sarasota', zip: '34240' };
  const src = (over = {}) => ({ address_line1: '100 Example Loop', address_line2: null, city: 'Sarasota', zip: '34240', commercial: false, ...over });
  const cust = (id, over = {}) => ({ id, first_name: 'Sample', last_name: 'Customer', active: true, property_type: 'residential', waveguard_tier: 'Bronze', ...over });
  // The shared same-address query's `complete` rows: one per matching address SOURCE.
  const set = (entries) => entries.flatMap(([c, sources]) => sources.map((source) => ({
    id: c.id, first_name: c.first_name, last_name: c.last_name, active: c.active, waveguard_tier: c.waveguard_tier,
    customer_property_type: c.property_type,
    address_line1: source.address_line1, address_line2: source.address_line2, city: source.city, zip: source.zip,
    source_property_type: source.commercial ? 'commercial' : null, source_occupancy_type: null,
  })));

  test('zero candidates: no hold', () => {
    expect(classifyHouseholdCandidates([], call)).toEqual({ customer: null, reason: 'no_address_match' });
  });

  test('exactly one: the hold names that customer', () => {
    const a = cust('a');
    expect(classifyHouseholdCandidates(set([[a, [src()]]]), call)).toEqual({ customer: { id: 'a', first_name: 'Sample', last_name: 'Customer' }, reason: 'address_match' });
  });

  test('two or more matching customers: no hold, however they match (row or property source)', () => {
    const [a, b] = [cust('a'), cust('b')];
    expect(classifyHouseholdCandidates(set([[a, [src()]], [b, [src()]]]), call).reason).toBe('multiple_customers_at_address');
    // a second account that holds the address as a property row counts too
    expect(classifyHouseholdCandidates(set([[a, [src({ address_line1: '7 Elsewhere Way' }), src()]], [b, [src()]]]), call).reason).toBe('multiple_customers_at_address');
  });

  test('a customer with the address on BOTH its row and a property row is still one customer', () => {
    const a = cust('a');
    expect(classifyHouseholdCandidates(set([[a, [src(), src()]]]), call).customer.id).toBe('a');
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
    expect(classifyHouseholdCandidates(set([[a, [src({ address_line1: ' 100  example LP. ', city: 'sarasota', zip: '34240-1111' })]]]), call).customer.id).toBe('a');
    expect(classifyHouseholdCandidates(set([[a, [src({ address_line1: '100 Example Lp' })]]]), { ...call, address_line1: '100 Example Loop' }).customer.id).toBe('a');
    // the same unit on both sides, after the same cleanup
    expect(classifyHouseholdCandidates(set([[a, [src({ address_line2: 'Apt 3' })]]]), { ...call, address_line2: ' apt  3 ' }).customer.id).toBe('a');
  });

  test('an explicitly inactive customer is not counted (and so cannot make a second household); a NULL flag is', () => {
    const [a, inactive] = [cust('a'), cust('b', { active: false })];
    expect(classifyHouseholdCandidates(set([[a, [src()]], [inactive, [src()]]]), call).customer.id).toBe('a');
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
    expect(classifyHouseholdCandidates(set([[a, [src(), elsewhere]]]), call).reason).toBe('address_match');
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

  test('a number held only by an INACTIVE (or deleted) customer is not identity evidence on any phone column; a live one is — the same live predicate as the address side', async () => {
    const owner = await newCustomer({ phone: '+19415550100' });
    const cols = ['phone', 'service_contact_phone', 'service_contact2_phone', 'service_contact3_phone', 'secondary_phone'];
    for (const col of cols) {
      const holder = await newCustomer({ phone: '+19415550777', address_line1: '9 Another Rd', zip: '34242', active: false, [col]: '+19415550999' });
      if (col !== 'phone') await trx('customers').where({ id: holder.id }).update({ phone: '+19415550777' });
      expect((await findHouseholdCustomerByAddress({ phone: '+19415550999', address: CALL, conn: trx })).customer.id).toBe(owner.id);
      expect(await householdPhoneOnFile(trx, '9415550999')).toBe(false);
      await trx('customers').where({ id: holder.id }).update({ active: null }); // NULL still counts, like the address side
      expect(await householdPhoneOnFile(trx, '9415550999')).toBe(true);
      expect((await findHouseholdCustomerByAddress({ phone: '+19415550999', address: CALL, conn: trx })).reason).toBe('phone_on_file');
      await trx('customers').where({ id: holder.id }).update({ active: true, deleted_at: new Date() });
      expect(await householdPhoneOnFile(trx, '9415550999')).toBe(false);
      await trx('customers').where({ id: holder.id }).del();
    }
  });

  test('ACTIVE_CLAIM_SQL: a beating claim blocks, a crashed (reclaimable) one and a finished one do not', async () => {
    const { ACTIVE_CLAIM_SQL } = require('../utils/call-claim');
    const mk = (over) => trx('call_log').insert({ direction: 'inbound', ...over }).returning('id').then(([r]) => r.id);
    const ago = (min) => new Date(Date.now() - min * 60000);
    const beating = await mk({ processing_status: 'processing', processing_token: 't1', processing_started_at: ago(30), processing_heartbeat_at: ago(1) });
    const crashed = await mk({ processing_status: 'processing', processing_token: 't2', processing_started_at: ago(30), processing_heartbeat_at: ago(15) });
    const legacyFresh = await mk({ processing_status: 'processing', processing_token: 't3', processing_started_at: ago(2), processing_heartbeat_at: null });
    const legacyStale = await mk({ processing_status: 'processing', processing_token: 't4', processing_started_at: ago(30), processing_heartbeat_at: null });
    const done = await mk({ processing_status: 'processed', processing_token: null });
    const active = (await trx('call_log').whereRaw(ACTIVE_CLAIM_SQL).select('id')).map((r) => r.id);
    expect(active.sort()).toEqual([beating, legacyFresh].sort());
    expect(active).not.toContain(crashed); expect(active).not.toContain(legacyStale); expect(active).not.toContain(done);
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

  test('the finder rides the shared same-address query in complete mode: no row limit can hide a second household, and a failing leg fails closed', async () => {
    const { findCustomersAtAddress } = require('../services/customer-address-match');
    // 60 households at the very same address (more than the default per-leg limit of 50)
    for (let i = 0; i < 60; i += 1) await newCustomer({ phone: `+1941555${String(3000 + i)}` });
    expect((await findCustomersAtAddress(trx, '100 Example Loop, Sarasota, 34240')).length).toBe(50); // default mode: bounded
    expect((await findCustomersAtAddress(trx, '100 Example Loop, Sarasota, 34240', { complete: true })).length).toBe(60); // complete: all
    expect((await findHouseholdCustomerByAddress({ phone: '+19415550999', address: CALL, conn: trx })).reason).toBe('multiple_customers_at_address');
    // a unit on one side only is another door in complete mode (the default mode keeps it a possible duplicate)
    await newCustomer({ phone: '+19415558888', address_line2: 'Apt 3' });
    expect((await findCustomersAtAddress(trx, '100 Example Loop Apt 3, Sarasota, 34240', { complete: true })).map((r) => r.address_line2)).toEqual(['Apt 3']);
    // fail closed: a property leg that cannot be read propagates instead of reading as "no match"
    await trx.raw('SAVEPOINT before_break');
    await trx.raw('ALTER TABLE customer_properties RENAME COLUMN active TO active_gone');
    await expect(findHouseholdCustomerByAddress({ phone: '+19415550999', address: CALL, conn: trx })).rejects.toBeTruthy();
    await trx.raw('ROLLBACK TO SAVEPOINT before_break');
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

  test('the card filer says WHICH way the call moved: a lost claim, or a link made meanwhile (with the linked customer)', async () => {
    const [call] = await trx('call_log').insert({ twilio_call_sid: `CA${'9'.repeat(30)}h1`, direction: 'inbound', processing_token: 'tok-1' }).returning('id');
    const args = { callLogId: call.id, procToken: 'tok-1', customerId: randomUUID(), phone: '+19415550999', extracted: { first_name: 'Sample' } };
    expect(await fileHouseholdHoldCard(trx, { ...args, procToken: 'someone-else' })).toBe('claim_lost');
    const linked = await newCustomer();
    await trx('call_log').where({ id: call.id }).update({ customer_id: linked.id });
    expect(await fileHouseholdHoldCard(trx, args)).toEqual({ state: 'linked', customerId: linked.id }); // the office linked it meanwhile
    // a lost claim wins over a link: the owning pass decides
    expect(await fileHouseholdHoldCard(trx, { ...args, procToken: 'someone-else' })).toBe('claim_lost');
    expect(await trx('triage_items').where({ call_log_id: call.id })).toHaveLength(0);
    await trx('call_log').where({ id: call.id }).update({ customer_id: null });
    expect(await fileHouseholdHoldCard(trx, args)).toBe('open');
    expect(await trx('triage_items').where({ call_log_id: call.id })).toHaveLength(1);
  });

  test('a standing card is retired (resolved by the system, never dismissed) when the hold no longer stands; the review flag follows', async () => {
    const [call] = await trx('call_log').insert({ twilio_call_sid: `CA${'9'.repeat(30)}h2`, direction: 'inbound', review_status: 'open' }).returning('id');
    const base = { callLogId: call.id, customerId: randomUUID(), phone: '+19415550999', extracted: { first_name: 'Sample' } };
    // nothing standing: no transaction needed, nothing changes
    expect(await retireHouseholdHoldCard(trx, { callLogId: call.id, note: 'n' })).toBe(0);
    await fileHouseholdHoldCard(trx, base);
    expect(await retireHouseholdHoldCard(trx, { callLogId: call.id, note: 'the reprocessed call no longer matches one existing customer' })).toBe(1);
    const [card] = await trx('triage_items').where({ call_log_id: call.id });
    expect(card).toMatchObject({ status: 'resolved', resolution_source: 'auto', resolution_rule: 'household_hold_retired',
      resolution_note: 'the reprocessed call no longer matches one existing customer' });
    expect(card.resolved_at).toBeTruthy();
    expect((await trx('call_log').where({ id: call.id }).first('review_status')).review_status).toBe('resolved');
    // a resolved card does not block a fresh filing if the hold stands again
    expect(await fileHouseholdHoldCard(trx, base)).toBe('open');
    // a DISMISSED card (the office's waiver) is never touched by a retire
    await trx('triage_items').where({ call_log_id: call.id }).del();
    await fileHouseholdHoldCard(trx, base);
    await trx('triage_items').update({ status: 'dismissed' });
    expect(await retireHouseholdHoldCard(trx, { callLogId: call.id, note: 'n' })).toBe(0);
    expect((await trx('triage_items').where({ call_log_id: call.id }))[0].status).toBe('dismissed');
    // a claimed card retires too, and another open card keeps the call's review flag open
    await trx('triage_items').where({ call_log_id: call.id }).del();
    await fileHouseholdHoldCard(trx, base);
    await trx('triage_items').update({ status: 'in_progress' });
    await trx('triage_items').insert({ call_log_id: call.id, category: 'service_unknown', severity: 'blocking', reason_code: 'address_unverified', status: 'open', summary: 's' });
    expect(await retireHouseholdHoldCard(trx, { callLogId: call.id, note: 'n' })).toBe(1);
    expect((await trx('call_log').where({ id: call.id }).first('review_status')).review_status).toBe('open');
  });

  test('call-log-relink never links a call a pass is working (live token or processing status); an idle one links as before', async () => {
    const { relinkUnattributedCalls } = require('../services/call-log-relink');
    const owner = await newCustomer({ phone: '+19415550999' });
    const mkCall = (over) => trx('call_log').insert({
      twilio_call_sid: null, direction: 'inbound', from_phone: '+19415550999', to_phone: '+19415550100', created_at: new Date(), ...over,
    }).returning('id').then(([r]) => r.id);
    const working = await mkCall({ processing_token: 'tok-9', processing_status: 'processing' });
    const tokenOnly = await mkCall({ processing_token: 'tok-8', processing_status: null });
    const statusOnly = await mkCall({ processing_token: null, processing_status: 'processing' });
    const idle = await mkCall({ processing_token: null, processing_status: 'processed' });
    const result = await relinkUnattributedCalls({ conn: trx });
    expect(result.linked).toBe(1);
    const linkOf = async (id) => (await trx('call_log').where({ id }).first('customer_id')).customer_id;
    expect(await linkOf(idle)).toBe(owner.id);
    for (const id of [working, tokenOnly, statusOnly]) expect(await linkOf(id)).toBeNull();
    // the pass finishes (token cleared): the next hourly run links it
    await trx('call_log').where({ id: working }).update({ processing_token: null, processing_status: 'processed' });
    expect((await relinkUnattributedCalls({ conn: trx })).linked).toBe(1);
    expect(await linkOf(working)).toBe(owner.id);
  });

  test('interleaving: a link committed after the hold was decided survives the pass\'s checkpoint write (COALESCE keeps it, an override still wins)', async () => {
    const expr = "CASE WHEN jsonb_exists(COALESCE(metadata, '{}'::jsonb), 'customer_link_override')"
      + " THEN NULLIF(metadata -> 'customer_link_override' ->> 'customer_id', '')::uuid ELSE COALESCE(?::uuid, customer_id) END";
    expect(source).toContain("(householdHoldActive ? 'COALESCE(?::uuid, customer_id)' : '?::uuid')");
    const linked = await newCustomer();
    const [call] = await trx('call_log').insert({ twilio_call_sid: `CA${'8'.repeat(30)}h3`, direction: 'inbound', processing_token: 'tok-1', customer_id: linked.id }).returning('id');
    // the held pass resolved no customer; the linker's link stays, and the checkpoint reports it back
    const rows = await trx('call_log').where({ id: call.id }).update({ customer_id: trx.raw(expr, [null]) }).returning('customer_id');
    expect(rows[0].customer_id).toBe(linked.id);
    // an unlinked call stays unlinked (nothing to keep)
    await trx('call_log').where({ id: call.id }).update({ customer_id: null });
    expect((await trx('call_log').where({ id: call.id }).update({ customer_id: trx.raw(expr, [null]) }).returning('customer_id'))[0].customer_id).toBeNull();
    // an operator UNLINK override still wins over everything
    await trx('call_log').where({ id: call.id }).update({ customer_id: linked.id, metadata: JSON.stringify({ customer_link_override: { customer_id: null } }) });
    expect((await trx('call_log').where({ id: call.id }).update({ customer_id: trx.raw(expr, [null]) }).returning('customer_id'))[0].customer_id).toBeNull();
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
    const { openTargetsForIds, suggestedCustomerId } = require('../utils/missing-first-name-card');
    await trx.raw('CREATE TEMP TABLE customer_merge_journal (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), winner_customer_id uuid, loser_customer_id uuid, created_at timestamptz DEFAULT clock_timestamp(), undone_at timestamptz) ON COMMIT DROP');
    const [loser, mid, winner, live] = [await newCustomer({ deleted_at: new Date() }), await newCustomer({ deleted_at: new Date() }), await newCustomer(), await newCustomer()];
    await trx('customer_merge_journal').insert([{ winner_customer_id: mid.id, loser_customer_id: loser.id }, { winner_customer_id: winner.id, loser_customer_id: mid.id }]);
    expect((await openTargetsForIds(trx, [live.id])).get(live.id)).toBe(live.id);
    expect((await openTargetsForIds(trx, [loser.id])).get(loser.id)).toBe(winner.id);
    // an undone hop is not followed; a gone id with no merge is returned unchanged; a malformed id yields nothing
    await trx('customer_merge_journal').where({ loser_customer_id: mid.id }).update({ undone_at: new Date() });
    expect((await openTargetsForIds(trx, [loser.id])).get(loser.id)).toBe(loser.id);
    expect((await openTargetsForIds(trx, ['not-a-uuid'])).size).toBe(0);
    // ONE query resolves every id on a page (household and first-name cards together), mapped back per id
    await trx('customer_merge_journal').where({ loser_customer_id: mid.id }).update({ undone_at: null });
    let queries = 0;
    const counting = { raw: (...args) => { queries += 1; return trx.raw(...args); } };
    const batch = await openTargetsForIds(counting, [live.id, loser.id, mid.id, live.id, 'not-a-uuid']);
    expect(queries).toBe(1);
    expect([...batch.entries()].sort()).toEqual([[live.id, live.id], [loser.id, winner.id], [mid.id, winner.id]].sort());
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
    expect(step3).toContain("if (!bridgeNeedsConfirmation.includes('household_address_match')) bridgeNeedsConfirmation.push('household_address_match');");
    // the filer takes the per-call lock before its first read, inside one transaction, and never inside a booking transaction
    const filer = source.slice(source.indexOf('async function fileHouseholdHoldCard'), source.indexOf('async function retireHouseholdHoldCard'));
    expect(filer.indexOf('conn.transaction')).toBeLessThan(filer.indexOf('lockTriageCall(trx, callLogId)'));
    expect(filer.indexOf('lockTriageCall(trx, callLogId)')).toBeLessThan(filer.indexOf("trx('call_log')"));
    expect(filer.indexOf("trx('call_log')")).toBeLessThan(filer.indexOf("trx('triage_items')"));
  });

  test('each filer result is handled separately: claim_lost abandons, linked continues on the linked customer, neither holds', () => {
    expect(step3).toMatch(/if \(cardState === 'claim_lost'\) \{[\s\S]{0,300}return abandonToPeer\('the household hold'\);/);
    expect(step3).toMatch(/cardState\.state === 'linked'\) \{[\s\S]{0,300}householdLinkedCustomerId = cardState\.customerId;/);
    // linked: this pass continues on that customer (the create branch is closed to it), never as a hold
    expect(source).toMatch(/\} else if \(householdLinkedCustomerId\) \{\s+customerId = householdLinkedCustomerId;\s+\} else if \(householdHoldActive\) \{/);
    const holdSet = step3.slice(step3.indexOf("} else {\n            householdHoldActive = true;"));
    expect(holdSet.indexOf('householdHoldActive = true')).toBeLessThan(holdSet.indexOf("push('household_address_match')"));
  });

  test('a standing card is retired whenever this pass does not hold (no match, number now on file, address no longer exact, unlinked, gate off) and its review reason is dropped; a prelinked call is left to the sweep', () => {
    expect(step3).toContain('const householdPrelinked = !!customerId;');
    expect(step3).toContain('if (!householdPrelinked && !(phone && !explicitUnlink)) await retireStandingHouseholdCard();');
    expect(step3).toContain('if (!householdHoldActive && !householdLinkedCustomerId && !householdPrelinked) await retireStandingHouseholdCard();');
    expect(step3).toContain("bridgeNeedsConfirmation.splice(at, 1)");
    expect(step3).toContain('household hold is switched off');
  });

  test('the checkpoint write reports back a link that landed after the hold and the pass continues on that customer, retiring the card', () => {
    const at = source.indexOf('const checkpointRows = await db(\'call_log\')');
    const block = source.slice(at, at + 4600);
    expect(block).toContain(".returning('customer_id');");
    expect(block).toContain('if (householdHoldActive && checkpointRows[0].customer_id) {');
    expect(block).toContain('customerId = checkpointRows[0].customer_id;');
    expect(block).toContain('householdHoldActive = false;');
    expect(block).toContain('await retireStandingHouseholdCard(');
  });

  test('the filer locks the call_log row FOR UPDATE after the per-call triage lock, in one transaction (the fileSkippedBookingCard order)', () => {
    const filer = source.slice(source.indexOf('async function fileHouseholdHoldCard'), source.indexOf('async function retireHouseholdHoldCard'));
    expect(filer.indexOf('lockTriageCall(trx, callLogId)')).toBeLessThan(filer.indexOf(".forUpdate().first('processing_token', 'customer_id')"));
    expect(filer.indexOf(".forUpdate().first('processing_token', 'customer_id')")).toBeLessThan(filer.indexOf("trx('triage_items')"));
  });

  test('ONE open-card helper serves the first-name and household reasons', () => {
    expect(source).not.toContain('missingFirstNameCardStillOpen');
    expect(source).toContain("triageCardStillOpen(db, call.id, 'missing_first_name')");
    expect(source).toContain("await triageCardStillOpen(trx, call.id, 'missing_first_name')");
  });

  test('the household finder uses the shared same-address query, not a parallel loader', () => {
    expect(source).not.toContain('loadHouseholdCandidates');
    expect(source).toContain('findCustomersAtAddress(conn,');
    expect(source).toContain('{ complete: true }');
  });

  test('nothing is written to any customer: the hold block touches no customers / contact / consent writer', () => {
    for (const forbidden of ["db('customers')", 'backfillLinkedCustomerFromExtraction', 'ensureCustomerAccount', 'saveContact', 'update(']) {
      expect(step3).not.toContain(forbidden);
    }
    const helpers = source.slice(source.indexOf('// ── Household hold (GATE_CALL_HOUSEHOLD_HOLD)'), source.indexOf('async function findCustomerForCallContact'));
    // the ONLY updates are on triage_items: the card's evidence refresh and the retire (plus the review-status sync helper); no deletes
    expect(helpers).not.toMatch(/\.(del|delete)\(/);
    expect(helpers.match(/\.update\(/g)).toHaveLength(2);
    expect(helpers).toContain("await trx('triage_items').where({ id: live.id }).update({");
    expect(helpers).toContain(".where({ call_log_id: callLogId, reason_code: 'household_address_match' })\n      .whereIn('status', ['open', 'in_progress'])\n      .update({");
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
    expect(route).toMatch(/if \(item\.reason_code === 'household_address_match'\) \{\s+if \(req\.techRole !== 'admin'\) return res\.status\(403\)[^\n]*\n\s+return res\.status\(400\)/);
    expect(route).toMatch(/'missing_first_name', 'household_address_match',/);
    expect(route).toMatch(/guarded\.reason_code === 'household_address_match'\) \{\s+return res\.status\(403\)/);
  });
});
