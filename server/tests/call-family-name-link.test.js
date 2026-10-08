/**
 * Owner ruling 2026-10-08 (suggest-only): a family member who calls for a parent or relative by
 * full name gets ONE advisory `family_account_candidates` card listing the live accounts with
 * that exact name (address-match marked). Nothing is linked, saved, texted or enrolled.
 *
 * Audited case (synthetic here): a daughter called for her mother by full name; the call linked
 * to no account and the accepted visit was never booked.
 *
 * Matching and the card are tested against real Postgres when DATABASE_URL is set (CI), inside a
 * rolled-back transaction; the processor wiring is pinned structurally (processRecording cannot
 * run end to end in a test). Synthetic names, numbers and addresses only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const fs = require('fs');
const knex = require('knex');
const { randomUUID } = require('crypto');
const {
  pickNamedAccountHolder, normName, fullNameKey, statedAddressCorroborates,
  findLiveCustomersByFullName, suggestFamilyAccounts, fileFamilyAccountCard, CARD_REASON,
} = require('../services/call-family-name-link');
const { buildTriageItem } = require('../services/call-routing-gates');

const source = fs.readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');
const moduleSource = fs.readFileSync(require.resolve('../services/call-family-name-link'), 'utf8');

describe('pickNamedAccountHolder', () => {
  const mother = { first_name: 'Angelina', last_name: 'Testerson', role: 'family_member' };
  const caller = { first_name: 'Dana', last_name: 'Lee' };

  test('a family caller who names one relative by full name yields that person', () => {
    expect(pickNamedAccountHolder({ callerRelationship: 'family_member', caller, secondaryContacts: [mother] }))
      .toMatchObject({ first_name: 'Angelina', last_name: 'Testerson' });
  });
  test('only a family_member caller qualifies', () => {
    for (const rel of ['owner', 'tenant', 'other', 'real_estate_agent', 'spouse_partner', null, undefined]) {
      expect(pickNamedAccountHolder({ callerRelationship: rel, caller, secondaryContacts: [mother] })).toBeNull();
    }
  });
  test('a first name alone, or a last name alone, is not a full name', () => {
    expect(pickNamedAccountHolder({ callerRelationship: 'family_member', caller, secondaryContacts: [{ first_name: 'Angelina', role: 'family_member' }] })).toBeNull();
    expect(pickNamedAccountHolder({ callerRelationship: 'family_member', caller, secondaryContacts: [{ last_name: 'Testerson', role: 'family_member' }] })).toBeNull();
  });
  test('a named party with an arranger or transaction role is never the account holder', () => {
    for (const role of ['real_estate_agent', 'lender', 'tenant', 'home_buyer', 'landlord', 'property_manager']) {
      expect(pickNamedAccountHolder({ callerRelationship: 'family_member', caller, secondaryContacts: [{ ...mother, role }] })).toBeNull();
    }
  });
  test('two different named relatives are ambiguous: no holder', () => {
    const aunt = { first_name: 'Rosa', last_name: 'Testerson', role: 'family_member' };
    expect(pickNamedAccountHolder({ callerRelationship: 'family_member', caller, secondaryContacts: [mother, aunt] })).toBeNull();
  });
  test('the same person listed twice is one holder, whatever the case or spacing', () => {
    const again = { first_name: ' angelina ', last_name: 'TESTERSON', role: 'unknown' };
    expect(pickNamedAccountHolder({ callerRelationship: 'family_member', caller, secondaryContacts: [mother, again] })).not.toBeNull();
  });
  test('the caller copied into the second-person slot is not the holder', () => {
    expect(pickNamedAccountHolder({ callerRelationship: 'family_member', caller, secondaryContacts: [{ ...caller, role: 'family_member' }] })).toBeNull();
  });
  test('normName and fullNameKey ignore case and repeated whitespace only', () => {
    expect(normName('  Mary   ANN ')).toBe('mary ann');
    expect(fullNameKey({ first_name: 'Mary Ann', last_name: 'Testerson' })).toBe('mary ann|testerson');
    expect(fullNameKey({ first_name: 'Angelina', last_name: 'Testerson' })).not.toBe(fullNameKey({ first_name: 'Angelina', last_name: 'Testersen' }));
  });
});

describe('statedAddressCorroborates (marks "address matches" on a candidate)', () => {
  const onFile = { address_line1: '100 Example Loop', city: 'Sarasota', zip: '34240' };
  test('same house number and street, with or without the suffix, case-insensitive', () => {
    expect(statedAddressCorroborates({ street_line_1: '100 example loop', city: 'Sarasota', postal_code: '34240' }, onFile)).toBe(true);
    expect(statedAddressCorroborates({ street_line_1: '100 Example' }, onFile)).toBe(true);
  });
  test('no stated street, or a different house number or street, does not', () => {
    expect(statedAddressCorroborates(null, onFile)).toBe(false);
    expect(statedAddressCorroborates({ city: 'Sarasota' }, onFile)).toBe(false);
    expect(statedAddressCorroborates({ street_line_1: '102 Example Loop' }, onFile)).toBe(false);
    expect(statedAddressCorroborates({ street_line_1: '100 Other Street' }, onFile)).toBe(false);
    expect(statedAddressCorroborates({ street_line_1: '100 Example Loop' }, { address_line1: null })).toBe(false);
  });
  test('a stated ZIP or city that disagrees with the account does not', () => {
    expect(statedAddressCorroborates({ street_line_1: '100 Example Loop', postal_code: '34202' }, onFile)).toBe(false);
    expect(statedAddressCorroborates({ street_line_1: '100 Example Loop', city: 'Bradenton' }, onFile)).toBe(false);
  });
  test('a stated unit must equal the stored unit, in any position; a unit against a unit-less record fails', () => {
    const condo = { address_line1: '100 Example Loop', address_line2: 'Apt 4B', city: 'Sarasota', zip: '34240' };
    expect(statedAddressCorroborates({ street_line_1: '100 Example Loop', street_line_2: 'Unit 5C' }, condo)).toBe(false);
    expect(statedAddressCorroborates({ street_line_1: '100 Example Loop Apt 5C' }, condo)).toBe(false);
    expect(statedAddressCorroborates({ street_line_1: '100 Example Loop', street_line_2: '#4b' }, condo)).toBe(true);
    expect(statedAddressCorroborates({ street_line_1: '100 Example Loop' }, condo)).toBe(true);
    const legacy = { address_line1: 'Apt 4B, 100 Example Loop', address_line2: null, city: 'Sarasota', zip: '34240' };
    expect(statedAddressCorroborates({ street_line_1: '100 Example Loop', street_line_2: 'Apt 4B' }, legacy)).toBe(true);
    expect(statedAddressCorroborates({ street_line_1: '100 Example Loop', street_line_2: 'Apt 9' }, legacy)).toBe(false);
    expect(statedAddressCorroborates({ street_line_1: '100 Example Loop', street_line_2: 'Apt 9' }, onFile)).toBe(false);
  });
});

describe('the card is advisory in the customer-field lane', () => {
  test('family_account_candidates', () => {
    const item = buildTriageItem({
      callLogId: randomUUID(), flag: 'family_account_candidates', severity: 'advisory', extraPayload: { account_holder_name: 'Angelina Testerson' },
    });
    expect(item).toMatchObject({ reason_code: 'family_account_candidates', severity: 'advisory', category: 'customer_field_conflict' });
    expect(JSON.parse(item.payload).account_holder_name).toBe('Angelina Testerson');
  });
});

describe('suggest-only: nothing is written but the card', () => {
  test('the module has no writer for links, contacts, opt-ins, texts or enrollment, and no gate', () => {
    const code = moduleSource.split('\n').filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//') && !line.trim().startsWith('/*')).join('\n');
    expect(code).not.toMatch(/\.update\(|\.delete\(|\('call_log'\)|persistCallSecondaryContact|recipient_optin|sendCustomerMessage|forShare|transaction\(|GATE_CALL_FAMILY_NAME_LINK/);
    expect((code.match(/\.insert\(/g) || [])).toHaveLength(1);
    expect(code).toContain("'triage_items'");
  });
  test('the processor makes one short call before the customer is created, and has no family-link state', () => {
    const call = source.indexOf("require('./call-family-name-link').fileFamilyAccountCard({");
    expect(call).toBeGreaterThan(0);
    expect(call).toBeLessThan(source.indexOf('const sharedPhoneAmbiguity = {};'));
    expect(call).toBeLessThan(source.indexOf('if (!customerId && phone && !explicitUnlink) {'));
    expect(source).toContain('if (!customerLinkOverride) {');
    expect(source).toContain('statedAddress: v2StatedServiceAddressRaw');
    for (const gone of ['familyNameLink', 'adoptFamilyNameLink', 'tryFamilyNameLink', 'suppressCallerIdentity', 'scrubCallerIdentity', 'family_name_link', 'callFamilyNameLinkLive']) {
      expect(source).not.toContain(gone);
    }
    expect(fs.readFileSync(require.resolve('../config/feature-gates'), 'utf8')).not.toContain('FAMILY_NAME_LINK');
  });
});

describe('the suggestion has its own resolution (a verdict must not close it or the call\'s other cards)', () => {
  const triage = fs.readFileSync(require.resolve('../routes/admin-triage'), 'utf8');
  test('/verdict refuses family_account_candidates with a 400', () => {
    const at = triage.indexOf("if (item.reason_code === 'family_account_candidates') {");
    expect(at).toBeGreaterThan(0);
    expect(triage.slice(at, at + 400)).toContain('res.status(400)');
  });
  test('the call-wide verdict sweep leaves it alone', () => {
    const at = triage.indexOf(".whereNotIn('reason_code', [\n          'email_bounce_reverify'");
    expect(at).toBeGreaterThan(0);
    expect(triage.slice(at, at + 700)).toContain("'family_account_candidates'");
  });
  test('the inbox shows Resolve, not Accept / Deny, on the card', () => {
    const client = fs.readFileSync(require.resolve('../../client/src/pages/admin/TriageInboxTabV2.jsx'), 'utf8');
    expect(client).toContain('const isFamilyCard = isTriage && item.reason_code === "family_account_candidates";');
    expect(client).toContain('!isFirstNameCard && !isFamilyCard &&');
    expect(client).toContain(') : isFamilyCard ? (');
  });
});

const SKIP = !process.env.DATABASE_URL;
(SKIP ? describe.skip : describe)('family account suggestions on PostgreSQL', () => {
  jest.setTimeout(30000);
  let database; let trx;
  beforeAll(() => { database = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 1 } }); });
  beforeEach(async () => { trx = await database.transaction(); });
  afterEach(async () => { await trx.rollback(); });
  afterAll(async () => { await database.destroy(); });

  async function customer(over = {}) {
    const id = randomUUID();
    await trx('customers').insert({
      id,
      first_name: 'Angelina',
      last_name: 'Testerson',
      phone: `+1941555${String(Math.floor(Math.random() * 9000) + 1000)}`,
      city: 'Sarasota',
      address_line1: '100 Example Loop',
      zip: '34240',
      pipeline_stage: 'active_customer',
      active: true,
      ...over,
    });
    return id;
  }
  async function call(over = {}) {
    const id = randomUUID();
    await trx('call_log').insert({ id, customer_id: null, metadata: {}, ...over });
    return id;
  }
  const input = (callLogId, over = {}) => ({
    call: { id: callLogId, from_phone: '+19415550101', customer_id: null },
    extracted: { first_name: 'Dana', last_name: 'Lee', is_voicemail: false },
    v2CanonicalExtraction: {
      caller: { relationship_to_property: 'family_member' },
      secondary_contact: { first_name: 'Angelina', last_name: 'Testerson', role: 'family_member' },
      meta: { call_summary: 'x' },
    },
    statedAddress: { street_line_1: '100 Example Loop', city: 'Sarasota', postal_code: '34240' },
    phone: '+19415550102',
    phones: ['+19415550102', '+19415550101'],
    isOutbound: false,
    conn: trx,
    ...over,
  });

  test('one live match: ONE advisory card with the caller, the named holder, the customer id and the address mark; the rest untouched', async () => {
    const mom = await customer();
    const before = await trx('customers').where({ id: mom }).first();
    const callLogId = await call();
    const out = await fileFamilyAccountCard(input(callLogId));
    expect(out.candidates).toEqual([{ id: String(mom), name: 'Angelina Testerson', city: 'Sarasota', address_matches: true }]);
    const cards = await trx('triage_items').where({ call_log_id: callLogId });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ reason_code: 'family_account_candidates', severity: 'advisory', status: 'open' });
    expect(cards[0].payload).toMatchObject({
      account_holder_name: 'Angelina Testerson',
      caller_name: 'Dana Lee',
      caller_phone: '+19415550101',
      caller_callback_phone: '+19415550102',
      customer_ids: [String(mom)],
      reason: CARD_REASON,
    });
    expect(cards[0].payload.holder_candidates).toEqual([{ id: String(mom), name: 'Angelina Testerson', city: 'Sarasota', address_matches: true }]);
    expect(await trx('customers').where({ id: mom }).first()).toEqual(before);
    const row = await trx('call_log').where({ id: callLogId }).first();
    expect(row.customer_id).toBeNull();
    expect(row.metadata).toEqual({});
    expect(await trx('recipient_optin').where({ customer_id: mom })).toHaveLength(0);
  });

  test('a second filing for the same call adds no second card', async () => {
    await customer();
    const callLogId = await call();
    await fileFamilyAccountCard(input(callLogId));
    await fileFamilyAccountCard(input(callLogId));
    expect(await trx('triage_items').where({ call_log_id: callLogId })).toHaveLength(1);
  });

  test('two live matches are both listed, only the one at the stated address is marked; a different stated address marks none', async () => {
    const a = await customer({ city: 'Sarasota' });
    const b = await customer({ city: 'Bradenton', address_line1: '4313 Other Dr', zip: '34205' });
    const out = await suggestFamilyAccounts(input(await call()));
    expect(out.candidates.map((c) => [c.id, c.address_matches]).sort()).toEqual([[String(a), true], [String(b), false]].sort());
    const none = await suggestFamilyAccounts(input(await call(), { statedAddress: { street_line_1: '9 Nowhere Ct' } }));
    expect(none.candidates).toHaveLength(2);
    expect(none.candidates.every((c) => c.address_matches === false)).toBe(true);
    const noAddress = await suggestFamilyAccounts(input(await call(), { statedAddress: null }));
    expect(noAddress.candidates.every((c) => c.address_matches === false)).toBe(true);
  });

  test('no live match: no card (soft-deleted, inactive, lead-stage and near-name rows never match)', async () => {
    await customer({ deleted_at: new Date() });
    await customer({ active: false });
    await customer({ pipeline_stage: 'new_lead' });
    await customer({ first_name: 'Angela' });
    const callLogId = await call();
    expect(await fileFamilyAccountCard(input(callLogId))).toBeNull();
    expect(await trx('triage_items').where({ call_log_id: callLogId })).toHaveLength(0);
  });

  test('case and whitespace differences match; no fuzzy match', async () => {
    const mom = await customer({ first_name: '  angelina ', last_name: 'TESTERSON  ' });
    const rows = await findLiveCustomersByFullName(trx, { first_name: 'Angelina', last_name: 'Testerson' });
    expect(rows.map((r) => String(r.id))).toEqual([String(mom)]);
    expect(await findLiveCustomersByFullName(trx, { first_name: 'Angelin', last_name: 'Testerson' })).toEqual([]);
  });

  test('a number some live account already knows (primary, slot or secondary_phone) gives no card; the inbound ID counts too', async () => {
    await customer();
    await customer({ first_name: 'Slot', last_name: 'Holder', service_contact2_phone: '+19415550177' });
    await customer({ first_name: 'Sec', last_name: 'Holder', secondary_phone: '+19415550166' });
    await customer({ first_name: 'Gone', last_name: 'Customer', phone: '+19415550188', deleted_at: new Date() });
    for (const phone of ['(941) 555-0177', '+19415550166']) {
      expect(await suggestFamilyAccounts(input(await call(), { phones: [phone, '+19415550102'] }))).toBeNull();
      expect(await suggestFamilyAccounts(input(await call(), { phones: ['+19415550102', phone] }))).toBeNull();
    }
    // a retired account does not hold a number
    expect(await suggestFamilyAccounts(input(await call(), { phones: ['+19415550188'] }))).not.toBeNull();
  });

  test('voicemail, outbound, an already-linked call and a non-family caller give no card', async () => {
    await customer();
    const base = input(await call());
    expect(await suggestFamilyAccounts({ ...base, extracted: { ...base.extracted, is_voicemail: true } })).toBeNull();
    expect(await suggestFamilyAccounts({ ...base, isOutbound: true })).toBeNull();
    expect(await suggestFamilyAccounts({ ...base, call: { ...base.call, customer_id: randomUUID() } })).toBeNull();
    expect(await suggestFamilyAccounts({
      ...base, v2CanonicalExtraction: { ...base.v2CanonicalExtraction, caller: { relationship_to_property: 'other' } },
    })).toBeNull();
    expect(await suggestFamilyAccounts({ ...base, v2CanonicalExtraction: null })).toBeNull();
    expect(await suggestFamilyAccounts(base)).not.toBeNull();
  });

  test('a database error files nothing and never throws (the call proceeds exactly as on main)', async () => {
    const broken = { raw: () => { throw new Error('boom'); }, ...(() => 0) };
    const brokenConn = () => { throw new Error('boom'); };
    brokenConn.raw = broken.raw;
    await expect(fileFamilyAccountCard(input(await call(), { conn: brokenConn }))).resolves.toBeNull();
  });
});
