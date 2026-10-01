// A direct invoice notice's provider retry (#4963) re-runs the invoice
// delivery checks with the real invoice, collectibility and visit helpers, on
// synthetic rows in an isolated PostgreSQL schema.
let mockPg;
jest.mock('../models/db', () => (...args) => mockPg(...args));

const { randomUUID } = require('node:crypto');
const knex = require('knex');
const { billingEmailReplayEligible } = require('../services/messaging/billing-email-replay-eligibility');

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `billing_invoice_replay_${randomUUID().replaceAll('-', '')}`;
const customerId = randomUUID();
let admin;

postgres('direct invoice Email replay eligibility (PostgreSQL)', () => {
  beforeAll(async () => {
    const target = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname)
      && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a verified private QA database or the isolated CI database');
    admin = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    mockPg = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 2 } });
    // The dispute-hold read (collections/collection-hold.js) - no rows: no active hold.
    await mockPg.schema.createTable('collections_flags', (table) => {
      table.increments('id'); table.uuid('customer_id'); table.text('flag'); table.text('reason'); table.timestamp('released_at', { useTz: true });
    });
    await mockPg.schema.createTable('invoices', (table) => {
      table.uuid('id').primary(); table.uuid('customer_id').notNullable(); table.text('status');
      table.uuid('payer_id'); table.text('scheduled_send_error');
      table.decimal('total', 10, 2); table.decimal('credit_applied', 10, 2);
      table.uuid('scheduled_service_id'); table.uuid('service_record_id');
      table.timestamp('sent_at', { useTz: true });
    });
    await mockPg.schema.createTable('scheduled_services', (table) => {
      table.uuid('id').primary(); table.text('status');
    });
    await mockPg.schema.createTable('service_records', (table) => {
      table.uuid('id').primary(); table.uuid('scheduled_service_id');
    });
  }, 30000);

  beforeEach(async () => {
    await mockPg('invoices').delete();
    await mockPg('scheduled_services').delete();
    await mockPg('service_records').delete();
  });

  afterAll(async () => {
    await mockPg?.destroy();
    if (admin) { await admin.schema.dropSchemaIfExists(schema, true); await admin.destroy(); }
  });

  async function invoiceWith(overrides = {}) {
    const visitId = randomUUID();
    await mockPg('scheduled_services').insert({ id: visitId, status: 'completed' });
    // A finalized send by default: a provider retry only runs after the send
    // that queued it stamped the invoice sent (sent_at).
    const invoice = { id: randomUUID(), customer_id: customerId, status: 'sent', sent_at: new Date(), payer_id: null,
      scheduled_send_error: null, total: '120.00', credit_applied: '0.00', scheduled_service_id: visitId,
      service_record_id: null, ...overrides };
    await mockPg('invoices').insert(invoice);
    return invoice;
  }

  const context = (invoiceId, source = 'invoice_send_via_sms') => ({
    schema_version: 1, customer_id: customerId, invoice_id: invoiceId, category: 'invoice',
    source_entry_point: source, notificationEventKey: `invoice:${invoiceId}:sent`,
  });

  test.each(['invoice_send_via_sms', 'invoice_send_deferred'])('allows a still-due invoice for %s', async (source) => {
    const invoice = await invoiceWith();
    await expect(billingEmailReplayEligible(context(invoice.id, source), mockPg)).resolves.toEqual({ eligible: true });
  });

  test.each([
    ['void', { status: 'void' }, 'invoice-terminal:void'],
    ['paid', { status: 'paid' }, 'invoice-terminal:paid'],
    ['processing a payment', { status: 'processing' }, 'invoice-terminal:processing'],
    ['nothing left due', { credit_applied: '120.00' }, 'invoice-nothing-due'],
    ['billed to a payer', { payer_id: randomUUID() }, 'payer-billed'],
    ['withdrawn from the customer', { scheduled_send_error: `payer_billed:${randomUUID()}` }, 'payer-billed-withdrawn'],
    ['moved to another customer', { customer_id: randomUUID() }, 'invoice-customer-changed'],
    ['in a status no send delivers from', { status: 'archived' }, 'invoice-status:archived'],
  ])('refuses an invoice %s', async (_label, overrides, reason) => {
    const invoice = await invoiceWith(overrides);
    await expect(billingEmailReplayEligible(context(invoice.id), mockPg))
      .resolves.toEqual({ eligible: false, reason, retryable: false });
  });

  // Codex #4963 P1: an Email-only send whose SendGrid attempt failed
  // retryably restored the invoice; its provider retry must not deliver a pay
  // link while the invoice reads unsent, and must stay re-sendable.
  test('a send that never finalized is refused as resendable, never blocked', async () => {
    const invoice = await invoiceWith({ status: 'draft', sent_at: null });
    await expect(billingEmailReplayEligible(context(invoice.id), mockPg)).resolves.toEqual({
      eligible: false, reason: 'invoice-send-not-finalized', retryable: false, resendable: true,
    });
  });

  test('a live send claim holds the retry until that send settles', async () => {
    const invoice = await invoiceWith({ status: 'sending', sent_at: null });
    await expect(billingEmailReplayEligible(context(invoice.id), mockPg))
      .resolves.toEqual({ eligible: false, reason: 'invoice-send-in-flight', retryable: true });
  });

  test('refuses a missing invoice', async () => {
    await expect(billingEmailReplayEligible(context(randomUUID()), mockPg))
      .resolves.toEqual({ eligible: false, reason: 'invoice-missing', retryable: false });
  });

  test('refuses when the linked visit never ran', async () => {
    const invoice = await invoiceWith();
    await mockPg('scheduled_services').where({ id: invoice.scheduled_service_id }).update({ status: 'cancelled' });
    await expect(billingEmailReplayEligible(context(invoice.id), mockPg))
      .resolves.toEqual({ eligible: false, reason: 'invoice-visit-cancelled', retryable: false });
  });

  test('finds the visit through the service record', async () => {
    const visitId = randomUUID();
    const recordId = randomUUID();
    await mockPg('scheduled_services').insert({ id: visitId, status: 'skipped' });
    await mockPg('service_records').insert({ id: recordId, scheduled_service_id: visitId });
    const invoice = await invoiceWith({ scheduled_service_id: null, service_record_id: recordId });
    await expect(billingEmailReplayEligible(context(invoice.id), mockPg))
      .resolves.toEqual({ eligible: false, reason: 'invoice-visit-skipped', retryable: false });
  });

  test('holds for a retry while the linked visit is locked', async () => {
    const invoice = await invoiceWith();
    await admin.transaction(async (trx) => {
      await trx.raw('SELECT id FROM ??.scheduled_services WHERE id = ? FOR UPDATE', [schema, invoice.scheduled_service_id]);
      await expect(billingEmailReplayEligible(context(invoice.id), mockPg))
        .resolves.toEqual({ eligible: false, reason: 'billing-email-eligibility-unavailable', retryable: true });
    });
  });
});
