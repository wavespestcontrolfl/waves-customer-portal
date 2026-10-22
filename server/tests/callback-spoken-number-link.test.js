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
const { findCustomerViaCallbackSpokenNumber } = CallRecordingProcessor._test;

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
    // The name fast path rejects the last-name mismatch; the single primary-phone owner still links.
    mockDb({ call_log: [voicemail({ ai_extraction: JSON.stringify({ phone: SPOKEN }) })], customers: [[customer()], [customer()]] });
    const out = await findCustomerViaCallbackSpokenNumber(callbackCall(), { first_name: 'Jordan', last_name: 'Reevas' });
    expect(out?.id).toBe('cust-1');
  });

  test('the number is only a secondary/slot phone on the customer: null', async () => {
    const slotOnly = customer({ phone: '+19415550177', secondary_phone: SPOKEN });
    mockDb({ call_log: [voicemail()], customers: [[slotOnly], [slotOnly], [slotOnly]] });
    expect(await findCustomerViaCallbackSpokenNumber(callbackCall(), extractedJordan)).toBeNull();
  });

  test('first name disagrees: null', async () => {
    mockDb({ call_log: [voicemail()], customers: [[customer({ first_name: 'Casey' })], [customer({ first_name: 'Casey' })]] });
    expect(await findCustomerViaCallbackSpokenNumber(callbackCall(), extractedJordan)).toBeNull();
  });

  test('the callback extraction has no first name: null (nothing to agree with)', async () => {
    mockDb({ call_log: [voicemail()], customers: [[customer()], [customer()]] });
    expect(await findCustomerViaCallbackSpokenNumber(callbackCall(), { last_name: 'Rivers' })).toBeNull();
    expect(tablesRead).toEqual([]);
  });

  test('no customer owns the spoken number: null', async () => {
    mockDb({ call_log: [voicemail()], customers: [[], []] });
    expect(await findCustomerViaCallbackSpokenNumber(callbackCall(), extractedJordan)).toBeNull();
  });
});
