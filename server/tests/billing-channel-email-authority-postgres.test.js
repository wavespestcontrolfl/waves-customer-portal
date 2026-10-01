// Opt-in PostgreSQL proof that final recipient authority rows stay locked
// through the provider callback. Every write uses a disposable schema.
// Calls the authority directly (no EmailTemplateLibrary/sendTemplate in the
// loop) since the recipient-lock guarantee is the authority's job, not the
// adapter's.
let mockPg;
jest.mock('../models/db', () => {
  const database = (...args) => mockPg(...args);
  database.transaction = (...args) => mockPg.transaction(...args);
  return database;
});

jest.mock('../services/email-template-library', () => ({
  loadTemplateByKey: jest.fn(async () => ({
    template: { template_key: 'billing.notice', send_stream: 'transactional_required' },
  })),
  activeSuppressionFor: jest.fn(async () => null),
}));
jest.mock('../services/customer-contact', () => ({
  getInvoiceEmailRecipients: (customer, prefs) => [{
    email: prefs.billing_email || customer.email,
    name: customer.first_name,
    role: prefs.billing_email ? 'billing' : 'primary',
  }],
}));

const { randomUUID } = require('node:crypto');
const knex = require('knex');
const {
  loadBillingEmailContext,
  dispatchUnderBillingEmailAuthority,
} = require('../services/billing-channel-email-authority');
const { lockCustomerEmail } = require('../utils/customer-comms-lock');

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `billing_email_handoff_${randomUUID().replaceAll('-', '')}`;
const customerId = randomUUID();
let admin;

postgres('billing email recipient locks (PostgreSQL)', () => {
  beforeAll(async () => {
    const target = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true'
      && ['localhost', '127.0.0.1'].includes(target.hostname)
      && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a verified private QA database or the isolated CI database');

    admin = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    mockPg = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 5 } });
    // Keep the disposable proof independent of public-schema migrations: it
    // needs only the columns exercised by recipient authority/suppression.
    await mockPg.schema.createTable('customers', (table) => {
      table.uuid('id').primary();
      table.uuid('account_id');
      table.boolean('is_primary_profile');
      table.string('first_name');
      table.string('last_name');
      table.boolean('active');
      table.string('phone');
      table.string('email');
      table.timestamp('deleted_at', { useTz: true });
    });
    await mockPg.schema.createTable('notification_prefs', (table) => {
      table.uuid('customer_id').primary();
      table.boolean('email_enabled');
      table.specificType('billing_channels', 'text[]');
      table.string('billing_email');
    });
    await mockPg.schema.createTable('messaging_suppression', (table) => {
      table.string('phone').primary();
      table.string('reason');
      table.boolean('active');
      table.timestamp('created_at', { useTz: true });
    });
    await mockPg('customers').insert({
      id: customerId, account_id: customerId, is_primary_profile: true,
      first_name: 'QA', last_name: 'Fixture', active: true,
      phone: '+19415550100', email: 'qa-primary@example.invalid',
    });
    await mockPg('notification_prefs').insert({
      customer_id: customerId, email_enabled: true,
      billing_channels: ['email'], billing_email: 'qa-billing@example.invalid',
    });
  }, 30000);

  afterAll(async () => {
    await mockPg?.destroy();
    if (admin) {
      await admin.schema.dropSchemaIfExists(schema, true);
      await admin.destroy();
    }
  });

  test('customer and billing-email edits cannot commit during provider handoff', async () => {
    let enterDispatch;
    let releaseDispatch;
    const dispatchEntered = new Promise((resolve) => { enterDispatch = resolve; });
    const dispatchRelease = new Promise((resolve) => { releaseDispatch = resolve; });

    const input = {
      body: 'Please review your billing update.', customerId, channel: 'email',
      metadata: { billingDeliveryCategory: 'billing', notificationEventKey: 'qa:recipient-lock' },
    };
    const context = await loadBillingEmailContext(input);
    expect(context.error).toBeUndefined();

    const state = { boundaryBlock: null, handoffStarted: false, providerAccepted: false };
    const dispatching = dispatchUnderBillingEmailAuthority({
      input,
      recipientEmail: context.recipientEmail,
      dispatch: async (database, providerBoundaryCheck) => {
        expect(await providerBoundaryCheck({ database })).toEqual({ ok: true });
        enterDispatch();
        await dispatchRelease;
      },
      state,
    });
    await dispatchEntered;

    const blockedWrite = (table, update) => mockPg.transaction(async (trx) => {
      await trx.raw("SET LOCAL lock_timeout = '100ms'");
      const where = table === 'customers' ? { id: customerId } : { customer_id: customerId };
      return trx(table).where(where).update(update);
    });
    let lockProofError;
    try {
      await expect(blockedWrite('notification_prefs', { billing_email: 'qa-new@example.invalid' }))
        .rejects.toMatchObject({ code: '55P03' });
      await expect(blockedWrite('customers', { email: 'qa-new-primary@example.invalid' }))
        .rejects.toMatchObject({ code: '55P03' });
      await expect(mockPg.transaction(async (trx) => {
        await trx.raw("SET LOCAL lock_timeout = '100ms'");
        await lockCustomerEmail(trx, 'qa-billing@example.invalid');
      })).rejects.toMatchObject({ code: '55P03' });
      // A STOP / manual DNC for the customer's phone waits for the handoff.
      await expect(mockPg.transaction(async (trx) => {
        await trx.raw("SET LOCAL lock_timeout = '100ms'");
        await require('../utils/customer-comms-lock').lockSmsPhone(trx, '+19415550100');
      })).rejects.toMatchObject({ code: '55P03' });
    } catch (err) {
      lockProofError = err;
    } finally {
      releaseDispatch();
    }
    const outcome = await dispatching;
    if (lockProofError) throw lockProofError;
    expect(outcome.ok).toBe(true);
    expect(state.providerAccepted).toBe(true);
    await expect(blockedWrite('notification_prefs', { billing_email: 'qa-new@example.invalid' }))
      .resolves.toBe(1);
  }, 30000);
});
