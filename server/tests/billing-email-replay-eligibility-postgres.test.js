// Query-shape proof on synthetic fixtures in an isolated PostgreSQL schema.
let mockPg;
jest.mock('../models/db', () => (...args) => mockPg(...args));
jest.mock('../services/messaging/deferred-replay-registry', () => ({
  invoiceStillCollectible: jest.fn(async () => ({ eligible: true })),
}));
jest.mock('../services/invoice-helpers', () => ({ selfPayAtDispatch: () => async () => ({ ok: true }) }));
jest.mock('../services/collections/rail-guard', () => ({ collectionsChannelPermitted: jest.fn(async () => true) }));

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
      table.text('status'); table.date('scheduled_date'); table.text('service_type');
    });
  }, 30000);

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    await mockPg('collections_contact_ledger').delete();
    await mockPg('scheduled_services').delete();
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
});
