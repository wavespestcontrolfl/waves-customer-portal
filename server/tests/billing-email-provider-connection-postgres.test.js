// Real provider preparation under billing authority with a one-slot pool.
// Only the HTTP transport and template/suppression lookup are mocked.
let mockPg;
jest.mock('../models/db', () => {
  const database = (...args) => mockPg(...args);
  database.transaction = (...args) => mockPg.transaction(...args);
  return database;
});
jest.mock('../services/email-template-library', () => ({
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
const { recordSuppression } = require('../services/messaging/validators/suppression');
const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `billing_provider_connection_${randomUUID().replaceAll('-', '')}`;
const customerId = randomUUID();
const originalApiKey = process.env.SENDGRID_API_KEY;
const originalFetch = global.fetch;
let admin;
let writer;

async function waitForPhoneLock(pid) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const result = await admin.raw("SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = ? AND locktype = 'advisory' AND NOT granted) AS waiting", [pid]);
    if (result.rows[0].waiting) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Expected a concurrent phone-lock waiter');
}

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
    writer = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 1 } });
    await mockPg.schema.createTable('customers', (table) => {
      table.uuid('id').primary(); table.text('email'); table.text('phone'); table.timestamp('deleted_at');
    });
    await mockPg.schema.createTable('notification_prefs', (table) => {
      table.uuid('customer_id').primary(); table.boolean('email_enabled');
      table.specificType('billing_channels', 'text[]');
    });
    await mockPg.schema.createTable('messaging_suppression', (table) => {
      table.text('phone').primary(); table.text('reason'); table.boolean('active'); table.timestamp('created_at');
      table.text('source'); table.text('captured_body'); table.timestamp('cleared_at');
    });
    await mockPg.schema.createTable('estimates', (table) => {
      table.uuid('id').primary(); table.text('token'); table.jsonb('estimate_data');
      for (const column of ['status', 'expires_at', 'customer_id', 'property_id', 'estimate_group_id',
        'customer_name', 'customer_phone', 'customer_email', 'address', 'notes', 'monthly_total',
        'annual_total', 'onetime_total', 'show_one_time_option', 'bill_by_invoice', 'waveguard_tier',
        'service_interest', 'category', 'source']) table.text(column);
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
    await mockPg?.destroy();
    await writer?.destroy();
    if (admin) { await admin.schema.dropSchemaIfExists(schema, true); await admin.destroy(); }
  });

  test.each(['refuse', 'rewrite'])('%s checks allow no-phone customers and never acquire a second slot', async (policy) => {
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

  test.each([
    ['manual_dnc', 'SUPPRESSED_MANUAL_DNC'],
    ['opt_out_keyword', 'SUPPRESSED_OPT_OUT'],
  ])('%s blocks provider work under the held transaction', async (reason, code) => {
    const phone = '+19415550100';
    await mockPg('customers').where({ id: customerId }).update({ phone });
    await mockPg('messaging_suppression').insert({ phone, reason, active: true, created_at: new Date() });
    const dispatch = jest.fn(async (database) => sendgrid.sendOne({
      to: 'qa@example.invalid', subject: 'Suppressed billing update', html: '<p>Blocked</p>', text: 'Blocked', database,
    }));
    const state = { boundaryBlock: null, handoffStarted: false, providerAccepted: false };
    try {
      await expect(dispatchUnderBillingEmailAuthority({
        input: { customerId, metadata: { billingDeliveryCategory: 'billing' } },
        recipientEmail: 'qa@example.invalid', state, dispatch,
      })).resolves.toEqual({ ok: false });
      expect(state.boundaryBlock).toMatchObject({ code, blocked: true });
      expect(dispatch).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
    } finally {
      await mockPg('messaging_suppression').where({ phone }).delete();
      await mockPg('customers').where({ id: customerId }).update({ phone: null });
    }
  }, 15000);

  test('an unreadable all-channel suppression store returns a retryable hold', async () => {
    const phone = '+19415550100';
    await mockPg('customers').where({ id: customerId }).update({ phone });
    await mockPg.schema.renameTable('messaging_suppression', 'messaging_suppression_unavailable');
    const dispatch = jest.fn();
    const state = { boundaryBlock: null, handoffStarted: false, providerAccepted: false };
    try {
      await expect(dispatchUnderBillingEmailAuthority({
        input: { customerId, metadata: { billingDeliveryCategory: 'billing' } },
        recipientEmail: 'qa@example.invalid', state, dispatch,
      })).resolves.toEqual({ ok: false });
      expect(state.boundaryBlock).toMatchObject({ code: 'BILLING_EMAIL_RECHECK_FAILED', retryable: true,
        reason: 'Billing email authority could not be verified' });
      expect(dispatch).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
    } finally {
      await mockPg.schema.renameTable('messaging_suppression_unavailable', 'messaging_suppression');
      await mockPg('customers').where({ id: customerId }).update({ phone: null });
    }
  }, 15000);

  test('SMS-only non_mobile suppression still permits authorized Email dispatch', async () => {
    const phone = '+19415550100';
    await mockPg('customers').where({ id: customerId }).update({ phone });
    await mockPg('messaging_suppression').insert({ phone, reason: 'non_mobile', active: true });
    const state = { boundaryBlock: null, handoffStarted: false, providerAccepted: false };
    try {
      expect(await dispatchUnderBillingEmailAuthority({
        input: { customerId, metadata: { billingDeliveryCategory: 'billing' } },
        recipientEmail: 'qa@example.invalid', state,
        dispatch: (database) => sendgrid.sendOne({ to: 'qa@example.invalid', subject: 'Synthetic update',
          html: '<p>Authorized Email</p>', text: 'Authorized Email', database }),
      })).toEqual({ ok: true });
      expect(state.providerAccepted).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    } finally {
      await mockPg('messaging_suppression').where({ phone }).delete();
      await mockPg('customers').where({ id: customerId }).update({ phone: null });
    }
  }, 15000);

  test('a prior suppression writer commits before the handoff recheck and blocks dispatch', async () => {
    const phone = '+19415550100';
    await mockPg('customers').where({ id: customerId }).update({ phone });
    const { rows: [{ pid }] } = await mockPg.raw('SELECT pg_backend_pid() AS pid');
    const suppression = await writer.transaction();
    const state = { boundaryBlock: null, handoffStarted: false, providerAccepted: false };
    const dispatch = jest.fn();
    let sending;
    try {
      expect(await recordSuppression({ phone, reason: 'manual_dnc', dbh: suppression })).toEqual({ ok: true });
      sending = dispatchUnderBillingEmailAuthority({
        input: { customerId, metadata: { billingDeliveryCategory: 'billing' } },
        recipientEmail: 'qa@example.invalid', state, dispatch,
      });
      await waitForPhoneLock(pid);
      // A phone-first writer can still take recipient rows: the waiting
      // sender must not hold them before acquiring the shared phone lock.
      await suppression('customers').where({ id: customerId }).update({ phone });
      await suppression.commit();
      expect(await sending).toEqual({ ok: false });
      expect(state.boundaryBlock).toMatchObject({ code: 'SUPPRESSED_MANUAL_DNC' });
      expect(dispatch).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
    } finally {
      if (!suppression.isCompleted()) await suppression.rollback();
      await sending;
      await mockPg('messaging_suppression').where({ phone }).delete();
      await mockPg('customers').where({ id: customerId }).update({ phone: null });
    }
  }, 15000);

  test('a later suppression writer cannot commit between authorization and provider dispatch', async () => {
    const phone = '+19415550100';
    await mockPg('customers').where({ id: customerId }).update({ phone });
    const { rows: [{ pid }] } = await writer.raw('SELECT pg_backend_pid() AS pid');
    const state = { boundaryBlock: null, handoffStarted: false, providerAccepted: false };
    let suppression;
    let committed = false;
    try {
      const result = await dispatchUnderBillingEmailAuthority({
        input: { customerId, metadata: { billingDeliveryCategory: 'billing' } },
        recipientEmail: 'qa@example.invalid', state,
        preSendCheck: async () => {
          suppression = recordSuppression({ phone, reason: 'manual_dnc', dbh: writer })
            .then(outcome => { committed = true; return outcome; });
          await waitForPhoneLock(pid);
          return { ok: true };
        },
        dispatch: async (database) => {
          expect(committed).toBe(false);
          await sendgrid.sendOne({ to: 'qa@example.invalid', subject: 'Synthetic billing update',
            html: '<p>Authorized</p>', text: 'Authorized', database });
          expect(committed).toBe(false);
        },
      });
      expect(result).toEqual({ ok: true });
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(await suppression).toEqual({ ok: true });
      expect(committed).toBe(true);
    } finally {
      await suppression;
      await mockPg('messaging_suppression').where({ phone }).delete();
      await mockPg('customers').where({ id: customerId }).update({ phone: null });
    }
  }, 15000);
});
