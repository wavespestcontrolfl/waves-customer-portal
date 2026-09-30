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

const CUSTOMER = { id: 'cust-1', first_name: 'Taylor', last_name: 'Morgan', email: 'taylor@example.com', phone: '+19415550101', stripe_customer_id: 'cus_stripe_1' };
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

// The failed intent's card is shown only when the intent's Stripe customer AND
// the emailed customer's stripe_customer_id are known and equal (round 9).
const STRIPE_ID = 'cus_stripe_1';
const failedIntent = (card = { brand: 'visa', last4: '4242' }) => ({
  id: 'pi_test',
  customer: STRIPE_ID,
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

  test('gate on: a saved-method lookup that throws leaves the label blank instead of failing the webhook', async () => {
    mockDetailsLive = true;
    mockQueues(lifecycle({
      invoices: [chain({ first: INVOICE })],
      payments: [chain({ first: row({ next_retry_at: null }) })],
      payment_methods: [(() => { const q = chain(); q.first = jest.fn(async () => { throw new Error('db blip'); }); return q; })()],
    }));
    const payload = await sendFailed({ failedAt: FAILED_AT });
    expect(payload.payment_method_label).toBe('');
    expect(payload.failed_payment_date).toBe('September 28, 2026');
  });

  test('round 5: the saved-method lookup carries the payment\'s customer id', async () => {
    mockDetailsLive = true;
    const pmChain = chain({ first: { id: 'pm-1', method_type: 'card', card_brand: 'Mastercard', last_four: '4444' } });
    mockQueues(lifecycle({
      invoices: [chain({ first: INVOICE })],
      payments: [chain({ first: row({ next_retry_at: null }) })],
      payment_methods: [pmChain],
    }));
    await sendFailed({ failedAt: FAILED_AT });
    expect(pmChain.where).toHaveBeenCalledWith({ id: 'pm-1', customer_id: 'cust-1' });
  });

  test('round 5: a payment that belongs to ANOTHER customer never names its saved method', async () => {
    mockDetailsLive = true;
    const pmChain = chain({ first: { id: 'pm-1', method_type: 'card', card_brand: 'Mastercard', last_four: '4444' } });
    mockQueues(lifecycle({
      invoices: [chain({ first: INVOICE })],
      payments: [chain({ first: row({ customer_id: 'someone-else', next_retry_at: null }) })],
      payment_methods: [pmChain],
    }));
    const payload = await sendFailed({ failedAt: FAILED_AT });
    expect(pmChain.first).not.toHaveBeenCalled();
    expect(payload.payment_method_label).toBe('');
  });

  test('round 5: a method the database says is not this customer\'s (no row back) leaves the label blank', async () => {
    mockDetailsLive = true;
    mockQueues(lifecycle({
      invoices: [chain({ first: INVOICE })],
      payments: [chain({ first: row({ next_retry_at: null }) })],
      payment_methods: [chain({ first: undefined })],
    }));
    const payload = await sendFailed({ failedAt: FAILED_AT });
    expect(payload.payment_method_label).toBe('');
  });
});

// Round 8: ANY card label (payment snapshot, saved method, failed intent) is
// shown only when payment, invoice and intent all agree with the emailed customer.
describe('round 8: the card label needs payment / invoice / intent ownership to agree', () => {
  const owned = (over = {}) => ({
    id: 'pay-1', customer_id: 'cust-1', payment_method_id: null, amount: '129.00',
    payment_date: '2026-09-28', next_retry_at: null, stripe_payment_intent_id: 'pi_test', ...over,
  });
  const intent = (customer) => ({ ...failedIntent(), customer });
  const build = ({ invoice = INVOICE, payment, customer = CUSTOMER } = {}) => lifecycle({
    customers: [chain({ first: customer })],
    invoices: [chain({ first: invoice })],
    payments: [chain({ first: payment })],
    payment_methods: [chain({ first: undefined })],
  });

  test('a payment row of ANOTHER customer never falls through to the intent\'s card', async () => {
    mockDetailsLive = true;
    mockQueues(build({ payment: owned({ customer_id: 'someone-else' }) }));
    const payload = await sendFailed({ paymentIntent: failedIntent(), failedAt: FAILED_AT });
    expect(payload.payment_method_label).toBe('');
  });

  test('an invoice of ANOTHER customer never shows the intent\'s card', async () => {
    mockDetailsLive = true;
    mockQueues(build({ invoice: { ...INVOICE, customer_id: 'someone-else' }, payment: undefined }));
    const payload = await sendFailed({ paymentIntent: failedIntent(), failedAt: FAILED_AT });
    expect(payload.payment_method_label).toBe('');
  });

  test('a payment snapshot on another customer\'s row is blanked too', async () => {
    mockDetailsLive = true;
    mockQueues(build({ payment: owned({ customer_id: 'someone-else', card_brand: 'Visa', card_last_four: '1111' }) }));
    const payload = await sendFailed({ failedAt: FAILED_AT });
    expect(payload.payment_method_label).toBe('');
  });

  test('an intent whose Stripe customer is not this customer\'s Stripe customer is blank', async () => {
    mockDetailsLive = true;
    mockQueues(build({ payment: undefined, customer: { ...CUSTOMER, stripe_customer_id: 'cus_mine' } }));
    const payload = await sendFailed({ paymentIntent: intent('cus_other'), failedAt: FAILED_AT });
    expect(payload.payment_method_label).toBe('');
  });

  test('an intent whose Stripe customer matches shows the card (string or expanded object)', async () => {
    mockDetailsLive = true;
    mockQueues(build({ payment: undefined, customer: { ...CUSTOMER, stripe_customer_id: 'cus_mine' } }));
    expect((await sendFailed({ paymentIntent: intent('cus_mine'), failedAt: FAILED_AT })).payment_method_label).toBe('Visa ending in 4242');
    mockQueues(build({ payment: undefined, customer: { ...CUSTOMER, stripe_customer_id: 'cus_mine' } }));
    expect((await sendFailed({ paymentIntent: intent({ id: 'cus_mine' }), failedAt: FAILED_AT })).payment_method_label).toBe('Visa ending in 4242');
  });

  // Round 9 FAIL CLOSED: the intent's card is shown only when BOTH Stripe
  // customer ids are known and equal. Unknown on either side is "cannot confirm".
  test('a customer with NO stripe_customer_id never shows the intent\'s card', async () => {
    mockDetailsLive = true;
    for (const stripeId of [null, undefined, '']) {
      mockQueues(build({ payment: undefined, customer: { ...CUSTOMER, stripe_customer_id: stripeId } }));
      expect((await sendFailed({ paymentIntent: intent('cus_other'), failedAt: FAILED_AT })).payment_method_label).toBe('');
    }
  });

  test('an intent with NO customer never shows its card, even when the customer has a Stripe id', async () => {
    mockDetailsLive = true;
    mockQueues(build({ payment: undefined, customer: { ...CUSTOMER, stripe_customer_id: 'cus_mine' } }));
    expect((await sendFailed({ paymentIntent: intent(undefined), failedAt: FAILED_AT })).payment_method_label).toBe('');
    mockQueues(build({ payment: undefined, customer: { ...CUSTOMER, stripe_customer_id: 'cus_mine' } }));
    expect((await sendFailed({ paymentIntent: intent(null), failedAt: FAILED_AT })).payment_method_label).toBe('');
  });

  test('a failed Stripe-customer lookup blanks the intent\'s card', async () => {
    mockDetailsLive = true;
    const boom = chain(); boom.first = jest.fn(async () => { throw new Error('db blip'); });
    mockQueues(build({ payment: undefined, customer: { ...CUSTOMER, stripe_customer_id: 'cus_mine' } }));
    // The ownership check reads customers first; only that read blips.
    db.mockImplementation(((impl) => {
      let customerReads = 0;
      return (table) => (table === 'customers' && ++customerReads === 1 ? boom : impl(table));
    })(db.getMockImplementation()));
    expect((await sendFailed({ paymentIntent: intent('cus_mine'), failedAt: FAILED_AT })).payment_method_label).toBe('');
  });

  test('a payments-row snapshot owned by the customer needs no Stripe ids', async () => {
    mockDetailsLive = true;
    mockQueues(build({
      payment: owned({ card_brand: 'Visa', card_last_four: '1111' }),
      customer: { ...CUSTOMER, stripe_customer_id: null },
    }));
    expect((await sendFailed({ paymentIntent: intent(undefined), failedAt: FAILED_AT })).payment_method_label).toBe('Visa ending in 1111');
  });

  test('a saved method owned by the customer needs no Stripe ids', async () => {
    mockDetailsLive = true;
    mockQueues(lifecycle({
      customers: [chain({ first: { ...CUSTOMER, stripe_customer_id: null } })],
      invoices: [chain({ first: INVOICE })],
      payments: [chain({ first: owned({ payment_method_id: 'pm-1' }) })],
      payment_methods: [chain({ first: { id: 'pm-1', method_type: 'card', card_brand: 'Mastercard', last_four: '4444' } })],
    }));
    expect((await sendFailed({ paymentIntent: intent(undefined), failedAt: FAILED_AT })).payment_method_label).toBe('Mastercard ending in 4444');
  });

  test('known Stripe ids that differ blank even an owned snapshot', async () => {
    mockDetailsLive = true;
    mockQueues(build({
      payment: owned({ card_brand: 'Visa', card_last_four: '1111' }),
      customer: { ...CUSTOMER, stripe_customer_id: 'cus_mine' },
    }));
    expect((await sendFailed({ paymentIntent: intent('cus_someone_else'), failedAt: FAILED_AT })).payment_method_label).toBe('');
    mockQueues(build({
      payment: owned({ card_brand: 'Visa', card_last_four: '1111' }),
      customer: { ...CUSTOMER, stripe_customer_id: 'cus_mine' },
    }));
    expect((await sendFailed({ paymentIntent: intent('cus_mine'), failedAt: FAILED_AT })).payment_method_label).toBe('Visa ending in 1111');
  });

  test('gate off: the payload is untouched by the ownership check', async () => {
    mockDetailsLive = false;
    mockQueues(build({ payment: owned({ customer_id: 'someone-else', card_brand: 'Visa', card_last_four: '1111' }) }));
    const payload = await sendFailed({ paymentIntent: failedIntent(), failedAt: FAILED_AT });
    expect(payload.payment_method_label).toBe('Visa ending in 1111');
  });
});
