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

  test('the protective context follows the persisted marker, not the gate, on a reprocess', () => {
    const resume = source.slice(source.indexOf('// A call this feature linked on an earlier pass'), source.indexOf('// Pre-linked calls (call.customer_id set at ring time'));
    expect(resume).toContain("String(call.metadata?.family_name_link?.customer_id || '') === String(customerId)");
    expect(resume.indexOf('adoptFamilyNameLink(customerId, markedHolder)')).toBeGreaterThan(resume.indexOf('callFamilyNameLinkLive()'));
    expect(resume.slice(0, resume.indexOf('try {'))).not.toContain('callFamilyNameLinkLive');
  });

  test('corroboration uses the ORIGINALLY stated address, never the validated or recovered one', () => {
    expect(source).toContain('statedAddress: v2StatedServiceAddressRaw,');
    const call = source.slice(source.indexOf('const result = await resolveFamilyNameLink('), source.indexOf('statedAddress: v2StatedServiceAddressRaw,') + 60)
      .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    expect(call).not.toMatch(/extracted\.(address_line1|city|zip)/);
    expect(call).not.toContain('v2CanonicalExtraction?.property');
    // frozen before address validation rewrites the extraction
    expect(source.indexOf('v2StatedServiceAddressRaw = rawServiceAddress ?')).toBeLessThan(source.indexOf('v2AddressValidation = await validateWithOnFileAssist'));
  });

  test('a card says why when the name matched but the address did not', () => {
    expect(source).toContain("result.status === 'uncorroborated'\n                  ? 'The caller named this account but gave no matching address. Confirm before linking.'");
  });

  test('the saved family contact goes through the recipient double opt-in, never texted on role alone', () => {
    const after = source.slice(source.indexOf('family-link caller saved as a service contact'));
    const block = after.slice(0, after.indexOf('family-link service contact skipped'));
    expect(block).toContain("if (saved === 'written' && !v2DoNotContact) {");
    expect(block).toContain("const { claimRecipientOptins, dispatchRecipientOptins } = require('./recipient-optin');");
    expect(block).toContain('void dispatchRecipientOptins(claims, custRow)');
    // fail closed: a failed claim leaves a blocking ask_failed row
    expect(block).toContain("status: 'ask_failed'");
    // no direct send anywhere in the family-link writer
    expect(block).not.toMatch(/sendCustomerMessage|sendSMS|twilio/i);
  });

  test('both the dictated callback number and the inbound caller ID are checked for an account', () => {
    expect(source).toContain('callerPhones: [phone, call.from_phone],');
  });

  test('canonical V2 output is trusted only in primary mode, for the link and for the retry', () => {
    expect(source).toContain('!callExtractionV2PrimaryEnabled()) return null;');
    expect(source).toContain('callFamilyNameLinkLive() && callExtractionV2PrimaryEnabled()');
  });

  test('the holder exclusion uses the structured name, so a two-word first name keys the same', () => {
    expect(fullNameKey({ first_name: 'Mary Ann', last_name: 'Testerson' })).toBe('mary ann|testerson');
    expect(source).toContain('holderKey: fullNameKey(holder)');
  });

  test('the booking backfill never copies the caller onto the holder', () => {
    expect(source).toContain('suppressCallerIdentity: !!familyNameLink');
    expect(source).toContain('const extracted = suppressCallerIdentity ? { ...extractedIn, first_name: null, last_name: null, phone: null, email: null } : extractedIn;');
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

  test('a caller who is not a family member links nothing', async () => {
    await customer();
    const callLogId = await call();
    const out = await resolveFamilyNameLink(args(callLogId, { callerRelationship: 'other' }));
    expect(out.status).toBe('not_applicable');
    expect((await trx('call_log').where({ id: callLogId }).first()).customer_id).toBeNull();
  });
});
