/**
 * sendReceiptEmail idempotency contract — the Stripe webhook path passes
 * `idempotencyKey` so a retried delivery doesn't email the customer twice.
 * Manual operator resends from /admin/invoices intentionally omit it.
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
  buildInvoicePDFBuffer: jest.fn(),
  buildReceiptPDFBuffer: jest.fn(async () => Buffer.from('pdf-bytes')),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
  invoiceShortCodePrefix: jest.fn(() => 'wpc'),
}));
jest.mock('../services/customer-contact', () => ({
  getInvoiceEmailRecipients: jest.fn(),
  getReceiptEmailRecipients: jest.fn(() => [{ email: 'customer@example.com', name: 'Pat', role: 'primary' }]),
}));

const db = require('../models/db');
const EmailTemplates = require('../services/email-template-library');
const { sendReceiptEmail } = require('../services/invoice-email');

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

function paidInvoiceRow() {
  return {
    id: 'inv-1',
    invoice_number: 'WPC-2026-0099',
    status: 'paid',
    total: '125.00',
    token: 'token-xyz',
    paid_at: new Date('2026-05-19T14:00:00Z'),
    service_type: 'Pest Control',
    line_items: [],
    card_brand: 'visa',
    card_last_four: '4242',
  };
}

describe('sendReceiptEmail idempotency', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const invoice = paidInvoiceRow();
    db.mockImplementation((table) => {
      if (table === 'invoices') return chain({ first: invoice });
      if (table === 'customers') {
        return chain({ first: { id: 'cust-1', first_name: 'Pat', email: 'customer@example.com' } });
      }
      if (table === 'notification_prefs') return chain({ first: null });
      if (table === 'payments') return chain({ first: null });
      if (table === 'invoice_attachments') return chain({ first: { count: 0 } });
      throw new Error(`Unexpected db table: ${table}`);
    });
  });

  test('passes idempotencyKey through to sendTemplate when provided', async () => {
    EmailTemplates.sendTemplate.mockResolvedValueOnce({
      sent: true,
      message: { provider_message_id: 'sg-1' },
    });

    const result = await sendReceiptEmail('inv-1', { idempotencyKey: 'receipt_email_auto:inv-1' });

    expect(result.ok).toBe(true);
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledTimes(1);
    const args = EmailTemplates.sendTemplate.mock.calls[0][0];
    expect(args.idempotencyKey).toBe('receipt_email_auto:inv-1');
    expect(args.templateKey).toBe('invoice.receipt');
    expect(args.to).toBe('customer@example.com');
  });

  test('passes null idempotencyKey when caller omits it (manual operator resend)', async () => {
    EmailTemplates.sendTemplate.mockResolvedValueOnce({
      sent: true,
      message: { provider_message_id: 'sg-2' },
    });

    await sendReceiptEmail('inv-1');

    const args = EmailTemplates.sendTemplate.mock.calls[0][0];
    expect(args.idempotencyKey).toBeNull();
  });

  test('returns deduped result without resending when sendTemplate dedupes', async () => {
    EmailTemplates.sendTemplate.mockResolvedValueOnce({
      sent: true,
      deduped: true,
      message: { provider_message_id: 'sg-original' },
    });

    const result = await sendReceiptEmail('inv-1', { idempotencyKey: 'receipt_email_auto:inv-1' });

    expect(result.ok).toBe(true);
    expect(result.deduped).toBe(true);
    expect(result.messageId).toBe('sg-original');
  });

  test('returns blocked result without claiming success when send is suppressed', async () => {
    EmailTemplates.sendTemplate.mockResolvedValueOnce({
      sent: false,
      blocked: true,
      deduped: true,
      reason: 'Suppressed: unsubscribe (service_operational)',
      message: { status: 'blocked' },
    });

    const result = await sendReceiptEmail('inv-1', { idempotencyKey: 'receipt_email_auto:inv-1' });

    expect(result.ok).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.error).toMatch(/Suppressed/);
  });
});
