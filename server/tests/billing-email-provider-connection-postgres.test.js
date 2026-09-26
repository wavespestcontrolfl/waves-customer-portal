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
    await mockPg.schema.createTable('customers', (table) => {
      table.uuid('id').primary(); table.text('email'); table.timestamp('deleted_at');
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
    await mockPg('customers').insert({ id: customerId, email: 'qa@example.invalid' });
    await mockPg('notification_prefs').insert({ customer_id: customerId,
      email_enabled: true, billing_channels: ['email'] });

    // Minimal invoices shape for the invoiceId dispatch below: just enough
    // columns for withInvoiceDepositSettlement's own lock+read (payer_id,
    // total, notes for its deposit-provenance scan), selfPayAtDispatch's
    // ownership recheck (payer_id, scheduled_send_error), and
    // billingEmailPreSendCheck's own re-read (send_claim_token).
    await mockPg.schema.createTable('invoices', (table) => {
      table.uuid('id').primary(); table.uuid('customer_id'); table.uuid('payer_id');
      table.text('status'); table.text('send_claim_token'); table.text('scheduled_send_error');
      table.text('total'); table.decimal('credit_applied'); table.jsonb('line_items'); table.text('notes');
    });
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

  // Invoice delivery's explicit billing Email leg (send-customer-message.js
  // billingEmailLeg) composes billingEmailPreSendCheck into preSendCheck
  // here — invoice.js's own hook re-reads `invoices` by id through the SAME
  // database it is given, never opening a fresh root-pool connection. This
  // pool has exactly ONE slot: a hook that reached through the plain `db`
  // module instead of its given `database` would starve on the still-open
  // outer transaction and this test would time out.
  test('an invoiceId dispatch composes the invoice pre-send check under the SAME held connection, never a second slot', async () => {
    const invoiceId = randomUUID();
    await mockPg('invoices').insert({
      id: invoiceId, customer_id: customerId, status: 'sending', send_claim_token: 'qa-claim',
      total: '50.00', credit_applied: 0, line_items: JSON.stringify([]),
    });
    const queries = [];
    const collect = (query) => { if (/"invoices"/.test(query.sql)) queries.push(query); };
    mockPg.on('query', collect);
    const state = { boundaryBlock: null, handoffStarted: false, providerAccepted: false };
    // Stand-in for invoice.js's billingEmailPreSendCheck: re-reads the
    // invoice by id through the given locked handle and checks the SAME
    // send-claim precondition checkInvoiceDeliveryPreconditions runs first.
    const billingEmailPreSendCheck = jest.fn(async ({ database }) => {
      const current = await database('invoices').where({ id: invoiceId }).first();
      return current?.send_claim_token === 'qa-claim'
        ? { ok: true }
        : { ok: false, code: 'send_claim_lost', reason: 'Invoice send claim changed; delivery not attempted' };
    });
    try {
      const outcome = await dispatchUnderBillingEmailAuthority({
        input: { customerId, invoiceId, metadata: { billingDeliveryCategory: 'billing' } },
        recipientEmail: 'qa@example.invalid', state,
        // Exactly how providerPreparationCheck (send-customer-message.js)
        // calls it: channel + the locked database it was itself given.
        preSendCheck: async ({ database }) => billingEmailPreSendCheck({ channel: 'email', database }),
        dispatch: async (database) => {
          expect(database.isTransaction).toBe(true);
          await sendgrid.sendOne({
            to: 'qa@example.invalid', subject: 'Synthetic invoice notice',
            html: '<p>Your invoice is ready.</p>', text: 'Your invoice is ready.', database,
          });
        },
      });
      expect(outcome).toEqual({ ok: true });
      expect(state.providerAccepted).toBe(true);
      expect(billingEmailPreSendCheck).toHaveBeenCalledTimes(1);
      expect(new Set(queries.map((query) => query.__knexTxId)).size).toBe(1);
      expect(queries[0].__knexTxId).toBeTruthy();
    } finally { mockPg.removeListener('query', collect); }
  }, 15000);
});
