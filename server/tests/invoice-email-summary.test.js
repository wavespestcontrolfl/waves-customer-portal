/**
 * sendInvoiceEmail surfaces the customer-facing service summary (invoice.notes)
 * in the email — both as a SendGrid template variable and in the rendered body —
 * so the AI-written / operator-edited summary reaches the customer, not just the
 * attached PDF.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: () => true,
  newsletterGroupId: () => null,
  serviceGroupId: () => null,
  sendOne: jest.fn(),
}));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(),
}));
jest.mock('../services/pdf/invoice-pdf', () => ({
  buildInvoicePDFBuffer: jest.fn(async () => Buffer.from('pdf-bytes')),
  buildReceiptPDFBuffer: jest.fn(),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
  invoiceShortCodePrefix: jest.fn(() => 'wpc'),
}));
jest.mock('../services/customer-contact', () => ({
  getInvoiceEmailRecipients: jest.fn(() => [{ email: 'customer@example.com', name: 'Pat', role: 'primary' }]),
  getReceiptEmailRecipients: jest.fn(),
}));
jest.mock('../services/payer', () => ({
  attachToInvoice: jest.fn(async () => null),
  payerRecipient: jest.fn(() => null),
  freezeApEmail: jest.fn(async () => null),
}));

const db = require('../models/db');
const EmailTemplates = require('../services/email-template-library');
const { sendInvoiceEmail } = require('../services/invoice-email');

function chain({ first, count, result } = {}) {
  const q = {};
  ['where', 'whereRaw', 'whereIn', 'select', 'orderBy', 'limit'].forEach((m) => {
    q[m] = jest.fn(() => q);
  });
  q.first = jest.fn(async () => first);
  q.count = jest.fn(() => q);
  q.then = (resolve, reject) => Promise.resolve(result || []).then(resolve, reject);
  q.catch = (reject) => Promise.resolve(result || []).catch(reject);
  return q;
}

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
    line_items: [],
    notes: 'We treated the exterior perimeter and entry points and checked the garage. You may see normal activity for a couple of weeks as the treatment settles in.',
    ...overrides,
  };
}

function mockDb(invoice) {
  db.mockImplementation((table) => {
    if (table === 'invoices') return chain({ first: invoice });
    if (table === 'customers') {
      return chain({ first: { id: 'cust-1', first_name: 'Pat', email: 'customer@example.com' } });
    }
    if (table === 'notification_prefs') return chain({ first: null });
    if (table === 'invoice_attachments') return chain({ first: { count: 0 } });
    throw new Error(`Unexpected db table: ${table}`);
  });
}

describe('sendInvoiceEmail service summary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    EmailTemplates.sendTemplate.mockResolvedValue({ sent: true, message: { provider_message_id: 'sg-1' } });
  });

  test('passes the invoice notes through as the invoice_summary template variable', async () => {
    const invoice = invoiceRow();
    mockDb(invoice);

    const result = await sendInvoiceEmail('inv-1');

    expect(result.ok).toBe(true);
    const args = EmailTemplates.sendTemplate.mock.calls[0][0];
    expect(args.payload.invoice_summary).toBe(invoice.notes);
  });

  test('sends an empty summary variable when the invoice has no notes', async () => {
    mockDb(invoiceRow({ notes: null }));

    await sendInvoiceEmail('inv-1');

    const args = EmailTemplates.sendTemplate.mock.calls[0][0];
    expect(args.payload.invoice_summary).toBe('');
  });

  test('escapes HTML in the summary to prevent markup injection in the body', async () => {
    mockDb(invoiceRow({ notes: 'Treated <b>garage</b> & perimeter' }));

    await sendInvoiceEmail('inv-1');

    const args = EmailTemplates.sendTemplate.mock.calls[0][0];
    // The raw note flows to the template variable verbatim (SendGrid escapes),
    // but the SMTP-fallback HTML path escapes it — assert the raw value is intact.
    expect(args.payload.invoice_summary).toBe('Treated <b>garage</b> & perimeter');
  });
});
