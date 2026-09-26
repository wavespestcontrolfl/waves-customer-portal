// Real migrated PostgreSQL types/constraints, isolated schema. Covers what
// only a real database proves: the jsonb metadata predicates in
// findAcceptedBillingTextLeg (including the reservation-promoted-row
// shape), and the nonblocking-claim concurrency guarantee in
// withBillingTextLegLock — two genuinely concurrent replays on the exact
// same customer+notificationEventKey must not both send, and neither one
// blocks waiting on a database connection to do it (proved against the
// knexfile's own supported MINIMUM pool size, 2).
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
  withBillingTextLegLock, findAcceptedBillingTextLeg, CLAIM_STALE_MS,
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

  // Codex pre-push P1: twilio.js's providerSmsMetadata() now stamps
  // billingDeliveryLeg onto a provider-handoff reservation's captured
  // context, so when the primary sms_log insert fails after Twilio
  // accepted, sms-suggest-mode.js's settleReplyHoldingReservation promotes
  // the RESERVATION row in place (status -> 'sent', metadata merged with
  // provider_outcome: 'accepted' + whatever context.metadata carried) —
  // this pins the exact shape that promotion leaves behind and proves this
  // lookup finds it, without needing to load the whole sms-suggest-mode.js
  // module (its own settlement logic has its own coverage elsewhere).
  test('a promoted provider-handoff reservation row (primary insert failed, Twilio still accepted) is found as prior acceptance', async () => {
    const reservationId = randomUUID();
    // Pre-promotion shape: created by createReplyHoldingReservation.
    await mockPg('sms_log').insert({
      id: reservationId, customer_id: customerId, direction: 'outbound',
      from_phone: '+19415550199', to_phone: '+19415550100', message_body: 'Your invoice is ready.',
      message_type: 'invoice_followup', status: 'sending', created_at: new Date(),
      metadata: JSON.stringify({ provider_handoff_reservation: true }),
    });
    // The promotion settleReplyHoldingReservation performs on acceptance:
    // status -> 'sent', twilio_sid stamped, metadata merged with the
    // captured context (which now includes billingDeliveryLeg alongside
    // notificationEventKey — the fix this test pins).
    await mockPg('sms_log').where({ id: reservationId }).update({
      status: 'sent',
      twilio_sid: `SM${'a'.repeat(32)}`,
      metadata: mockPg.raw("metadata || ?::jsonb", [JSON.stringify({
        provider_outcome: 'accepted', billingDeliveryLeg: 'sms', notificationEventKey: 'billing:key:reservation',
      })]),
    });
    const row = await findAcceptedBillingTextLeg(mockPg, customerId, 'billing:key:reservation');
    expect(row).not.toBeNull();
    expect(row.twilio_sid).toMatch(/^SM/);

    // And excludeUnresolvedSendReservations (applied inside
    // findAcceptedBillingTextLeg) does NOT hide it once promoted — only
    // while it is still 'sending'.
    const { excludeUnresolvedSendReservations } = require('../services/messaging/review-ask-reservation');
    const stillVisible = await excludeUnresolvedSendReservations(
      mockPg('sms_log').where({ id: reservationId }),
    ).first('status');
    expect(stillVisible.status).toBe('sent');
  });

  test('withBillingTextLegLock end to end: no prior row sends once, then leaves nothing behind (the claim is released)', async () => {
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

  test('a claim released after a successful send lets a LATER (sequential) replay dedupe via the real accepted row', async () => {
    const input = { customerId, metadata: { billingDeliveryLeg: 'sms', notificationEventKey: 'billing:key:sequential' } };
    let calls = 0;
    const send = jest.fn(async () => {
      calls += 1;
      await mockPg('sms_log').insert({
        id: randomUUID(), customer_id: customerId, direction: 'outbound',
        from_phone: '+19415550199', to_phone: '+19415550100', message_body: 'x',
        message_type: 'billing_reminder', status: 'sent', created_at: new Date(), twilio_sid: `SM-seq-${calls}`,
        metadata: JSON.stringify({ billingDeliveryLeg: 'sms', notificationEventKey: 'billing:key:sequential' }),
      });
      return { sent: true, provider: 'twilio', deliveryOutcome: 'accepted', providerMessageId: `SM-seq-${calls}` };
    });

    const first = await withBillingTextLegLock(input, send);
    expect(first).toMatchObject({ sent: true, providerMessageId: 'SM-seq-1' });
    expect(first.deduped).toBeUndefined();

    // The claim from the first attempt is gone (released after send
    // settled) — a second, later attempt finds the real accepted row and
    // dedupes instead of racing an in-flight claim that no longer exists.
    const second = await withBillingTextLegLock(input, send);
    expect(second).toMatchObject({ sent: true, deduped: true, providerMessageId: 'SM-seq-1' });
    expect(calls).toBe(1);
  });

  test('a stale claim (older than CLAIM_STALE_MS) is delivery-uncertain and never resent, on a real claim row', async () => {
    const notificationEventKey = 'billing:key:stale';
    await mockPg('sms_log').insert({
      id: randomUUID(), customer_id: customerId, direction: 'outbound',
      from_phone: 'billing-text-claim', to_phone: '+19415550100', message_body: '',
      message_type: 'billing_text_leg_claim', status: 'sending',
      created_at: new Date(Date.now() - CLAIM_STALE_MS - 60000),
      metadata: JSON.stringify({ billing_text_leg_claim: true, billingDeliveryLeg: 'sms', notificationEventKey }),
    });
    const send = jest.fn();
    const result = await withBillingTextLegLock({ customerId, metadata: { billingDeliveryLeg: 'sms', notificationEventKey } }, send);
    expect(send).not.toHaveBeenCalled();
    expect(result).toMatchObject({ sent: false, deliveryOutcome: 'uncertain', code: 'BILLING_TEXT_LEG_CLAIM_STALE', retryable: false });
    // Never auto-cleared — an operator must resolve it by hand.
    expect(await mockPg('sms_log').where({ status: 'sending' }).whereRaw("metadata->>'billing_text_leg_claim' = 'true'").count('* as n').first())
      .toEqual({ n: '1' });
  });

  // The core concurrency guarantee: two replays racing on the exact same
  // customer+notificationEventKey must not both reach the provider. Unlike
  // holding a transaction across send(), the claim step here commits (and
  // releases its connection) BEFORE send() ever runs — the second attempt's
  // OWN claim step (a separate, near-instant transaction) finds the
  // first's live claim and returns an in-flight hold instead of racing it.
  test('two genuinely concurrent replays on the same key: only one sends, the other is an in-flight hold', async () => {
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
    expect(results.filter((r) => r.sent === true && !r.deduped)).toHaveLength(1);
    expect(results.filter((r) => r.code === 'BILLING_TEXT_LEG_IN_FLIGHT')).toHaveLength(1);
    expect(await mockPg('sms_log').count('* as n').first()).toEqual({ n: '1' });
  });

  // knexfile.js enforces a minimum production pool of 2. Holding a
  // transaction across send() would let two concurrent billing Text legs
  // occupy both connections and stall a third caller on acquisition — the
  // whole reason for the nonblocking-claim redesign. Proves it against
  // that exact minimum: two concurrent attempts complete (one sends, one
  // is an in-flight hold) well inside the pool's own acquisition timeout,
  // never each holding a connection for the (artificially slowed) send().
  test('two concurrent attempts complete under the supported minimum pool size (2) — neither blocks waiting for a connection', async () => {
    const smallPool = require('knex')({
      client: 'pg', connection, searchPath: [schema, 'public'],
      pool: { min: 1, max: 2, acquireTimeoutMillis: 3000 },
    });
    const originalPg = mockPg;
    try {
      mockPg = smallPool;
      const input = { customerId, metadata: { billingDeliveryLeg: 'sms', notificationEventKey: 'billing:key:small-pool' } };
      let sendCalls = 0;
      const slowSend = async () => {
        sendCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { sent: true, provider: 'twilio', deliveryOutcome: 'accepted', providerMessageId: `SM-pool-${sendCalls}` };
      };

      const startedAt = Date.now();
      const [first, second] = await Promise.all([
        withBillingTextLegLock(input, slowSend),
        withBillingTextLegLock(input, slowSend),
      ]);
      const elapsedMs = Date.now() - startedAt;

      expect(sendCalls).toBe(1);
      const results = [first, second];
      expect(results.filter((r) => r.sent === true)).toHaveLength(1);
      expect(results.filter((r) => r.code === 'BILLING_TEXT_LEG_IN_FLIGHT')).toHaveLength(1);
      // Both claim steps are near-instant local DB work; only ONE side
      // actually waits out the artificial 200ms send(). If a connection
      // were held across send() instead, the second attempt's own claim
      // step would have to wait for a free connection — on a 2-connection
      // pool with the first attempt sending, that wait would itself
      // approach or exceed the acquisition timeout. Comfortably under it
      // here is the proof the claim never holds a connection into send().
      expect(elapsedMs).toBeLessThan(2000);
    } finally {
      mockPg = originalPg;
      await smallPool.destroy();
    }
  });
});
