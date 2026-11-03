// CI's DB-gated pass runs this against PostgreSQL: the current-customer quote text's claim
// (services/lead-auto-reply.js sendCurrentCustomerQuoteText, GATE_CURRENT_CUSTOMER_QUOTE_TEXT) as
// the database runs it: the per-phone advisory lock, the day check on the database clock, one row
// per attempt, and the settle that touches only that attempt's row. The fixture table lives in a
// unique schema dropped after the suite; the template render and the text send are mocked.
const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');
let mockConn;
jest.mock('../models/db', () => {
  const proxy = (...args) => mockConn(...args);
  proxy.raw = (...args) => mockConn.raw(...args);
  proxy.transaction = (...args) => mockConn.transaction(...args);
  return proxy;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({
  renderSmsTemplate: async (_key, vars) => `Hello ${vars.first_name}, Waves here. We got your quote request. Reply CALL and we'll call you shortly, or TEXT to handle it right here.`,
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
  normalizeRecipient: (phone) => phone,
  classifyDeliveryCertainty: (outcome) => (outcome?.deliveryOutcome === 'not_sent' ? 'not_sent' : 'unknown'),
}));

const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { sendCurrentCustomerQuoteText } = require('../services/lead-auto-reply');

const HOUR = 3600000;

jest.setTimeout(30000);
(SKIP ? describe.skip : describe)('current-customer quote text claim on PostgreSQL', () => {
  let database;
  const schema = `cc_quote_${randomUUID().replaceAll('-', '')}`;
  const TABLE = 'current_customer_quote_texts';

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 4 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    await database.raw('CREATE TABLE ??.?? AS SELECT * FROM public.?? WITH NO DATA', [schema, TABLE, TABLE]);
    // CREATE TABLE ... AS copies columns only: restore the defaults the claim relies on.
    await database.raw(`ALTER TABLE "${schema}".${TABLE} ALTER COLUMN id SET DEFAULT gen_random_uuid(), ALTER COLUMN claimed_at SET DEFAULT now()`);
    mockConn = database;
  });
  beforeEach(() => {
    jest.clearAllMocks();
    sendCustomerMessage.mockResolvedValue({ sent: true, providerMessageId: `SM${randomUUID().replaceAll('-', '')}` });
  });
  afterEach(async () => {
    await database.raw('TRUNCATE TABLE ??.??', [schema, TABLE]);
  });
  afterAll(async () => {
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await database.destroy();
  });

  const input = (phone, customerId = randomUUID()) => ({
    customer: { id: customerId, first_name: 'Maria' },
    phoneFormatted: phone,
    location: { id: 'loc-1' },
    leadSource: { source: 'website' },
  });
  const rows = (digits) => database(TABLE).where({ phone_digits: digits }).orderBy('claimed_at');

  test('two forms for one phone at the same moment send one text and leave one confirmed row', async () => {
    const results = await Promise.all([sendCurrentCustomerQuoteText(input('+19415550201')), sendCurrentCustomerQuoteText(input('+19415550201'))]);
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.reason === 'sent_today')).toHaveLength(1);
    const stored = await rows('9415550201');
    expect(stored).toHaveLength(1);
    expect(stored[0].twilio_sid).toMatch(/^SM/);
  });

  test('a delivered text over a day old allows the next one and stays on file untouched', async () => {
    const customerId = randomUUID();
    const earlier = { id: randomUUID(), phone_digits: '9415550202', customer_id: customerId, twilio_sid: 'SMearlier', claimed_at: new Date(Date.now() - 25 * HOUR) };
    await database(TABLE).insert(earlier);
    sendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, code: 'CONSENT_BLOCKED' });
    await sendCurrentCustomerQuoteText(input('+19415550202', customerId));
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    // The blocked attempt's own row is gone; the earlier delivery is the reply witness still.
    expect(await rows('9415550202')).toEqual([expect.objectContaining({ id: earlier.id, twilio_sid: 'SMearlier' })]);
  });

  test('a provable no-delivery frees the phone at once; an ambiguous outcome holds it for the day', async () => {
    sendCustomerMessage.mockResolvedValueOnce({ sent: false, blocked: true, code: 'CONSENT_BLOCKED' });
    await sendCurrentCustomerQuoteText(input('+19415550203'));
    expect(await rows('9415550203')).toHaveLength(0);

    sendCustomerMessage.mockResolvedValueOnce({ sent: false, retryable: true, code: 'ETIMEDOUT' });
    await sendCurrentCustomerQuoteText(input('+19415550203'));
    expect(await rows('9415550203')).toEqual([expect.objectContaining({ twilio_sid: null })]);

    await expect(sendCurrentCustomerQuoteText(input('+19415550203'))).resolves.toEqual({ sent: false, reason: 'sent_today' });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(2);
  });
});
