/**
 * Owner ruling 2026-10-07, option A (GATE_CALL_FAMILY_NAME_LINK): a family member who calls
 * for a parent or relative by full name, from a number no account carries, links the call
 * to that person's account when exactly one LIVE customer has that first and last name.
 *
 * Audited case (synthetic here): a daughter called for her mother by full name; the call
 * linked to no account, the accepted "tomorrow around four" visit was never booked, and
 * address cards were filed.
 *
 * A full processRecording() run cannot be mocked end to end, so the matching and the link
 * are tested behaviorally (the writers against real Postgres when DATABASE_URL is set, as in
 * CI, inside a rolled-back transaction) and the Step 3 wiring is pinned structurally.
 * Synthetic names, numbers and addresses only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const fs = require('fs');
const knex = require('knex');
const { randomUUID } = require('crypto');
const gates = require('../config/feature-gates');
const {
  pickNamedAccountHolder, normName, fullNameKey, resolveFamilyNameLink,
  findLiveCustomersByFullName, linkCallToCustomer,
} = require('../services/call-family-name-link');

const { buildTriageItem } = require('../services/call-routing-gates');

const GATE = 'GATE_CALL_FAMILY_NAME_LINK';
const source = fs.readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');

describe('the gate ships dark and reads at call time', () => {
  afterEach(() => { delete process.env[GATE]; });
  test('off unless exactly "true"', () => {
    expect(gates.callFamilyNameLinkLive()).toBe(false);
    for (const v of ['1', 'TRUE', 'on', 'yes', '']) {
      process.env[GATE] = v;
      expect(gates.callFamilyNameLinkLive()).toBe(false);
    }
    process.env[GATE] = 'true';
    expect(gates.callFamilyNameLinkLive()).toBe(true);
  });
});

describe('pickNamedAccountHolder', () => {
  const mother = { first_name: 'Angelina', last_name: 'Testerson', role: 'family_member' };
  const caller = { first_name: 'Dana', last_name: 'Testerson-Lee' };

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

  test('the same person listed twice is still one holder, whatever the case or spacing', () => {
    const again = { first_name: ' angelina ', last_name: 'TESTERSON', role: 'unknown' };
    expect(pickNamedAccountHolder({ callerRelationship: 'family_member', caller, secondaryContacts: [mother, again] })).not.toBeNull();
  });

  test('the caller copied into the second-person slot is not the holder', () => {
    expect(pickNamedAccountHolder({ callerRelationship: 'family_member', caller, secondaryContacts: [{ ...caller, role: 'family_member' }] })).toBeNull();
  });

  test('normName and fullNameKey ignore case and repeated whitespace only', () => {
    expect(normName('  Mary   ANN ')).toBe('mary ann');
    expect(fullNameKey({ first_name: 'A', last_name: 'B' })).toBe('a|b');
    expect(fullNameKey({ first_name: 'Angelina', last_name: 'Testerson' })).not.toBe(fullNameKey({ first_name: 'Angelina', last_name: 'Testersen' }));
  });
});

describe('the two advisory cards', () => {
  test.each(['family_account_linked', 'family_account_candidates'])('%s files advisory in the customer-field lane', (flag) => {
    const item = buildTriageItem({
      callLogId: randomUUID(), flag, severity: 'advisory', extraPayload: { account_holder_name: 'Angelina Testerson' },
    });
    expect(item).toMatchObject({ reason_code: flag, severity: 'advisory', category: 'customer_field_conflict' });
    expect(JSON.parse(item.payload).account_holder_name).toBe('Angelina Testerson');
  });
});

describe('Step 3 wiring (structural)', () => {
  test('the family link runs only after the phone match and the shared-phone branch, before the customer create', () => {
    const shared = source.indexOf('} else if (sharedPhoneAmbiguity.candidates) {');
    const family = source.indexOf('tryFamilyNameLink())) {');
    const create = source.indexOf('} else if ((extracted.first_name || firstNameAdvisoryCreate) && phone');
    expect(shared).toBeGreaterThan(0);
    expect(family).toBeGreaterThan(shared);
    expect(create).toBeGreaterThan(family);
  });

  test('inbound only, gated, fail-open, token-fenced through the shared module', () => {
    expect(source).toContain('!isOutboundCall(call) && (familyLinked = await tryFamilyNameLink())');
    expect(source).toContain("require('../config/feature-gates').callFamilyNameLinkLive()");
    expect(source).toContain('procToken,\n          callerRelationship: v2CanonicalExtraction?.caller?.relationship_to_property');
  });

  test('the caller is saved through the one slot writer, on the inbound number only, never clearing the account consent stamp', () => {
    expect(source).toMatch(/!isOutboundCall\(call\) && phone && samePhone\(phone, call\.from_phone\)\)/);
    expect(source).toMatch(/persistCallSecondaryContact\(linkedCustomerId, \{[\s\S]*?\}, \{\s*smsConsentExplicit: consentGiven,\s*keepConsentStamp: !consentGiven,\s*holdPhone: held,/);
  });

  test('canonical V2 output is trusted only in primary mode, for the link and for the retry', () => {
    expect(source).toContain('!callExtractionV2PrimaryEnabled()) return null;');
    expect(source).toContain('callFamilyNameLinkLive() && callExtractionV2PrimaryEnabled()');
  });

  test('the holder exclusion uses the structured name, so a two-word first name keys the same', () => {
    expect(fullNameKey({ first_name: 'Mary Ann', last_name: 'Testerson' })).toBe('mary ann|testerson');
    expect(source).toContain('holderKey: fullNameKey(holder)');
  });
});

const SKIP = !process.env.DATABASE_URL;
(SKIP ? describe.skip : describe)('family name link on PostgreSQL', () => {
  jest.setTimeout(30000);
  let database; let trx;
  const TOKEN = 'proc-token-a';
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
      pipeline_stage: 'active_customer',
      active: true,
      ...over,
    });
    return id;
  }
  async function call(over = {}) {
    const id = randomUUID();
    await trx('call_log').insert({ id, processing_token: TOKEN, customer_id: null, metadata: {}, ...over });
    return id;
  }
  const args = (callLogId, over = {}) => ({
    callLogId,
    procToken: TOKEN,
    callerRelationship: 'family_member',
    caller: { first_name: 'Dana', last_name: 'Lee' },
    secondaryContacts: [{ first_name: 'Angelina', last_name: 'Testerson', role: 'family_member' }],
    conn: trx,
    ...over,
  });

  test('exactly one live match links the call and stamps the marker', async () => {
    const mom = await customer();
    await customer({ first_name: 'Angela', last_name: 'Testerson' }); // near-name: never matches
    const callLogId = await call();
    const out = await resolveFamilyNameLink(args(callLogId));
    expect(out.status).toBe('linked');
    expect(String(out.customer.id)).toBe(String(mom));
    const row = await trx('call_log').where({ id: callLogId }).first();
    expect(String(row.customer_id)).toBe(String(mom));
    expect(row.metadata.family_name_link).toMatchObject({ customer_id: String(mom), holder_name: 'Angelina Testerson' });
  });

  test('case and whitespace differences in the stored name still match; no fuzzy match', async () => {
    const mom = await customer({ first_name: '  angelina ', last_name: 'TESTERSON  ' });
    const rows = await findLiveCustomersByFullName(trx, { first_name: 'Angelina', last_name: 'Testerson' });
    expect(rows.map((r) => String(r.id))).toEqual([String(mom)]);
    expect(await findLiveCustomersByFullName(trx, { first_name: 'Angelin', last_name: 'Testerson' })).toEqual([]);
  });

  test('a soft-deleted, merged-away, inactive or lead-stage record never matches', async () => {
    await customer({ deleted_at: new Date() });
    await customer({ active: false });
    await customer({ pipeline_stage: 'new_lead' });
    const callLogId = await call();
    const out = await resolveFamilyNameLink(args(callLogId));
    expect(out.status).toBe('candidates');
    expect(out.candidates).toEqual([]);
    expect((await trx('call_log').where({ id: callLogId }).first()).customer_id).toBeNull();
  });

  test('two live matches link nothing and list both with name and city', async () => {
    await customer({ city: 'Sarasota' });
    await customer({ city: 'Bradenton' });
    const callLogId = await call();
    const out = await resolveFamilyNameLink(args(callLogId));
    expect(out.status).toBe('candidates');
    expect(out.candidates.map((c) => c.city).sort()).toEqual(['Bradenton', 'Sarasota']);
    expect(out.candidates[0]).toMatchObject({ name: 'Angelina Testerson' });
    expect((await trx('call_log').where({ id: callLogId }).first()).customer_id).toBeNull();
  });

  test('a lost processing claim writes nothing', async () => {
    await customer();
    const callLogId = await call({ processing_token: 'someone-else' });
    const out = await resolveFamilyNameLink(args(callLogId));
    expect(out.status).toBe('claim_lost');
    expect((await trx('call_log').where({ id: callLogId }).first()).customer_id).toBeNull();
  });

  test('an already-linked call, or an operator unlink, is never overwritten', async () => {
    const mom = await customer();
    const other = await customer({ first_name: 'Someone', last_name: 'Else' });
    const linkedCall = await call({ customer_id: other });
    expect((await resolveFamilyNameLink(args(linkedCall))).status).toBe('claim_lost');
    expect(String((await trx('call_log').where({ id: linkedCall }).first()).customer_id)).toBe(String(other));
    const unlinkedCall = await call({ metadata: { customer_link_override: { customer_id: null } } });
    expect((await resolveFamilyNameLink(args(unlinkedCall))).status).toBe('claim_lost');
    expect((await trx('call_log').where({ id: unlinkedCall }).first()).customer_id).toBeNull();
    expect(mom).toBeTruthy();
  });

  test('a customer retired between the search and the write is not linked', async () => {
    const mom = await customer();
    const callLogId = await call();
    await trx('customers').where({ id: mom }).update({ deleted_at: new Date() });
    const outcome = await linkCallToCustomer({
      callLogId, procToken: TOKEN, customer: { id: mom },
      holder: { first_name: 'Angelina', last_name: 'Testerson' }, caller: {}, conn: trx,
    });
    expect(outcome).toBe('customer_gone');
    expect((await trx('call_log').where({ id: callLogId }).first()).customer_id).toBeNull();
  });

  test('a caller who is not a family member links nothing', async () => {
    await customer();
    const callLogId = await call();
    const out = await resolveFamilyNameLink(args(callLogId, { callerRelationship: 'other' }));
    expect(out.status).toBe('not_applicable');
    expect((await trx('call_log').where({ id: callLogId }).first()).customer_id).toBeNull();
  });
});
