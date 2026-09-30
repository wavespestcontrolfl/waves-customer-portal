/**
 * billing.notice / billing.receipt_notice under GATE_BILLING_EMAIL_DETAILS
 * (dark, owner-approved 2026-09-29). The routed billing emails only ever
 * carried the SMS body; when the notice is about ONE invoice the template's
 * detail rows now get the property, the service, the service date and (on a
 * receipt) the tender behind the payment.
 *
 * Gate off: the payload is exactly today's, and nothing extra is read.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockLoadBillingEmailContext = jest.fn();
const mockDispatchUnderBillingEmailAuthority = jest.fn();
jest.mock('../services/billing-channel-email-authority', () => {
  const actual = jest.requireActual('../services/billing-channel-email-authority');
  return {
    ...actual,
    loadBillingEmailContext: (...args) => mockLoadBillingEmailContext(...args),
    dispatchUnderBillingEmailAuthority: (...args) => mockDispatchUnderBillingEmailAuthority(...args),
  };
});
const mockSendTemplate = jest.fn();
jest.mock('../services/email-template-library', () => ({
  sendTemplate: (...args) => mockSendTemplate(...args),
  redactEmailAddresses: (value) => value,
}));

const db = require('../models/db');
const { sendBillingChannelEmail } = require('../services/billing-channel-email');

function chain(rows) {
  const q = {};
  ['where', 'whereIn', 'whereRaw', 'orderBy', 'select', 'join'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.first = jest.fn(async () => (Array.isArray(rows) ? rows[0] : rows));
  q.then = (resolve, reject) => Promise.resolve(Array.isArray(rows) ? rows : []).then(resolve, reject);
  return q;
}

const CUSTOMER = {
  id: 'cust-1', first_name: 'Casey', address_line1: '100 Example Lane', city: 'Bradenton', state: 'FL', zip: '34205', profile_label: 'Primary',
};
const INVOICE = {
  id: 'inv-1', customer_id: 'cust-1', invoice_number: 'WPC-2026-0123', service_type: 'Quarterly Pest Control',
  service_date: '2026-09-29', payment_method: 'zelle', card_brand: null, card_last_four: null, status: 'paid',
};

function context(category, invoice = INVOICE) {
  return {
    category,
    categoryLabel: category === 'payment_receipt' ? 'Payment receipt' : 'Invoice update',
    customer: CUSTOMER,
    prefs: null,
    invoice,
    recipient: { email: 'casey@example.com', name: 'Casey', role: 'primary' },
    recipientEmail: 'casey@example.com',
  };
}

const send = async (category, invoice) => {
  mockLoadBillingEmailContext.mockResolvedValue(context(category, invoice));
  await sendBillingChannelEmail({
    body: 'Thanks - we received your payment.',
    customerId: 'cust-1',
    invoiceId: invoice === null ? undefined : 'inv-1',
    channel: 'email',
    metadata: { billingDeliveryCategory: category, notificationEventKey: `evt:${category}` },
  });
  return mockSendTemplate.mock.calls.at(-1)[0];
};

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.GATE_BILLING_EMAIL_DETAILS;
  db.mockImplementation((table) => {
    if (table === 'payments') return chain({ id: 'pay-1', payment_method_type: null, metadata: null });
    throw new Error(`Unexpected db table: ${table}`);
  });
  mockDispatchUnderBillingEmailAuthority.mockImplementation(async ({ dispatch, state }) => {
    state.handoffStarted = true;
    await dispatch();
    state.providerAccepted = true;
    return { ok: true };
  });
  mockSendTemplate.mockImplementation(async (opts) => {
    await opts.withProviderHandoff(async () => {});
    return { sent: true, message: { provider_message_id: 'p-1' } };
  });
});
afterEach(() => { delete process.env.GATE_BILLING_EMAIL_DETAILS; });

test('gate off: the routed receipt notice carries exactly today\'s four variables and reads nothing extra', async () => {
  const args = await send('payment_receipt', INVOICE);
  expect(args.templateKey).toBe('billing.receipt_notice');
  expect(Object.keys(args.payload).sort()).toEqual(['billing_url', 'category_label', 'first_name', 'notification_body']);
  expect(db).not.toHaveBeenCalled();
});

test('gate on: a receipt notice names the property, service, service date and the tender', async () => {
  process.env.GATE_BILLING_EMAIL_DETAILS = 'true';
  const args = await send('payment_receipt', INVOICE);
  expect(args.templateKey).toBe('billing.receipt_notice');
  expect(args.payload).toMatchObject({
    property_full_address: '100 Example Lane, Bradenton, FL 34205',
    service_label: 'Quarterly Pest Control',
    service_date: 'September 29, 2026',
    payment_method: 'Zelle',
    notification_body: 'Thanks - we received your payment.',
  });
  // The stable email key is unchanged by the gate.
  expect(args.idempotencyKey).toBe('billing_channel_email:evt:payment_receipt:email');
});

test('gate on: a non-receipt notice gets the property and service but never a payment method', async () => {
  process.env.GATE_BILLING_EMAIL_DETAILS = 'true';
  const args = await send('invoice', { ...INVOICE, status: 'sent' });
  expect(args.templateKey).toBe('billing.notice');
  expect(args.payload.property_full_address).toBe('100 Example Lane, Bradenton, FL 34205');
  expect(args.payload.service_label).toBe('Quarterly Pest Control');
  expect(args.payload).not.toHaveProperty('payment_method');
});

test('gate on: a notice that is not about one invoice adds nothing', async () => {
  process.env.GATE_BILLING_EMAIL_DETAILS = 'true';
  const args = await send('billing', null);
  expect(Object.keys(args.payload).sort()).toEqual(['billing_url', 'category_label', 'first_name', 'notification_body']);
});

test('gate on: a lookup that throws still sends the notice, without the extra rows', async () => {
  process.env.GATE_BILLING_EMAIL_DETAILS = 'true';
  db.mockImplementation(() => { throw new Error('db down'); });
  const args = await send('payment_receipt', { ...INVOICE, service_type: '', scheduled_service_id: 'ss-1' });
  expect(args.templateKey).toBe('billing.receipt_notice');
  expect(args.payload.notification_body).toBe('Thanks - we received your payment.');
});
