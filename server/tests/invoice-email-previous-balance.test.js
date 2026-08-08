/**
 * sendInvoiceEmail previous-balance note (GATE_BALANCE_VISIBILITY, owner
 * ruling 2026-08-08).
 *
 * Contract:
 *   - gate ON + other open invoices → one display-only sentence rides the
 *     invoice_message template slot AFTER the operator note; the CTA amount
 *     stays this invoice's own
 *   - gate OFF → payload byte-identical to today (note absent)
 *   - payer-billed invoices NEVER carry the homeowner balance note
 *   - a lookup failure sends the email exactly as today
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
  payerRecipient: jest.fn(() => ({ email: 'ap@example.com', name: 'AP', role: 'payer_ap' })),
  freezeApEmail: jest.fn(async () => null),
}));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => false),
  gates: {},
}));
jest.mock('../services/open-balance', () => ({
  openBalanceSummary: jest.fn(async () => ({ total: 0, count: 0, invoices: [] })),
}));

const db = require('../models/db');
const EmailTemplates = require('../services/email-template-library');
const { isEnabled } = require('../config/feature-gates');
const { openBalanceSummary } = require('../services/open-balance');
const { sendInvoiceEmail } = require('../services/invoice-email');

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
    notes: '',
    email_message: 'Thanks for having us out!',
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

describe('sendInvoiceEmail previous-balance note', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isEnabled.mockImplementation(() => false);
    openBalanceSummary.mockResolvedValue({ total: 0, count: 0, invoices: [] });
    EmailTemplates.sendTemplate.mockResolvedValue({ sent: true, message: { provider_message_id: 'sg-1' } });
  });

  test('gate on + open balance: note rides invoice_message after the operator note; CTA amount unchanged', async () => {
    isEnabled.mockImplementation((gate) => gate === 'balanceVisibility');
    openBalanceSummary.mockResolvedValue({ total: 450, count: 2, invoices: [{}, {}] });
    mockDb(invoiceRow());

    const result = await sendInvoiceEmail('inv-1');

    expect(result.ok).toBe(true);
    expect(openBalanceSummary).toHaveBeenCalledWith('cust-1', { excludeInvoiceId: 'inv-1' });
    const args = EmailTemplates.sendTemplate.mock.calls[0][0];
    expect(args.payload.invoice_message).toBe(
      'Thanks for having us out!\n\nReminder: your account also has a previous balance of $450.00 from 2 earlier invoices, separate from this invoice. Each earlier invoice has its own payment link in the email it arrived with, and you can always see your full balance in your customer portal at portal.wavespestcontrol.com.',
    );
    // Nothing is folded into this bill — the CTA amount stays this invoice's own.
    expect(args.payload.amount_due).toBe('$150.00');
  });

  test('gate off: payload byte-identical to today, no balance lookup', async () => {
    mockDb(invoiceRow());

    await sendInvoiceEmail('inv-1');

    expect(openBalanceSummary).not.toHaveBeenCalled();
    const args = EmailTemplates.sendTemplate.mock.calls[0][0];
    expect(args.payload.invoice_message).toBe('Thanks for having us out!');
  });

  test('payer-billed invoice never carries the homeowner balance note', async () => {
    isEnabled.mockImplementation((gate) => gate === 'balanceVisibility');
    openBalanceSummary.mockResolvedValue({ total: 450, count: 2, invoices: [{}, {}] });
    mockDb(invoiceRow({ payer_id: 'payer-1', payer: { company_name: 'HOA', ap_email: 'ap@example.com' } }));

    await sendInvoiceEmail('inv-1');

    expect(openBalanceSummary).not.toHaveBeenCalled();
    const args = EmailTemplates.sendTemplate.mock.calls[0][0];
    expect(args.payload.invoice_message).toBe('Thanks for having us out!');
  });

  test('a one-off recipient override never receives the balance note (pre-push r3 P0)', async () => {
    // An operator one-off send routes THIS invoice to an arbitrary address —
    // authorized for this invoice only, never the account's balance.
    isEnabled.mockImplementation((gate) => gate === 'balanceVisibility');
    openBalanceSummary.mockResolvedValue({ total: 450, count: 2, moreCount: 0, invoices: [{}, {}] });
    mockDb(invoiceRow());

    const result = await sendInvoiceEmail('inv-1', {
      recipientOverride: { email: 'bookkeeper@example.com', name: 'Books', role: 'invoice_override' },
    });

    expect(result.ok).toBe(true);
    expect(openBalanceSummary).not.toHaveBeenCalled();
    const args = EmailTemplates.sendTemplate.mock.calls[0][0];
    expect(args.to).toBe('bookkeeper@example.com');
    expect(args.payload.invoice_message).toBe('Thanks for having us out!');
  });

  test('a balance lookup failure sends the email exactly as today', async () => {
    isEnabled.mockImplementation((gate) => gate === 'balanceVisibility');
    openBalanceSummary.mockRejectedValue(new Error('db down'));
    mockDb(invoiceRow());

    const result = await sendInvoiceEmail('inv-1');

    expect(result.ok).toBe(true);
    const args = EmailTemplates.sendTemplate.mock.calls[0][0];
    expect(args.payload.invoice_message).toBe('Thanks for having us out!');
  });
});
