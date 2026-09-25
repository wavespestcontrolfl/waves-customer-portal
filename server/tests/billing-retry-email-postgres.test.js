const { randomUUID } = require('node:crypto');

let mockPg;
const mockSendPaymentRetryNotice = jest.fn();

jest.mock('../models/db', () => {
  const database = (...args) => mockPg(...args);
  database.raw = (...args) => mockPg.raw(...args);
  database.transaction = (...args) => mockPg.transaction(...args);
  Object.defineProperty(database, 'fn', { get: () => mockPg.fn });
  Object.defineProperty(database, 'schema', { get: () => mockPg.schema });
  return database;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/payment-lifecycle-email', () => ({
  sendPaymentRetryNotice: (...args) => mockSendPaymentRetryNotice(...args),
}));
jest.mock('../services/automation-enroll', () => ({ enrollSequenceFromEvent: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false) }));
jest.mock('../config/twilio-numbers', () => ({ getOutboundNumber: () => '+19415550000' }));

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `billing_retry_email_${randomUUID().replaceAll('-', '')}`;
const customerId = randomUUID();
const paymentId = randomUUID();
const retryDate = '2026-10-02T14:00:00.000Z';
let admin;
let BillingRetryEmail;

jest.setTimeout(30000);

postgres('billing retry Email obligation durability (private PostgreSQL)', () => {
  beforeAll(async () => {
    const target = new URL(connection);
    if (process.env.WAVES_DATABASE_ENVIRONMENT !== 'test'
        || !/^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname)) {
      throw new Error('Use the labeled private Waves QA database');
    }
    admin = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    mockPg = require('knex')({
      client: 'pg', connection, searchPath: [schema, 'public'], pool: { min: 0, max: 6 },
    });
    for (const table of ['customers', 'payments', 'notification_prefs', 'sms_log']) {
      await mockPg.raw('CREATE TABLE ?? (LIKE ?? INCLUDING ALL)', [table, `public.${table}`]);
    }
    // The target release permits Email/App-only accounts without a phone;
    // this shared QA schema predates that published migration.
    await mockPg.raw('ALTER TABLE ?? ALTER COLUMN phone DROP NOT NULL', ['customers']);
    expect(await mockPg.schema.hasColumn('payments', 'next_retry_at')).toBe(true);
    if (await mockPg.schema.hasColumn('notification_prefs', 'payment_issue_channels')) {
      await mockPg.schema.alterTable('notification_prefs', (table) => {
        table.dropColumn('payment_issue_channels');
      });
    }
    await mockPg.schema.alterTable('notification_prefs', (table) => {
      table.specificType('payment_issue_channels', 'text[]');
    });
    expect(await mockPg.schema.hasColumn('notification_prefs', 'payment_issue_channels')).toBe(true);
    BillingRetryEmail = require('../services/billing-retry-email-obligation');
  });

  afterAll(async () => {
    await mockPg?.destroy();
    if (admin) {
      await admin.schema.dropSchemaIfExists(schema, true);
      await admin.destroy();
    }
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await mockPg('sms_log').del();
    await mockPg('notification_prefs').del();
    await mockPg('payments').del();
    await mockPg('customers').del();
    await mockPg('customers').insert({
      id: customerId,
      first_name: 'Queue',
      last_name: 'Fixture',
      email: 'queue-fixture@example.invalid',
      phone: null,
      address_line1: '100 Test Lane',
      city: 'Test',
      state: 'FL',
      zip: '00000',
      active: true,
    });
    await mockPg('notification_prefs').insert({
      customer_id: customerId,
      payment_issue_channels: ['email'],
    });
    const descriptor = BillingRetryEmail.pendingDescriptor({
      customerId, paymentId, retryDate, preferenceState: true,
    });
    await mockPg('payments').insert({
      id: paymentId,
      customer_id: customerId,
      payment_date: '2026-09-25',
      amount: '42.00',
      status: 'failed',
      description: 'Synthetic retry fixture',
      next_retry_at: retryDate,
      metadata: JSON.stringify({ billing_retry_email_notice: descriptor }),
    });
  });

  function descriptor() {
    return BillingRetryEmail.pendingDescriptor({
      customerId, paymentId, retryDate, preferenceState: true,
    });
  }

  test('queue insertion and exact descriptor clearing commit atomically', async () => {
    await expect(BillingRetryEmail.ensureObligation(descriptor(), mockPg)).resolves.toMatchObject({
      queued: true,
    });

    const [payment, queue] = await Promise.all([
      mockPg('payments').where({ id: paymentId }).first('metadata'),
      mockPg('sms_log').where({ customer_id: customerId }).first('to_phone', 'status', 'metadata'),
    ]);
    expect(payment.metadata.billing_retry_email_notice).toBeUndefined();
    expect(queue).toMatchObject({ to_phone: '', status: 'scheduled' });
    expect(queue.metadata).toMatchObject({
      requires_registered_dispatch: true,
      billing_retry_email_key: descriptor().key,
    });
  });

  test('an enqueue failure rolls back and leaves the pending descriptor durable', async () => {
    await mockPg.raw(`
      CREATE FUNCTION "${schema}".reject_retry_queue() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'synthetic queue failure';
      END $$;
      CREATE TRIGGER reject_retry_queue
      BEFORE INSERT ON "${schema}".sms_log
      FOR EACH ROW EXECUTE FUNCTION "${schema}".reject_retry_queue();
    `);
    try {
      await expect(BillingRetryEmail.ensureObligation(descriptor(), mockPg))
        .rejects.toThrow('synthetic queue failure');
      const payment = await mockPg('payments').where({ id: paymentId }).first('metadata');
      expect(payment.metadata.billing_retry_email_notice).toMatchObject({ key: descriptor().key });
      expect(await mockPg('sms_log').where({ customer_id: customerId })).toHaveLength(0);
    } finally {
      await mockPg.raw(`
        DROP TRIGGER IF EXISTS reject_retry_queue ON "${schema}".sms_log;
        DROP FUNCTION IF EXISTS "${schema}".reject_retry_queue();
      `);
    }
  });

  test('the old descriptor clear cannot erase a newer episode written during queue insertion', async () => {
    await mockPg.raw(`
      CREATE FUNCTION "${schema}".advance_retry_descriptor() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        UPDATE "${schema}".payments
        SET metadata = jsonb_set(
          COALESCE(metadata, '{}'::jsonb),
          '{billing_retry_email_notice,key}',
          to_jsonb((metadata->'billing_retry_email_notice'->>'key') || ':new')
        )
        WHERE id = (NEW.metadata->>'payment_id')::uuid;
        RETURN NEW;
      END $$;
      CREATE TRIGGER advance_retry_descriptor
      AFTER INSERT ON "${schema}".sms_log
      FOR EACH ROW EXECUTE FUNCTION "${schema}".advance_retry_descriptor();
    `);
    try {
      await expect(BillingRetryEmail.ensureObligation(descriptor(), mockPg)).resolves.toMatchObject({
        queued: true,
      });
      const payment = await mockPg('payments').where({ id: paymentId }).first('metadata');
      expect(payment.metadata.billing_retry_email_notice.key).toBe(`${descriptor().key}:new`);
      expect(await mockPg('sms_log').where({ customer_id: customerId })).toHaveLength(1);
    } finally {
      await mockPg.raw(`
        DROP TRIGGER IF EXISTS advance_retry_descriptor ON "${schema}".sms_log;
        DROP FUNCTION IF EXISTS "${schema}".advance_retry_descriptor();
      `);
    }
  });

  test('two concurrent reconcilers create one queue row and clear one descriptor', async () => {
    const [left, right] = await Promise.all([
      BillingRetryEmail.reconcilePendingNotices({ paymentId, database: mockPg }),
      BillingRetryEmail.reconcilePendingNotices({ paymentId, database: mockPg }),
    ]);

    expect(left.queued + right.queued).toBe(1);
    expect(await mockPg('sms_log').where({ customer_id: customerId })).toHaveLength(1);
    const payment = await mockPg('payments').where({ id: paymentId }).first('metadata');
    expect(payment.metadata.billing_retry_email_notice).toBeUndefined();
  });

  test('a durable provider-start marker blocks every later provider dispatch', async () => {
    const [queue] = await mockPg('sms_log').insert({
      customer_id: customerId,
      direction: 'outbound',
      from_phone: '+19415550000',
      to_phone: '',
      message_body: 'Synthetic Email obligation',
      message_type: 'payment_retry_email',
      status: 'sending',
      scheduled_for: new Date(),
      metadata: JSON.stringify({
        entry_point: BillingRetryEmail.ENTRY_POINT,
        customer_id: customerId,
        payment_id: paymentId,
        retry_date: '2026-10-02',
        preference_state: 'explicit',
        billing_retry_email_key: descriptor().key,
        billing_retry_email_mode: 'branded',
      }),
    }).returning(['id', 'metadata']);

    mockSendPaymentRetryNotice.mockImplementationOnce(async ({ beforeProviderHandoff }) => {
      expect(await beforeProviderHandoff()).toBe(true);
      return { ok: false, deliveryOutcome: 'uncertain', retryable: false };
    });
    const first = await BillingRetryEmail.replayPaymentRetryNotice({
      ...queue.metadata,
      scheduled_sms_log_id: queue.id,
    }, mockPg);
    expect(first).toMatchObject({
      sent: false,
      blocked: true,
      code: 'BILLING_EMAIL_DELIVERY_UNCERTAIN',
      deliveryOutcome: 'uncertain',
    });

    const persisted = await mockPg('sms_log').where({ id: queue.id }).first('metadata');
    expect(persisted.metadata.billing_retry_email_provider_started_at).toBeTruthy();

    const second = await BillingRetryEmail.replayPaymentRetryNotice({
      ...persisted.metadata,
      scheduled_sms_log_id: queue.id,
    }, mockPg);
    expect(second).toMatchObject({
      sent: false,
      blocked: true,
      code: 'BILLING_EMAIL_DELIVERY_UNCERTAIN',
      deliveryOutcome: 'uncertain',
    });
    expect(mockSendPaymentRetryNotice).toHaveBeenCalledTimes(1);
  });
});
