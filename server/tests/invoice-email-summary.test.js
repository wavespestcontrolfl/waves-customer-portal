/**
 * sendInvoiceEmail surfaces the customer-facing service summary (invoice.notes)
 * in the email — both as a SendGrid template variable and in the rendered body —
 * so the AI-written / operator-edited summary reaches the customer, not just the
 * attached PDF.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: jest.fn(() => true),
  newsletterGroupId: () => null,
  serviceGroupId: () => null,
  sendOne: jest.fn(),
}));
jest.mock('nodemailer', () => ({ createTransport: jest.fn(() => ({ sendMail: jest.fn().mockResolvedValue({}) })) }));
jest.mock('../services/email-fallback-gate', () => ({ smtpFallbackAllowed: () => true }));
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
jest.mock('../services/estimate-deposits', () => ({
  assertInvoiceDepositSettlementReady: jest.fn(async () => {}),
  withInvoiceDepositSettlement: jest.fn(async (invoiceId, callback) => {
    const database = require('../models/db');
    const current = await database('invoices').where({ id: invoiceId }).first();
    return callback(database, current);
  }),
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
    require('../services/sendgrid-mail').isConfigured.mockReturnValue(true);
    EmailTemplates.sendTemplate.mockResolvedValue({ sent: true, message: { provider_message_id: 'sg-1' } });
    require('../services/estimate-deposits').withInvoiceDepositSettlement.mockImplementation(async (invoiceId, callback) => {
      const current = await db('invoices').where({ id: invoiceId }).first();
      return callback(db, current);
    });
  });

  test('refuses an email caller holding a replaced claim', async () => {
    mockDb(invoiceRow({ status: 'sending', send_claim_token: 'replacement' }));
    await expect(sendInvoiceEmail('inv-1', { claimToken: 'original' }))
      .resolves.toMatchObject({ ok: false, code: 'send_claim_lost' });
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
  });

  test('rechecks captured ownership at provider handoff after rendering', async () => {
    mockDb(invoiceRow({ status: 'sending', send_claim_token: 'original' }));
    const dispatch = jest.fn();
    EmailTemplates.sendTemplate.mockImplementationOnce(async ({ withProviderHandoff }) => {
      mockDb(invoiceRow({ status: 'sending', send_claim_token: 'replacement' }));
      const verdict = await withProviderHandoff(dispatch);
      return { sent: verdict.ok, reason: verdict.reason };
    });
    await expect(sendInvoiceEmail('inv-1', { claimToken: 'original' }))
      .resolves.toMatchObject({ ok: false, error: expect.stringMatching(/claim changed/) });
    expect(dispatch).not.toHaveBeenCalled();
  });

  test('rechecks sendable status at provider handoff after rendering', async () => {
    mockDb(invoiceRow({ status: 'sending', send_claim_token: 'original' }));
    const dispatch = jest.fn();
    EmailTemplates.sendTemplate.mockImplementationOnce(async ({ withProviderHandoff }) => {
      mockDb(invoiceRow({ status: 'void', send_claim_token: 'original' }));
      const verdict = await withProviderHandoff(dispatch);
      return { sent: verdict.ok, reason: verdict.reason };
    });

    await expect(sendInvoiceEmail('inv-1', { claimToken: 'original' }))
      .resolves.toMatchObject({ ok: false, error: expect.stringMatching(/no longer sendable.*void/i) });
    expect(dispatch).not.toHaveBeenCalled();
  });

  test.each(['draft', 'scheduled', 'sent', 'viewed', 'overdue', 'sending'])(
    'allows %s at the locked provider boundary',
    async (status) => {
      const claimToken = status === 'sending' ? 'active-claim' : null;
      mockDb(invoiceRow({ status, send_claim_token: claimToken }));
      const dispatch = jest.fn();
      EmailTemplates.sendTemplate.mockImplementationOnce(async ({ withProviderHandoff }) => {
        const verdict = await withProviderHandoff(dispatch);
        return { sent: verdict.ok, reason: verdict.reason };
      });

      const options = {
        recipientOverride: { email: 'office@example.com' },
        ...(claimToken ? { claimToken } : {}),
      };
      await expect(sendInvoiceEmail('inv-1', options)).resolves.toMatchObject({ ok: true });
      expect(dispatch).toHaveBeenCalledTimes(1);
    },
  );

  test('accepted email cannot stamp or freeze payer data over a replacement claim', async () => {
    const invoice = invoiceRow({ status: 'sending', send_claim_token: 'original' });
    mockDb(invoice);
    const stamp = jest.fn();
    EmailTemplates.sendTemplate.mockImplementationOnce(async () => {
      invoice.send_claim_token = 'replacement';
      const previousDb = db.getMockImplementation();
      db.mockImplementation((table) => {
        if (table !== 'invoices') return previousDb(table);
        let expected;
        const q = chain({ first: invoice });
        q.where = jest.fn((values) => { expected = values; return q; });
        q.update = jest.fn(async (values) => {
          if (expected.send_claim_token !== invoice.send_claim_token) return 0;
          stamp(values);
          return 1;
        });
        return q;
      });
      return { sent: true, message: { provider_message_id: 'accepted-old' } };
    });
    await expect(sendInvoiceEmail('inv-1', { claimToken: 'original' })).resolves.toMatchObject({ ok: true });
    expect(stamp).not.toHaveBeenCalled();
    expect(require('../services/payer').freezeApEmail).not.toHaveBeenCalled();
  });

  test('does not freeze payer data when the ownership-guarded delivery stamp fails', async () => {
    mockDb(invoiceRow({ status: 'sending', send_claim_token: 'original' }));
    const previousDb = db.getMockImplementation();
    db.mockImplementation((table) => {
      const q = previousDb(table);
      if (table === 'invoices') q.update = jest.fn().mockRejectedValue(new Error('stamp database unavailable'));
      return q;
    });
    await expect(sendInvoiceEmail('inv-1', { claimToken: 'original' })).resolves.toMatchObject({ ok: true });
    expect(require('../services/payer').freezeApEmail).not.toHaveBeenCalled();
  });

  test('passes the invoice notes through as the invoice_summary template variable', async () => {
    const invoice = invoiceRow();
    mockDb(invoice);

    const result = await sendInvoiceEmail('inv-1');

    expect(result.ok).toBe(true);
    const args = EmailTemplates.sendTemplate.mock.calls[0][0];
    expect(args.payload.invoice_summary).toBe(invoice.notes);
  });

  test('does not render or dispatch an invoice email while its deposit is held', async () => {
    mockDb(invoiceRow());
    const fence = jest.spyOn(require('../services/estimate-deposits'), 'assertInvoiceDepositSettlementReady')
      .mockRejectedValue(Object.assign(new Error('Deposit awaiting reconciliation'), {
        code: 'DEPOSIT_RECONCILIATION_REQUIRED',
      }));
    try {
      expect(await sendInvoiceEmail('inv-1')).toEqual({
        ok: false, error: 'Deposit awaiting reconciliation', code: 'DEPOSIT_RECONCILIATION_REQUIRED',
      });
      expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
    } finally {
      fence.mockRestore();
    }
  });

  test.each([
    ['reduced balance', { total: '101.00', line_items: [{ type: 'deposit_credit', amount: -49 }] }],
    ['changed lines with the same total', { line_items: [{ type: 'deposit_credit', amount: -49 }, { amount: 49 }] }],
  ])('blocks stale rendered email after %s', async (_label, changes) => {
    mockDb(invoiceRow());
    const dispatch = jest.fn();
    EmailTemplates.sendTemplate.mockImplementationOnce(async ({ withProviderHandoff }) => {
      mockDb(invoiceRow(changes));
      const verdict = await withProviderHandoff(dispatch);
      return { sent: verdict.ok, reason: verdict.reason };
    });
    const result = await sendInvoiceEmail('inv-1');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/balance changed/);
    expect(dispatch).not.toHaveBeenCalled();
  });

  test('dispatches an unchanged rendered invoice', async () => {
    mockDb(invoiceRow());
    const dispatch = jest.fn();
    EmailTemplates.sendTemplate.mockImplementationOnce(async ({ withProviderHandoff }) => {
      const verdict = await withProviderHandoff(dispatch);
      return { sent: verdict.ok, reason: verdict.reason };
    });
    expect((await sendInvoiceEmail('inv-1', { recipientOverride: { email: 'office@example.com' } })).ok).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  test('a commit failure after provider acceptance preserves the delivered result', async () => {
    const invoice = invoiceRow();
    mockDb(invoice);
    const dispatch = jest.fn(async () => {});
    EmailTemplates.sendTemplate.mockImplementationOnce(async ({ withProviderHandoff }) => {
      const verdict = await withProviderHandoff(dispatch);
      return { sent: verdict.ok, message: { provider_message_id: 'sg-accepted' } };
    });
    require('../services/estimate-deposits').withInvoiceDepositSettlement.mockImplementationOnce(async (_invoiceId, callback) => {
      await callback(db, invoice);
      throw new Error('commit connection lost');
    });

    await expect(sendInvoiceEmail('inv-1', { recipientOverride: { email: 'office@example.com' } }))
      .resolves.toMatchObject({ ok: true, messageId: 'sg-accepted' });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  test('a provider error is rethrown to the template library for delivery classification', async () => {
    mockDb(invoiceRow());
    const providerError = new Error('provider socket closed without a response');
    let providerErrorPropagated = false;
    EmailTemplates.sendTemplate.mockImplementationOnce(async ({ withProviderHandoff }) => {
      try {
        await withProviderHandoff(async () => { throw providerError; });
      } catch (err) {
        providerErrorPropagated = err === providerError;
        throw err;
      }
      throw new Error('provider error was misclassified as a pre-dispatch refusal');
    });

    await expect(sendInvoiceEmail('inv-1', { recipientOverride: { email: 'office@example.com' } }))
      .resolves.toMatchObject({ ok: false, error: providerError.message });
    expect(providerErrorPropagated).toBe(true);
  });

  test('does not email a pay link for an invoice already covered in full', async () => {
    mockDb(invoiceRow({ total: '0.00' }));
    const dispatch = jest.fn();
    EmailTemplates.sendTemplate.mockImplementationOnce(async ({ withProviderHandoff }) => {
      const verdict = await withProviderHandoff(dispatch);
      return { sent: verdict.ok, reason: verdict.reason };
    });

    await expect(sendInvoiceEmail('inv-1', { recipientOverride: { email: 'office@example.com' } }))
      .resolves.toMatchObject({ ok: false, error: expect.stringMatching(/balance changed/) });
    expect(dispatch).not.toHaveBeenCalled();
  });

  test('SMTP rejects a balance changed during PDF rendering', async () => {
    const previousPassword = process.env.GOOGLE_SMTP_PASSWORD;
    process.env.GOOGLE_SMTP_PASSWORD = 'synthetic-test-password';
    require('../services/sendgrid-mail').isConfigured.mockReturnValue(false);
    mockDb(invoiceRow());
    require('../services/pdf/invoice-pdf').buildInvoicePDFBuffer.mockImplementationOnce(async () => {
      mockDb(invoiceRow({ total: '101.00' }));
      return Buffer.from('old-pdf');
    });
    try {
      const result = await sendInvoiceEmail('inv-1');
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/balance changed/);
      expect(require('nodemailer').createTransport.mock.results[0].value.sendMail).not.toHaveBeenCalled();
    } finally {
      if (previousPassword === undefined) delete process.env.GOOGLE_SMTP_PASSWORD;
      else process.env.GOOGLE_SMTP_PASSWORD = previousPassword;
    }
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
