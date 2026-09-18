// Real PostgreSQL transactions; provider calls use synthetic stubs only.
const postgres = process.env.DATABASE_URL ? describe : describe.skip;
let mockConnection;
jest.mock('../models/db', () => new Proxy((...args) => mockConnection(...args), {
  get(_target, key) {
    const value = mockConnection?.[key];
    return typeof value === 'function' ? value.bind(mockConnection) : value;
  },
}));
jest.mock('../services/invoice-email', () => ({ sendInvoiceEmail: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: async (url) => url, invoiceShortCodePrefix: () => 'test' }));
jest.mock('../routes/admin-sms-templates', () => ({ isTemplateActive: async () => true, getTemplate: async () => 'Your invoice: {pay_url}' }));
jest.mock('../services/customer-credit', () => ({ autoApplyAccountCreditIfEnabled: async () => null, restoreAccountCreditForVoidedInvoice: async () => null }));
jest.mock('../services/invoice-followups', () => ({ scheduleForInvoice: jest.fn(), stopForInvoice: jest.fn() }));
jest.mock('../services/invoice-issued-closeout', () => ({ closeOutVisitForIssuedInvoice: jest.fn(async () => null), issuedCloseoutOwnsRecord: () => false }));
jest.mock('../services/inspection-credit', () => ({ reverseInspectionCreditForBooking: async () => null }));
jest.mock('../services/annual-prepay-renewals', () => ({ syncTermForInvoicePayment: async () => null }));
jest.mock('../services/lead-estimate-link', () => ({ convertLeadFromEvent: async () => null }));
jest.mock('../config/feature-gates', () => ({ isEnabled: () => false }));
const { randomUUID } = require('node:crypto');
const Invoice = require('../services/invoice');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const migration = require('../models/migrations/20260911000001_invoice_send_claim_token');

jest.setTimeout(30000);
postgres('invoice send episode ownership', () => {
  let database;
  let trx;
  let invoiceId;
  let visitId;
  const read = () => trx('invoices').where({ id: invoiceId }).first();
  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Use an isolated local/CI database');
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    trx = await database.transaction();
    mockConnection = trx;
    const customerId = randomUUID();
    invoiceId = randomUUID();
    visitId = randomUUID();
    await trx('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Claim', phone: '+12025550123', email: `${customerId}@example.invalid` });
    await trx('scheduled_services').insert({ id: visitId, customer_id: customerId, status: 'confirmed', scheduled_date: '2040-03-04', service_type: 'Pest Control' });
    await trx('invoices').insert({ id: invoiceId, customer_id: customerId, scheduled_service_id: visitId, invoice_number: `TEST-${invoiceId.slice(0, 8)}`, token: randomUUID(), status: 'draft', total: 117, subtotal: 117, line_items: '[]' });
  });
  afterEach(async () => { await trx.rollback(); mockConnection = database; });
  afterAll(async () => { await database.destroy(); });

  test('migration up/down is idempotent inside a rolled-back transaction', async () => {
    await migration.down(trx);
    await migration.down(trx);
    expect(await trx.schema.hasColumn('invoices', 'send_claim_token')).toBe(false);
    await migration.up(trx);
    await migration.up(trx);
    expect(await trx.schema.hasColumn('invoices', 'send_claim_token')).toBe(true);
    expect(require('../models/db').isTransaction).toBe(true);
    await require('../models/db').transaction(async (nested) => expect(nested.isTransaction).toBe(true));
  });

  test.each([true, false])('late provider result (accepted=%s) cannot overwrite a replacement episode', async (accepted) => {
    const replacement = randomUUID();
    let original;
    sendCustomerMessage.mockImplementationOnce(async ({ withProviderHandoff }) => {
      original = (await read()).send_claim_token;
      expect(original).toMatch(/^[0-9a-f-]{36}$/);
      const result = await withProviderHandoff(async () => ({ sent: accepted, code: 'fixture_refusal', deliveryOutcome: accepted ? 'provider_accepted' : 'not_sent' }));
      await trx('invoices').where({ id: invoiceId }).update({ status: 'sending', send_claim_token: replacement });
      return result;
    });
    if (accepted) expect(await Invoice.sendViaSMS(invoiceId)).toMatchObject({ sent: true });
    else await expect(Invoice.sendViaSMS(invoiceId)).rejects.toThrow();
    expect(await read()).toMatchObject({ status: 'sending', send_claim_token: replacement, sent_at: null });
    expect(original).not.toBe(replacement);
    expect(require('../services/invoice-followups').scheduleForInvoice).not.toHaveBeenCalled();
    expect(require('../services/invoice-issued-closeout').closeOutVisitForIssuedInvoice).not.toHaveBeenCalled();
  });

  test('cancellation invalidates the token before provider handoff and after unvoid', async () => {
    let original;
    const dispatch = jest.fn(async () => ({ sent: true }));
    sendCustomerMessage.mockImplementationOnce(async ({ withProviderHandoff }) => {
      original = (await read()).send_claim_token;
      await trx('scheduled_services').where({ id: visitId }).update({ status: 'cancelled' });
      expect(Array.from(await Invoice.voidOpenInvoicesForCancelledService(visitId))).toEqual([invoiceId]);
      expect(await read()).toMatchObject({ status: 'void', send_claim_token: null });
      await trx('scheduled_services').where({ id: visitId }).update({ status: 'confirmed' });
      await Invoice.unvoidInvoice(invoiceId);
      return withProviderHandoff(dispatch);
    });
    await expect(Invoice.sendViaSMS(invoiceId)).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
    await Invoice.markDeliverySent(invoiceId, { sms: true, claimToken: original });
    expect(await read()).toMatchObject({ status: 'draft', send_claim_token: null, sent_at: null });
  });

  test('successful direct send releases its token, and a resend mints a new one', async () => {
    const tokens = [];
    sendCustomerMessage.mockImplementation(async ({ withProviderHandoff }) => {
      tokens.push((await read()).send_claim_token);
      return withProviderHandoff(async () => ({ sent: true, deliveryOutcome: 'provider_accepted' }));
    });
    await Invoice.sendViaSMS(invoiceId);
    expect(await read()).toMatchObject({ status: 'sent', send_claim_token: null });
    await Invoice.sendViaSMS(invoiceId);
    expect(tokens[0]).toBeTruthy();
    expect(tokens[1]).toBeTruthy();
    expect(tokens[0]).not.toBe(tokens[1]);
  });

  test('tokenless legacy finalization cannot finalize a claimed invoice', async () => {
    const token = randomUUID();
    await trx('invoices').where({ id: invoiceId }).update({ status: 'sending', send_claim_token: token });
    await Invoice.markDeliverySent(invoiceId, { sms: true });
    expect(await read()).toMatchObject({ status: 'sending', send_claim_token: token, sent_at: null });
  });

  test('scheduled retry cannot restore a replacement claim', async () => {
    await trx('invoices').where({ id: invoiceId }).update({ status: 'scheduled', scheduled_send_at: new Date(Date.now() - 60000) });
    const replacement = randomUUID();
    const sender = jest.spyOn(Invoice, 'sendViaSMSAndEmail').mockImplementationOnce(async (id, options) => {
      expect(options.claimToken).toBe((await read()).send_claim_token);
      expect(options.claimToken).toBeTruthy();
      await trx('invoices').where({ id }).update({ send_claim_token: replacement });
      return { ok: false, sms: { error: 'synthetic refusal' } };
    });
    try {
      await Invoice.processScheduledSends({ limit: 1 });
      expect(sender).toHaveBeenCalledTimes(1);
      expect(await read()).toMatchObject({ status: 'sending', send_claim_token: replacement, scheduled_send_attempts: 0 });
    } finally { sender.mockRestore(); }
  });

  test('nested SMS retains ownership for email; the outer send clears it', async () => {
    sendCustomerMessage.mockImplementationOnce(({ withProviderHandoff }) => withProviderHandoff(async () => ({ sent: true })));
    require('../services/invoice-email').sendInvoiceEmail.mockImplementationOnce(async (_id, options) => {
      expect(options.claimToken).toBeTruthy();
      expect((await read()).send_claim_token).toBe(options.claimToken);
      return { ok: true };
    });
    expect(await Invoice.sendViaSMSAndEmail(invoiceId)).toMatchObject({ ok: true });
    expect(await read()).toMatchObject({ status: 'sent', send_claim_token: null });
  });

});
