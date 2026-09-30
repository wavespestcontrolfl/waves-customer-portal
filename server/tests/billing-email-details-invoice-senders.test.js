/**
 * invoice.sent and invoice.receipt under GATE_BILLING_EMAIL_DETAILS (dark,
 * owner-approved 2026-09-29).
 *
 * Contract:
 *   - gate OFF: the payload and the idempotency key are exactly what they were
 *     (no new variables, no key on invoice.sent, a null key on a receipt sent
 *     with none)
 *   - gate ON: the service, service date, full street address and the payment
 *     method reach the template even when the invoice row itself is blank; the
 *     nickname "Primary" never stands in for the address; a payer's or a
 *     one-off recipient's email never names the homeowner's card
 *   - gate ON: invoice.sent carries one key per send claim, a receipt with no
 *     caller key carries one per receipt generation, and a caller's own key
 *     always wins
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/estimate-deposits', () => ({
  assertInvoiceDepositSettlementReady: jest.fn(async () => {}),
  withInvoiceDepositSettlement: jest.fn(async (invoiceId, callback) => {
    const database = require('../models/db');
    return callback(database, await database('invoices').where({ id: invoiceId }).first());
  }),
}));
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: () => true,
  newsletterGroupId: () => null,
  serviceGroupId: () => null,
  sendOne: jest.fn(),
}));
jest.mock('../services/email-template-library', () => ({ sendTemplate: jest.fn() }));
jest.mock('../services/pdf/invoice-pdf', () => ({
  buildInvoicePDFBuffer: jest.fn(async () => Buffer.from('pdf-bytes')),
  buildReceiptPDFBuffer: jest.fn(async () => Buffer.from('pdf-bytes')),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
  invoiceShortCodePrefix: jest.fn(() => 'wpc'),
}));
jest.mock('../services/customer-contact', () => ({
  getInvoiceEmailRecipients: jest.fn(() => [{ email: 'customer@example.com', name: 'Pat', role: 'primary' }]),
  getReceiptEmailRecipients: jest.fn(() => [{ email: 'customer@example.com', name: 'Pat', role: 'primary' }]),
}));
jest.mock('../services/payer', () => ({
  attachToInvoice: jest.fn(async () => null),
  payerRecipient: jest.fn(() => ({ email: 'ap@example.com', name: 'AP', role: 'payer_ap' })),
  freezeApEmail: jest.fn(async () => null),
}));

const db = require('../models/db');
const EmailTemplates = require('../services/email-template-library');
const { sendInvoiceEmail, sendReceiptEmail } = require('../services/invoice-email');

function chain(rows) {
  const q = {};
  ['where', 'whereRaw', 'whereIn', 'select', 'orderBy', 'limit', 'join'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.first = jest.fn(async () => (Array.isArray(rows) ? rows[0] : rows));
  q.count = jest.fn(() => q);
  q.then = (resolve, reject) => Promise.resolve(Array.isArray(rows) ? rows : []).then(resolve, reject);
  q.catch = (reject) => Promise.resolve(Array.isArray(rows) ? rows : []).catch(reject);
  return q;
}

const CUSTOMER = {
  id: 'cust-1',
  first_name: 'Pat',
  email: 'customer@example.com',
  address_line1: '100 Example Lane',
  address_line2: null,
  city: 'Bradenton',
  state: 'FL',
  zip: '34205',
  profile_label: 'Primary',
  autopay_payment_method_id: 'pm-1',
};

function invoiceRow(overrides = {}) {
  return {
    id: 'inv-1',
    invoice_number: 'WPC-2026-0123',
    customer_id: 'cust-1',
    status: 'sent',
    total: '150.00',
    credit_applied: 0,
    token: 'token-xyz',
    service_type: 'Quarterly Pest Control',
    service_date: '2026-09-29',
    line_items: [],
    notes: '',
    send_claim_token: 'claim-1',
    ...overrides,
  };
}

function mockTables(tables) {
  db.mockImplementation((table) => {
    if (!(table in tables)) throw new Error(`Unexpected db table: ${table}`);
    return chain(tables[table]);
  });
}

function baseTables(invoice, extra = {}) {
  return {
    invoices: invoice,
    customers: CUSTOMER,
    notification_prefs: null,
    invoice_attachments: { count: 0 },
    payment_methods: { id: 'pm-1', method_type: 'card', card_brand: 'visa', last_four: '4242' },
    ...extra,
  };
}

const NEW_KEYS = ['property_full_address', 'payment_method'];

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.GATE_BILLING_EMAIL_DETAILS;
  EmailTemplates.sendTemplate.mockResolvedValue({ sent: true, message: { provider_message_id: 'sg-1' } });
});
afterEach(() => { delete process.env.GATE_BILLING_EMAIL_DETAILS; });

describe('invoice.sent', () => {
  const sent = async (invoice, options = {}, extra = {}) => {
    mockTables(baseTables(invoice, extra));
    const result = await sendInvoiceEmail('inv-1', { claimToken: 'claim-1', ...options });
    return { result, args: EmailTemplates.sendTemplate.mock.calls[0]?.[0] };
  };

  test('gate off: no new variables, no idempotency key, a blank service stays blank', async () => {
    const { result, args } = await sent(invoiceRow({ service_type: null, service_date: null }));
    expect(result.ok).toBe(true);
    expect(args.templateKey).toBe('invoice.sent');
    expect(args.payload.service_label).toBe('');
    expect(args.payload.service_date).toBe('');
    for (const key of NEW_KEYS) expect(args.payload).not.toHaveProperty(key);
    expect(args).not.toHaveProperty('idempotencyKey');
    // Gate off reads nothing extra: no visit, record, payment-method or address lookups.
    expect(db.mock.calls.map(([table]) => table)).not.toEqual(expect.arrayContaining(['scheduled_services', 'service_records', 'payment_methods']));
  });

  test('gate on: service, date, full street address and the card on file reach the template', async () => {
    process.env.GATE_BILLING_EMAIL_DETAILS = 'true';
    const { result, args } = await sent(invoiceRow());
    expect(result.ok).toBe(true);
    expect(args.payload).toMatchObject({
      service_label: 'Quarterly Pest Control',
      service_date: 'September 29, 2026',
      property_full_address: '100 Example Lane, Bradenton, FL 34205',
      payment_method: 'VISA ···· 4242',
    });
    expect(args.payload.property_full_address).not.toMatch(/primary/i);
  });

  test('gate on: a blank service and date are filled from the visit the invoice bills', async () => {
    process.env.GATE_BILLING_EMAIL_DETAILS = 'true';
    const { args } = await sent(
      invoiceRow({ service_type: null, service_date: null, scheduled_service_id: 'ss-1' }),
      {},
      { scheduled_services: { service_type: 'Bi-Monthly Pest Control', scheduled_date: '2026-09-18', service_address_line1: null } },
    );
    expect(args.payload.service_label).toBe('Bi-Monthly Pest Control');
    expect(args.payload.service_date).toBe('September 18, 2026');
  });

  test('gate on: the visit\'s own stamped address (a secondary property) is the Property row', async () => {
    process.env.GATE_BILLING_EMAIL_DETAILS = 'true';
    const { args } = await sent(
      invoiceRow({ scheduled_service_id: 'ss-1' }),
      {},
      {
        scheduled_services: {
          service_type: 'Quarterly Pest Control', scheduled_date: '2026-09-29',
          service_address_line1: '55 Rental Court', service_address_city: 'Sarasota', service_address_state: 'FL', service_address_zip: '34236',
        },
      },
    );
    expect(args.payload.property_full_address).toBe('55 Rental Court, Sarasota, FL 34236');
  });

  test('gate on: a customer with no street address gets no Property row (never "Primary")', async () => {
    process.env.GATE_BILLING_EMAIL_DETAILS = 'true';
    const { args } = await sent(invoiceRow(), {}, { customers: { ...CUSTOMER, address_line1: '' } });
    expect(args.payload.property_full_address).toBe('');
  });

  test('gate on: the idempotency key is per send claim, so a retry dedupes and a resend under a new claim does not', async () => {
    process.env.GATE_BILLING_EMAIL_DETAILS = 'true';
    const first = await sent(invoiceRow());
    expect(first.args.idempotencyKey).toBe('invoice_sent:inv-1:claim-1');
    EmailTemplates.sendTemplate.mockClear();
    mockTables(baseTables(invoiceRow({ send_claim_token: 'claim-2' })));
    await sendInvoiceEmail('inv-1', { claimToken: 'claim-2' });
    expect(EmailTemplates.sendTemplate.mock.calls[0][0].idempotencyKey).toBe('invoice_sent:inv-1:claim-2');
  });

  test('gate on: a deduped send (the retry of a delivered claim) reports ok without a second provider call', async () => {
    process.env.GATE_BILLING_EMAIL_DETAILS = 'true';
    EmailTemplates.sendTemplate.mockResolvedValue({
      sent: true, deduped: true, message: { provider_message_id: 'sg-original', sent_at: '2026-09-29T12:00:00.000Z', status: 'sent' },
    });
    const { result } = await sent(invoiceRow());
    expect(result.ok).toBe(true);
    expect(result.deduped).toBe(true);
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledTimes(1);
  });

  test('gate on: an operator\'s one-off recipient never sees the homeowner\'s card, but still gets the rest', async () => {
    process.env.GATE_BILLING_EMAIL_DETAILS = 'true';
    const { args } = await sent(invoiceRow(), {
      recipientOverride: { email: 'bookkeeper@example.com', name: 'Books', role: 'invoice_override' },
    });
    expect(args.to).toBe('bookkeeper@example.com');
    expect(args.payload.payment_method).toBe('');
    expect(args.payload.service_label).toBe('Quarterly Pest Control');
    expect(args.idempotencyKey).toBe('invoice_sent:inv-1:claim-1');
  });

  test('gate on: a payer-billed invoice never names the homeowner\'s card', async () => {
    process.env.GATE_BILLING_EMAIL_DETAILS = 'true';
    const { args } = await sent(invoiceRow({ payer_id: 7, payer: { company_name: 'Example HOA', ap_email: 'ap@example.com' } }));
    expect(args.to).toBe('ap@example.com');
    expect(args.payload.payment_method).toBe('');
  });

  test('gate on: no saved card and no autopay method is a blank row, not a guess', async () => {
    process.env.GATE_BILLING_EMAIL_DETAILS = 'true';
    const { args } = await sent(invoiceRow(), {}, { customers: { ...CUSTOMER, autopay_payment_method_id: null }, payment_methods: undefined });
    expect(args.payload.payment_method).toBe('');
  });
});

describe('invoice.receipt', () => {
  const paid = (overrides = {}) => invoiceRow({
    status: 'paid',
    paid_at: new Date('2026-09-29T14:00:00Z'),
    card_brand: null,
    card_last_four: null,
    receipt_sent_at: null,
    ...overrides,
  });
  const receipt = async (invoice, options = {}, extra = {}) => {
    mockTables({ ...baseTables(invoice), payments: null, ...extra });
    const result = await sendReceiptEmail('inv-1', options);
    return { result, args: EmailTemplates.sendTemplate.mock.calls.at(-1)?.[0] };
  };

  test('gate off: exactly today\'s payload (a cash payment shows no method) and a null key', async () => {
    const { result, args } = await receipt(paid({ payment_method: 'cash' }));
    expect(result.ok).toBe(true);
    expect(args.templateKey).toBe('invoice.receipt');
    expect(args.payload.payment_method).toBe('');
    expect(args.payload).not.toHaveProperty('property_full_address');
    expect(args.payload).not.toHaveProperty('service_date');
    expect(args.idempotencyKey).toBeNull();
  });

  test('gate on: cash, check and ACH tenders now name themselves; service date and address ride along', async () => {
    process.env.GATE_BILLING_EMAIL_DETAILS = 'true';
    const { args } = await receipt(paid({ payment_method: 'check' }));
    expect(args.payload).toMatchObject({
      payment_method: 'Check',
      service_label: 'Quarterly Pest Control',
      service_date: 'September 29, 2026',
      property_full_address: '100 Example Lane, Bradenton, FL 34205',
    });
  });

  test('gate on: a card still reads exactly as before', async () => {
    process.env.GATE_BILLING_EMAIL_DETAILS = 'true';
    const { args } = await receipt(paid(), {}, { payments: { id: 'pay-1', card_brand: 'visa', card_last_four: '4242', amount: '150.00' } });
    expect(args.payload.payment_method).toBe('VISA ···· 4242');
  });

  test('gate on: a receipt with no caller key and no attempt identity stays key-less, as on main', async () => {
    process.env.GATE_BILLING_EMAIL_DETAILS = 'true';
    const { args } = await receipt(paid(), {}, { payments: { id: 'pay-1', amount: '150.00' } });
    expect(args.idempotencyKey).toBeNull();
  });

  test('gate on: an operator send is keyed on its own claim token; a new claim is a new key (blocked first attempt -> fixed address -> resend sends)', async () => {
    process.env.GATE_BILLING_EMAIL_DETAILS = 'true';
    const first = await receipt(paid(), { attemptToken: 'operator:w1:claim-a' });
    EmailTemplates.sendTemplate.mockClear();
    const again = await receipt(paid(), { attemptToken: 'operator:w1:claim-a' });
    const resend = await receipt(paid(), { attemptToken: 'operator:w1:claim-b' });
    expect(first.args.idempotencyKey).toMatch(/^invoice_receipt:inv-1:attempt:/);
    expect(again.args.idempotencyKey).toBe(first.args.idempotencyKey);
    expect(resend.args.idempotencyKey).not.toBe(first.args.idempotencyKey);
  });

  test('gate on: a key the caller passes always wins (the queue, the webhook, the prepaid receipt)', async () => {
    process.env.GATE_BILLING_EMAIL_DETAILS = 'true';
    const { args } = await receipt(paid(), { idempotencyKey: 'receipt_email_auto:inv-1' });
    expect(args.idempotencyKey).toBe('receipt_email_auto:inv-1');
  });

  test('gate on: a deduped receipt is reported as delivered, not re-sent', async () => {
    process.env.GATE_BILLING_EMAIL_DETAILS = 'true';
    EmailTemplates.sendTemplate.mockResolvedValue({ sent: true, deduped: true, message: { provider_message_id: 'sg-original' } });
    const { result } = await receipt(paid());
    expect(result).toMatchObject({ ok: true, deduped: true });
  });
});
