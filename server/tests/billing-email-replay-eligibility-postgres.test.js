// Query-shape proof on synthetic fixtures in an isolated PostgreSQL schema.
let mockPg;
jest.mock('../models/db', () => (...args) => mockPg(...args));
jest.mock('../services/messaging/deferred-replay-registry', () => ({
  invoiceStillCollectible: jest.fn(async () => ({ eligible: true })),
}));
jest.mock('../services/invoice-helpers', () => ({
  ...jest.requireActual('../services/invoice-helpers'), selfPayAtDispatch: () => async () => ({ ok: true }),
}));
jest.mock('../services/collections/rail-guard', () => ({
  collectionsChannelPermitted: jest.fn(async () => ({ allowed: true, durable: false })),
  collectionsChannelVerdict: jest.fn(async () => ({ permitted: true, eligibleInvoiceIds: null })),
}));

const { randomUUID } = require('node:crypto');
const knex = require('knex');
const { billingEmailReplayEligible } = require('../services/messaging/billing-email-replay-eligibility');
const { collectionsChannelPermitted, collectionsChannelVerdict } = require('../services/collections/rail-guard');
const { etDateString, addETDays } = require('../utils/datetime-et');

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `billing_eligibility_${randomUUID().replaceAll('-', '')}`;
const customerId = randomUUID();
const visitId = randomUUID();
const ownId = randomUUID();
const siblingIds = [randomUUID(), randomUUID()];
const source = 'late_payment_checker';
const eventKey = 'qa:billing-event';
const originalGate = process.env.GATE_COLLECTIONS_POLICY;
let admin;

postgres('billing replay eligibility (PostgreSQL)', () => {
  beforeAll(async () => {
    const target = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname)
      && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a verified private QA database or the isolated CI database');
    admin = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    mockPg = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 2 } });
    await mockPg.schema.createTable('collections_contact_ledger', (table) => {
      table.uuid('id').primary(); table.uuid('customer_id').notNullable();
      table.text('source').notNullable(); table.jsonb('metadata'); table.text('channel');
    });
    await mockPg.schema.createTable('scheduled_services', (table) => {
      table.uuid('id').primary(); table.uuid('customer_id').notNullable();
      table.text('status'); table.date('scheduled_date'); table.text('service_type'); table.boolean('is_recurring');
      table.integer('payer_id'); table.text('po_number'); table.boolean('self_pay_override');
    });
    await mockPg.schema.createTable('customers', (table) => {
      table.uuid('id').primary(); table.integer('payer_id'); table.text('billing_mode');
      table.text('waveguard_tier'); table.decimal('monthly_rate'); table.integer('billing_day');
    });
    await mockPg.schema.createTable('payers', (table) => {
      table.integer('id').primary(); table.boolean('active');
    });
    await mockPg.schema.createTable('invoices', (table) => {
      table.uuid('id').primary(); table.uuid('customer_id'); table.integer('payer_id');
      table.text('status'); table.decimal('total'); table.decimal('credit_applied');
      table.uuid('scheduled_service_id'); table.date('due_date'); table.timestamp('created_at');
      table.timestamp('last_reminder_at'); table.text('scheduled_send_error');
    });
    await mockPg.schema.createTable('invoice_followup_sequences', (table) => {
      table.uuid('invoice_id'); table.text('status'); table.timestamp('last_touch_at');
    });
    await mockPg.schema.createTable('activity_log', (table) => {
      table.uuid('customer_id'); table.text('action'); table.timestamp('created_at'); table.jsonb('metadata');
    });
  }, 30000);

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    await mockPg('collections_contact_ledger').delete();
    await mockPg('scheduled_services').delete();
    await mockPg('customers').delete();
    await mockPg('payers').delete();
    await mockPg('invoices').delete();
    await mockPg('invoice_followup_sequences').delete();
    await mockPg('activity_log').delete();
  });

  afterAll(async () => {
    if (originalGate === undefined) delete process.env.GATE_COLLECTIONS_POLICY;
    else process.env.GATE_COLLECTIONS_POLICY = originalGate;
    await mockPg?.destroy();
    if (admin) { await admin.schema.dropSchemaIfExists(schema, true); await admin.destroy(); }
  });

  const metadata = () => ({ customer_id: customerId, source_entry_point: source,
    notificationEventKey: eventKey, collections_ledger_id: ownId });
  const row = (id, overrides = {}) => ({ id, customer_id: customerId, source,
    metadata: { notificationEventKey: eventKey }, ...overrides });

  test('excludes only the persisted reservations for this customer, source and event', async () => {
    const unrelatedId = randomUUID();
    await mockPg('collections_contact_ledger').insert([
      row(ownId), ...siblingIds.map((id) => row(id)),
      row(unrelatedId, { customer_id: randomUUID() }),
      row(randomUUID(), { source: 'invoice_followup_sequence' }),
      row(randomUUID(), { metadata: { notificationEventKey: 'another-event' } }),
      row(randomUUID(), { metadata: null }),
    ]);
    await expect(billingEmailReplayEligible({ ...metadata(),
      collections_sibling_ledger_ids: [unrelatedId] })).resolves.toEqual({ eligible: true });
    expect(new Set(collectionsChannelPermitted.mock.calls[0][0].excludeLedgerIds))
      .toEqual(new Set([ownId, ...siblingIds]));
  });

  test.each([
    { customer_id: randomUUID() }, { metadata: null },
    { metadata: { notificationEventKey: 'another-event' } },
  ])('does not trust a reservation outside its original event: %j', async (override) => {
    await mockPg('collections_contact_ledger').insert([row(ownId, override), row(siblingIds[0])]);
    await billingEmailReplayEligible(metadata());
    expect(collectionsChannelPermitted.mock.calls[0][0].excludeLedgerIds).toEqual([]);
  });

  test('derives the ledger source from the reservation when it differs from the entry point', async () => {
    await mockPg('collections_contact_ledger').insert([
      row(ownId, { source: 'invoice_followups' }), row(siblingIds[0], { source: 'invoice_followups' }),
      row(siblingIds[1]),
    ]);
    await billingEmailReplayEligible({ ...metadata(), source_entry_point: 'invoice_followup_sequence' });
    expect(new Set(collectionsChannelPermitted.mock.calls[0][0].excludeLedgerIds))
      .toEqual(new Set([ownId, siblingIds[0]]));
  });

  test.each([
    { status: 'cancelled' }, { scheduled_date: etDateString(addETDays(new Date(), 2)) },
    { service_type: 'Different service' }, { customer_id: randomUUID() },
  ])('refuses frozen visit copy after its source changes: %j', async (change) => {
    delete process.env.GATE_COLLECTIONS_POLICY;
    const date = etDateString(addETDays(new Date(), 1));
    await mockPg('scheduled_services').insert({ id: visitId, customer_id: customerId,
      status: 'confirmed', scheduled_date: date, service_type: 'Pest Control' });
    const meta = { customer_id: customerId, source_entry_point: 'balance_reminder_workflow',
      appointment_id: visitId, appointment_date: date, appointment_service_type: 'Pest Control',
      appointment_rendered_on: etDateString() };
    await expect(billingEmailReplayEligible(meta)).resolves.toEqual({ eligible: true });
    await mockPg('scheduled_services').where({ id: visitId }).update(change);
    await expect(billingEmailReplayEligible(meta)).resolves.toMatchObject({ eligible: false, retryable: false });
  });

  test('previsit replay uses the held database, excludes its episode, and rejects a newly eligible invoice', async () => {
    const invoiceIds = [randomUUID(), randomUUID()];
    const siblingId = randomUUID();
    const date = etDateString(addETDays(new Date(), 1));
    const previsitEventKey = `previsit-balance:${visitId}`;
    await mockPg('customers').insert({ id: customerId, billing_mode: 'per_visit' });
    await mockPg('scheduled_services').insert({
      id: visitId, customer_id: customerId, status: 'confirmed', scheduled_date: date,
      service_type: 'Pest Control', is_recurring: true,
    });
    await mockPg('invoices').insert(invoiceIds.map((id, index) => ({
      id, customer_id: customerId, status: 'sent', total: index ? '60.00' : '40.00', credit_applied: '0.00',
      scheduled_service_id: visitId, due_date: etDateString(addETDays(new Date(), -8)),
    })));
    await mockPg('collections_contact_ledger').insert([
      { id: ownId, customer_id: customerId, source: 'previsit_balance_reminder', channel: 'email',
        metadata: { notificationEventKey: previsitEventKey } },
      { id: siblingId, customer_id: customerId, source: 'previsit_balance_reminder', channel: 'push',
        metadata: { notificationEventKey: previsitEventKey } },
    ]);
    const meta = {
      customer_id: customerId,
      source_entry_point: 'previsit_balance_reminder',
      notificationEventKey: previsitEventKey,
      collections_ledger_id: ownId,
      appointment_id: visitId,
      appointment_date: date,
      appointment_service_type: 'Pest Control',
      appointment_rendered_on: etDateString(),
      rendered_amount: '100.00',
      invoice_ids: invoiceIds,
    };

    await mockPg.transaction(async (trx) => {
      await expect(billingEmailReplayEligible(meta, trx)).resolves.toEqual({ eligible: true });
      expect(collectionsChannelVerdict).toHaveBeenLastCalledWith(expect.objectContaining({
        customerId, channel: 'email', database: trx,
        excludeLedgerIds: expect.arrayContaining([ownId, siblingId]),
      }));
    });

    await mockPg('invoices').insert({
      id: randomUUID(), customer_id: customerId, status: 'sent', total: '25.00', credit_applied: '0.00',
      scheduled_service_id: visitId, due_date: etDateString(addETDays(new Date(), -8)),
    });
    await expect(billingEmailReplayEligible(meta, mockPg))
      .resolves.toEqual({ eligible: false, reason: 'previsit-quote-changed', retryable: false });
  }, 15000);
});
