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
// A routed receipt (billingDeliveryCategory) rides the shared billing email
// authority (owner ruling 2026-09-27). Its own locks, rechecks and suppression
// reads are pinned in billing-channel-email-authority.test.js and the
// Postgres suite; here it authorizes the billing recipient, and a test
// overrides it to refuse at the first read or at the provider handoff.
jest.mock('../services/billing-channel-email-authority', () => ({
  loadBillingEmailContext: jest.fn(),
  dispatchUnderBillingEmailAuthority: jest.fn(),
}));

const db = require('../models/db');
const EmailTemplates = require('../services/email-template-library');
const BillingEmailAuthority = require('../services/billing-channel-email-authority');
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
    customer_id: 'cust-1',
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

let invoiceRow;
describe('sendReceiptEmail idempotency', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    BillingEmailAuthority.loadBillingEmailContext.mockReset().mockResolvedValue({
      category: 'payment_receipt',
      recipient: { email: 'Billing@Example.com', name: 'Jordan', role: 'billing' },
      recipientEmail: 'billing@example.com',
    });
    BillingEmailAuthority.dispatchUnderBillingEmailAuthority.mockReset()
      .mockImplementation(async ({ dispatch, state }) => {
        state.handoffStarted = true;
        await dispatch('authority-trx');
        state.providerAccepted = true;
        return { ok: true };
      });
    invoiceRow = paidInvoiceRow();
    const invoice = invoiceRow;
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

  const routed = { idempotencyKey: 'receipt_email_auto:inv-1', billingDeliveryCategory: 'payment_receipt' };

  test('a routed receipt goes to the authority\'s billing recipient and dispatches under its locked recheck', async () => {
    const dispatch = jest.fn();
    EmailTemplates.sendTemplate.mockImplementationOnce(async ({ withProviderHandoff }) => {
      const handoff = await withProviderHandoff(dispatch);
      return { sent: handoff.ok, message: { provider_message_id: 'sg-routed' } };
    });

    const result = await sendReceiptEmail('inv-1', routed);

    expect(result).toEqual({ ok: true, messageId: 'sg-routed' });
    const input = {
      customerId: 'cust-1', invoiceId: 'inv-1', channel: 'email',
      metadata: { billingDeliveryCategory: 'payment_receipt' },
    };
    expect(BillingEmailAuthority.loadBillingEmailContext).toHaveBeenCalledWith(input);
    expect(EmailTemplates.sendTemplate.mock.calls[0][0].to).toBe('billing@example.com');
    expect(BillingEmailAuthority.dispatchUnderBillingEmailAuthority).toHaveBeenCalledWith(expect.objectContaining({
      input, recipientEmail: 'billing@example.com', templateKey: 'invoice.receipt',
    }));
    expect(dispatch).toHaveBeenCalledWith('authority-trx');
  });

  test('the routed pre-send check refuses an invoice that is no longer paid, on the authority\'s transaction', async () => {
    EmailTemplates.sendTemplate.mockImplementationOnce(async ({ withProviderHandoff }) => {
      await withProviderHandoff(jest.fn());
      return { sent: true, message: { provider_message_id: 'sg-routed' } };
    });
    await sendReceiptEmail('inv-1', routed);
    const { preSendCheck } = BillingEmailAuthority.dispatchUnderBillingEmailAuthority.mock.calls[0][0];

    const database = jest.fn(() => chain({ first: { status: 'refunded' } }));
    await expect(preSendCheck({ channel: 'email', database })).resolves.toMatchObject({ ok: false, code: 'INVOICE_NOT_PAID' });
    expect(database).toHaveBeenCalledWith('invoices');
    const paid = jest.fn(() => chain({ first: { status: 'paid' } }));
    await expect(preSendCheck({ channel: 'email', database: paid })).resolves.toEqual({ ok: true });
  });

  test.each([
    ['an explicit receipt choice without Email', 'BILLING_PREFERENCES_CHANGED',
      { ok: false, skipped: true, error: 'billing_email_not_selected', code: 'billing_email_not_selected' }],
    ['no billing address', 'NO_EMAIL_RECIPIENT', { ok: false, error: 'No receipt recipient email' }],
    ['an invoice moved to a payer since', 'INVOICE_PAYER_BILLED',
      { ok: false, error: 'INVOICE_PAYER_BILLED', code: 'receipt_handoff_aborted' }],
  ])('%s at the routed first read is the receipt callers\' usual refusal, and sends nothing', async (_label, code, expected) => {
    BillingEmailAuthority.loadBillingEmailContext.mockResolvedValueOnce({ error: { code, reason: code } });

    await expect(sendReceiptEmail('inv-1', routed)).resolves.toEqual(expected);
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
  });

  test('an unreadable routed context is the retryable prefs-unavailable failure', async () => {
    BillingEmailAuthority.loadBillingEmailContext.mockRejectedValueOnce(new Error('connection reset'));

    await expect(sendReceiptEmail('inv-1', routed)).resolves.toEqual({
      ok: false, error: 'Receipt delivery preferences unavailable', code: 'billing_prefs_unavailable',
    });
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
  });

  test.each([
    ['a staff do-not-contact is a blocked send', { code: 'SUPPRESSED_MANUAL_DNC', reason: 'manual_dnc' },
      { ok: false, error: 'Suppressed: manual_dnc', blocked: true }],
    ['a choice that moved mid-send is an aborted handoff', {
      code: 'BILLING_PREFERENCES_CHANGED', reason: 'Email is not selected for this billing category',
    }, { ok: false, error: 'Email is not selected for this billing category', code: 'receipt_handoff_aborted' }],
    ['a no-longer-paid invoice is an aborted handoff', { code: 'INVOICE_NOT_PAID', reason: 'Invoice is no longer paid' },
      { ok: false, error: 'Invoice is no longer paid', code: 'receipt_handoff_aborted' }],
  ])('at the routed provider handoff, %s', async (_label, boundaryBlock, expected) => {
    BillingEmailAuthority.dispatchUnderBillingEmailAuthority.mockImplementationOnce(async ({ state }) => {
      state.boundaryBlock = boundaryBlock;
      return { ok: false };
    });
    const dispatch = jest.fn();
    EmailTemplates.sendTemplate.mockImplementationOnce(async ({ withProviderHandoff }) => {
      await withProviderHandoff(dispatch);
      return { sent: false, aborted: true, reason: 'aborted_by_caller_before_dispatch' };
    });

    await expect(sendReceiptEmail('inv-1', routed)).resolves.toEqual(expected);
    expect(dispatch).not.toHaveBeenCalled();
  });

  test('a payer-billed receipt goes to the payer\'s AP inbox, outside the authority', async () => {
    invoiceRow.payer_id = 'payer-1';
    const PayerService = require('../services/payer');
    jest.spyOn(PayerService, 'attachToInvoice').mockImplementation(async (invoice) => {
      invoice.payer = { id: 'payer-1' };
    });
    jest.spyOn(PayerService, 'payerRecipient').mockReturnValue({ email: 'ap@payer.example.com', name: 'AP', role: 'payer' });
    EmailTemplates.sendTemplate.mockResolvedValueOnce({ sent: true, message: { provider_message_id: 'sg-ap' } });

    await expect(sendReceiptEmail('inv-1', routed)).resolves.toEqual({ ok: true, messageId: 'sg-ap' });
    expect(BillingEmailAuthority.loadBillingEmailContext).not.toHaveBeenCalled();
    const args = EmailTemplates.sendTemplate.mock.calls[0][0];
    expect(args.to).toBe('ap@payer.example.com');
    expect(args.withProviderHandoff).toBeUndefined();
  });

  test('does not report success when the provider handoff aborts before dispatch', async () => {
    EmailTemplates.sendTemplate.mockResolvedValueOnce({
      sent: false,
      aborted: true,
      reason: 'Receipt ownership changed before provider handoff',
    });

    const result = await sendReceiptEmail('inv-1', {
      idempotencyKey: 'receipt_email_auto:inv-1',
      billingDeliveryCategory: 'payment_receipt',
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'receipt_handoff_aborted',
      error: 'Receipt ownership changed before provider handoff',
    });
  });
});
