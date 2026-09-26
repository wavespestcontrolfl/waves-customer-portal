// Real migrated PostgreSQL types/constraints, isolated schema. Covers what
// only a real database proves: the jsonb metadata predicates in
// findAcceptedBillingTextLeg, and the pg_advisory_xact_lock concurrency
// guarantee in withBillingTextLegLock — two genuinely concurrent replays on
// the exact same customer+notificationEventKey must not both send.
const { randomUUID } = require('node:crypto');

let mockPg;
jest.mock('../models/db', () => {
  const database = (...args) => mockPg(...args);
  database.raw = (...args) => mockPg.raw(...args);
  database.transaction = (...args) => mockPg.transaction(...args);
  return database;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  withBillingTextLegLock, findAcceptedBillingTextLeg,
} = require('../services/messaging/billing-text-leg-dedupe');

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `billing_text_leg_dedupe_${randomUUID().replaceAll('-', '')}`;
let admin;
let customerId;

jest.setTimeout(30000);

postgres('billing text leg dedupe (private PostgreSQL)', () => {
  beforeAll(async () => {
    const target = new URL(connection);
    if (!/^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname)) {
      throw new Error('Use the labeled private Waves QA database');
    }
    admin = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    mockPg = require('knex')({
      client: 'pg', connection, searchPath: [schema, 'public'], pool: { min: 0, max: 6 },
    });
    await mockPg.raw('CREATE TABLE ?? (LIKE ?? INCLUDING ALL)', ['sms_log', 'public.sms_log']);
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
    customerId = randomUUID();
  });

  async function insertRow(fields = {}) {
    await mockPg('sms_log').insert({
      id: randomUUID(),
      customer_id: customerId,
      direction: 'outbound',
      from_phone: '+19415550199',
      to_phone: '+19415550100',
      message_body: 'Your invoice is ready.',
      message_type: 'billing_reminder',
      status: 'sent',
      created_at: new Date(),
      metadata: JSON.stringify({ billingDeliveryLeg: 'sms', notificationEventKey: 'billing:key:1' }),
      ...fields,
      ...(fields.metadata ? { metadata: JSON.stringify(fields.metadata) } : {}),
    });
  }

  test('an accepted row (sent) for the exact customer/leg/key is found', async () => {
    await insertRow();
    const row = await findAcceptedBillingTextLeg(mockPg, customerId, 'billing:key:1');
    expect(row).not.toBeNull();
  });

  test('queued and delivered both count as accepted', async () => {
    for (const status of ['queued', 'delivered']) {
      await mockPg('sms_log').del();
      await insertRow({ status });
      expect(await findAcceptedBillingTextLeg(mockPg, customerId, 'billing:key:1')).not.toBeNull();
    }
  });

  test('failed/blocked rows do not count as accepted', async () => {
    for (const status of ['failed', 'blocked']) {
      await mockPg('sms_log').del();
      await insertRow({ status });
      expect(await findAcceptedBillingTextLeg(mockPg, customerId, 'billing:key:1')).toBeUndefined();
    }
  });

  test('the in-flight replay row itself (scheduled/sending) does not count as accepted', async () => {
    for (const status of ['scheduled', 'sending']) {
      await mockPg('sms_log').del();
      await insertRow({ status });
      expect(await findAcceptedBillingTextLeg(mockPg, customerId, 'billing:key:1')).toBeUndefined();
    }
  });

  test('a legacy send (no billingDeliveryLeg) never matches, even sharing the same key text', async () => {
    await insertRow({ metadata: { notificationEventKey: 'billing:key:1' } });
    expect(await findAcceptedBillingTextLeg(mockPg, customerId, 'billing:key:1')).toBeUndefined();
  });

  test('a different notificationEventKey or a different customer does not match', async () => {
    await insertRow();
    expect(await findAcceptedBillingTextLeg(mockPg, customerId, 'billing:key:2')).toBeUndefined();
    expect(await findAcceptedBillingTextLeg(mockPg, randomUUID(), 'billing:key:1')).toBeUndefined();
  });

  test('withBillingTextLegLock end to end: no prior row sends once and persists nothing itself', async () => {
    const send = jest.fn(async () => ({ sent: true, provider: 'twilio', deliveryOutcome: 'accepted', providerMessageId: 'SM-live' }));
    const result = await withBillingTextLegLock(
      { customerId, metadata: { billingDeliveryLeg: 'sms', notificationEventKey: 'billing:key:1' } },
      send,
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.providerMessageId).toBe('SM-live');
    expect(await mockPg('sms_log').count('* as n').first()).toEqual({ n: '0' });
  });

  test('withBillingTextLegLock end to end: a prior accepted row dedupes without calling send', async () => {
    await insertRow({ metadata: { billingDeliveryLeg: 'sms', notificationEventKey: 'billing:key:1' } });
    const send = jest.fn();
    const result = await withBillingTextLegLock(
      { customerId, metadata: { billingDeliveryLeg: 'sms', notificationEventKey: 'billing:key:1' } },
      send,
    );
    expect(send).not.toHaveBeenCalled();
    expect(result).toMatchObject({ sent: true, deliveryOutcome: 'accepted', deduped: true });
  });

  // The core concurrency guarantee: two replays racing on the exact same
  // customer+notificationEventKey must not both reach the provider. The
  // first attempt's `send` holds the lock deliberately (a real Twilio round
  // trip) and, once "accepted", writes the durable sms_log row itself
  // (mirroring services/twilio.js's own post-accept insert) before
  // resolving — exactly the shape withBillingTextLegLock is designed to
  // protect: the lock stays held until that write is durable.
  test('two genuinely concurrent replays on the same key: only one sends', async () => {
    const input = { customerId, metadata: { billingDeliveryLeg: 'sms', notificationEventKey: 'billing:key:racing' } };
    let sendCalls = 0;
    const slowSend = async () => {
      sendCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 150));
      await mockPg('sms_log').insert({
        id: randomUUID(), customer_id: customerId, direction: 'outbound',
        from_phone: '+19415550199', to_phone: '+19415550100', message_body: 'x',
        message_type: 'billing_reminder', status: 'sent', created_at: new Date(),
        metadata: JSON.stringify({ billingDeliveryLeg: 'sms', notificationEventKey: 'billing:key:racing' }),
      });
      return { sent: true, provider: 'twilio', deliveryOutcome: 'accepted', providerMessageId: `SM-race-${sendCalls}` };
    };

    const [first, second] = await Promise.all([
      withBillingTextLegLock(input, slowSend),
      withBillingTextLegLock(input, slowSend),
    ]);

    expect(sendCalls).toBe(1);
    const results = [first, second];
    expect(results.filter((r) => r.deduped)).toHaveLength(1);
    expect(results.filter((r) => !r.deduped)).toHaveLength(1);
    expect(await mockPg('sms_log').count('* as n').first()).toEqual({ n: '1' });
  });
});
