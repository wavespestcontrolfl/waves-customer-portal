/**
 * sendPayerInvoiceText (GATE_PAYER_INVOICE_SMS): the pay link of a payer-billed invoice is texted to the payer's
 * ap_phone after the payer's email was accepted. The db is a table-keyed fake; the messaging pipeline is mocked here
 * (its payer identity rule has its own suite, payer-recipient-validator.test.js).
 */

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  return fn;
});
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async () => 'portal.wavespestcontrol.com/l/wpc-2026-0042-k3j9'),
  invoiceShortCodePrefix: jest.fn(() => 'wpc-2026-0042'),
}));
jest.mock('../services/billing-email-details', () => ({
  invoicePropertyAddress: jest.fn(async () => '123 Palm Ave, Bradenton, FL 34208'),
  invoiceServiceDetails: jest.fn(async () => ({ label: '', date: '' })),
}));

const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { shortenOrPassthrough } = require('../services/short-url');
const { sendPayerInvoiceText, buildPayerInvoiceBody, eventKeyFor } = require('../services/payer-invoice-sms');

const OWNER_PHONE = '+19415550111';
const AP_PHONE = '(941) 555-0123';

let tables;
let smsLogUpdate;

function chain(table) {
  const q = {};
  ['where', 'whereRaw', 'whereIn', 'select'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.first = jest.fn(async () => tables[table]);
  q.update = jest.fn(async (values) => { smsLogUpdate(values); return 1; });
  return q;
}

function invoiceRow(overrides = {}) {
  return {
    id: 'inv-1',
    invoice_number: 'WPC-2026-0042',
    customer_id: 'cust-1',
    payer_id: 7,
    payer_statement_id: null,
    status: 'sending',
    total: '150.00',
    credit_applied: 0,
    amount_paid: 0,
    token: 'tok-abc',
    service_type: 'One-Time Pest Control Service',
    service_date: new Date('2026-11-03T00:00:00Z'),
    scheduled_send_error: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_PAYER_INVOICE_SMS = 'true';
  smsLogUpdate = jest.fn();
  tables = {
    invoices: invoiceRow(),
    payers: { id: 7, display_name: 'Pat Rowe', company_name: null, ap_phone: AP_PHONE, active: true },
    customers: { id: 'cust-1', first_name: 'Sam', phone: OWNER_PHONE },
    sms_log: undefined,
  };
  db.mockImplementation((table) => chain(table));
  sendCustomerMessage.mockResolvedValue({ sent: true, deliveryOutcome: 'accepted', providerMessageId: `SM${'a'.repeat(32)}` });
});

afterAll(() => { delete process.env.GATE_PAYER_INVOICE_SMS; });

describe('gate', () => {
  test.each([undefined, 'false', '1', 'TRUE'])('GATE_PAYER_INVOICE_SMS=%s sends nothing and reads nothing', async (value) => {
    if (value === undefined) delete process.env.GATE_PAYER_INVOICE_SMS; else process.env.GATE_PAYER_INVOICE_SMS = value;
    await expect(sendPayerInvoiceText({ invoiceId: 'inv-1' })).resolves.toMatchObject({ sent: false, code: 'gate_off' });
    expect(db).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });
});

describe('recipient', () => {
  test('texts the payer ap_phone only, as the payer_payment_link purpose on the invoice customer', async () => {
    await expect(sendPayerInvoiceText({ invoiceId: 'inv-1', emailMessageId: 'em-1' }))
      .resolves.toMatchObject({ sent: true, code: 'sent' });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    const input = sendCustomerMessage.mock.calls[0][0];
    expect(input).toMatchObject({
      to: '+19415550123',
      channel: 'sms',
      audience: 'customer',
      purpose: 'payer_payment_link',
      customerId: 'cust-1',
      invoiceId: 'inv-1',
      entryPoint: 'payer_invoice_sms',
      metadata: {
        original_message_type: 'payer_invoice',
        notificationEventKey: 'invoice:inv-1:payer_sms:em-1',
        payer_id: 7,
        invoice_id: 'inv-1',
      },
    });
    expect(input.operatorInitiated).toBeUndefined();
    expect(input.to).not.toBe(OWNER_PHONE);
  });

  test('an office send may use the window exemption of the invoice text', async () => {
    await sendPayerInvoiceText({ invoiceId: 'inv-1', operatorInitiated: true });
    expect(sendCustomerMessage.mock.calls[0][0].operatorInitiated).toBe(true);
  });

  test('the pay link is minted for the invoice customer, on the sms channel, tagged as a payer click', async () => {
    await sendPayerInvoiceText({ invoiceId: 'inv-1' });
    expect(shortenOrPassthrough).toHaveBeenCalledWith(
      expect.stringMatching(/\/pay\/tok-abc$/),
      expect.objectContaining({ kind: 'invoice', entityType: 'invoices', entityId: 'inv-1', customerId: 'cust-1', channel: 'sms', purpose: 'payer_invoice' }),
    );
  });

  test('the sent sms_log row is stamped with the payer and the invoice', async () => {
    await sendPayerInvoiceText({ invoiceId: 'inv-1' });
    expect(smsLogUpdate).toHaveBeenCalledTimes(1);
    expect(db.raw).toHaveBeenCalledWith(expect.stringContaining('||'), [JSON.stringify({ payer_id: 7, invoice_id: 'inv-1' })]);
  });

  test('the customer phone is never a fallback: a payer with no ap_phone is skipped', async () => {
    tables.payers.ap_phone = null;
    await expect(sendPayerInvoiceText({ invoiceId: 'inv-1' })).resolves.toMatchObject({ sent: false, code: 'payer_phone_missing' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test.each(['555-0123', '(041) 555-0123', 'call Pat', '+44 20 7946 0958'])('ap_phone %p is not a valid US number', async (phone) => {
    tables.payers.ap_phone = phone;
    await expect(sendPayerInvoiceText({ invoiceId: 'inv-1' })).resolves.toMatchObject({ sent: false, code: 'payer_phone_invalid' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a payer phone that is the homeowner\'s own phone is skipped', async () => {
    tables.customers.phone = '941-555-0123';
    await expect(sendPayerInvoiceText({ invoiceId: 'inv-1' })).resolves.toMatchObject({ sent: false, code: 'payer_phone_is_customer_phone' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('an inactive payer is skipped', async () => {
    tables.payers.active = false;
    await expect(sendPayerInvoiceText({ invoiceId: 'inv-1' })).resolves.toMatchObject({ sent: false, code: 'payer_inactive' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });
});

describe('invoice state', () => {
  test.each([
    ['not billed to a payer', { payer_id: null }, 'not_payer_invoice'],
    ['paid', { status: 'paid' }, 'invoice_not_open'],
    ['prepaid', { status: 'prepaid' }, 'invoice_not_open'],
    ['void', { status: 'void' }, 'invoice_not_open'],
    ['refunded', { status: 'refunded' }, 'invoice_not_open'],
    ['with no balance due', { amount_paid: '150.00' }, 'invoice_not_open'],
    ['accrued to a payer statement', { payer_statement_id: 12 }, 'statement_accrued'],
    ['withdrawn from the customer', { scheduled_send_error: 'payer_billed: combined visit moved to AP' }, 'invoice_withdrawn'],
    ['with no pay token', { token: null }, 'no_pay_link'],
  ])('an invoice %s is skipped', async (_name, overrides, code) => {
    tables.invoices = invoiceRow(overrides);
    await expect(sendPayerInvoiceText({ invoiceId: 'inv-1' })).resolves.toMatchObject({ sent: false, code });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test.each(['draft', 'scheduled', 'sending', 'sent', 'viewed', 'overdue'])('a %s invoice is texted', async (status) => {
    tables.invoices = invoiceRow({ status });
    await expect(sendPayerInvoiceText({ invoiceId: 'inv-1' })).resolves.toMatchObject({ sent: true });
  });
});

describe('body', () => {
  test('renders the owner example', async () => {
    await sendPayerInvoiceText({ invoiceId: 'inv-1' });
    expect(sendCustomerMessage.mock.calls[0][0].body).toBe(
      'Hi Pat! The invoice for Sam\'s One-Time Pest Control Service at 123 Palm Ave on Tuesday, November 3, 2026 is ready: portal.wavespestcontrol.com/l/wpc-2026-0042-k3j9',
    );
  });

  test('carries no dollar amount and the stored service name verbatim', async () => {
    tables.invoices = invoiceRow({ service_type: 'WDO Inspection (Termite Letter)', total: '1234.56' });
    await sendPayerInvoiceText({ invoiceId: 'inv-1' });
    const { body } = sendCustomerMessage.mock.calls[0][0];
    expect(body).not.toMatch(/\$|1234|\d+\.\d\d/);
    expect(body).toContain('Sam\'s WDO Inspection (Termite Letter) at');
    expect(body).not.toMatch(/pest control\b/i);
  });

  test('a company payer opens with Hello! and no name', async () => {
    tables.payers.company_name = 'Rowe Builders LLC';
    await sendPayerInvoiceText({ invoiceId: 'inv-1' });
    const { body } = sendCustomerMessage.mock.calls[0][0];
    expect(body.startsWith('Hello! The invoice for Sam\'s')).toBe(true);
    expect(body).not.toContain('Pat');
    expect(body).not.toContain('Rowe');
  });

  test('a missing field drops its phrase, never prints a blank', () => {
    const payer = { display_name: 'Pat Rowe' };
    expect(buildPayerInvoiceBody({ payer, customerFirstName: '', serviceType: 'Lawn Care', addressLine: '', serviceDate: '', payUrl: 'u.co/l/x' }))
      .toBe('Hi Pat! The invoice for Lawn Care is ready: u.co/l/x');
    expect(buildPayerInvoiceBody({ payer, customerFirstName: 'Sam', serviceType: '', addressLine: '12 Oak St', serviceDate: '', payUrl: 'u.co/l/x' }))
      .toBe('Hi Pat! The invoice for Sam\'s recent service at 12 Oak St is ready: u.co/l/x');
    expect(buildPayerInvoiceBody({ payer: { display_name: '' }, customerFirstName: '', serviceType: '', addressLine: '', serviceDate: '', payUrl: 'u.co/l/x' }))
      .toBe('Hello! The invoice for a recent service is ready: u.co/l/x');
  });

  test('the service falls back to the visit\'s name when the invoice has none', async () => {
    require('../services/billing-email-details').invoiceServiceDetails.mockResolvedValueOnce({ label: 'Rodent Exclusion' });
    tables.invoices = invoiceRow({ service_type: null });
    await sendPayerInvoiceText({ invoiceId: 'inv-1' });
    expect(sendCustomerMessage.mock.calls[0][0].body).toContain('Sam\'s Rodent Exclusion at');
  });
});

describe('never throws, never repeats', () => {
  test('a refused text is a result, not an error', async () => {
    sendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, code: 'SUPPRESSED_OPT_OUT', reason: 'Recipient is suppressed' });
    await expect(sendPayerInvoiceText({ invoiceId: 'inv-1' })).resolves.toMatchObject({ sent: false, code: 'SUPPRESSED_OPT_OUT' });
    expect(smsLogUpdate).not.toHaveBeenCalled();
  });

  test('a quiet-hours hold is reported as deferred', async () => {
    sendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, code: 'QUIET_HOURS_HOLD', reason: 'Automated SMS is limited', deferred: true, nextAllowedAt: '2026-11-04T12:00:00.000Z' });
    await expect(sendPayerInvoiceText({ invoiceId: 'inv-1' }))
      .resolves.toMatchObject({ sent: false, code: 'QUIET_HOURS_HOLD', deferred: true });
  });

  test('a thrown send is a result, not an error', async () => {
    sendCustomerMessage.mockRejectedValue(new Error('twilio down'));
    await expect(sendPayerInvoiceText({ invoiceId: 'inv-1' })).resolves.toMatchObject({ sent: false, code: 'error', reason: 'twilio down' });
  });

  test('a database failure is a result, not an error', async () => {
    db.mockImplementation(() => { throw new Error('db down'); });
    await expect(sendPayerInvoiceText({ invoiceId: 'inv-1' })).resolves.toMatchObject({ sent: false, code: 'error' });
  });

  test('the claim\'s answer for an already-accepted text is not a new send', async () => {
    sendCustomerMessage.mockResolvedValue({ sent: true, deduped: true, deliveryOutcome: 'accepted', providerMessageId: `SM${'a'.repeat(32)}` });
    await expect(sendPayerInvoiceText({ invoiceId: 'inv-1', emailMessageId: 'em-1' }))
      .resolves.toMatchObject({ sent: false, code: 'already_texted' });
    expect(smsLogUpdate).not.toHaveBeenCalled();
  });

  test('a concurrent attempt\'s in-flight hold is reported, not sent', async () => {
    sendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, code: 'BILLING_TEXT_LEG_IN_FLIGHT', reason: 'in flight', retryable: true, deferred: true });
    await expect(sendPayerInvoiceText({ invoiceId: 'inv-1', emailMessageId: 'em-1' }))
      .resolves.toMatchObject({ sent: false, code: 'BILLING_TEXT_LEG_IN_FLIGHT' });
  });

  test('the event key is the email row; the acceptance time only when there is no row', () => {
    expect(eventKeyFor('inv-1', { emailMessageId: 'em-1', emailAcceptedAt: '2026-11-03T15:00:00.000Z' })).toBe('invoice:inv-1:payer_sms:em-1');
    expect(eventKeyFor('inv-1', { emailMessageId: 'em-1', emailAcceptedAt: '2026-11-09T09:00:00.000Z' })).toBe('invoice:inv-1:payer_sms:em-1');
    expect(eventKeyFor('inv-1', { emailAcceptedAt: '2026-11-03T15:00:00.000Z' })).toBe('invoice:inv-1:payer_sms:2026-11-03T15:00:00.000Z');
    expect(eventKeyFor('inv-1', { emailAcceptedAt: new Date('2026-11-03T15:00:00.000Z') })).toBe(eventKeyFor('inv-1', { emailAcceptedAt: '2026-11-03T15:00:00.000Z' }));
    expect(eventKeyFor('inv-1', { emailMessageId: 'em-2' })).not.toBe(eventKeyFor('inv-1', { emailMessageId: 'em-1' }));
  });
});
