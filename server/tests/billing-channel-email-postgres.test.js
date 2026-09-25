// Opt-in PostgreSQL proof that final recipient authority rows stay locked
// through the provider callback. Every write uses a disposable schema.
let mockPg;
jest.mock('../models/db', () => {
  const database = (...args) => mockPg(...args);
  database.transaction = (...args) => mockPg.transaction(...args);
  return database;
});

const mockSendTemplate = jest.fn();
jest.mock('../services/email-template-library', () => ({
  sendTemplate: mockSendTemplate,
  redactEmailAddresses: (value) => value,
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
const { sendBillingChannelEmail } = require('../services/billing-channel-email');

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
    for (const table of ['customers', 'notification_prefs']) {
      await mockPg.raw('CREATE TABLE ?? (LIKE ?? INCLUDING ALL)', [table, `public.${table}`]);
    }
    if (!(await mockPg.schema.hasColumn('notification_prefs', 'billing_channels'))) {
      await mockPg.schema.alterTable('notification_prefs', (table) => table.specificType('billing_channels', 'text[]'));
    }
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
    mockSendTemplate.mockImplementationOnce(async ({ withProviderHandoff }) => {
      const verdict = await withProviderHandoff(async () => {
        enterDispatch();
        await dispatchRelease;
      });
      return verdict.ok
        ? { sent: true, message: { provider_message_id: 'qa-provider-1' } }
        : { sent: false, aborted: true };
    });

    const sending = sendBillingChannelEmail({
      body: 'Please review your billing update.', customerId, channel: 'email',
      metadata: { billingDeliveryCategory: 'billing', notificationEventKey: 'qa:recipient-lock' },
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
    } catch (err) {
      lockProofError = err;
    } finally {
      releaseDispatch();
    }
    const result = await sending;
    if (lockProofError) throw lockProofError;
    expect(result).toMatchObject({ sent: true, deliveryOutcome: 'accepted' });
    await expect(blockedWrite('notification_prefs', { billing_email: 'qa-new@example.invalid' }))
      .resolves.toBe(1);
  }, 30000);
});
