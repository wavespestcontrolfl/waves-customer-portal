// Real provider preparation under billing authority with a one-slot pool.
// Only the HTTP transport and template/suppression lookup are mocked.
let mockPg;
let mockMarkerPg;
jest.mock('../models/marker-db', () => () => mockMarkerPg);
jest.mock('../models/db', () => {
  const database = (...args) => mockPg(...args);
  database.transaction = (...args) => mockPg.transaction(...args);
  database.raw = (...args) => mockPg.raw(...args);
  return database;
});
jest.mock('../services/email-template-library', () => ({
  ...jest.requireActual('../services/email-template-library'),
  loadTemplateByKey: async () => ({ template: { template_key: 'billing.notice' } }),
  activeSuppressionFor: async () => null,
}));
jest.mock('../services/customer-contact', () => ({
  getInvoiceEmailRecipients: (customer) => [{ email: customer.email, name: 'QA' }],
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { randomUUID } = require('node:crypto');
const knex = require('knex');
const sendgrid = require('../services/sendgrid-mail');
const { dispatchUnderBillingEmailAuthority } = require('../services/billing-channel-email-authority');
const { etDateString, addETDays } = require('../utils/datetime-et');
const { retryOne } = require('../services/transactional-email-provider-retry');
const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `billing_provider_connection_${randomUUID().replaceAll('-', '')}`;
const customerId = randomUUID();
const originalApiKey = process.env.SENDGRID_API_KEY;
const originalFetch = global.fetch;
let admin;

postgres('billing Email provider preparation on its held connection', () => {
  beforeAll(async () => {
    const target = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname)
      && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a verified private QA database or the isolated CI database');
    admin = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    mockPg = knex({ client: 'pg', connection, searchPath: [schema],
      pool: { min: 0, max: 1 }, acquireConnectionTimeout: 1500 });
    mockMarkerPg = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 1 } });
    await mockPg.schema.createTable('customers', (table) => {
      table.uuid('id').primary(); table.text('email'); table.timestamp('deleted_at');
      table.boolean('active'); table.boolean('autopay_enabled'); table.decimal('monthly_rate');
      table.integer('billing_day'); table.text('billing_mode');
    });
    await mockPg.schema.createTable('notification_prefs', (table) => {
      table.uuid('customer_id').primary(); table.boolean('email_enabled');
      table.specificType('billing_channels', 'text[]');
    });
    await mockPg.schema.createTable('estimates', (table) => {
      table.uuid('id').primary(); table.text('token'); table.jsonb('estimate_data');
      for (const column of ['status', 'expires_at', 'customer_id', 'property_id', 'estimate_group_id',
        'customer_name', 'customer_phone', 'customer_email', 'address', 'notes', 'monthly_total',
        'annual_total', 'onetime_total', 'show_one_time_option', 'bill_by_invoice', 'waveguard_tier',
        'service_interest', 'category', 'source']) table.text(column);
    });
    await mockPg.schema.createTable('email_messages', (table) => {
      table.uuid('id').primary();
      for (const key of ['template_key', 'recipient_type', 'recipient_id', 'recipient_email_snapshot',
        'trigger_event_id', 'idempotency_key', 'subject_snapshot', 'html_snapshot', 'text_snapshot',
        'suppression_group_key_snapshot', 'send_attempt_token', 'provider_handoff_attempt_token',
        'provider_handoff_phase', 'status', 'provider_message_id', 'error_message']) table.text(key);
      table.jsonb('payload_snapshot'); table.jsonb('categories'); table.integer('provider_retry_count');
      for (const key of ['sent_at', 'updated_at', 'provider_retry_next_at', 'provider_retry_exhausted_at']) table.timestamp(key);
    });
    await mockPg('customers').insert({ id: customerId, email: 'qa@example.invalid' });
    await mockPg('notification_prefs').insert({ customer_id: customerId,
      email_enabled: true, billing_channels: ['email'] });
  }, 30000);

  beforeEach(() => {
    process.env.SENDGRID_API_KEY = 'SG.synthetic-no-network';
    global.fetch = jest.fn(async () => ({ ok: true, headers: { get: () => 'synthetic-provider-id' } }));
  });
  afterEach(() => {
    global.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.SENDGRID_API_KEY;
    else process.env.SENDGRID_API_KEY = originalApiKey;
  });
  afterAll(async () => {
    await mockMarkerPg?.destroy();
    await mockPg?.destroy();
    if (admin) { await admin.schema.dropSchemaIfExists(schema, true); await admin.destroy(); }
  });

  test.each(['refuse', 'rewrite'])('%s checks see the transaction and never acquire a second slot', async (policy) => {
    const estimateId = randomUUID();
    const token = randomUUID().replaceAll('-', '');
    const queries = [];
    const collect = (query) => { if (/"estimates"/.test(query.sql)) queries.push(query); };
    mockPg.on('query', collect);
    const state = { boundaryBlock: null, handoffStarted: false, providerAccepted: false };
    try {
      const outcome = await dispatchUnderBillingEmailAuthority({
        input: { customerId, metadata: { billingDeliveryCategory: 'billing' } },
        recipientEmail: 'qa@example.invalid', state,
        dispatch: async (database) => {
          expect(database.isTransaction).toBe(true);
          await database('estimates').insert({ id: estimateId, token, status: 'accepted', estimate_data: {} });
          await sendgrid.sendOne({
            to: 'qa@example.invalid', subject: 'Synthetic billing update',
            html: `<a href="https://example.invalid/estimate/${token}">Review</a>`,
            text: `https://example.invalid/estimate/${token}`, withheldLinkPolicy: policy, database,
          });
        },
      });
      expect(outcome).toEqual({ ok: true });
      expect(state.providerAccepted).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(queries.filter((query) => /^select/i.test(query.sql)).length).toBeGreaterThanOrEqual(2);
      expect(new Set(queries.map((query) => query.__knexTxId)).size).toBe(1);
      expect(queries[0].__knexTxId).toBeTruthy();
    } finally { mockPg.removeListener('query', collect); }
  }, 15000);

  test.each([true, false])('full billing replay on one root slot respects current Email choice %s', async (emailEnabled) => {
    const chargeDate = etDateString(addETDays(new Date(), 1));
    await mockPg('customers').where({ id: customerId }).update({ active: true, autopay_enabled: true,
      monthly_rate: 100, billing_day: Number(chargeDate.slice(-2)), billing_mode: 'monthly_membership' });
    await mockPg('notification_prefs').where({ customer_id: customerId }).update({ email_enabled: emailEnabled });
    const estimateToken = randomUUID().replaceAll('-', '');
    await mockPg('estimates').insert({ id: randomUUID(), token: estimateToken, status: 'accepted', estimate_data: {} });
    const event = `precharge:${customerId}:${chargeDate}`;
    const attempt = randomUUID();
    const stored = {
      id: randomUUID(), template_key: 'billing.notice', recipient_type: 'customer', recipient_id: customerId,
      recipient_email_snapshot: 'qa@example.invalid', trigger_event_id: event,
      idempotency_key: `billing_channel_email:${event}:email`, subject_snapshot: 'Synthetic precharge',
      html_snapshot: `<a href="https://example.invalid/estimate/${estimateToken}">Review</a>`,
      text_snapshot: 'Synthetic precharge', suppression_group_key_snapshot: 'transactional_required',
      payload_snapshot: { __billing_replay_context: { schema_version: 1, customer_id: customerId,
        category: 'billing', source_entry_point: 'autopay_pre_charge_reminder', notificationEventKey: event, charge_date: chargeDate } },
      categories: JSON.stringify(['email_template', 'billing']), send_attempt_token: attempt,
      provider_handoff_attempt_token: attempt, provider_handoff_phase: 'pending', status: 'queued', provider_retry_count: 1,
    };
    await mockPg('email_messages').insert(stored);
    global.fetch.mockImplementation(async (_url, options) => {
      if (options.method === 'POST') {
        expect(await mockMarkerPg('email_messages').where({ id: stored.id }).first()).toMatchObject({
          provider_handoff_phase: 'started', provider_handoff_attempt_token: attempt,
        });
      }
      return { ok: true, headers: { get: () => 'synthetic-provider-id' } };
    });
    const outcome = await retryOne(stored);
    const saved = await mockPg('email_messages').where({ id: stored.id }).first();
    if (emailEnabled) {
      expect(outcome).toMatchObject({ sent: true });
      expect(saved).toMatchObject({ status: 'sent', sent_at: expect.any(Date) });
      expect(global.fetch).toHaveBeenCalledTimes(2);
    } else {
      expect(outcome).toMatchObject({ sent: false, stopped: true });
      expect(saved).toMatchObject({ status: 'blocked', provider_retry_next_at: null });
      expect(global.fetch).not.toHaveBeenCalled();
    }
  }, 15000);
});
