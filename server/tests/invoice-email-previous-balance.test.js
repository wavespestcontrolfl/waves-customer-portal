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
 *   - the attached PDF itemizes the balance only when this invoice's Pay
 *     button collects every open invoice (the pay page's own selection), so
 *     a plan, stopped, disputed or in-flight invoice is never printed in red
 *   - a customer under a collections dispute hold gets neither the note nor
 *     the block, even on an operator-exempt send
 */

jest.mock('../models/db', () => jest.fn());
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
jest.mock('../routes/pay-v2', () => ({ payPageCombinedBalance: jest.fn(async () => null) }));
jest.mock('../services/open-balance', () => ({
  openBalanceSummary: jest.fn(async () => ({ total: 0, count: 0, invoices: [] })),
}));
// Only the dispute-hold read behind the balance is stubbed; the rest of the
// module stays real.
jest.mock('../services/collections/collection-hold', () => ({
  ...jest.requireActual('../services/collections/collection-hold'),
  customerHasActiveCollectionHold: jest.fn(async () => false),
}));

const db = require('../models/db');
const EmailTemplates = require('../services/email-template-library');
const { isEnabled } = require('../config/feature-gates');
const { openBalanceSummary } = require('../services/open-balance');
const { sendInvoiceEmail } = require('../services/invoice-email');
const { buildInvoicePDFBuffer } = require('../services/pdf/invoice-pdf');
const { payPageCombinedBalance } = require('../routes/pay-v2');
const { customerHasActiveCollectionHold } = require('../services/collections/collection-hold');

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
    customerHasActiveCollectionHold.mockResolvedValue(false);
    EmailTemplates.sendTemplate.mockResolvedValue({ sent: true, message: { provider_message_id: 'sg-1' } });
  });

  test('gate on + open balance: note rides invoice_message after the operator note; CTA amount unchanged', async () => {
    isEnabled.mockImplementation((gate) => gate === 'balanceVisibility');
    openBalanceSummary.mockResolvedValue({ total: 450, count: 2, invoices: [{}, {}] });
    mockDb(invoiceRow());

    const result = await sendInvoiceEmail('inv-1');

    expect(result.ok).toBe(true);
    expect(openBalanceSummary).toHaveBeenCalledWith('cust-1', { excludeInvoiceId: 'inv-1', displayLimit: 10 });
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

  const twoOpenInvoices = () => ({
    total: 300.1,
    count: 2,
    moreCount: 0,
    complete: true,
    invoices: [
      { invoice_number: 'INV-OLD-1', service_type: 'Quarterly Pest Control', service_date: '2026-08-01', due_date: '2026-08-15', is_overdue: true, total: '200.10', credit_applied: 0 },
      { invoice_number: 'INV-OLD-2', service_type: null, service_date: '2026-09-01', due_date: '2026-09-15', is_overdue: false, total: '120.00', credit_applied: '20.00' },
    ],
  });
  const expectedRows = [
    { invoiceNumber: 'INV-OLD-1', serviceType: 'Quarterly Pest Control', serviceDate: '2026-08-01', dueDate: '2026-08-15', pastDue: true, amountDue: 200.1 },
    { invoiceNumber: 'INV-OLD-2', serviceType: null, serviceDate: '2026-09-01', dueDate: '2026-09-15', pastDue: false, amountDue: 100 },
  ];

  test('when the Pay button collects every open invoice, the attached PDF itemizes them with service names and past-due flags, with the account total', async () => {
    isEnabled.mockImplementation((gate) => gate === 'balanceVisibility' || gate === 'payIncludeBalance');
    openBalanceSummary.mockResolvedValue(twoOpenInvoices());
    payPageCombinedBalance.mockResolvedValueOnce({ invoices: [{}, {}], total: 300.1, combinedTotal: 450.1 });
    mockDb(invoiceRow());

    await sendInvoiceEmail('inv-1');

    expect(buildInvoicePDFBuffer.mock.calls[0][0].previous_balance).toEqual({
      invoices: expectedRows,
      moreCount: 0,
      total: 300.1,
      combinedTotal: 450.1,
      totalLabel: 'Total account balance',
    });
  });

  test('payIncludeBalance off: the note still names the balance, but the PDF prints no block', async () => {
    isEnabled.mockImplementation((gate) => gate === 'balanceVisibility');
    openBalanceSummary.mockResolvedValue(twoOpenInvoices());
    mockDb(invoiceRow());

    await sendInvoiceEmail('inv-1');

    expect(payPageCombinedBalance).not.toHaveBeenCalled();
    expect(buildInvoicePDFBuffer.mock.calls[0][0].previous_balance).toBeUndefined();
    expect(EmailTemplates.sendTemplate.mock.calls[0][0].payload.invoice_message).toContain('previous balance of $300.10 from 2 earlier invoices, separate from this invoice');
  });

  test.each([
    ['an active dispute hold', () => customerHasActiveCollectionHold.mockResolvedValue(true)],
    ['a dispute-hold read that fails', () => customerHasActiveCollectionHold.mockRejectedValue(new Error('db down'))],
  ])('%s: neither the note nor the PDF block, even on an operator send', async (_label, arrange) => {
    // An operator send passes a plain dispute hold (holdExempt 'operator'),
    // but the customer was told billing follow-up is on hold.
    isEnabled.mockImplementation((gate) => gate === 'balanceVisibility' || gate === 'payIncludeBalance');
    openBalanceSummary.mockResolvedValue(twoOpenInvoices());
    arrange();
    mockDb(invoiceRow());

    const result = await sendInvoiceEmail('inv-1', { operatorInitiated: true, holdExempt: 'operator' });

    expect(result.ok).toBe(true);
    expect(customerHasActiveCollectionHold).toHaveBeenCalledWith('cust-1');
    expect(openBalanceSummary).not.toHaveBeenCalled();
    expect(payPageCombinedBalance).not.toHaveBeenCalled();
    expect(buildInvoicePDFBuffer.mock.calls[0][0].previous_balance).toBeUndefined();
    expect(EmailTemplates.sendTemplate.mock.calls[0][0].payload.invoice_message).toBe('Thanks for having us out!');
  });

  test('an incomplete balance read keeps the email note but prints no account total on the PDF', async () => {
    isEnabled.mockImplementation((gate) => gate === 'balanceVisibility');
    openBalanceSummary.mockResolvedValue({ total: 450, count: 2, moreCount: 0, complete: false, invoices: [{}, {}] });
    mockDb(invoiceRow());

    await sendInvoiceEmail('inv-1');

    expect(buildInvoicePDFBuffer.mock.calls[0][0].previous_balance).toBeUndefined();
    expect(EmailTemplates.sendTemplate.mock.calls[0][0].payload.invoice_message).toContain('previous balance of $450.00');
  });

  test('gate off: the PDF gets no previous balance', async () => {
    mockDb(invoiceRow());

    await sendInvoiceEmail('inv-1');

    expect(buildInvoicePDFBuffer.mock.calls[0][0].previous_balance).toBeUndefined();
  });

  test('when the Pay button would collect the whole balance, the note says this link pays everything, and names the portal and app', async () => {
    isEnabled.mockImplementation((gate) => gate === 'balanceVisibility' || gate === 'payIncludeBalance');
    openBalanceSummary.mockResolvedValue({ total: 234, count: 2, complete: true, invoices: [{}, {}] });
    payPageCombinedBalance.mockResolvedValueOnce({ invoices: [{}, {}], total: 234, combinedTotal: 384 });
    mockDb(invoiceRow());

    await sendInvoiceEmail('inv-1');

    const args = EmailTemplates.sendTemplate.mock.calls[0][0];
    expect(args.payload.invoice_message).toBe(
      "Thanks for having us out!\n\nReminder: your account also has a previous balance of $234.00 from 2 earlier invoices. You can pay everything at once from this invoice's payment link, or see each invoice in your customer portal at portal.wavespestcontrol.com or in the Waves app.",
    );
    expect(args.payload.amount_due).toBe('$150.00');
  });

  test.each([
    ['the combined charge leaves an open invoice out (payment plan, stopped reminders, micro-deposit or in-flight payment)', () => payPageCombinedBalance.mockResolvedValueOnce({ invoices: [{}], total: 117, combinedTotal: 267 })],
    ['the combined charge has the same count but other cents (a sibling changed between the reads)', () => payPageCombinedBalance.mockResolvedValueOnce({ invoices: [{}, {}], total: 233.99, combinedTotal: 383.99 })],
    ['setup would charge this invoice alone, or might not match (any account credit, capture hold)', () => payPageCombinedBalance.mockResolvedValueOnce(null)],
    ['the combined lookup fails', () => payPageCombinedBalance.mockRejectedValueOnce(new Error('stripe down'))],
  ])('both gates on but %s: the note keeps pointing at each invoice\'s own link and the PDF prints no block', async (_label, arrange) => {
    isEnabled.mockImplementation((gate) => gate === 'balanceVisibility' || gate === 'payIncludeBalance');
    openBalanceSummary.mockResolvedValue({ total: 234, count: 2, complete: true, invoices: [{}, {}] });
    arrange();
    mockDb(invoiceRow());

    await sendInvoiceEmail('inv-1');

    const message = EmailTemplates.sendTemplate.mock.calls[0][0].payload.invoice_message;
    expect(message).toContain('Each earlier invoice has its own payment link');
    expect(message).not.toContain('pay everything at once');
    // A plan, stopped, disputed or in-flight invoice is never printed in red
    // when the pay page and reminders have set it aside.
    expect(buildInvoicePDFBuffer.mock.calls[0][0].previous_balance).toBeUndefined();
  });
});
