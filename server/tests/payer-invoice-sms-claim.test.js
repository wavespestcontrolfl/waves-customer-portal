/**
 * One payer text per accepted email row, under the EXISTING billing text claim (messaging/billing-text-leg-dedupe.js
 * withBillingTextLegLock, extended to purpose payer_payment_link). Real sendPayerInvoiceText and real claim; the messaging
 * pipeline between them is a stub that calls the claim around a fake provider send, and sms_log / the advisory lock are an
 * in-memory fake with the same semantics (an xact lock held until its transaction ends; a try-lock never waits). The
 * real-database concurrency of the claim itself is billing-text-leg-dedupe-postgres.test.js.
 */
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async () => 'portal.wavespestcontrol.com/l/x'),
  invoiceShortCodePrefix: jest.fn(() => 'wpc'),
}));
jest.mock('../services/billing-email-details', () => ({
  invoicePropertyAddress: jest.fn(async () => '123 Palm Ave, Bradenton, FL'),
  invoiceServiceDetails: jest.fn(async () => ({ label: '' })),
}));

const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { withBillingTextLegLock } = require('../services/messaging/billing-text-leg-dedupe');
const { sendPayerInvoiceText } = require('../services/payer-invoice-sms');

let claims; // live claim rows
let accepted; // durable accepted text rows
let heldLocks;
let providerSends;

const tick = () => new Promise((resolve) => setImmediate(resolve));

function smsLogTable() {
  const q = {};
  let kind = 'accepted';
  q.where = (arg) => { if (arg && typeof arg === 'object' && arg.status === 'sending') kind = 'claim'; return q; };
  q.whereRaw = () => q;
  q.whereNot = () => q;
  q.whereIn = () => q;
  q.orderBy = () => q;
  q.first = async () => (kind === 'claim' ? claims[0] : accepted[0]);
  q.insert = (row) => { claims.push({ ...row, id: `claim-${claims.length + 1}` }); return { returning: async () => [`claim-${claims.length}`] }; };
  q.del = async () => { claims.length = 0; return 1; };
  q.update = async () => 1;
  return q;
}

function fakeTransaction(callback) {
  const trx = (table) => {
    if (table !== 'sms_log') throw new Error(`unexpected table ${table}`);
    return smsLogTable();
  };
  const held = [];
  trx.raw = async (sql, [key]) => {
    if (!String(sql).includes('pg_try_advisory_xact_lock')) return {};
    if (heldLocks.has(key)) return { rows: [{ locked: false }] };
    heldLocks.add(key); held.push(key);
    return { rows: [{ locked: true }] };
  };
  return Promise.resolve(callback(trx)).finally(() => held.forEach((key) => heldLocks.delete(key)));
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_PAYER_INVOICE_SMS = 'true';
  claims = []; accepted = []; heldLocks = new Set(); providerSends = [];
  const rows = {
    invoices: { id: 'inv-1', customer_id: 'cust-1', payer_id: 7, payer_statement_id: null, status: 'sending', total: '150.00', credit_applied: 0, amount_paid: 0, token: 'tok', service_type: 'Lawn Care', service_date: null, scheduled_send_error: null },
    payers: { id: 7, display_name: 'Pat Rowe', company_name: null, ap_phone: '(941) 555-0123', active: true },
    customers: { id: 'cust-1', first_name: 'Sam', phone: '+19415550111' },
  };
  db.mockImplementation((table) => {
    if (table === 'sms_log') return smsLogTable();
    const q = {};
    q.where = () => q;
    q.first = async () => rows[table];
    return q;
  });
  db.transaction = jest.fn(fakeTransaction);
  // The pipeline stub: the claim around a provider send that takes a few ticks and then logs the accepted text.
  sendCustomerMessage.mockImplementation((input) => withBillingTextLegLock(input, async () => {
    await tick(); await tick();
    providerSends.push(input.metadata.notificationEventKey);
    accepted.push({ twilio_sid: `SM${'a'.repeat(32)}`, created_at: new Date() });
    return { sent: true, provider: 'twilio', deliveryOutcome: 'accepted', providerMessageId: `SM${'a'.repeat(32)}` };
  }));
});

afterAll(() => { delete process.env.GATE_PAYER_INVOICE_SMS; });

test('two concurrent calls for the same accepted email row send exactly once', async () => {
  const [a, b] = await Promise.all([
    sendPayerInvoiceText({ invoiceId: 'inv-1', emailMessageId: 'em-1' }),
    sendPayerInvoiceText({ invoiceId: 'inv-1', emailMessageId: 'em-1' }),
  ]);
  expect(providerSends).toEqual(['invoice:inv-1:payer_sms:em-1']);
  expect([a.sent, b.sent].filter(Boolean)).toHaveLength(1);
  const loser = a.sent ? b : a;
  expect(loser).toMatchObject({ sent: false, code: 'BILLING_TEXT_LEG_IN_FLIGHT' });
});

test('a later replay of the same email row finds the accepted text and does not send', async () => {
  await expect(sendPayerInvoiceText({ invoiceId: 'inv-1', emailMessageId: 'em-1' })).resolves.toMatchObject({ sent: true });
  await expect(sendPayerInvoiceText({ invoiceId: 'inv-1', emailMessageId: 'em-1' })).resolves.toMatchObject({ sent: false, code: 'already_texted' });
  expect(providerSends).toHaveLength(1);
});

test('a different email row (a deliberate resend) is its own claim and texts again', async () => {
  await sendPayerInvoiceText({ invoiceId: 'inv-1', emailMessageId: 'em-1' });
  accepted.length = 0; // the resend\'s lookup is by key; the first text is a different key
  await expect(sendPayerInvoiceText({ invoiceId: 'inv-1', emailMessageId: 'em-2' })).resolves.toMatchObject({ sent: true });
  expect(providerSends).toEqual(['invoice:inv-1:payer_sms:em-1', 'invoice:inv-1:payer_sms:em-2']);
});

test('the claim guards purpose payer_payment_link with no billing leg marker, and still ignores other legacy sends', async () => {
  const send = jest.fn(async () => ({ sent: true, deliveryOutcome: 'accepted', providerMessageId: 'SM1' }));
  await withBillingTextLegLock({ purpose: 'review_request', customerId: 'cust-1', metadata: { notificationEventKey: 'k' } }, send);
  expect(db.transaction).not.toHaveBeenCalled();
  await withBillingTextLegLock({ purpose: 'payer_payment_link', customerId: 'cust-1', to: '+19415550123', metadata: { notificationEventKey: 'k' } }, send);
  expect(db.transaction).toHaveBeenCalledTimes(1);
});
