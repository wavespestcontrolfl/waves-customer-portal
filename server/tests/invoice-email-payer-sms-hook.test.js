/**
 * The payer text hook at the tail of sendInvoiceEmail (GATE_PAYER_INVOICE_SMS). sendInvoiceEmail is the one function every
 * payer invoice email passes: the office send (invoice.js sendViaSMSAndEmail), the automatic visit-completion send
 * (complete-scheduled-service.js sendPayerInvoiceToApIfEligible, which calls sendInvoiceEmail(invoice.id) with no options) and
 * resends. The text is attempted only after the provider ACCEPTED the payer's email, and never changes the email's result.
 */

jest.mock('../services/collections/collection-hold', () => ({
  ...jest.requireActual('../services/collections/collection-hold'),
  messagingHeldByCollectionHold: jest.fn(async () => ({ held: false })),
}));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: jest.fn(() => true),
  newsletterGroupId: () => null,
  serviceGroupId: () => null,
  sendOne: jest.fn(),
}));
jest.mock('nodemailer', () => ({ createTransport: jest.fn(() => ({ sendMail: jest.fn().mockResolvedValue({}) })) }));
jest.mock('../services/email-fallback-gate', () => ({ smtpFallbackAllowed: () => false }));
jest.mock('../services/email-template-library', () => ({ sendTemplate: jest.fn() }));
jest.mock('../services/pdf/invoice-pdf', () => ({
  buildInvoicePDFBuffer: jest.fn(async () => Buffer.from('pdf-bytes')),
  buildReceiptPDFBuffer: jest.fn(),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
  invoiceShortCodePrefix: jest.fn(() => 'wpc'),
}));
jest.mock('../services/customer-contact', () => ({
  getInvoiceEmailRecipients: jest.fn(() => [{ email: 'sam@example.com', name: 'Sam', role: 'primary' }]),
  getReceiptEmailRecipients: jest.fn(),
}));
jest.mock('../services/payer', () => ({
  attachToInvoice: jest.fn(async (invoice) => { invoice.payer = { display_name: 'Pat Rowe', ap_email: 'pat@example.com' }; return invoice; }),
  payerRecipient: jest.fn(() => ({ email: 'pat@example.com', name: 'Pat Rowe', role: 'payer' })),
  freezeApEmail: jest.fn(async () => null),
}));
jest.mock('../services/estimate-deposits', () => ({
  assertInvoiceDepositSettlementReady: jest.fn(async () => {}),
  withInvoiceDepositSettlement: jest.fn(),
}));
jest.mock('../services/invoice-followups', () => ({ renderedEmailFingerprint: jest.fn(async () => ({ digest: 'd' })) }));
jest.mock('../services/payer-invoice-sms', () => ({ sendPayerInvoiceText: jest.fn(async () => ({ sent: true, code: 'sent' })) }));

const db = require('../models/db');
const EmailTemplates = require('../services/email-template-library');
const { sendPayerInvoiceText } = require('../services/payer-invoice-sms');
const { sendInvoiceEmail } = require('../services/invoice-email');

function chain({ first, count } = {}) {
  const q = {};
  ['where', 'whereRaw', 'whereIn', 'select', 'orderBy', 'limit'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.first = jest.fn(async () => first);
  q.count = jest.fn(() => q);
  q.update = jest.fn(async () => 1);
  q.then = (resolve, reject) => Promise.resolve(count || []).then(resolve, reject);
  q.catch = (reject) => Promise.resolve(count || []).catch(reject);
  return q;
}

function invoiceRow(overrides = {}) {
  return {
    id: 'inv-1',
    invoice_number: 'WPC-2026-0042',
    customer_id: 'cust-1',
    payer_id: 7,
    status: 'draft',
    total: '150.00',
    credit_applied: 0,
    token: 'tok-abc',
    service_type: 'One-Time Pest Control Service',
    line_items: [],
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  const invoice = invoiceRow();
  db.mockImplementation((table) => {
    if (table === 'invoices') return chain({ first: invoice });
    if (table === 'customers') return chain({ first: { id: 'cust-1', first_name: 'Sam', email: 'sam@example.com' } });
    if (table === 'notification_prefs') return chain({ first: null });
    if (table === 'invoice_attachments') return chain({ first: { count: 0 } });
    throw new Error(`Unexpected db table: ${table}`);
  });
  require('../services/sendgrid-mail').isConfigured.mockReturnValue(true);
  require('../services/estimate-deposits').withInvoiceDepositSettlement.mockImplementation(async (invoiceId, callback) => {
    const current = await db('invoices').where({ id: invoiceId }).first();
    return callback(db, current);
  });
  EmailTemplates.sendTemplate.mockImplementation(async ({ withProviderHandoff }) => {
    const verdict = await withProviderHandoff(jest.fn());
    return verdict.ok ? { sent: true, message: { id: 'em-1', provider_message_id: 'sg-1' } } : { sent: false, reason: verdict.reason };
  });
});

describe('payer invoice email accepted', () => {
  test('the automatic completion send (sendInvoiceEmail with only the invoice id) texts the payer', async () => {
    const result = await sendInvoiceEmail('inv-1');
    expect(result).toMatchObject({ ok: true, recipient: { email: 'pat@example.com', role: 'payer' } });
    expect(sendPayerInvoiceText).toHaveBeenCalledTimes(1);
    expect(sendPayerInvoiceText).toHaveBeenCalledWith({
      invoiceId: 'inv-1',
      operatorInitiated: false,
      emailMessageId: 'em-1',
      emailAcceptedAt: expect.any(Date),
    });
    // The text is attempted after the email handoff, never before it.
    expect(EmailTemplates.sendTemplate.mock.invocationCallOrder[0]).toBeLessThan(sendPayerInvoiceText.mock.invocationCallOrder[0]);
  });

  test('an office send passes its operator marker on', async () => {
    await sendInvoiceEmail('inv-1', { operatorInitiated: true });
    expect(sendPayerInvoiceText).toHaveBeenCalledWith(expect.objectContaining({ invoiceId: 'inv-1', operatorInitiated: true }));
  });

  test('a send and its deduped replay hand the text the same email row id', async () => {
    const originalAt = new Date('2026-11-03T15:00:00Z');
    await sendInvoiceEmail('inv-1');
    EmailTemplates.sendTemplate.mockImplementation(async ({ withProviderHandoff }) => {
      await withProviderHandoff(jest.fn());
      // The library's dedupe returns the ORIGINAL stored row.
      return { sent: true, deduped: true, message: { id: 'em-1', provider_message_id: 'sg-1', sent_at: originalAt } };
    });
    await sendInvoiceEmail('inv-1');
    expect(sendPayerInvoiceText).toHaveBeenCalledTimes(2);
    const [fresh, replay] = sendPayerInvoiceText.mock.calls.map(([args]) => args);
    expect(fresh.emailMessageId).toBe('em-1');
    expect(replay.emailMessageId).toBe('em-1');
    expect(replay.emailAcceptedAt).toEqual(originalAt);
  });

  test('a deduped email with neither a row id nor a stored time is not provably a new episode: no text', async () => {
    EmailTemplates.sendTemplate.mockImplementation(async ({ withProviderHandoff }) => {
      await withProviderHandoff(jest.fn());
      return { sent: true, deduped: true, message: { provider_message_id: 'old' } };
    });
    await expect(sendInvoiceEmail('inv-1')).resolves.toMatchObject({ ok: true, deduped: true });
    expect(sendPayerInvoiceText).not.toHaveBeenCalled();
  });
});

describe('no payer text', () => {
  test('an email the provider did not accept sends no text', async () => {
    EmailTemplates.sendTemplate.mockResolvedValue({ sent: false, reason: 'suppressed' });
    await expect(sendInvoiceEmail('inv-1')).resolves.toMatchObject({ ok: false });
    expect(sendPayerInvoiceText).not.toHaveBeenCalled();
  });

  test('a refused handoff sends no text', async () => {
    const refusing = invoiceRow({ status: 'void' });
    const first = db.getMockImplementation();
    let calls = 0;
    db.mockImplementation((table) => {
      if (table === 'invoices') { calls += 1; return chain({ first: calls > 1 ? refusing : invoiceRow() }); }
      return first(table);
    });
    const result = await sendInvoiceEmail('inv-1');
    expect(result.ok).toBe(false);
    expect(sendPayerInvoiceText).not.toHaveBeenCalled();
  });

  test('an operator\'s one-off recipient sends no payer text', async () => {
    await expect(sendInvoiceEmail('inv-1', { recipientOverride: { email: 'bookkeeper@example.com' } })).resolves.toMatchObject({ ok: true });
    expect(sendPayerInvoiceText).not.toHaveBeenCalled();
  });

  test('the Intelligence Bar card preview sends no text', async () => {
    await expect(sendInvoiceEmail('inv-1', { previewOnly: true })).resolves.toMatchObject({ ok: true, preview: true });
    expect(sendPayerInvoiceText).not.toHaveBeenCalled();
  });
});

describe('the text never changes the email result', () => {
  test('a text that throws leaves the email result as it was', async () => {
    const baseline = await sendInvoiceEmail('inv-1');
    sendPayerInvoiceText.mockRejectedValueOnce(new Error('sms exploded'));
    const afterFailure = await sendInvoiceEmail('inv-1');
    expect(afterFailure.ok).toBe(true);
    expect({ ...afterFailure }).toEqual({ ...baseline });
  });

  test('a refused text leaves the email result as it was', async () => {
    const baseline = await sendInvoiceEmail('inv-1');
    sendPayerInvoiceText.mockResolvedValueOnce({ sent: false, code: 'SUPPRESSED_OPT_OUT', reason: 'Recipient is suppressed' });
    await expect(sendInvoiceEmail('inv-1')).resolves.toEqual(baseline);
  });

  test('the invoice row is not written by the text hook', async () => {
    const writes = [];
    const first = db.getMockImplementation();
    db.mockImplementation((table) => {
      const q = first(table);
      if (table === 'invoices') q.update = jest.fn(async (values) => { writes.push(values); return 1; });
      return q;
    });
    await sendInvoiceEmail('inv-1');
    // Only the email's own delivery stamp (email_sent_at) is written; nothing from the text.
    expect(writes.every((values) => Object.keys(values).every((key) => ['email_sent_at', 'updated_at'].includes(key)))).toBe(true);
  });
});

describe('the completion path reaches the hook', () => {
  const source = require('fs').readFileSync(require('path').join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
  const start = source.indexOf('const sendPayerInvoiceToApIfEligible = async () => {');
  const block = source.slice(start, source.indexOf('\n    };\n', start));

  test('it calls sendInvoiceEmail with the invoice id alone: no override, so the hook fires', () => {
    expect(start).toBeGreaterThan(0);
    expect(block).toContain('InvoiceEmail.sendInvoiceEmail(invoice.id)');
    expect(block).not.toMatch(/recipientOverride/);
  });

  test('a backfill completion skips the AP send, so it sends no payer text either', () => {
    expect(block).toMatch(/invoice\.payer_id && !payerInvoiceAlreadyDelivered && !isBackfillCompletion/);
    // The only call to sendInvoiceEmail in the block sits inside that guarded branch.
    expect(block.match(/sendInvoiceEmail\(/g)).toHaveLength(1);
    expect(block.indexOf('!isBackfillCompletion')).toBeLessThan(block.indexOf('sendInvoiceEmail('));
  });
});
