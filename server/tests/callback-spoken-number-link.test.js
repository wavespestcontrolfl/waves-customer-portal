// GATE_CALLBACK_SPOKEN_NUMBER_LINK: an office callback dials the voicemail's
// caller ID, but the caller spoke another number to ring back, and that number
// may already be a customer's PRIMARY phone (a quote form filed minutes after
// the voicemail). findCustomerViaCallbackSpokenNumber is the second chance the
// call pass takes only when the dialed number found no customer.
//
// Fixtures are fictitious: 555-01xx numbers, synthetic names and ids.
jest.mock('../models/db', () => jest.fn());
jest.mock('../utils/triage-locks', () => ({ lockTriageCall: jest.fn(async () => {}), syncCallReviewStatus: jest.fn(async () => {}) }));
jest.mock('../utils/known-caller-phone', () => ({ findKnownCallerCustomer: jest.fn(async () => null) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/twilio-numbers', () => ({
  isInternalNumber: jest.fn(() => false),
  isOwnedNumber: jest.fn(() => false),
  findByNumber: jest.fn(() => null),
  getLeadSourceFromNumber: jest.fn(() => ({ source: 'phone_call' })),
}));

const db = require('../models/db');
const CallRecordingProcessor = require('../services/call-recording-processor');
const { findCustomerViaCallbackSpokenNumber } = CallRecordingProcessor._test;
const familyLink = require('../services/call-family-name-link');

const DIALED = '+19415550199';
const SPOKEN = '+19415558642';
const PARENT_ID = '11111111-1111-4111-8111-111111111111';

// Thenable knex-builder mock: chain methods return the builder; `first` and a
// bare await each take the next queued result for the table, in call order.
let tablesRead;
function mockDb(queues) {
  tablesRead = [];
  db.mockImplementation((table) => {
    tablesRead.push(table);
    const next = (fallback) => Promise.resolve((queues[table] || []).shift() ?? fallback);
    const builder = {
      where: () => builder,
      whereNull: () => builder,
      whereNot: () => builder,
      whereRaw: () => builder,
      orWhereRaw: () => builder,
      orderBy: () => builder,
      orderByRaw: () => builder,
      limit: () => builder,
      count: () => builder,
      select: () => builder,
      first: () => next(null),
      then: (resolve, reject) => next([]).then(resolve, reject),
    };
    return builder;
  });
}

const callbackCall = (over = {}) => ({
  id: 'cb-1',
  direction: 'outbound',
  source: 'admin-callback',
  from_phone: '+19415550100',
  to_phone: DIALED,
  metadata: { relatedCallId: PARENT_ID },
  ...over,
});
const voicemail = (over = {}) => ({
  id: PARENT_ID,
  direction: 'inbound',
  from_phone: DIALED,
  call_outcome: 'voicemail',
  ai_extraction: { phone: SPOKEN },
  ...over,
});
const customer = (over = {}) => ({
  id: 'cust-1', first_name: 'Jordan', last_name: 'Rivers', phone: SPOKEN, ...over,
});
const extractedJordan = { first_name: 'Jordan', last_name: 'Rivers' };

beforeEach(() => {
  db.mockReset();
  process.env.GATE_CALLBACK_SPOKEN_NUMBER_LINK = 'true';
});
afterAll(() => { delete process.env.GATE_CALLBACK_SPOKEN_NUMBER_LINK; });

describe('findCustomerViaCallbackSpokenNumber', () => {
  test('gate off: null and no query', async () => {
    delete process.env.GATE_CALLBACK_SPOKEN_NUMBER_LINK;
    mockDb({ call_log: [voicemail()], customers: [[customer()]] });
    expect(await findCustomerViaCallbackSpokenNumber(callbackCall(), extractedJordan)).toBeNull();
    expect(tablesRead).toEqual([]);
  });

  test('gate set to anything but "true" stays off', async () => {
    process.env.GATE_CALLBACK_SPOKEN_NUMBER_LINK = '1';
    mockDb({ call_log: [voicemail()], customers: [[customer()]] });
    expect(await findCustomerViaCallbackSpokenNumber(callbackCall(), extractedJordan)).toBeNull();
    expect(tablesRead).toEqual([]);
  });

  test('not an admin callback (inbound, other source, no related call): null', async () => {
    mockDb({ call_log: [voicemail()], customers: [[customer()]] });
    expect(await findCustomerViaCallbackSpokenNumber(callbackCall({ direction: 'inbound' }), extractedJordan)).toBeNull();
    expect(await findCustomerViaCallbackSpokenNumber(callbackCall({ source: 'twilio-voice' }), extractedJordan)).toBeNull();
    expect(await findCustomerViaCallbackSpokenNumber(callbackCall({ metadata: {} }), extractedJordan)).toBeNull();
    expect(await findCustomerViaCallbackSpokenNumber(callbackCall({ metadata: { relatedCallId: 'not-a-uuid' } }), extractedJordan)).toBeNull();
    expect(tablesRead).toEqual([]);
  });

  test('operator link override: null', async () => {
    mockDb({ call_log: [voicemail()], customers: [[customer()]] });
    const out = await findCustomerViaCallbackSpokenNumber(callbackCall(), extractedJordan, { customerLinkOverride: { customer_id: null } });
    expect(out).toBeNull();
    expect(tablesRead).toEqual([]);
  });

  test('related call missing or not inbound: null', async () => {
    mockDb({ call_log: [null], customers: [[customer()]] });
    expect(await findCustomerViaCallbackSpokenNumber(callbackCall(), extractedJordan)).toBeNull();
    mockDb({ call_log: [voicemail({ direction: 'outbound-api' })], customers: [[customer()]] });
    expect(await findCustomerViaCallbackSpokenNumber(callbackCall(), extractedJordan)).toBeNull();
  });

  test('spoken number equals the dialed number, or is missing or unusable: null', async () => {
    mockDb({ call_log: [voicemail({ ai_extraction: { phone: DIALED } })], customers: [[customer({ phone: DIALED })]] });
    expect(await findCustomerViaCallbackSpokenNumber(callbackCall(), extractedJordan)).toBeNull();
    mockDb({ call_log: [voicemail({ ai_extraction: {} })], customers: [[customer()]] });
    expect(await findCustomerViaCallbackSpokenNumber(callbackCall(), extractedJordan)).toBeNull();
    mockDb({ call_log: [voicemail({ ai_extraction: { phone: 'anonymous' } })], customers: [[customer()]] });
    expect(await findCustomerViaCallbackSpokenNumber(callbackCall(), extractedJordan)).toBeNull();
    // No customer lookup ran in any of the three.
    expect(tablesRead.filter((t) => t === 'customers')).toEqual([]);
  });

  test('spoken number one digit off the dialed number is a misheard digit: null', async () => {
    const nearMiss = '+19415550198';
    mockDb({ call_log: [voicemail({ ai_extraction: { phone: nearMiss } })], customers: [[customer({ phone: nearMiss })]] });
    expect(await findCustomerViaCallbackSpokenNumber(callbackCall(), extractedJordan)).toBeNull();
    expect(tablesRead.filter((t) => t === 'customers')).toEqual([]);
  });

  test('spoken number is a customer primary phone and the first name agrees: the customer', async () => {
    mockDb({ call_log: [voicemail()], customers: [[customer()]] });
    const out = await findCustomerViaCallbackSpokenNumber(callbackCall(), extractedJordan);
    expect(out).toMatchObject({ id: 'cust-1', phone: SPOKEN });
  });

  test('the voicemail extraction may arrive as a JSON string; a misspelled last name does not block', async () => {
    mockDb({ call_log: [voicemail({ ai_extraction: JSON.stringify({ phone: SPOKEN }) })], customers: [[customer()]] });
    const out = await findCustomerViaCallbackSpokenNumber(callbackCall(), { first_name: 'Jordan', last_name: 'Reevas' });
    expect(out?.id).toBe('cust-1');
  });

  test('the parent is an ordinary inbound call, not a voicemail: null', async () => {
    mockDb({ call_log: [voicemail({ call_outcome: 'answered', answered_by: 'human' })], customers: [[customer()]] });
    expect(await findCustomerViaCallbackSpokenNumber(callbackCall(), extractedJordan)).toBeNull();
    expect(tablesRead.filter((t) => t === 'customers')).toEqual([]);
  });

  test('the parent voicemail came from a different number than the one dialed: null', async () => {
    mockDb({ call_log: [voicemail({ from_phone: '+19415550177' })], customers: [[customer()]] });
    expect(await findCustomerViaCallbackSpokenNumber(callbackCall(), extractedJordan)).toBeNull();
    expect(tablesRead.filter((t) => t === 'customers')).toEqual([]);
  });

  test('answered_by voicemail marks a voicemail parent too', async () => {
    mockDb({ call_log: [voicemail({ call_outcome: null, answered_by: 'voicemail' })], customers: [[customer()]] });
    expect((await findCustomerViaCallbackSpokenNumber(callbackCall(), extractedJordan))?.id).toBe('cust-1');
  });

  test('shared household number: links the member whose first name agrees, whatever the last name', async () => {
    const wife = customer({ id: 'cust-wife', first_name: 'Morgan', last_name: 'Rivers' });
    const husband = customer({ id: 'cust-husband', first_name: 'Jordan', last_name: 'Rivers' });
    mockDb({ call_log: [voicemail()], customers: [[wife, husband]] });
    const out = await findCustomerViaCallbackSpokenNumber(callbackCall(), { first_name: 'Jordan', last_name: 'Reevas' });
    expect(out?.id).toBe('cust-husband');
  });

  test('two household members share the first name: null (no tiebreak)', async () => {
    const a = customer({ id: 'cust-a', first_name: 'Jordan', last_name: 'Rivers' });
    const b = customer({ id: 'cust-b', first_name: 'Jordan', last_name: 'Rivers-Hale' });
    mockDb({ call_log: [voicemail()], customers: [[a, b]] });
    expect(await findCustomerViaCallbackSpokenNumber(callbackCall(), extractedJordan)).toBeNull();
  });

  test('more than 25 customers share the number: null (the sample cannot prove uniqueness)', async () => {
    const crowd = Array.from({ length: 26 }, (_, i) => customer({ id: `c${i}`, first_name: i === 0 ? 'Jordan' : 'Other' }));
    mockDb({ call_log: [voicemail()], customers: [crowd] });
    expect(await findCustomerViaCallbackSpokenNumber(callbackCall(), extractedJordan)).toBeNull();
  });

  test('the number is only a secondary/slot phone on the customer: null', async () => {
    const slotOnly = customer({ phone: '+19415550177', secondary_phone: SPOKEN });
    mockDb({ call_log: [voicemail()], customers: [[slotOnly]] });
    expect(await findCustomerViaCallbackSpokenNumber(callbackCall(), extractedJordan)).toBeNull();
  });

  test('first name disagrees: null', async () => {
    mockDb({ call_log: [voicemail()], customers: [[customer({ first_name: 'Casey' })]] });
    expect(await findCustomerViaCallbackSpokenNumber(callbackCall(), extractedJordan)).toBeNull();
  });

  test('the callback extraction has no first name: null (nothing to agree with)', async () => {
    mockDb({ call_log: [voicemail()], customers: [[customer()]] });
    expect(await findCustomerViaCallbackSpokenNumber(callbackCall(), { last_name: 'Rivers' })).toBeNull();
    expect(tablesRead).toEqual([]);
  });

  test('no customer owns the spoken number: null', async () => {
    mockDb({ call_log: [voicemail()], customers: [[]] });
    expect(await findCustomerViaCallbackSpokenNumber(callbackCall(), extractedJordan)).toBeNull();
  });
});

// Codex #6419 r3: the voicemail number's owner is fed to the EXISTING family-account card
// (family_account_candidates) as the callback_spoken_number basis, so the card keeps that card's whole
// lifecycle (refresh and retire on reprocess, admin-only, Resolve, review-status sync, evidence).
describe('callback_spoken_number basis of the family-account card', () => {
  test('operatorClosedCard is true only for a card a person closed (resolution_source human)', async () => {
    const rows = [];
    const db2 = () => {
      const b = { where: () => b, whereIn: () => b, first: async () => rows.shift() || null };
      return b;
    };
    rows.push({ id: 'closed' });
    await expect(familyLink.operatorClosedCard(db2, 'cb-1')).resolves.toBe(true);
    await expect(familyLink.operatorClosedCard(db2, 'cb-1')).resolves.toBe(false);
  });

  // customers: one result array per customers query, in call order. One match = the voicemail-number
  // lookup, then the pass's normal lookup on the contact number (its name query and its phone query;
  // empty = nobody there). A NEW card runs the match twice (suggestFamilyAccounts re-checks it).
  const matchQueue = (owner = customer()) => [[owner], [], []];
  function cardTrx({ customers = [[]], voicemailRow = voicemail(), openCard = null, failInsert = false } = {}) {
    const inserted = [];
    const updates = [];
    const queue = [...customers];
    const trx = jest.fn((table) => {
      const builder = {
        where: () => builder,
        whereNot: () => builder,
        whereNull: () => builder,
        whereIn: () => builder,
        whereRaw: () => builder,
        orderBy: () => builder,
        orderByRaw: () => builder,
        orWhereRaw: () => builder,
        count: () => builder,
        select: () => builder,
        limit: () => builder,
        forUpdate: () => builder,
        modify: () => builder,
        insert: (row) => {
          if (failInsert) throw Object.assign(new Error('write failed'), { code: 'XX000' });
          inserted.push(row);
          return builder;
        },
        onConflict: () => builder,
        merge: () => builder,
        update: (patch) => { updates.push({ table, patch }); return Promise.resolve(1); },
        first: () => Promise.resolve(table === 'call_log' ? voicemailRow : (table === 'triage_items' ? openCard : null)),
        then: (resolve, reject) => Promise.resolve(table === 'customers' ? (queue.shift() || []) : []).then(resolve, reject),
      };
      return builder;
    });
    trx.raw = (sql) => sql;
    const conn = { transaction: async (fn) => fn(trx) };
    return { conn, trx, inserted, updates };
  }
  const args = (conn, over = {}) => ({
    call: callbackCall({ id: 'cb-7' }), extracted: extractedJordan, v2CanonicalExtraction: null, statedAddress: null, phone: DIALED, isOutbound: true, conn, ...over,
  });

  test('files ONE advisory family-account card that names the account, the number said and the number dialed', async () => {
    const { conn, inserted } = cardTrx({ customers: [...matchQueue(), ...matchQueue()] });
    const out = await familyLink.fileFamilyAccountCard(args(conn));
    expect(out).toMatchObject({ basis: 'callback_spoken_number' });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ call_log_id: 'cb-7', reason_code: 'family_account_candidates', severity: 'advisory', category: 'customer_field_conflict' });
    const payload = JSON.parse(inserted[0].payload);
    expect(payload).toMatchObject({
      match_basis: 'callback_spoken_number',
      caller_name: 'Jordan Rivers',
      caller_phone: null,
      caller_callback_phone: DIALED,
      matched_contact_phones: [SPOKEN],
      customer_ids: ['cust-1'],
    });
    expect(payload.holder_candidates).toEqual([expect.objectContaining({ id: 'cust-1', name: 'Jordan Rivers', matched_phone: SPOKEN })]);
    expect(payload.reason).toBe(familyLink.OWN_ACCOUNT_REASONS.callback_spoken_number);
  });

  test('gate off: no suggestion and no card', async () => {
    delete process.env.GATE_CALLBACK_SPOKEN_NUMBER_LINK;
    const { conn, inserted } = cardTrx({ customers: [[customer()], []] });
    expect(await familyLink.fileFamilyAccountCard(args(conn))).toBeNull();
    expect(inserted).toHaveLength(0);
  });

  test('an ordinary inbound call (not an admin callback) never takes the new basis', async () => {
    const { conn, inserted } = cardTrx({ customers: [[customer()], []] });
    const out = await familyLink.fileFamilyAccountCard(args(conn, { call: callbackCall({ direction: 'inbound', source: 'twilio-voice' }), isOutbound: false }));
    expect(out).toBeNull();
    expect(inserted).toHaveLength(0);
  });

  test('two accounts with the first name on the number: no suggestion', async () => {
    const { conn, inserted } = cardTrx({ customers: [[customer(), customer({ id: 'cust-2', last_name: 'Rivers-Hale' })]] });
    expect(await familyLink.fileFamilyAccountCard(args(conn))).toBeNull();
    expect(inserted).toHaveLength(0);
  });

  test('the card shows the number the office dialed, even when the resolved contact phone is the spoken number', async () => {
    const { conn, inserted } = cardTrx({ customers: [...matchQueue(), ...matchQueue()] });
    await familyLink.fileFamilyAccountCard(args(conn, { phone: SPOKEN }));
    expect(JSON.parse(inserted[0].payload).caller_callback_phone).toBe(DIALED);
  });

  test('the dialed number already links a customer through the normal lookup: no new card', async () => {
    const { conn, inserted } = cardTrx({ customers: [[customer()], [customer({ id: 'cust-9', first_name: 'Jordan', phone: DIALED })]] });
    expect(await familyLink.fileFamilyAccountCard(args(conn))).toBeNull();
    expect(inserted).toHaveLength(0);
  });

  test('reprocess after the dialed number linked normally: the OPEN card is retired, not refreshed', async () => {
    const { conn, inserted, updates } = cardTrx({
      customers: [[customer()], [customer({ id: 'cust-9', first_name: 'Jordan', phone: DIALED })]],
      openCard: { id: 'card-1' },
    });
    expect(await familyLink.fileFamilyAccountCard(args(conn))).toBeNull();
    expect(inserted).toHaveLength(0);
    expect(updates).toEqual([expect.objectContaining({ table: 'triage_items', patch: expect.objectContaining({ status: 'dismissed', resolution_source: 'auto', resolution_rule: familyLink.RETIRE_RULE }) })]);
  });

  test('reprocess with the match still standing: the open card is refreshed and kept', async () => {
    const { conn, inserted, updates } = cardTrx({ customers: [[customer()], []], openCard: { id: 'card-1' } });
    expect(await familyLink.fileFamilyAccountCard(args(conn))).toMatchObject({ basis: 'callback_spoken_number' });
    expect(inserted).toHaveLength(1);
    expect(updates).toEqual([]);
  });

  test('a failed card write is swallowed (the pass decides not to mint a customer from the read-only match, not from the card)', async () => {
    const { conn, inserted } = cardTrx({ customers: [...matchQueue(), ...matchQueue()], failInsert: true });
    await expect(familyLink.fileFamilyAccountCard(args(conn))).resolves.toBeNull();
    expect(inserted).toHaveLength(0);
  });

  describe('the dialed number resolves only through address disambiguation', () => {
    const lookupOpts = {
      callAddress: { address_line1: '1 Test St', address_line2: null, city: 'Testville', zip: '34200' },
      avDecisive: true,
    };
    let spy;
    beforeEach(() => {
      // Links a customer only when the lookup is given the same address inputs Step 3 builds.
      spy = jest.spyOn(CallRecordingProcessor, 'findCustomerForCallContact').mockImplementation(async (phone, extracted, opts = {}) => (
        opts.avDecisive === true && opts.callAddress?.address_line1 === '1 Test St' ? customer({ id: 'cust-addr', phone: DIALED }) : null
      ));
    });
    afterEach(() => spy.mockRestore());

    test('with the pass inputs the recheck links the dialed number: no new card', async () => {
      const { conn, inserted } = cardTrx({ customers: [...matchQueue(), ...matchQueue()] });
      expect(await familyLink.fileFamilyAccountCard(args(conn, { contactLookupOpts: lookupOpts }))).toBeNull();
      expect(inserted).toHaveLength(0);
      expect(spy.mock.calls[0][2]).toMatchObject(lookupOpts);
    });

    test('with the pass inputs an OPEN card is retired, not refreshed', async () => {
      const { conn, inserted, updates } = cardTrx({ customers: [...matchQueue()], openCard: { id: 'card-1' } });
      expect(await familyLink.fileFamilyAccountCard(args(conn, { contactLookupOpts: lookupOpts }))).toBeNull();
      expect(inserted).toHaveLength(0);
      expect(updates).toEqual([expect.objectContaining({ patch: expect.objectContaining({ status: 'dismissed', resolution_rule: familyLink.RETIRE_RULE }) })]);
    });

    test('without those inputs the same lookup finds nobody (the gap this closes)', async () => {
      const { trx } = cardTrx({ customers: [...matchQueue()] });
      expect(await familyLink.matchCallbackSpokenNumberAccount({ call: callbackCall(), extracted: extractedJordan, phone: DIALED, conn: trx })).toMatchObject({ basis: 'callback_spoken_number' });
    });
  });

  test('the processor builds the lookup inputs once and shares them with the card and Step 3', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../services/call-recording-processor.js'), 'utf8');
    expect(src.match(/const contactLookupOpts = \{/g)).toHaveLength(1);
    expect(src).toMatch(/fileFamilyAccountCard\(\{[^}]*contactLookupOpts,?\s*\}\)/);
    expect(src).toMatch(/const existing = await findCustomerForCallContact\(phone, extracted, \{\s*multiMatchOut: sharedPhoneAmbiguity,\s*\.\.\.contactLookupOpts,\s*\}\);/);
  });

  test('an operator link override on the call: no suggestion', async () => {
    const { conn } = cardTrx({ customers: [[customer()], []] });
    const call = callbackCall({ metadata: { relatedCallId: PARENT_ID, customer_link_override: { customer_id: null } } });
    expect(await familyLink.matchCallbackSpokenNumberAccount({ call, extracted: extractedJordan, conn })).toBeNull();
  });
});

// processRecording cannot run end to end in a test: pin the wiring. The suggestion never becomes the
// call's customer, never reaches a backfill, and the pass mints no customer around it.
describe('Step 3 keeps a spoken-number match suggest-only', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../services/call-recording-processor.js'), 'utf8');
  const start = src.indexOf('} else if (spokenNumberSuggested) {');
  const end = src.indexOf('} else if ((extracted.first_name || firstNameAdvisoryCreate)', start);
  const branch = src.slice(start, end);

  test('the branch sits before customer creation and writes nothing', () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(branch).not.toMatch(/customerId\s*=/);
    expect(branch).not.toMatch(/phoneMatchedThisPass/);
    expect(branch).not.toMatch(/backfillLinkedCustomerFromExtraction/);
    expect(branch).not.toMatch(/db\('(customers|triage_items)'\)/);
  });

  test('the flag is the read-only match, set only after the normal lookup found nobody, never the card write', () => {
    expect(src).not.toContain('familySuggestion');
    expect(src).toMatch(/let spokenNumberSuggested = false;/);
    const set = src.indexOf('spokenNumberSuggested = !!(await findCustomerViaCallbackSpokenNumber(');
    expect(set).toBeGreaterThan(0);
    // inside the Step 3 block, after the normal lookup and only with no customer and no ambiguity
    expect(set).toBeGreaterThan(src.indexOf('const existing = await findCustomerForCallContact(phone, extracted, {'));
    expect(src.slice(set - 120, set)).toContain('if (!existing && !sharedPhoneAmbiguity.candidates) {');
    expect(src).toMatch(/await require\('\.\/call-family-name-link'\)\.fileFamilyAccountCard\(/);
  });

  test('a card an operator closed by hand ends the suppression; a failed read keeps it', () => {
    const set = src.indexOf('spokenNumberSuggested = !!(await findCustomerViaCallbackSpokenNumber(');
    const tail = src.slice(set, set + 1400);
    expect(tail).toMatch(/operatorClosedCard\(db, call\.id\)\.catch\(\(\) => false\)\) \{\s*spokenNumberSuggested = false;/);
  });

  test('a deliberate customer-less result is not a customer_creation_failed, and the lead path stays unclaimed-only', () => {
    expect(src).toMatch(/const customerExpected = [^\n]*&& !spokenNumberSuggested\);/);
    expect(src).toContain('unclaimedOnly: !!(sharedPhoneAmbiguity.candidates || spokenNumberSuggested)');
  });

  test('no bespoke card type is left behind', () => {
    const routes = require('fs').readFileSync(require('path').join(__dirname, '../routes/admin-triage.js'), 'utf8');
    const gates = require('fs').readFileSync(require('path').join(__dirname, '../services/call-routing-gates.js'), 'utf8');
    for (const text of [src, routes, gates]) expect(text).not.toContain('callback_spoken_number_link');
  });
});
