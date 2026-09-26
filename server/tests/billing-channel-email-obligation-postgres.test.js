/** Opt-in proof against a verified private QA database; all rows live in a disposable schema. */
jest.mock('../models/db', () => {
  const conn = (...args) => mockPg(...args);
  conn.transaction = (...args) => mockPg.transaction(...args);
  conn.raw = (...args) => mockPg.raw(...args);
  return conn;
});
jest.mock('../config/twilio-numbers', () => ({ getOutboundNumber: () => '+19415550000' }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));

const knex = require('knex');
const { randomUUID } = require('node:crypto');
const obligation = require('../services/messaging/billing-channel-email-obligation');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const connection = process.env.BILLING_EMAIL_OBLIGATION_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `billing_email_obligation_${randomUUID().replaceAll('-', '')}`;
let admin;
let mockPg;
let customerId;
jest.setTimeout(60000);

postgres('billing Email-only obligation PostgreSQL', () => {
  beforeEach(() => jest.clearAllMocks());
  beforeAll(async () => {
    if (process.env.WAVES_DATABASE_ENVIRONMENT !== 'test'
      || !/^\/waves_qa_[a-f0-9]{32}$/.test(new URL(connection).pathname)) {
      throw new Error('Use a verified private Waves QA database with test environment marker');
    }
    admin = knex({ client: 'pg', connection });
    await admin.schema.createSchema(schema);
    mockPg = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 5 } });
    for (const table of ['customers', 'sms_log', 'email_messages']) {
      await admin.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [schema, table, table]);
    }
    customerId = randomUUID();
    await mockPg('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Fixture',
      phone: '+12025550101', email: 'synthetic@example.invalid' });
  });

  afterAll(async () => {
    if (mockPg) await mockPg.destroy();
    if (admin) {
      await admin.schema.dropSchemaIfExists(schema, true);
      await admin.destroy();
    }
  });

  function notice() {
    return { customerId, purpose: 'payment_receipt', body: 'Synthetic receipt notification',
      metadata: { original_message_type: 'receipt' } };
  }

  test('concurrent same-event enqueues create exactly one no-phone Email owner', async () => {
    const eventKey = `receipt:${randomUUID()}`;
    const failure = { sent: false, retryable: true, deliveryOutcome: 'not_sent' };
    const outcomes = await Promise.all(Array.from({ length: 4 }, () =>
      obligation.queueObligation(notice(), 'payment_receipt', eventKey, failure, ['sms'])));
    expect(outcomes.filter((item) => item.duplicate !== true)).toHaveLength(1);
    const rows = await mockPg('sms_log').whereRaw("metadata->>'billing_channel_email_key' = ?", [obligation.obligationKey(eventKey)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ customer_id: customerId, to_phone: '', status: 'scheduled' });
    expect(rows[0].metadata).toMatchObject({ entry_point: obligation.ENTRY_POINT,
      requires_registered_dispatch: true, billingDeliveryLeg: 'email', channel: 'email',
      notificationEventKey: eventKey, billing_email_siblings: { sms: 'pending' } });
  });

  test('concurrent Email status writes and sibling progress preserve both JSONB fields', async () => {
    const eventKey = `receipt:${randomUUID()}`;
    const queued = await obligation.queueObligation(notice(), 'payment_receipt', eventKey,
      { sent: false, retryable: true, deliveryOutcome: 'not_sent' }, ['sms']);
    expect(await obligation.claimSibling(queued.id, 'sms')).toBe(true);
    const [emailStatus, siblingStatus] = await Promise.all([
      mockPg('sms_log').where({ id: queued.id }).update({
        status: 'sending', metadata: mockPg.raw(
          "COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('scheduled_sms_attempts', 1)"),
      }),
      obligation.transitionSibling(queued.id, 'sms', 'started', 'accepted'),
    ]);
    expect(emailStatus).toBe(1);
    expect(siblingStatus).toBe(true);
    await mockPg('sms_log').where({ id: queued.id }).update({
      status: 'sent', metadata: mockPg.raw(
        "COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('queued_at', to_jsonb(created_at))"),
    });
    const row = await mockPg('sms_log').where({ id: queued.id }).first();
    expect(row).toMatchObject({ status: 'sent', metadata: {
      scheduled_sms_attempts: 1, billing_email_siblings: { sms: 'accepted' },
      notificationEventKey: eventKey,
    } });
    expect(await obligation.claimSibling(queued.id, 'sms')).toBe(false);
  });

  test('an in-flight original Email collision is durably held even after its row grows stale', async () => {
    const eventKey = `receipt:${randomUUID()}`;
    await mockPg('email_messages').insert({ id: randomUUID(),
      idempotency_key: obligation.obligationKey(eventKey), status: 'queued',
      recipient_email_snapshot: 'synthetic@example.invalid',
      queued_at: new Date(Date.now() - 10 * 60 * 1000) });
    const queued = await obligation.queueObligation(notice(), 'payment_receipt', eventKey,
      { sent: false, retryable: true, deliveryOutcome: 'not_sent' }, ['sms']);
    expect(queued).toMatchObject({ queued: true, uncertain: true });
    const row = await mockPg('sms_log').where({ id: queued.id }).first();
    expect(row).toMatchObject({ status: 'blocked', metadata: { billing_email_uncertain: true } });
  });

  test.each(['queued', 'failed'])('a late %s initial attempt cannot be reclaimed by the queued replay', async (status) => {
    const eventKey = `receipt:${randomUUID()}`;
    const queued = await obligation.queueObligation(notice(), 'payment_receipt', eventKey,
      { sent: false, retryable: true, deliveryOutcome: 'not_sent' }, []);
    await mockPg('email_messages').insert({ id: randomUUID(),
      idempotency_key: obligation.obligationKey(eventKey), status,
      recipient_email_snapshot: 'synthetic@example.invalid',
      error_message: status === 'failed' ? 'transport response lost' : null,
      queued_at: new Date(Date.now() - 10 * 60 * 1000) });
    await mockPg('sms_log').where({ id: queued.id }).update({ status: 'sending' });
    const row = await mockPg('sms_log').where({ id: queued.id }).first();
    await expect(obligation.replay({ ...row.metadata, scheduled_sms_log_id: row.id }))
      .resolves.toMatchObject({ sent: false, blocked: true, deliveryOutcome: 'uncertain' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a concurrent uncertain initial result escalates an existing owner to a durable hold', async () => {
    const eventKey = `receipt:${randomUUID()}`;
    const queued = await obligation.queueObligation(notice(), 'payment_receipt', eventKey,
      { sent: false, retryable: true, deliveryOutcome: 'not_sent' }, ['sms']);
    expect(await obligation.queueObligation(notice(), 'payment_receipt', eventKey,
      { sent: false, deliveryOutcome: 'uncertain' }, ['sms']))
      .toMatchObject({ queued: true, duplicate: true, blocked: true, deliveryOutcome: 'uncertain' });
    const row = await mockPg('sms_log').where({ id: queued.id }).first();
    expect(row).toMatchObject({ status: 'blocked', metadata: {
      billing_email_uncertain: true, billing_email_siblings: { sms: 'pending' },
    } });
    expect(await obligation.recheck(row.metadata)).toMatchObject({ eligible: false });
  });

  test('a crash after provider-start leaves a durable fence that suppresses stale claim replay', async () => {
    const eventKey = `receipt:${randomUUID()}`;
    const queued = await obligation.queueObligation(notice(), 'payment_receipt', eventKey,
      { sent: false, retryable: true, deliveryOutcome: 'not_sent' }, []);
    await mockPg('sms_log').where({ id: queued.id }).update({ status: 'sending' });
    sendCustomerMessage.mockImplementationOnce(async (input) => {
      expect(await input.preSendCheck()).toEqual({ ok: true });
      throw new Error('simulated process death after provider handoff');
    });
    const meta = { ...(await mockPg('sms_log').where({ id: queued.id }).first()).metadata,
      scheduled_sms_log_id: queued.id };
    await expect(obligation.replay(meta)).resolves.toMatchObject({ sent: false,
      deliveryOutcome: 'uncertain', code: 'BILLING_EMAIL_DELIVERY_UNCERTAIN' });
    const inFlight = await mockPg('sms_log').where({ id: queued.id }).first();
    expect(inFlight.metadata.billing_email_provider_started_at).toBeTruthy();
    await mockPg('sms_log').where({ id: queued.id }).update({ status: 'scheduled' });
    await expect(obligation.recheck(inFlight.metadata)).resolves.toMatchObject({ eligible: false,
      reason: 'billing-email-delivery-uncertain' });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  });

  test('only a proven not_sent result clears the provider-start fence for bounded retry', async () => {
    const eventKey = `receipt:${randomUUID()}`;
    const queued = await obligation.queueObligation(notice(), 'payment_receipt', eventKey,
      { sent: false, retryable: true, deliveryOutcome: 'not_sent' }, []);
    await mockPg('sms_log').where({ id: queued.id }).update({ status: 'sending' });
    sendCustomerMessage.mockImplementationOnce(async (input) => {
      expect(await input.preSendCheck()).toEqual({ ok: true });
      await mockPg('email_messages').insert({ id: randomUUID(),
        idempotency_key: obligation.obligationKey(eventKey), status: 'failed',
        send_attempt_token: randomUUID(), recipient_email_snapshot: 'synthetic@example.invalid',
        error_message: 'definite provider rejection' });
      return { sent: false, retryable: true, deliveryOutcome: 'not_sent', code: 'EMAIL_PROVIDER_REJECTED' };
    });
    const meta = { ...(await mockPg('sms_log').where({ id: queued.id }).first()).metadata,
      scheduled_sms_log_id: queued.id };
    await expect(obligation.replay(meta)).resolves.toMatchObject({ sent: false,
      retryable: true, deliveryOutcome: 'not_sent' });
    const row = await mockPg('sms_log').where({ id: queued.id }).first();
    expect(row.metadata.billing_email_provider_started_at).toBeUndefined();
    expect(row.metadata.billing_email_safe_attempt_token).toBeTruthy();
    await expect(obligation.recheck(row.metadata)).resolves.toEqual({ eligible: true });
    sendCustomerMessage.mockImplementationOnce(async (input) => {
      expect(await input.preSendCheck()).toEqual({ ok: true });
      return { sent: true, deliveryOutcome: 'accepted' };
    });
    await expect(obligation.replay({ ...row.metadata, scheduled_sms_log_id: queued.id }))
      .resolves.toMatchObject({ sent: true, deliveryOutcome: 'accepted' });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(2);
  });
});
