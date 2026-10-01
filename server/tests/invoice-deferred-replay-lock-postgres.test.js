// Codex r5 P1 on #4963 (split PR 3): a queued invoice notice's replay read the
// invoice before recipient resolution and provider preparation, so a void,
// payment or Bill-To change could commit after that read and the replay still
// delivered the stale pay link. The replay's provider handoff now holds the
// invoice row lock (withInvoiceDepositSettlement) from its check through the
// provider call. Real PostgreSQL locks on synthetic rows in an isolated schema.
let mockPg;
jest.mock('../models/db', () => new Proxy(function mockDb() {}, {
  apply: (_target, _this, args) => mockPg(...args),
  get: (_target, prop) => {
    const value = mockPg[prop];
    return typeof value === 'function' ? value.bind(mockPg) : value;
  },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn(), invoiceShortCodePrefix: jest.fn(() => 'wpc') }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: () => 'https://waves.test' }));
jest.mock('../services/invoice-prepay', () => ({ loadInvoiceAnnualPrepay: jest.fn(), buildPrepayCoverageSummary: jest.fn() }));
jest.mock('../routes/admin-sms-templates', () => ({ isTemplateActive: jest.fn(), getTemplate: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/customer-credit', () => ({ autoApplyAccountCreditIfEnabled: jest.fn() }));
jest.mock('../services/lead-estimate-link', () => ({ convertLeadFromEvent: jest.fn() }));
jest.mock('../services/invoice-issued-closeout', () => ({ closeOutVisitForIssuedInvoice: jest.fn() }));

const { randomUUID } = require('node:crypto');
const knex = require('knex');
const InvoiceService = require('../services/invoice');

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `invoice_replay_lock_${randomUUID().replaceAll('-', '')}`;
const accepted = { sent: true, deliveryOutcome: 'accepted', providerMessageId: 'SM1' };
let admin;

postgres('queued invoice notice replay holds the invoice lock (PostgreSQL)', () => {
  beforeAll(async () => {
    const target = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname)
      && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a verified private QA database or the isolated CI database');
    admin = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    mockPg = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 2 } });
    await mockPg.schema.createTable('customers', (table) => { table.uuid('id').primary(); });
    // The dispute-hold read (collections/collection-hold.js) - no rows: no active hold.
    await mockPg.schema.createTable('collections_flags', (table) => {
      table.increments('id'); table.uuid('customer_id'); table.text('flag'); table.text('reason'); table.timestamp('released_at', { useTz: true });
    });
    await mockPg.schema.createTable('scheduled_services', (table) => {
      table.uuid('id').primary(); table.uuid('customer_id'); table.text('status'); table.uuid('source_estimate_id');
    });
    await mockPg.schema.createTable('service_records', (table) => {
      table.uuid('id').primary(); table.uuid('scheduled_service_id');
    });
    await mockPg.schema.createTable('invoices', (table) => {
      table.uuid('id').primary(); table.uuid('customer_id').notNullable(); table.text('status');
      table.uuid('payer_id'); table.text('scheduled_send_error'); table.text('notes'); table.jsonb('line_items');
      table.timestamp('sent_at', { useTz: true });
      table.decimal('total', 10, 2); table.decimal('credit_applied', 10, 2);
      table.uuid('scheduled_service_id'); table.uuid('service_record_id');
    });
  }, 30000);

  afterAll(async () => {
    await mockPg?.destroy();
    if (admin) { await admin.schema.dropSchemaIfExists(schema, true); await admin.destroy(); }
  });

  // A sent invoice by default: the whole-notice retry #4963 queues after its
  // send finalized (sent_at stamped).
  async function queuedInvoice(invoiceOverrides = {}, rowMeta = {}) {
    const customerId = randomUUID();
    const visitId = randomUUID();
    const invoiceId = randomUUID();
    await mockPg('customers').insert({ id: customerId });
    await mockPg('scheduled_services').insert({ id: visitId, customer_id: customerId, status: 'completed' });
    await mockPg('invoices').insert({ id: invoiceId, customer_id: customerId, status: 'sent', sent_at: new Date(),
      total: '120.00', credit_applied: '0.00', scheduled_service_id: visitId, ...invoiceOverrides });
    return { invoice_id: invoiceId, customer_id: customerId, entry_point: 'invoice_send_deferred', ...rowMeta };
  }

  test('keeps the invoice row locked through the provider call', async () => {
    const meta = await queuedInvoice();
    const dispatch = jest.fn(async () => {
      await expect(admin.raw('SELECT id FROM ??.invoices WHERE id = ? FOR UPDATE NOWAIT', [schema, meta.invoice_id]))
        .rejects.toMatchObject({ code: '55P03' });
      return accepted;
    });
    await expect(InvoiceService.withDeferredInvoiceProviderHandoff(meta, dispatch)).resolves.toEqual(accepted);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  test('a void that commits while the replay waits for the lock stops the send', async () => {
    const meta = await queuedInvoice();
    const voider = await admin.transaction();
    const dispatch = jest.fn(async () => accepted);
    let pending;
    try {
      await voider.raw('UPDATE ??.invoices SET status = ? WHERE id = ?', [schema, 'void', meta.invoice_id]);
      pending = InvoiceService.withDeferredInvoiceProviderHandoff(meta, dispatch);
      await new Promise((resolve) => { setTimeout(resolve, 250); });
      expect(dispatch).not.toHaveBeenCalled();
      await voider.commit();
    } catch (err) {
      await voider.rollback();
      throw err;
    }
    await expect(pending).resolves.toEqual(expect.objectContaining({
      sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'INVOICE_REPLAY_INELIGIBLE',
      reason: 'invoice-terminal:void', retryable: false,
    }));
    expect(dispatch).not.toHaveBeenCalled();
  });

  // sendViaSMSAndEmail's held pay-link text is the only delivery when its
  // email leg failed too; its finalize (markDeliverySent) is what marks the
  // invoice sent, so it must still go out to the unsent draft.
  test('a held pay-link text that marks the delivery still reaches an invoice not yet marked sent', async () => {
    const meta = await queuedInvoice({ status: 'draft', sent_at: null }, { mark_invoice_delivery: true });
    const dispatch = jest.fn(async () => accepted);
    await expect(InvoiceService.withDeferredInvoiceProviderHandoff(meta, dispatch)).resolves.toEqual(accepted);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  test('any other queued retry of an invoice that never finalized is refused, never sent', async () => {
    const meta = await queuedInvoice({ status: 'draft', sent_at: null });
    const dispatch = jest.fn(async () => accepted);
    await expect(InvoiceService.withDeferredInvoiceProviderHandoff(meta, dispatch)).resolves.toEqual(expect.objectContaining({
      sent: false, code: 'INVOICE_REPLAY_INELIGIBLE', reason: 'invoice-send-not-finalized', retryable: false,
    }));
    expect(dispatch).not.toHaveBeenCalled();
  });

  test('the Email leg check reads the invoice on the authority transaction that holds its lock', async () => {
    const meta = await queuedInvoice();
    const verdict = await mockPg.transaction(async (trx) => {
      await trx('invoices').where({ id: meta.invoice_id }).forUpdate().first('id');
      await trx('invoices').where({ id: meta.invoice_id }).update({ payer_id: randomUUID() });
      return InvoiceService.checkDeferredInvoiceEmailDelivery(meta, { channel: 'email', database: trx });
    });
    expect(verdict).toEqual({ ok: false, code: 'INVOICE_REPLAY_INELIGIBLE', reason: 'payer-billed', retryable: false });
  });
});
