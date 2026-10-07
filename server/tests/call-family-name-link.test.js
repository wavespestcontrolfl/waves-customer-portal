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
  findLiveCustomersByFullName, linkCallToCustomer, phoneOnAnyLiveAccount, statedAddressCorroborates,
  scrubCallerIdentity, familyLinkContextFromCall, linkFamilyCall,
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

describe('statedAddressCorroborates', () => {
  const onFile = { address_line1: '100 Example Loop', city: 'Sarasota', zip: '34240' };
  test('same house number and street corroborates, with or without the suffix, case-insensitive', () => {
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
  test('a stated unit must equal the stored unit; no stated unit is fine', () => {
    const condo = { address_line1: '100 Example Loop', address_line2: 'Apt 4B', city: 'Sarasota', zip: '34240' };
    expect(statedAddressCorroborates({ street_line_1: '100 Example Loop', street_line_2: 'Unit 5C' }, condo)).toBe(false);
    expect(statedAddressCorroborates({ street_line_1: '100 Example Loop Apt 5C' }, condo)).toBe(false);
    expect(statedAddressCorroborates({ street_line_1: '100 Example Loop', street_line_2: '#4b' }, condo)).toBe(true);
    expect(statedAddressCorroborates({ street_line_1: '100 Example Loop' }, condo)).toBe(true);
  });
  test('legacy unit-FIRST on-file address: same unit matches, a different unit does not', () => {
    const legacy = { address_line1: 'Apt 4B, 100 Example Loop', address_line2: null, city: 'Sarasota', zip: '34240' };
    expect(statedAddressCorroborates({ street_line_1: '100 Example Loop', street_line_2: 'Apt 4B' }, legacy)).toBe(true);
    expect(statedAddressCorroborates({ street_line_1: '100 Example Loop', street_line_2: 'Apt 9' }, legacy)).toBe(false);
    expect(statedAddressCorroborates({ street_line_1: 'Apt 9, 100 Example Loop' }, legacy)).toBe(false);
    expect(statedAddressCorroborates({ street_line_1: '100 Example Loop' }, legacy)).toBe(true);
  });
  test('a stated unit against a record with no parseable unit is not corroborated', () => {
    expect(statedAddressCorroborates({ street_line_1: '100 Example Loop', street_line_2: 'Apt 9' }, onFile)).toBe(false);
    expect(statedAddressCorroborates({ street_line_1: '100 Example Loop Unit 9' }, onFile)).toBe(false);
  });

  test('a stated ZIP or city that disagrees with the account does not', () => {
    expect(statedAddressCorroborates({ street_line_1: '100 Example Loop', postal_code: '34202' }, onFile)).toBe(false);
    expect(statedAddressCorroborates({ street_line_1: '100 Example Loop', city: 'Bradenton' }, onFile)).toBe(false);
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
    expect(source).toContain('!isOutboundCall(call) && (familyLinked = await tryFamilyNameLink())');
  });

  test('the processor keeps a short call; the decisions live in the family link module', () => {
    const start = source.indexOf('const tryFamilyNameLink = async () => {');
    const block = source.slice(start, source.indexOf('const sharedPhoneAmbiguity = {};'));
    expect(block).toContain("require('./call-family-name-link').linkFamilyCall({");
    expect(block.split('\n').length).toBeLessThan(14);
    expect(block).toContain('statedAddress: v2StatedServiceAddressRaw');
    expect(block).not.toMatch(/extracted\.(address_line1|city|zip)/);
  });

  test('the caller is NOT saved on the holder: no slot write, no opt-in claim, no consent branch', () => {
    expect(source).not.toMatch(/persistCallSecondaryContact\(linkedCustomerId/);
    expect(source).not.toContain('family-link opt-in');
    expect(source).not.toContain('family-link caller saved');
    const moduleSource = fs.readFileSync(require.resolve('../services/call-family-name-link'), 'utf8');
    const code = moduleSource.split('\n').filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//')).join('\n');
    expect(code).not.toMatch(/persistCallSecondaryContact|claimRecipientOptins|dispatchRecipientOptins|recipient_optin|sendCustomerMessage/);
  });

  test('a family link sends the holder no text on the caller\'s consent: SMS blocked, implied and explicit consent cleared', () => {
    const adopt = source.slice(source.indexOf('const adoptFamilyNameLink = (context) => {'), source.indexOf('const tryFamilyNameLink = async () => {'));
    expect(adopt).toContain('v2SmsBlocked = true;');
    expect(adopt).toContain('v2SmsClearedByImpliedConsent = false;');
    expect(adopt).toContain('v2SmsConsentExplicit = false;');
    // adopted after the consent was computed, so it cannot be overwritten by that read
    expect(source.indexOf('v2SmsBlocked = !tcpa.canSms;')).toBeLessThan(source.indexOf('const adoptFamilyNameLink'));
    expect(source.indexOf('v2SmsConsentExplicit = v2Result?.status')).toBeLessThan(source.indexOf('const adoptFamilyNameLink'));
    // nothing after Step 3 recomputes SMS blocking from consent without keeping a block already set
    const later = source.slice(source.indexOf('const adoptFamilyNameLink')).match(/v2SmsBlocked = [^;]*;/g) || [];
    for (const assignment of later) expect(assignment).toMatch(/v2SmsBlocked = (true|v2SmsBlocked \|\|)/);
  });

  test('the protective context follows the persisted marker, not the gate, on a reprocess', () => {
    const resume = source.slice(source.indexOf('A call this feature linked on an earlier pass keeps its protections'), source.indexOf('// Pre-linked calls (call.customer_id set at ring time'));
    expect(resume).toContain('familyLinkContextFromCall(call, customerId)');
    expect(resume).not.toContain('callFamilyNameLinkLive');
  });

  test('candidate staging scrubs the caller identity on a family link', () => {
    expect(source).toContain('scrubCallerIdentity(extracted, v2ExtractionForAudit)');
    expect(source).toContain('extraction: stagingInput.extracted,');
    expect(source).toContain('v2Extraction: stagingInput.v2Extraction,');
  });

  test('the booking backfill never copies the caller onto the holder', () => {
    expect(source).toContain('suppressCallerIdentity: !!familyNameLink');
    expect(source).toContain('const extracted = suppressCallerIdentity ? { ...extractedIn, first_name: null, last_name: null, phone: null, email: null } : extractedIn;');
  });

  test('a family-linked call persists no secondary contact on the holder\'s account (caller, caller copy or holder)', () => {
    expect(source).toContain("GATE_CALL_SECONDARY_CONTACT === 'true' && customerId && callSecondaryContacts.length && !familyNameLink) {");
    expect(fullNameKey({ first_name: 'Mary Ann', last_name: 'Testerson' })).toBe('mary ann|testerson');
    // the holder is also left out of the second-contact review card
    expect(source).toContain('familyNameLink?.holderKey');
  });
});

describe('scrubCallerIdentity', () => {
  test('drops the caller name, number and email from both extractions and keeps the address', () => {
    const extracted = { first_name: 'Dana', last_name: 'Lee', phone: '+19415550101', email: 'dana@example.com', address_line1: '100 Example Loop' };
    const v2 = { meta: { schema_version: '1.24.0' }, caller: { first_name: 'Dana', last_name: 'Lee', name_full: 'Dana Lee', email: 'dana@example.com', phone_e164: '+19415550101', phone_raw_spoken: '941 555 0101', relationship_to_property: 'family_member' }, property: { service_address: { street_line_1: '100 Example Loop' } } };
    const out = scrubCallerIdentity(extracted, v2);
    expect(out.extracted).toMatchObject({ first_name: null, last_name: null, phone: null, email: null, address_line1: '100 Example Loop' });
    expect(out.v2Extraction.caller).toMatchObject({ first_name: null, last_name: null, name_full: null, email: null, phone_e164: null, phone_raw_spoken: null, relationship_to_property: 'family_member' });
    expect(out.v2Extraction.property.service_address.street_line_1).toBe('100 Example Loop');
    expect(extracted.first_name).toBe('Dana'); // input untouched
    expect(v2.caller.email).toBe('dana@example.com');
  });

  test('with no V2 extraction it still scrubs the V1 record', () => {
    expect(scrubCallerIdentity({ first_name: 'Dana', email: 'd@example.com' }, null).extracted).toMatchObject({ first_name: null, email: null });
  });
});

describe('familyLinkContextFromCall', () => {
  const marker = { customer_id: 'c1', holder_first_name: 'Mary Ann', holder_last_name: 'Testerson' };
  test('restores the structured holder key from the persisted marker for the same customer only', () => {
    expect(familyLinkContextFromCall({ metadata: { family_name_link: marker } }, 'c1')).toMatchObject({ customerId: 'c1', holderKey: 'mary ann|testerson' });
    expect(familyLinkContextFromCall({ metadata: { family_name_link: marker } }, 'c2')).toBeNull();
    expect(familyLinkContextFromCall({ metadata: {} }, 'c1')).toBeNull();
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
    await trx('call_log').insert({ id, processing_token: TOKEN, customer_id: null, metadata: {}, ...over });
    return id;
  }
  const args = (callLogId, over = {}) => ({
    callLogId,
    procToken: TOKEN,
    callerRelationship: 'family_member',
    statedAddress: { street_line_1: '100 Example Loop', city: 'Sarasota', postal_code: '34240' },
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

  test('one name match but no stated address, or a different one, links and saves nothing', async () => {
    const mom = await customer();
    for (const statedAddress of [null, { street_line_1: '' }, { street_line_1: '4313 Other Dr', city: 'Sarasota', postal_code: '34240' }]) {
      const callLogId = await call();
      const out = await resolveFamilyNameLink(args(callLogId, { statedAddress }));
      expect(out.status).toBe('uncorroborated');
      expect(out.candidates).toEqual([{ customer_id: String(mom), name: 'Angelina Testerson', city: 'Sarasota' }]);
      const row = await trx('call_log').where({ id: callLogId }).first();
      expect(row.customer_id).toBeNull();
      expect(row.metadata.family_name_link).toBeUndefined();
    }
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

  test('a number carried by any live account, even only in a service-contact slot, is not ours to link', async () => {
    await customer();
    await customer({ first_name: 'Slot', last_name: 'Holder', service_contact2_phone: '+19415550177' });
    await customer({ first_name: 'Gone', last_name: 'Customer', phone: '+19415550188', deleted_at: new Date() });
    const callLogId = await call();
    const out = await resolveFamilyNameLink(args(callLogId, { callerPhones: ['+19415550142', '(941) 555-0177'] }));
    expect(out.status).toBe('phone_on_file');
    expect((await trx('call_log').where({ id: callLogId }).first()).customer_id).toBeNull();
    expect(await phoneOnAnyLiveAccount(trx, '+19415550188')).toBe(false); // a retired account does not hold a number
    expect(await phoneOnAnyLiveAccount(trx, '+19415550199')).toBe(false);
    expect((await resolveFamilyNameLink(args(await call(), { callerPhones: ['+19415550199', null] }))).status).toBe('linked');
  });

  test('the match is rechecked under the customer lock: a rename or address change after the search links nothing', async () => {
    const mom = await customer();
    const holder = { first_name: 'Angelina', last_name: 'Testerson' };
    const stated = { street_line_1: '100 Example Loop', city: 'Sarasota', postal_code: '34240' };
    const tryLink = async () => {
      const callLogId = await call();
      const outcome = await linkCallToCustomer({ callLogId, procToken: TOKEN, customer: { id: mom }, holder, caller: {}, statedAddress: stated, conn: trx });
      return { outcome, row: await trx('call_log').where({ id: callLogId }).first() };
    };
    await trx('customers').where({ id: mom }).update({ last_name: 'Renamed' });
    let r = await tryLink();
    expect(r.outcome).toBe('no_longer_matches');
    expect(r.row.customer_id).toBeNull();
    await trx('customers').where({ id: mom }).update({ last_name: 'Testerson', address_line1: '4313 Other Dr' });
    r = await tryLink();
    expect(r.outcome).toBe('no_longer_matches');
    expect(r.row.customer_id).toBeNull();
    expect(r.row.metadata.family_name_link).toBeUndefined();
    await trx('customers').where({ id: mom }).update({ address_line1: '100 Example Loop' });
    r = await tryLink();
    expect(r.outcome).toBe('linked');
  });

  test('a voicemail never links: the card lists the one candidate and the call stays unlinked', async () => {
    const mom = await customer();
    const callLogId = await call();
    const out = await resolveFamilyNameLink(args(callLogId, { allowLink: false }));
    expect(out.status).toBe('voicemail');
    expect(out.candidates).toEqual([{ customer_id: String(mom), name: 'Angelina Testerson', city: 'Sarasota' }]);
    expect((await trx('call_log').where({ id: callLogId }).first()).customer_id).toBeNull();
  });

  test('a different stated unit on a matching street links nothing', async () => {
    await customer({ address_line2: 'Apt 4B' });
    const callLogId = await call();
    const out = await resolveFamilyNameLink(args(callLogId, { statedAddress: { street_line_1: '100 Example Loop', street_line_2: 'Apt 9', city: 'Sarasota', postal_code: '34240' } }));
    expect(out.status).toBe('uncorroborated');
    expect((await trx('call_log').where({ id: callLogId }).first()).customer_id).toBeNull();
  });

  describe('linkFamilyCall files the cards and saves nothing on the account', () => {
    beforeAll(() => { process.env.GATE_CALL_FAMILY_NAME_LINK = 'true'; });
    afterAll(() => { delete process.env.GATE_CALL_FAMILY_NAME_LINK; });
    const base = (callRow, over = {}) => ({
      call: { id: callRow, from_phone: '+19415550101' },
      procToken: TOKEN,
      extracted: { first_name: 'Dana', last_name: 'Lee', is_voicemail: false },
      v2CanonicalExtraction: { caller: { relationship_to_property: 'family_member' }, meta: { call_summary: 'x' } },
      statedAddress: { street_line_1: '100 Example Loop', city: 'Sarasota', postal_code: '34240' },
      secondaryContacts: [{ first_name: 'Angelina', last_name: 'Testerson', role: 'family_member' }],
      phone: '+19415550102',
      v2Primary: true,
      isOutbound: false,
      conn: trx,
      ...over,
    });
    test('linked: FYI card shows the caller name and numbers, the holder row is untouched', async () => {
      const mom = await customer();
      const before = await trx('customers').where({ id: mom }).first();
      const callLogId = await call();
      const out = await linkFamilyCall(base(callLogId));
      expect(String(out.customer.id)).toBe(String(mom));
      expect(out.context.holderKey).toBe('angelina|testerson');
      const [card] = await trx('triage_items').where({ call_log_id: callLogId });
      expect(card).toMatchObject({ reason_code: 'family_account_linked', severity: 'advisory' });
      expect(card.payload).toMatchObject({ caller_name: 'Dana Lee', caller_phone: '+19415550101', caller_callback_phone: '+19415550102', account_holder_name: 'Angelina Testerson' });
      expect(card.payload.reason).toContain('Add them as a contact on this account if that is right');
      const after = await trx('customers').where({ id: mom }).first();
      expect(after).toEqual(before); // no slot, no phone, no email, nothing
      expect(await trx('recipient_optin').where({ customer_id: mom })).toHaveLength(0);
    });
    test('voicemail, outbound, V2 shadow mode and gate off all link nothing', async () => {
      await customer();
      for (const over of [{ extracted: { first_name: 'Dana', last_name: 'Lee', is_voicemail: true } }, { isOutbound: true }, { v2Primary: false }]) {
        const callLogId = await call();
        const out = await linkFamilyCall(base(callLogId, over));
        expect(out).toBeNull();
        expect((await trx('call_log').where({ id: callLogId }).first()).customer_id).toBeNull();
      }
      const voicemailCall = await call();
      await linkFamilyCall(base(voicemailCall, { extracted: { first_name: 'Dana', last_name: 'Lee', is_voicemail: true } }));
      expect((await trx('triage_items').where({ call_log_id: voicemailCall, reason_code: 'family_account_candidates' }))).toHaveLength(1);
      delete process.env.GATE_CALL_FAMILY_NAME_LINK;
      const off = await call();
      expect(await linkFamilyCall(base(off))).toBeNull();
      process.env.GATE_CALL_FAMILY_NAME_LINK = 'true';
    });
  });

  test('a caller who is not a family member links nothing', async () => {
    await customer();
    const callLogId = await call();
    const out = await resolveFamilyNameLink(args(callLogId, { callerRelationship: 'other' }));
    expect(out.status).toBe('not_applicable');
    expect((await trx('call_log').where({ id: callLogId }).first()).customer_id).toBeNull();
  });
});
