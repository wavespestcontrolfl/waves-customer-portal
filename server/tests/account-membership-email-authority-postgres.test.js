// PostgreSQL proof that account-membership billing email keeps the customer
// and notification preference rows locked through the provider callback.
// The schema is disposable and has no dependency on public application tables.
let mockPg;
jest.mock('../models/db', () => {
  const database = (...args) => mockPg(...args);
  database.transaction = (...args) => mockPg.transaction(...args);
  return database;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/customer-contact', () => ({
  getPrimaryContact: (customer) => ({ email: customer.email, name: customer.first_name }),
  getInvoiceEmailRecipients: (customer, prefs) => [{
    email: prefs.billing_email || customer.email,
    name: customer.first_name,
  }],
}));
jest.mock('../services/email-template-library', () => ({ sendTemplate: jest.fn() }));

const { randomUUID } = require('node:crypto');
const knex = require('knex');
const EmailTemplateLibrary = require('../services/email-template-library');
const { _private: { sendTemplate } } = require('../services/account-membership-email');

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `account_membership_email_${randomUUID().replaceAll('-', '')}`;
const customerId = randomUUID();
let admin;
let writer;

async function waitUntilBlocked(pid) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const result = await admin.raw('SELECT cardinality(pg_blocking_pids(?)) > 0 AS waiting', [pid]);
    if (result.rows[0].waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Expected the competing admin update to wait for the email handoff');
}

postgres('account membership billing email row authority (PostgreSQL)', () => {
  beforeAll(async () => {
    const target = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true'
      && ['localhost', '127.0.0.1'].includes(target.hostname)
      && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a verified private QA database or the isolated CI database');

    admin = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    mockPg = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 4 } });
    writer = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 1 } });
    await mockPg.schema.createTable('customers', (table) => {
      table.uuid('id').primary();
      for (const column of ['first_name', 'last_name', 'company_name', 'email', 'phone', 'address_line1',
        'address_line2', 'city', 'state', 'zip', 'profile_label', 'waveguard_tier', 'billing_mode',
        'pipeline_stage', 'service_pause_reason']) table.text(column);
      table.decimal('monthly_rate');
      table.decimal('per_application_fee');
      table.boolean('active');
      table.timestamp('member_since');
      table.timestamp('deleted_at');
      table.timestamp('service_paused_at');
    });
    await mockPg.schema.createTable('notification_prefs', (table) => {
      table.uuid('customer_id').primary();
      table.boolean('email_enabled');
      table.specificType('billing_channels', 'text[]');
      table.text('billing_email');
    });
    await mockPg.schema.createTable('customer_interactions', (table) => {
      table.bigIncrements('id');
      table.uuid('customer_id');
      table.text('interaction_type');
      table.text('subject');
      table.text('body');
      table.jsonb('metadata');
    });
  }, 30000);

  beforeEach(async () => {
    jest.clearAllMocks();
    await mockPg('customer_interactions').del();
    await mockPg('notification_prefs').del();
    await mockPg('customers').del();
    await mockPg('customers').insert({
      id: customerId,
      first_name: 'QA',
      last_name: 'Fixture',
      email: 'qa-primary@example.invalid',
      active: true,
    });
    await mockPg('notification_prefs').insert({
      customer_id: customerId,
      email_enabled: false,
      billing_channels: ['email'],
    });
  });

  afterAll(async () => {
    await mockPg?.destroy();
    await writer?.destroy();
    if (admin) {
      await admin.schema.dropSchemaIfExists(schema, true);
      await admin.destroy();
    }
  });

  test.each([
    ['customer email', 'customers', { email: 'qa-new-primary@example.invalid' }],
    ['billing email override', 'notification_prefs', { billing_email: 'qa-billing@example.invalid' }],
  ])('a competing admin %s edit waits until provider dispatch returns', async (_label, table, update) => {
    let enterDispatch;
    let releaseDispatch;
    const dispatchEntered = new Promise((resolve) => { enterDispatch = resolve; });
    const dispatchRelease = new Promise((resolve) => { releaseDispatch = resolve; });
    const events = [];
    EmailTemplateLibrary.sendTemplate.mockImplementation(async ({ withProviderHandoff, to }) => {
      const verdict = await withProviderHandoff(async () => {
        events.push(`provider:${to}`);
        enterDispatch();
        await dispatchRelease;
        events.push('provider:return');
      });
      if (verdict?.ok !== true) return { sent: false, reason: 'aborted_by_caller_before_dispatch' };
      return {
        sent: true,
        message: { provider_message_id: 'sg-synthetic', sent_at: '2026-09-26T12:00:00.000Z' },
      };
    });

    const sending = sendTemplate({
      customerId,
      templateKey: 'billing.previsit_balance',
      eventType: 'billing.previsit_balance',
      idempotencyKey: `qa:${table}`,
      billingCategory: 'billing',
    });
    await dispatchEntered;

    let publishPid;
    const pidReady = new Promise((resolve) => { publishPid = resolve; });
    const editing = writer.transaction(async (trx) => {
      const pidResult = await trx.raw('SELECT pg_backend_pid() AS pid');
      publishPid(pidResult.rows[0].pid);
      const where = table === 'customers' ? { id: customerId } : { customer_id: customerId };
      await trx(table).where(where).forUpdate().first();
      await trx(table).where(where).update(update);
      events.push('admin:commit');
    });
    const pid = await pidReady;
    let proofError;
    try {
      await waitUntilBlocked(pid);
      expect(events).toEqual(['provider:qa-primary@example.invalid']);
    } catch (err) {
      proofError = err;
    } finally {
      releaseDispatch();
    }

    const [result] = await Promise.all([sending, editing]);
    if (proofError) throw proofError;
    expect(result).toMatchObject({ ok: true, messageId: 'sg-synthetic' });
    expect(events).toEqual([
      'provider:qa-primary@example.invalid',
      'provider:return',
      'admin:commit',
    ]);
  }, 30000);
});
