// B18 backstop: sendCustomerMessage - the one point every text passes through, immediate or replayed -
// refuses a customer/lead SMS about an estimate when its DESTINATION is the number a contradicted accept
// disputed for that estimate. Per-route checks give operators a better message; this is the net under them.

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { CONTRADICTED_PHONE_NOTE_MARK } = require('../services/estimate-phone-quarantine');

const STAMP = { key: '9415550123', rejectedCustomerId: 'cust-bob' };
let estimates;
let customer;
let readFails;

beforeEach(() => {
  jest.clearAllMocks();
  readFails = false;
  customer = { id: 'cust-1', phone: '', internal_notes: null };
  estimates = { 'est-1': { id: 'est-1', customer_id: null, customer_phone: '(941) 555-0123', estimate_data: { acceptPhoneDispute: STAMP } } };
  db.mockImplementation((table) => {
    const q = { _id: null };
    q.where = jest.fn((w) => { q._id = w?.id ?? null; return q; });
    q.first = jest.fn(async () => {
      if (readFails) throw new Error('db down');
      if (table === 'estimates') return estimates[q._id] || null;
      if (table === 'customers') return customer;
      return null;
    });
    return q;
  });
});

const send = (over = {}) => sendCustomerMessage({
  to: '+19415550123', body: 'Your estimate: https://example.test/e/1', channel: 'sms', audience: 'lead',
  purpose: 'estimate_followup', estimateId: 'est-1', entryPoint: 'estimate_follow_up_cron', identityTrustLevel: 'phone_provided_unverified',
  ...over,
});
const wasQuarantined = (res) => res?.code === 'ESTIMATE_PHONE_QUARANTINED';

test('a text about a stamped estimate to the disputed number is blocked (not retryable), in any phone format', async () => {
  for (const to of ['+19415550123', '(941) 555-0123', '1-941-555-0123']) {
    const res = await send({ to });
    expect(res).toMatchObject({ sent: false, blocked: true, code: 'ESTIMATE_PHONE_QUARANTINED', retryable: false, deliveryOutcome: 'not_sent' });
  }
});

test('destination-side: a replay queued to the disputed number is blocked even after the estimate\'s phone was corrected; a text to another number is not', async () => {
  estimates['est-1'].customer_phone = '(941) 555-0188';
  expect(wasQuarantined(await send({ to: '+19415550123' }))).toBe(true);
  // +44 number with the same ten-digit suffix is a different phone.
  const other = await send({ to: '+449415550123' }).catch(() => null);
  expect(wasQuarantined(other)).toBe(false);
});

test('estimateIds (a grouped send) are all checked', async () => {
  estimates['est-2'] = { id: 'est-2', customer_id: null, customer_phone: '(941) 555-0123', estimate_data: {} };
  expect(wasQuarantined(await send({ estimateId: 'est-2', estimateIds: ['est-1'] }))).toBe(true);
});

test('the customer marker path: the estimate\'s own phone, not the profile\'s, is blocked; the profile\'s real number is not', async () => {
  estimates['est-1'] = { id: 'est-1', customer_id: 'cust-1', customer_phone: '(941) 555-0123', estimate_data: {} };
  customer = { id: 'cust-1', phone: '(941) 555-0188', internal_notes: `Phone ${CONTRADICTED_PHONE_NOTE_MARK}.` };
  expect(wasQuarantined(await send({ audience: 'customer', customerId: 'cust-1', to: '+19415550123' }))).toBe(true);
  expect(wasQuarantined(await send({ audience: 'customer', customerId: 'cust-1', to: '+19415550188' }).catch(() => null))).toBe(false);
});

test('out of scope: no estimate on the send, an internal audience, a non-SMS channel, and an unstamped estimate are never blocked here', async () => {
  const noEstimate = await send({ estimateId: undefined }).catch(() => null);
  expect(wasQuarantined(noEstimate)).toBe(false);
  expect(wasQuarantined(await send({ audience: 'internal' }).catch(() => null))).toBe(false);
  expect(wasQuarantined(await send({ channel: 'email' }).catch(() => null))).toBe(false);
  estimates['est-1'].estimate_data = {};
  expect(wasQuarantined(await send().catch(() => null))).toBe(false);
});

test('a failed estimate read FAILS CLOSED (the text is held, nothing sent)', async () => {
  readFails = true;
  expect(wasQuarantined(await send())).toBe(true);
});
