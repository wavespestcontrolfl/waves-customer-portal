// Query-shape proof on synthetic fixtures in an isolated PostgreSQL schema.
let mockPg;
jest.mock('../models/db', () => (...args) => mockPg(...args));
jest.mock('../services/messaging/deferred-replay-registry', () => ({
  invoiceStillCollectible: jest.fn(async () => ({ eligible: true })),
}));
jest.mock('../services/invoice-helpers', () => ({
  ...jest.requireActual('../services/invoice-helpers'),
  selfPayAtDispatch: () => async () => ({ ok: true }),
}));
jest.mock('../services/collections/rail-guard', () => ({ collectionsChannelPermitted: jest.fn(async () => ({ allowed: true, durable: false })) }));

const { randomUUID } = require('node:crypto');
const knex = require('knex');
const { billingEmailReplayEligible } = require('../services/messaging/billing-email-replay-eligibility');
const { collectionsChannelPermitted } = require('../services/collections/rail-guard');
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
      table.text('source').notNullable(); table.jsonb('metadata');
    });
    await mockPg.schema.createTable('scheduled_services', (table) => {
      table.uuid('id').primary(); table.uuid('customer_id').notNullable();
      table.text('status'); table.date('scheduled_date'); table.text('service_type'); table.uuid('source_estimate_id');
    });
    await mockPg.schema.createTable('invoices', (table) => {
      table.uuid('id').primary(); table.uuid('customer_id').notNullable(); table.text('status');
      table.decimal('total', 12, 2); table.decimal('credit_applied', 12, 2).defaultTo(0);
      table.integer('payer_id'); table.timestamp('customer_collection_withdrawn_at');
      table.uuid('scheduled_service_id'); table.text('notes'); table.jsonb('line_items');
    });
    await mockPg.schema.createTable('annual_prepay_terms', (table) => {
      table.uuid('id').primary(); table.uuid('customer_id').notNullable(); table.uuid('prepay_invoice_id').notNullable();
      table.text('status'); table.date('term_start'); table.date('first_visit_date');
    });
    await mockPg.schema.createTable('invoice_followup_sequences', (table) => {
      table.uuid('invoice_id'); table.text('status'); table.timestamp('last_touch_at'); table.timestamp('next_touch_at');
    });
    await mockPg.schema.createTable('estimates', (table) => {
      table.uuid('id').primary(); table.uuid('customer_id').notNullable();
    });
    await mockPg.schema.createTable('estimate_deposits', (table) => {
      table.uuid('id').primary();
      table.uuid('estimate_id'); table.text('status'); table.decimal('amount', 12, 2);
      table.decimal('credited_amount', 12, 2).defaultTo(0); table.decimal('refunded_amount', 12, 2).defaultTo(0);
    });
  }, 30000);

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    await mockPg('collections_contact_ledger').delete();
    await mockPg('scheduled_services').delete();
    await mockPg('invoice_followup_sequences').delete();
    await mockPg('annual_prepay_terms').delete();
    await mockPg('invoices').delete();
    await mockPg('estimate_deposits').delete();
    await mockPg('estimates').delete();
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

  test('holds annual invoice, deposit and term locks through dispatch and refuses a concurrent receipt', async () => {
    delete process.env.GATE_COLLECTIONS_POLICY;
    const termId = randomUUID();
    const invoiceId = randomUUID();
    const estimateId = randomUUID();
    const serviceId = randomUUID();
    const firstVisitDate = etDateString(addETDays(new Date(), 1));
    await mockPg('estimates').insert({ id: estimateId, customer_id: customerId });
    await mockPg('scheduled_services').insert({ id: serviceId, customer_id: customerId,
      status: 'confirmed', scheduled_date: firstVisitDate, source_estimate_id: estimateId });
    await mockPg('invoices').insert({ id: invoiceId, customer_id: customerId, status: 'sent', total: '392.04',
      scheduled_service_id: serviceId, line_items: JSON.stringify([]) });
    await mockPg('annual_prepay_terms').insert({ id: termId, customer_id: customerId,
      prepay_invoice_id: invoiceId, status: 'payment_pending', term_start: firstVisitDate });
    const check = require('../services/annual-prepay-renewals')._private.invoiceStillOwedAsQuoted({
      customer_id: customerId,
      invoice_id: invoiceId,
      source_entry_point: 'annual_prepay_payment_reminder',
      notificationEventKey: `annual-prepay-payment:${termId}:1`,
      collections_ledger_id: ownId,
      annual_prepay_term_id: termId,
      first_visit_date: firstVisitDate,
      days_out: 1,
      rendered_amount: '392.04',
      delivery_channel: 'email',
    });

    await mockPg.transaction(async (held) => {
      await expect(check({ database: held })).resolves.toEqual({ ok: true });
      process.env.GATE_COLLECTIONS_POLICY = 'true';
      const policy = jest.spyOn(require('../services/collections/contact-policy'), 'evaluate')
        .mockResolvedValueOnce({ allowed: true, denialReasons: [], eligibleInvoiceIds: [], balanceIncomplete: 'payer resolve failed' });
      collectionsChannelPermitted.mockImplementationOnce(jest.requireActual('../services/collections/rail-guard').collectionsChannelPermitted);
      await expect(check({ database: held })).resolves.toMatchObject({ ok: false, retryable: true });
      policy.mockRestore();
      delete process.env.GATE_COLLECTIONS_POLICY;
      for (const [table, id] of [['invoices', invoiceId], ['annual_prepay_terms', termId]]) {
        await expect(mockPg.transaction(async (contender) => {
          await contender.raw("SET LOCAL lock_timeout = '100ms'");
          await contender(table).where({ id }).update({ status: 'cancelled' });
        })).rejects.toMatchObject({ code: '55P03' });
      }
      const contender = await mockPg.raw(
        "SELECT pg_try_advisory_xact_lock(hashtext('estimate.deposit.ledger'), hashtext(?::text)) AS locked",
        [estimateId],
      );
      expect(contender.rows[0].locked).toBe(false);
      await held.schema.renameTable('invoice_followup_sequences', 'invoice_followup_sequences_hidden');
      await expect(check({ database: held })).resolves.toMatchObject({ ok: false, retryable: true });
      await expect(held.raw('SELECT 1')).resolves.toBeTruthy();
      await held.schema.renameTable('invoice_followup_sequences_hidden', 'invoice_followup_sequences');
    });
    await mockPg.transaction(async (receipt) => {
      await receipt.raw(
        "SELECT pg_advisory_xact_lock(hashtext('estimate.deposit.ledger'), hashtext(?::text))",
        [estimateId],
      );
      await receipt('estimate_deposits').insert({ id: randomUUID(), estimate_id: estimateId, status: 'received', amount: 40 });
      await mockPg.transaction(async (handoff) => {
        await handoff.raw("SET LOCAL lock_timeout = '100ms'");
        await expect(check({ database: handoff })).resolves.toMatchObject({ ok: false, retryable: true });
        await expect(handoff.raw('SELECT 1')).resolves.toBeTruthy();
      });
    });
    await expect(check()).resolves.toMatchObject({ ok: false, retryable: true });
    await expect(mockPg('invoices').where({ id: invoiceId }).update({ status: 'paid' })).resolves.toBe(1);
  }, 15000);
});
