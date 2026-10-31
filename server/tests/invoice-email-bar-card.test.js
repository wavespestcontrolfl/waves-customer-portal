/**
 * sendInvoiceEmail for the Intelligence Bar's email card (send_invoice channel 'email', GATE_IB_INVOICE_EMAIL):
 *   - previewOnly builds the email as a send builds it and returns its fingerprint: no claim, no short link, no PDF, no send
 *   - the send refuses a different address, a different rendered email, or a changed template, before the provider
 *   - the card's live owner check runs again at the provider handoff
 *   - a bar send never falls back to SMTP
 * Synthetic names only.
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
  isDefiniteRejection: jest.requireActual('../services/sendgrid-mail').isDefiniteRejection,
}));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(),
  thrownSendDeliveryOutcome: jest.requireActual('../services/email-template-library').thrownSendDeliveryOutcome,
}));
jest.mock('../services/pdf/invoice-pdf', () => ({
  buildInvoicePDFBuffer: jest.fn(async () => Buffer.from('pdf-bytes')),
  buildReceiptPDFBuffer: jest.fn(),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async () => 'https://wvs.example/p/abc'),
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
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false), gates: {} }));
jest.mock('../services/collections/collection-hold', () => ({
  ...jest.requireActual('../services/collections/collection-hold'),
  messagingHeldByCollectionHold: jest.fn(async () => ({ held: false })),
}));
jest.mock('../utils/customer-comms-lock', () => ({ tryLockCustomerComms: jest.fn(async () => true) }));
jest.mock('../services/invoice-helpers', () => ({
  ...jest.requireActual('../services/invoice-helpers'),
  selfPayAtDispatch: jest.fn(() => async () => ({ ok: true })),
  visitRefusesSettlement: jest.fn(async () => null),
}));
// The reminder card's fingerprint (its own tests cover the render): one digest per payload.
jest.mock('../services/invoice-followups', () => ({
  renderedEmailFingerprint: jest.fn(async (templateKey, payload) => ({
    subject: `Invoice ${payload.invoice_number}`, text: `Hi ${payload.first_name}. Pay online: ${payload.invoice_url}`,
    contentHash: 'hash-1', digest: `digest:${payload.first_name}:${payload.invoice_url}:${payload.amount_due}`,
  })),
}));

const db = require('../models/db');
const { tryLockCustomerComms } = require('../utils/customer-comms-lock');
const { getInvoiceEmailRecipients } = require('../services/customer-contact');
const EmailTemplates = require('../services/email-template-library');
const { shortenOrPassthrough } = require('../services/short-url');
const { buildInvoicePDFBuffer } = require('../services/pdf/invoice-pdf');
const { renderedEmailFingerprint } = require('../services/invoice-followups');
const { sendInvoiceEmail } = require('../services/invoice-email');

function chain({ first, result } = {}) {
  const q = {};
  ['where', 'whereRaw', 'whereIn', 'select', 'orderBy', 'limit'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.first = jest.fn(async () => first);
  q.count = jest.fn(() => q);
  q.update = jest.fn(async () => 1);
  q.then = (resolve, reject) => Promise.resolve(result || []).then(resolve, reject);
  q.catch = (reject) => Promise.resolve(result || []).catch(reject);
  return q;
}

const invoice = (overrides = {}) => ({
  id: 'inv-1', invoice_number: 'WPC-2099-0001', customer_id: 'cust-1', status: 'sending', total: '150.00', credit_applied: 0,
  token: 'token-xyz', service_type: 'Quarterly Pest Control', line_items: [], notes: '', email_message: '', send_claim_token: null,
  ...overrides,
});

function mockDb(row) {
  db.transaction = jest.fn(async (callback) => callback(db));
  db.mockImplementation((table) => {
    if (table === 'invoices') return chain({ first: row });
    if (table === 'customers') return chain({ first: { id: 'cust-1', first_name: 'Pat', email: 'customer@example.com' } });
    if (table === 'notification_prefs') return chain({ first: null });
    if (table === 'invoice_attachments') return chain({ first: { count: 0 } });
    throw new Error(`Unexpected db table: ${table}`);
  });
}

// The library's handoff as sendTemplate runs it: the caller's boundary decides whether the provider is called.
const provider = jest.fn(async () => {});
function sendTemplateThroughHandoff(beforeHandoff = () => {}) {
  EmailTemplates.sendTemplate.mockImplementation(async ({ withProviderHandoff }) => {
    beforeHandoff();
    const verdict = await withProviderHandoff(provider);
    return verdict.ok ? { sent: true, message: { provider_message_id: 'sg-1' } } : { sent: false, blocked: true, reason: verdict.reason };
  });
}

const PIN = 'digest:Pat:[pay link]:$150.00';

beforeEach(() => {
  jest.clearAllMocks();
  sendTemplateThroughHandoff();
});

describe('previewOnly (the card)', () => {
  test('returns the email the send would build, with the pay link as a token, and writes nothing', async () => {
    // A row another delivery has claimed: the card never needs (or checks) a claim.
    mockDb(invoice({ status: 'draft', send_claim_token: 'someone-else' }));
    const result = await sendInvoiceEmail('inv-1', { previewOnly: true, cc: 'Manager@Example.com' });

    expect(result).toEqual({
      ok: true, preview: true, recipient: { email: 'customer@example.com', name: 'Pat', role: 'primary' }, cc: ['manager@example.com'],
      email: expect.objectContaining({ subject: 'Invoice WPC-2099-0001', contentHash: 'hash-1', digest: PIN }),
    });
    expect(renderedEmailFingerprint).toHaveBeenCalledWith('invoice.sent', expect.objectContaining({ invoice_url: '[pay link]', first_name: 'Pat' }));
    expect(shortenOrPassthrough).not.toHaveBeenCalled();
    expect(buildInvoicePDFBuffer).not.toHaveBeenCalled();
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
  });
});

describe('the bar send (expectedEmailDigest)', () => {
  const barOptions = (extra = {}) => ({ expectedRecipientEmail: 'customer@example.com', expectedEmailDigest: PIN, expectedContentHash: 'hash-1', ...extra });

  test('the same email sends with the template pin, the real pay link and the CC', async () => {
    mockDb(invoice());
    const result = await sendInvoiceEmail('inv-1', barOptions({ cc: 'manager@example.com' }));
    expect(result).toMatchObject({ ok: true, cc: ['manager@example.com'] });
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'invoice.sent', expectedContentHash: 'hash-1', to: 'customer@example.com', cc: ['manager@example.com'],
      payload: expect.objectContaining({ invoice_url: 'https://wvs.example/p/abc' }),
    }));
  });

  test.each([
    ['a different address', { expectedRecipientEmail: 'old@example.com' }, 'recipient_changed'],
    ['a different email (the greeting, amount or wording changed)', { expectedEmailDigest: 'digest:Sam:[pay link]:$150.00' }, 'email_content_changed'],
  ])('%s refuses before the provider, nothing sent', async (_label, extra, code) => {
    mockDb(invoice());
    await expect(sendInvoiceEmail('inv-1', barOptions(extra))).resolves.toMatchObject({ ok: false, code, deliveryOutcome: 'not_sent' });
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
  });

  test('a template changed after the render check refuses as email_content_changed; any other failure never falls back to SMTP', async () => {
    mockDb(invoice());
    EmailTemplates.sendTemplate.mockRejectedValueOnce(new Error('The reviewed email content changed. Review the message again before sending.'));
    await expect(sendInvoiceEmail('inv-1', barOptions())).resolves.toMatchObject({ ok: false, code: 'email_content_changed', deliveryOutcome: 'not_sent' });

    mockDb(invoice());
    EmailTemplates.sendTemplate.mockRejectedValueOnce(Object.assign(new Error('template not found'), { code: 'EMAIL_TEMPLATE_UNAVAILABLE' }));
    await expect(sendInvoiceEmail('inv-1', barOptions())).resolves.toMatchObject({ ok: false, error: 'template not found', deliveryOutcome: 'not_sent' });
    expect(require('../services/sendgrid-mail').sendOne).not.toHaveBeenCalled();
  });

  test('a provider timeout after the handoff began is uncertain, never a plain failure; a definite rejection is not sent', async () => {
    mockDb(invoice());
    EmailTemplates.sendTemplate.mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { providerHandoffStarted: true }));
    await expect(sendInvoiceEmail('inv-1', barOptions())).resolves.toMatchObject({ ok: false, deliveryOutcome: 'uncertain' });

    mockDb(invoice());
    EmailTemplates.sendTemplate.mockRejectedValueOnce(Object.assign(new Error('Bad Request'), { providerHandoffStarted: true, status: 400 }));
    await expect(sendInvoiceEmail('inv-1', barOptions())).resolves.toMatchObject({ ok: false, deliveryOutcome: 'not_sent' });
  });

  test('the address is read again at the handoff under the customer-comms lock: changed while preparing, or a busy lock, sends nothing', async () => {
    mockDb(invoice());
    // The customer's invoice address changes after the email was prepared, before the handoff.
    sendTemplateThroughHandoff(() => getInvoiceEmailRecipients.mockReturnValue([{ email: 'new@example.com', name: 'Pat', role: 'primary' }]));
    await expect(sendInvoiceEmail('inv-1', barOptions())).resolves.toMatchObject({ ok: false, code: 'recipient_changed', deliveryOutcome: 'not_sent' });
    expect(tryLockCustomerComms).toHaveBeenCalledWith(db, 'cust-1');
    expect(provider).not.toHaveBeenCalled();

    getInvoiceEmailRecipients.mockReturnValue([{ email: 'customer@example.com', name: 'Pat', role: 'primary' }]);
    sendTemplateThroughHandoff();
    tryLockCustomerComms.mockResolvedValueOnce(false);
    mockDb(invoice());
    await expect(sendInvoiceEmail('inv-1', barOptions())).resolves.toMatchObject({ ok: false, code: 'recipient_busy', deliveryOutcome: 'not_sent' });
    expect(provider).not.toHaveBeenCalled();

    // A page send (no approved address) takes no comms lock.
    tryLockCustomerComms.mockClear();
    mockDb(invoice());
    await expect(sendInvoiceEmail('inv-1', {})).resolves.toMatchObject({ ok: true });
    expect(tryLockCustomerComms).not.toHaveBeenCalled();
    expect(provider).toHaveBeenCalledTimes(1);
  });

  test('the card\'s live owner check runs at the provider handoff on the locked row; a refusal or a throw sends nothing', async () => {
    const verifyOwner = jest.fn(async () => null);
    mockDb(invoice());
    await expect(sendInvoiceEmail('inv-1', barOptions({ verifyOwner }))).resolves.toMatchObject({ ok: true });
    expect(verifyOwner).toHaveBeenCalledWith(expect.objectContaining({ id: 'inv-1', status: 'sending' }), db);

    for (const answer of [async () => 'This invoice is billed to a payer, not the customer.', async () => { throw new Error('db down'); }]) {
      mockDb(invoice());
      const result = await sendInvoiceEmail('inv-1', barOptions({ verifyOwner: jest.fn(answer) }));
      expect(result).toMatchObject({ ok: false, code: 'approved_version_changed', deliveryOutcome: 'not_sent' });
    }
  });
});
