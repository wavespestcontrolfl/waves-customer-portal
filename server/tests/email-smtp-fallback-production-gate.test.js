/**
 * C2: SMTP fallback is dev/staging-only.
 *
 * In production, when the SendGrid template path fails (template row missing,
 * SendGrid unconfigured, or any other reason that today triggers the SMTP
 * fallback), the send must hard-fail rather than bypass email_messages /
 * email_suppressions. This pins that gate in invoice-email.js for both
 * sendInvoiceEmail and sendReceiptEmail.
 */

const mockSendMail = jest.fn(async () => ({ messageId: 'smtp-1' }));

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: () => true,
  newsletterGroupId: () => null,
  serviceGroupId: () => null,
  sendOne: jest.fn(),
}));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(async () => {
    throw new Error('active template not found');
  }),
}));
jest.mock('../services/pdf/invoice-pdf', () => ({
  buildInvoicePDFBuffer: jest.fn(async () => Buffer.from('pdf')),
  buildReceiptPDFBuffer: jest.fn(async () => Buffer.from('pdf')),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
  invoiceShortCodePrefix: jest.fn(() => 'wpc'),
}));
jest.mock('../services/customer-contact', () => ({
  getInvoiceEmailRecipients: jest.fn(() => [{ email: 'customer@example.com', name: 'Pat', role: 'primary' }]),
  getReceiptEmailRecipients: jest.fn(() => [{ email: 'customer@example.com', name: 'Pat', role: 'primary' }]),
}));
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail: mockSendMail })),
}));

const db = require('../models/db');
const { sendInvoiceEmail, sendReceiptEmail } = require('../services/invoice-email');

function chain({ first, result } = {}) {
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

function paidInvoice() {
  return {
    id: 'inv-1',
    invoice_number: 'WPC-2026-0099',
    status: 'paid',
    total: '125.00',
    token: 'tok-xyz',
    paid_at: new Date('2026-05-20T14:00:00Z'),
    service_type: 'Pest Control',
    line_items: [],
  };
}

function openInvoice() {
  return {
    id: 'inv-1',
    invoice_number: 'WPC-2026-0099',
    status: 'sent',
    total: '125.00',
    token: 'tok-xyz',
    service_type: 'Pest Control',
    service_date: new Date('2026-05-19T14:00:00Z'),
    due_date: new Date('2026-06-01T00:00:00Z'),
    line_items: [],
  };
}

function setUpDbForInvoiceFlow(invoice) {
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
}

describe('SMTP fallback production gate (C2)', () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
  let ORIGINAL_SMTP_PASS;

  beforeEach(() => {
    jest.clearAllMocks();
    ORIGINAL_SMTP_PASS = process.env.GOOGLE_SMTP_PASSWORD;
    process.env.GOOGLE_SMTP_PASSWORD = 'test-smtp-pass';
  });

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    if (ORIGINAL_SMTP_PASS === undefined) {
      delete process.env.GOOGLE_SMTP_PASSWORD;
    } else {
      process.env.GOOGLE_SMTP_PASSWORD = ORIGINAL_SMTP_PASS;
    }
  });

  describe('sendInvoiceEmail', () => {
    test('production: template-missing error → hard-fail, no SMTP send', async () => {
      process.env.NODE_ENV = 'production';
      setUpDbForInvoiceFlow(openInvoice());

      const result = await sendInvoiceEmail('inv-1');

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/SMTP fallback is disabled in production/);
      expect(mockSendMail).not.toHaveBeenCalled();
    });

    test('development: template-missing error → falls through to SMTP', async () => {
      process.env.NODE_ENV = 'development';
      setUpDbForInvoiceFlow(openInvoice());

      const result = await sendInvoiceEmail('inv-1');

      expect(result.ok).toBe(true);
      expect(mockSendMail).toHaveBeenCalledTimes(1);
    });
  });

  describe('sendReceiptEmail', () => {
    test('production: template-missing error → hard-fail, no SMTP send', async () => {
      process.env.NODE_ENV = 'production';
      setUpDbForInvoiceFlow(paidInvoice());

      const result = await sendReceiptEmail('inv-1');

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/SMTP fallback is disabled in production/);
      expect(mockSendMail).not.toHaveBeenCalled();
    });

    test('development: template-missing error → falls through to SMTP', async () => {
      process.env.NODE_ENV = 'development';
      setUpDbForInvoiceFlow(paidInvoice());

      const result = await sendReceiptEmail('inv-1');

      expect(result.ok).toBe(true);
      expect(mockSendMail).toHaveBeenCalledTimes(1);
    });
  });
});
