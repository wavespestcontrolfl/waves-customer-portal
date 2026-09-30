/**
 * payment.failed under GATE_BILLING_EMAIL_DETAILS (dark, owner-approved
 * 2026-09-29). The template already had Attempted, Payment method and Next
 * retry rows; the audit found the sender left all three blank on a pay-page
 * failure (no payments row yet).
 *
 * Contract:
 *   - gate OFF: the payload is exactly what it was (blank when there is no row)
 *   - gate ON: the card label comes from the payments row, then the saved
 *     method, then the failed PaymentIntent itself; the attempt date falls back
 *     to Stripe's event time; the retry date is ONLY one the dunning ladder
 *     armed (payments.next_retry_at) - never computed, blank when none exists
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(async () => ({ sent: true, message: { provider_message_id: 'sg-1', status: 'sent' } })),
}));
jest.mock('../services/customer-contact', () => ({
  getInvoiceEmailRecipients: jest.fn(() => [{ email: 'billing@example.com', name: 'Taylor Morgan', role: 'primary' }]),
}));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn() }));
jest.mock('../utils/customer-comms-lock', () => ({ withCustomerCommsLock: jest.fn() }));
let mockDetailsLive = false;
jest.mock('../config/feature-gates', () => ({
  isEnabled: () => false,
  gates: {},
  billingEmailDetailsLive: () => mockDetailsLive,
}));

const db = require('../models/db');
const EmailTemplates = require('../services/email-template-library');
const PaymentLifecycleEmail = require('../services/payment-lifecycle-email');

function chain({ first, result = [] } = {}) {
  const q = {};
  ['where', 'whereIn', 'whereNotNull', 'whereNotIn', 'whereNull', 'whereRaw', 'select', 'orderBy'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.insert = jest.fn(() => q);
  q.first = jest.fn(async () => first);
  q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  q.catch = (reject) => Promise.resolve(result).catch(reject);
  return q;
}

// Every table is a queue: each read takes the next entry (the last one repeats).
function mockQueues(queues) {
  const state = Object.fromEntries(Object.entries(queues).map(([k, v]) => [k, [...v]]));
  db.mockImplementation((table) => {
    const q = state[table];
    if (!q) throw new Error(`Unexpected db table ${table}`);
    return q.length > 1 ? q.shift() : q[0];
  });
}

const CUSTOMER = { id: 'cust-1', first_name: 'Taylor', last_name: 'Morgan', email: 'taylor@example.com', phone: '+19415550101' };
const INVOICE = { id: 'inv-1', customer_id: 'cust-1', invoice_number: 'INV-1001', title: 'Quarterly Pest Control', token: 'pay-token', total: '129.00' };
const PREFS = { email_enabled: true };

function lifecycle(extra = {}) {
  return {
    customers: [chain({ first: CUSTOMER })],
    notification_prefs: [chain({ first: PREFS })],
    customer_interactions: [chain()],
    ...extra,
  };
}

const failedIntent = (card = { brand: 'visa', last4: '4242' }) => ({
  id: 'pi_test',
  last_payment_error: { code: 'card_declined', payment_method: { type: 'card', card } },
});

const FAILED_AT = new Date('2026-09-29T15:30:00Z');

async function sendFailed(args = {}) {
  await PaymentLifecycleEmail.sendPaymentFailed({
    customerId: 'cust-1', paymentIntentId: 'pi_test', attemptId: 'ch_1', invoiceId: 'inv-1', ...args,
  });
  return EmailTemplates.sendTemplate.mock.calls.at(-1)[0].payload;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDetailsLive = false;
});

describe('pay-page failure with no payments row (the audited case)', () => {
  const queues = () => lifecycle({
    invoices: [chain({ first: INVOICE })],
    payments: [chain({ first: undefined })],
    notification_prefs: [chain({ first: PREFS })],
  });

  test('gate off: attempted, method and retry stay blank, exactly as before', async () => {
    mockQueues(queues());
    const payload = await sendFailed({ paymentIntent: failedIntent(), failedAt: FAILED_AT });
    expect(payload).toMatchObject({ failed_payment_date: '', retry_date: '', payment_method_label: '', invoice_number: 'INV-1001' });
  });

  test('gate on: the declined card and the attempt date appear; no retry is invented', async () => {
    mockDetailsLive = true;
    mockQueues(queues());
    const payload = await sendFailed({ paymentIntent: failedIntent(), failedAt: FAILED_AT });
    expect(payload.payment_method_label).toBe('Visa ending in 4242');
    expect(payload.failed_payment_date).toBe('September 29, 2026');
    // The ladder armed nothing for a pay-page failure: the row stays blank.
    expect(payload.retry_date).toBe('');
  });

  test('gate on: the brand reads the way the card does', async () => {
    mockDetailsLive = true;
    mockQueues(queues());
    const payload = await sendFailed({ paymentIntent: failedIntent({ brand: 'amex', last4: '1005' }), failedAt: FAILED_AT });
    expect(payload.payment_method_label).toBe('American Express ending in 1005');
  });

  test('gate on: a non-card failure or a card with no last four leaves the label blank', async () => {
    mockDetailsLive = true;
    mockQueues(queues());
    let payload = await sendFailed({
      paymentIntent: { last_payment_error: { payment_method: { type: 'us_bank_account' } } }, failedAt: FAILED_AT,
    });
    expect(payload.payment_method_label).toBe('');
    mockQueues(queues());
    payload = await sendFailed({ paymentIntent: failedIntent({ brand: 'visa' }), failedAt: FAILED_AT });
    expect(payload.payment_method_label).toBe('');
  });

  test('gate on with nothing extra passed: still today\'s payload, no throw', async () => {
    mockDetailsLive = true;
    mockQueues(queues());
    const payload = await sendFailed();
    expect(payload).toMatchObject({ failed_payment_date: '', retry_date: '', payment_method_label: '' });
  });

  test('gate on: a retry the ladder armed for THIS invoice is the retry date, read from the stored row', async () => {
    mockDetailsLive = true;
    const armed = new Date(Date.now() + 2 * 86400000);
    mockQueues(lifecycle({
      invoices: [chain({ first: INVOICE })],
      // First read: the PI lookup (none). Second: the armed-retry lookup.
      payments: [chain({ first: undefined }), chain({ first: { next_retry_at: armed } })],
    }));
    const payload = await sendFailed({ paymentIntent: failedIntent(), failedAt: FAILED_AT });
    expect(payload.retry_date).toBe(require('../utils/date-only').formatDisplayDate(armed, { fallback: '' }));
    expect(payload.retry_date).not.toBe('');
  });
});

describe('failure with a payments row', () => {
  const row = (overrides = {}) => ({
    id: 'pay-1', customer_id: 'cust-1', payment_method_id: 'pm-1', amount: '129.00',
    payment_date: '2026-09-28', next_retry_at: '2026-10-01', stripe_payment_intent_id: 'pi_test', ...overrides,
  });

  test('gate off and on agree when the row already carries everything (the dates are the row\'s own, never the event time)', async () => {
    const pm = { id: 'pm-1', method_type: 'card', card_brand: 'Visa', last_four: '4242' };
    const build = () => lifecycle({
      invoices: [chain({ first: INVOICE })],
      payments: [chain({ first: row({ card_brand: 'Visa', card_last_four: '4242' }) })],
      payment_methods: [chain({ first: pm })],
    });
    mockQueues(build());
    const off = await sendFailed({ paymentIntent: failedIntent(), failedAt: FAILED_AT });
    mockDetailsLive = true;
    mockQueues(build());
    const on = await sendFailed({ paymentIntent: failedIntent(), failedAt: FAILED_AT });
    expect(on).toEqual(off);
    expect(on).toMatchObject({ failed_payment_date: 'September 28, 2026', retry_date: 'October 1, 2026', payment_method_label: 'Visa ending in 4242' });
  });

  test('gate on: a row with no card snapshot names the saved method it points at', async () => {
    mockDetailsLive = true;
    mockQueues(lifecycle({
      invoices: [chain({ first: INVOICE })],
      payments: [chain({ first: row({ next_retry_at: null }) })],
      payment_methods: [chain({ first: { id: 'pm-1', method_type: 'card', card_brand: 'Mastercard', last_four: '4444' } })],
    }));
    const payload = await sendFailed({ paymentIntent: failedIntent({ brand: 'visa', last4: '9999' }), failedAt: FAILED_AT });
    expect(payload.payment_method_label).toBe('Mastercard ending in 4444');
  });
});
