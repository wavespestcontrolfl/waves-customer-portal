// GATE_CALLBACK_SPOKEN_NUMBER_LINK: an office callback dials the voicemail's
// caller ID, but the caller spoke another number to ring back, and that number
// may already be a customer's PRIMARY phone (a quote form filed minutes after
// the voicemail). findCustomerViaCallbackSpokenNumber is the second chance the
// call pass takes only when the dialed number found no customer.
//
// Fixtures are fictitious: 555-01xx numbers, synthetic names and ids.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/twilio-numbers', () => ({
  isInternalNumber: jest.fn(() => false),
  isOwnedNumber: jest.fn(() => false),
  findByNumber: jest.fn(() => null),
  getLeadSourceFromNumber: jest.fn(() => ({ source: 'phone_call' })),
}));

const db = require('../models/db');
const CallRecordingProcessor = require('../services/call-recording-processor');
const { findCustomerViaCallbackSpokenNumber, fileCallbackSpokenNumberCard } = CallRecordingProcessor._test;

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

// The pass keeps the call customer-less and files one suggest-only card (Codex #6419 r2): the
// voicemail number is typed out by whoever left the message, so it proves nothing about the person
// who answered the callback.
describe('fileCallbackSpokenNumberCard', () => {
  function captureInsert() {
    const inserted = [];
    const chain = {
      insert: (row) => { inserted.push(row); return chain; },
      onConflict: () => chain,
      ignore: () => chain,
      catch: () => Promise.resolve(),
    };
    const conn = Object.assign(jest.fn(() => chain), { raw: (sql) => sql });
    return { conn, inserted };
  }

  test('files one blocking customer-field card that names the candidate, both numbers and the extracted name', async () => {
    const { conn, inserted } = captureInsert();
    await fileCallbackSpokenNumberCard({
      call: callbackCall({ id: 'cb-9' }), extracted: extractedJordan, candidate: customer(), conn,
    });
    expect(conn).toHaveBeenCalledWith('triage_items');
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      call_log_id: 'cb-9', reason_code: 'callback_spoken_number_link', category: 'customer_field_conflict', severity: 'blocking', status: 'open',
    });
    expect(JSON.parse(inserted[0].payload)).toMatchObject({
      flag: 'callback_spoken_number_link',
      link_candidate: { id: 'cust-1', name: 'Jordan Rivers' },
      spoken_number: SPOKEN,
      dialed_number: DIALED,
      extracted_name: 'Jordan Rivers',
    });
  });
});

// The Step 3 branch cannot run without a database, so pin its shape: the suggestion never becomes
// the call's customer, never reaches a backfill, and the pass does not mint a customer around it.
describe('Step 3 keeps a spoken-number match suggest-only', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../services/call-recording-processor.js'), 'utf8');
  const start = src.indexOf('} else if (spokenNumberCandidate) {');
  const end = src.indexOf('} else if ((extracted.first_name || firstNameAdvisoryCreate)', start);
  const branch = src.slice(start, end);

  test('the branch exists, files the card and sits before customer creation', () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(branch).toContain('fileCallbackSpokenNumberCard');
  });

  test('no link, phone-match mark, backfill or customer write from the suggestion', () => {
    expect(branch).not.toMatch(/customerId\s*=/);
    expect(branch).not.toMatch(/phoneMatchedThisPass/);
    expect(branch).not.toMatch(/backfillLinkedCustomerFromExtraction/);
    expect(branch).not.toMatch(/db\('customers'\)/);
    // The only assignment of the candidate is from the gated helper.
    expect(src.match(/spokenNumberCandidate = /g)).toHaveLength(2);
    expect(src).not.toMatch(/existing = await findCustomerViaCallbackSpokenNumber/);
  });

  test('the lead path treats the suggestion as an unclaimed-only phone', () => {
    expect(src).toContain('unclaimedOnly: !!(sharedPhoneAmbiguity.candidates || spokenNumberCandidate)');
  });
});

describe('triage route keeps the suggestion out of call verdicts', () => {
  const route = require('fs').readFileSync(require('path').join(__dirname, '../routes/admin-triage.js'), 'utf8');

  test('a verdict on the card is refused with an instruction, and a sibling verdict does not sweep it', () => {
    expect(route).toMatch(/NOT_A_VERDICT_MESSAGES = \{[\s\S]*callback_spoken_number_link:/);
    expect(route).toMatch(/\.whereNotIn\('reason_code', \[[\s\S]*'callback_spoken_number_link'[\s\S]*\]\)/);
  });
});
