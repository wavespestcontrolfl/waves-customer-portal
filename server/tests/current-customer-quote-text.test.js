/**
 * services/lead-auto-reply.js sendCurrentCustomerQuoteText
 * (GATE_CURRENT_CUSTOMER_QUOTE_TEXT, owner 2026-11-02 "text and bell"): a
 * current or past customer who sends the quote form gets the lead text's CALL
 * or TEXT offer from its own template, at most once a day per phone. Each
 * attempt claims its own current_customer_quote_texts row under a per-phone
 * advisory lock, only when no row for the phone is under a day old, before the
 * send; the real SID confirms that row, a provable no-delivery deletes it, an
 * ambiguous outcome keeps it. An earlier delivered row is never touched.
 * Synthetic db, template and sender; all names are synthetic.
 */
const mockSend = jest.fn();
const mockRender = jest.fn();
const mockState = { recent: null, locks: [], inserted: [], writes: [], recentFilters: [] };

jest.mock('../models/db', () => {
  const chain = (table, { inTrx = false } = {}) => {
    const c = { filters: [] };
    c.where = (...a) => { c.filters.push(['where', ...a]); return c; };
    c.whereNull = (...a) => { c.filters.push(['whereNull', ...a]); return c; };
    c.whereRaw = (...a) => { c.filters.push(['whereRaw', ...a]); return c; };
    c.first = async () => { mockState.recentFilters.push(c.filters); return mockState.recent; };
    c.insert = (row) => {
      mockState.inserted.push({ table, row, inTrx });
      return { returning: async () => [{ id: 'claim-1' }] };
    };
    c.update = async (patch) => { mockState.writes.push({ table, op: 'update', patch, filters: c.filters }); return 1; };
    c.del = async () => { mockState.writes.push({ table, op: 'del', filters: c.filters }); return 1; };
    return c;
  };
  const db = jest.fn((table) => chain(table));
  db.transaction = async (fn) => {
    const trx = jest.fn((table) => chain(table, { inTrx: true }));
    trx.raw = async (sql, bindings) => { mockState.locks.push({ sql, bindings }); return {}; };
    return fn(trx);
  };
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: (...args) => mockRender(...args) }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: (...args) => mockSend(...args),
  normalizeRecipient: (phone) => phone,
  classifyDeliveryCertainty: (outcome) => (outcome?.deliveryOutcome === 'not_sent' ? 'not_sent' : 'unknown'),
}));

const { sendCurrentCustomerQuoteText } = require('../services/lead-auto-reply');

const offer = (name) => `Hello ${name}, Waves here. We got your quote request. Reply CALL and we'll call you shortly, or TEXT to handle it right here.`;
const args = (customer = {}) => ({
  customer: { id: 'cust-1', first_name: 'Maria', ...customer },
  phoneFormatted: '+19415550142',
  location: { id: 'loc-1' },
  leadSource: { source: 'website' },
});
// Every settle write names this attempt's row and nothing else.
const ownRow = [['where', { id: 'claim-1' }]];
const RELEASE = { table: 'current_customer_quote_texts', op: 'del', filters: [...ownRow, ['whereNull', 'twilio_sid']] };

beforeEach(() => {
  jest.clearAllMocks();
  Object.assign(mockState, { recent: null, locks: [], inserted: [], writes: [], recentFilters: [] });
  mockRender.mockImplementation(async (_key, vars) => offer(vars.first_name));
  mockSend.mockResolvedValue({ sent: true, providerMessageId: 'SM123' });
});

test('claims a row under the phone lock, sends the offer and stamps the real sid on that row', async () => {
  const out = await sendCurrentCustomerQuoteText(args());

  expect(out).toMatchObject({ sent: true });
  expect(mockRender).toHaveBeenCalledWith(
    'current_customer_quote_text',
    { first_name: 'Maria' },
    { workflow: 'current_customer_quote_text', entity_type: 'customer', entity_id: 'cust-1' },
    { noVariants: true },
  );
  expect(mockState.locks).toEqual([{ sql: 'SELECT pg_advisory_xact_lock(hashtext(?))', bindings: ['current_customer_quote_texts:9415550142'] }]);
  // The day check reads this phone's rows by the database clock, inside the lock.
  expect(mockState.recentFilters[0]).toEqual([
    ['where', { phone_digits: '9415550142' }],
    ['whereRaw', "claimed_at > now() - interval '24 hours'"],
  ]);
  expect(mockState.inserted).toEqual([{ table: 'current_customer_quote_texts', row: { phone_digits: '9415550142', customer_id: 'cust-1' }, inTrx: true }]);
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(mockSend.mock.calls[0][0]).toEqual({
    to: '+19415550142',
    body: offer('Maria'),
    channel: 'sms',
    audience: 'lead',
    purpose: 'conversational',
    customerId: 'cust-1',
    identityTrustLevel: 'phone_matches_customer',
    entryPoint: 'current_customer_quote_text',
    metadata: { original_message_type: 'auto_reply', customerLocationId: 'loc-1', lead_source: 'website', templateKey: 'current_customer_quote_text' },
  });
  // No STOP line: the recipient is a customer (docs/sms-stop-line-policy.md, test 2).
  expect(mockSend.mock.calls[0][0].body).not.toMatch(/STOP/);
  expect(mockState.writes).toEqual([{ table: 'current_customer_quote_texts', op: 'update', patch: { twilio_sid: 'SM123' }, filters: ownRow }]);
});

test('a row for this phone under a day old: no claim and nothing is sent', async () => {
  mockState.recent = { id: 'earlier' };
  await expect(sendCurrentCustomerQuoteText(args())).resolves.toEqual({ sent: false, reason: 'sent_today' });
  expect(mockState.inserted).toEqual([]);
  expect(mockSend).not.toHaveBeenCalled();
  expect(mockState.writes).toEqual([]);
});

test('a blocked send (STOP, landline, switch off) deletes only this attempt\'s row', async () => {
  mockSend.mockResolvedValue({ sent: false, blocked: true, code: 'CONSENT_BLOCKED' });
  await sendCurrentCustomerQuoteText(args());
  expect(mockState.writes).toEqual([RELEASE]);
});

test('an ambiguous provider outcome keeps the row (fail closed: the phone waits the day)', async () => {
  mockSend.mockResolvedValue({ sent: false, retryable: true, code: 'ETIMEDOUT' });
  await sendCurrentCustomerQuoteText(args());
  expect(mockState.writes).toEqual([]);
});

test('a refusal before dispatch deletes only this attempt\'s row and rethrows', async () => {
  mockSend.mockRejectedValue(Object.assign(new Error('refused'), { providerOutcome: { deliveryOutcome: 'not_sent' } }));
  await expect(sendCurrentCustomerQuoteText(args())).rejects.toThrow('refused');
  expect(mockState.writes).toEqual([RELEASE]);
});

test('a template that will not render claims nothing and sends nothing', async () => {
  mockRender.mockResolvedValue(null);
  await expect(sendCurrentCustomerQuoteText(args())).rejects.toThrow(/current_customer_quote_text/);
  expect(mockState.locks).toEqual([]);
  expect(mockSend).not.toHaveBeenCalled();
});

test('the name on the customer row greets them; a typed name is never an input', async () => {
  // A public form's typed "name" could be a link; the sender takes no name argument at all.
  await sendCurrentCustomerQuoteText({ ...args(), firstName: 'Billing: https://example.invalid/x' });
  expect(mockRender.mock.calls[0][1]).toEqual({ first_name: 'Maria' });
  expect(mockSend.mock.calls[0][0].body).toBe(offer('Maria'));
});

test('no first name on file: "there"', async () => {
  await sendCurrentCustomerQuoteText(args({ first_name: null }));
  expect(mockRender.mock.calls[0][1]).toEqual({ first_name: 'there' });
});

test('a name on file that would add a segment falls back to "there"', async () => {
  await sendCurrentCustomerQuoteText(args({ first_name: 'Maximiliana Bartholomew-Featherstonehaugh Constantinople' }));
  expect(mockRender).toHaveBeenCalledTimes(2);
  expect(mockSend.mock.calls[0][0].body).toBe(offer('there'));
});
