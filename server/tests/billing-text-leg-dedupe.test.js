// Text-leg idempotency for the explicit billing-channel router
// (billing-channel-routing.js). Covers the module's own guard scoping
// (explicit billing Text legs only), the accepted/failed/in-flight status
// classification of the lookup, and the fail-open/no-double-send behavior
// of withBillingTextLegLock. The full router fan-out (Email+Text both
// previously accepted) is covered in billing-text-leg-dedupe-postgres.test.js
// against a real sms_log table.
jest.mock('../models/db', () => {
  const dbMock = jest.fn();
  return dbMock;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const logger = require('../services/logger');
const {
  withBillingTextLegLock, findAcceptedBillingTextLeg, ACCEPTED_STATUSES,
} = require('../services/messaging/billing-text-leg-dedupe');

// A minimal chainable query-builder stub compatible with
// review-ask-reservation.js's excludeUnresolvedSendReservations (which
// calls .whereRaw on whatever is passed to it) and this module's own
// .where/.whereRaw/.whereIn/.orderBy/.first chain.
function makeQuery(row) {
  const calls = [];
  const query = {};
  for (const method of ['where', 'whereRaw', 'whereIn', 'orderBy']) {
    query[method] = (...args) => { calls.push([method, ...args]); return query; };
  }
  query.first = async () => row;
  query.__calls = calls;
  return query;
}

function makeTrx(row) {
  const raw = jest.fn(async () => ({}));
  let lastQuery = null;
  const trx = (table) => { lastQuery = makeQuery(row); trx.__lastTable = table; return lastQuery; };
  trx.raw = raw;
  Object.defineProperty(trx, '__lastQuery', { get: () => lastQuery });
  return trx;
}

function baseInput(overrides = {}) {
  return {
    to: '+19415550100',
    body: 'Your invoice is ready.',
    channel: 'sms',
    customerId: 'cust-1',
    metadata: {
      billingDeliveryLeg: 'sms',
      notificationEventKey: 'billing:cust-1:billing_reminder:abc123',
    },
    ...overrides,
  };
}

describe('billing-text-leg-dedupe', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('findAcceptedBillingTextLeg', () => {
    test('scopes the lookup to this customer, direction, leg, and key, accepted statuses only', async () => {
      const query = makeQuery({ twilio_sid: 'SM1', created_at: new Date('2026-09-01T00:00:00Z') });
      const conn = jest.fn(() => query);
      const row = await findAcceptedBillingTextLeg(conn, 'cust-1', 'billing:cust-1:billing_reminder:abc123');
      expect(conn).toHaveBeenCalledWith('sms_log');
      expect(query.__calls).toEqual(expect.arrayContaining([
        ['where', { customer_id: 'cust-1', direction: 'outbound' }],
        ['whereRaw', "metadata->>'billingDeliveryLeg' = 'sms'"],
        ['whereRaw', "metadata->>'notificationEventKey' = ?", ['billing:cust-1:billing_reminder:abc123']],
        ['whereIn', 'status', ACCEPTED_STATUSES],
      ]));
      expect(ACCEPTED_STATUSES).toEqual(['queued', 'sent', 'delivered']);
      expect(row).toEqual({ twilio_sid: 'SM1', created_at: new Date('2026-09-01T00:00:00Z') });
    });
  });

  describe('withBillingTextLegLock', () => {
    test('a legacy send with no billingDeliveryLeg never opens a transaction or calls send twice', async () => {
      db.transaction = jest.fn();
      const send = jest.fn(async () => ({ sent: true, provider: 'twilio', deliveryOutcome: 'accepted', providerMessageId: 'SM-legacy' }));
      const result = await withBillingTextLegLock(baseInput({ metadata: {} }), send);
      expect(send).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ sent: true, provider: 'twilio', deliveryOutcome: 'accepted', providerMessageId: 'SM-legacy' });
      expect(db.transaction).not.toHaveBeenCalled();
    });

    test('a push leg (billingDeliveryLeg push) is untouched — only sms legs are guarded', async () => {
      db.transaction = jest.fn();
      const send = jest.fn(async () => ({ sent: true }));
      await withBillingTextLegLock(baseInput({ metadata: { billingDeliveryLeg: 'push', notificationEventKey: 'k' } }), send);
      expect(send).toHaveBeenCalledTimes(1);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    test('an explicit billing Text leg with no notificationEventKey sends unprotected', async () => {
      db.transaction = jest.fn();
      const send = jest.fn(async () => ({ sent: true }));
      await withBillingTextLegLock(baseInput({ metadata: { billingDeliveryLeg: 'sms' } }), send);
      expect(send).toHaveBeenCalledTimes(1);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    test('an explicit billing Text leg with no customerId sends unprotected', async () => {
      db.transaction = jest.fn();
      const send = jest.fn(async () => ({ sent: true }));
      await withBillingTextLegLock(baseInput({ customerId: null }), send);
      expect(send).toHaveBeenCalledTimes(1);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    test('a prior accepted row for the key dedupes — no provider call', async () => {
      const trx = makeTrx({ twilio_sid: 'SMprior00000000000000000000000000', created_at: new Date('2026-09-01T00:00:00Z') });
      db.transaction = jest.fn(async (cb) => cb(trx));
      const send = jest.fn(async () => ({ sent: true, provider: 'twilio', deliveryOutcome: 'accepted', providerMessageId: 'SM-new' }));

      const result = await withBillingTextLegLock(baseInput(), send);

      expect(send).not.toHaveBeenCalled();
      expect(trx.raw).toHaveBeenCalledWith(
        'SELECT pg_advisory_xact_lock(hashtextextended(?, 0))',
        ['billing_text_leg:cust-1:billing:cust-1:billing_reminder:abc123'],
      );
      expect(result).toEqual({
        sent: true,
        provider: 'twilio',
        deliveryOutcome: 'accepted',
        deduped: true,
        providerMessageId: 'SMprior00000000000000000000000000',
        sentAt: new Date('2026-09-01T00:00:00Z'),
      });
    });

    test('no prior accepted row -> send() runs exactly once inside the lock, and its result is returned verbatim', async () => {
      const trx = makeTrx(null);
      db.transaction = jest.fn(async (cb) => cb(trx));
      const send = jest.fn(async () => ({ sent: true, provider: 'twilio', deliveryOutcome: 'accepted', providerMessageId: 'SM-new' }));

      const result = await withBillingTextLegLock(baseInput(), send);

      expect(send).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ sent: true, provider: 'twilio', deliveryOutcome: 'accepted', providerMessageId: 'SM-new' });
    });

    test('a prior failed/blocked row does not count as accepted -> sends', async () => {
      // findAcceptedBillingTextLeg itself is what excludes non-accepted
      // statuses (whereIn ACCEPTED_STATUSES) — a real DB never returns a
      // failed/blocked row to this lookup, so the stub returning null here
      // models exactly that: the query found nothing.
      const trx = makeTrx(null);
      db.transaction = jest.fn(async (cb) => cb(trx));
      const send = jest.fn(async () => ({ sent: true, deliveryOutcome: 'accepted' }));
      await withBillingTextLegLock(baseInput(), send);
      expect(send).toHaveBeenCalledTimes(1);
    });

    test('lock acquisition failure fails closed with a schedulable hold and never sends', async () => {
      db.transaction = jest.fn(async () => { throw new Error('advisory lock unavailable'); });
      const send = jest.fn(async () => ({ sent: true, provider: 'twilio', deliveryOutcome: 'accepted' }));

      const result = await withBillingTextLegLock(baseInput(), send);

      expect(send).not.toHaveBeenCalled();
      expect(result).toMatchObject({ sent: false, blocked: true, deliveryOutcome: 'not_sent',
        code: 'BILLING_TEXT_DEDUPE_UNAVAILABLE', retryable: true, deferred: true });
      expect(Date.parse(result.nextAllowedAt)).toBeGreaterThan(Date.now());
      expect(require('../services/messaging/billing-channel-routing').REPLAY_HOLD_CODES)
        .toContain('BILLING_TEXT_DEDUPE_UNAVAILABLE');
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('lock/lookup failed'));
    });

    test('a throw from send() itself (inside the lock) propagates and is never retried unprotected', async () => {
      const trx = makeTrx(null);
      db.transaction = jest.fn(async (cb) => cb(trx));
      const send = jest.fn(async () => { throw new Error('twilio SDK exploded'); });

      await expect(withBillingTextLegLock(baseInput(), send)).rejects.toThrow('twilio SDK exploded');
      expect(send).toHaveBeenCalledTimes(1);
    });

    test('a different notificationEventKey for the same customer is a separate lock/lookup and sends', async () => {
      const trx = makeTrx(null);
      db.transaction = jest.fn(async (cb) => cb(trx));
      const send = jest.fn(async () => ({ sent: true }));
      await withBillingTextLegLock(baseInput({ metadata: { billingDeliveryLeg: 'sms', notificationEventKey: 'billing:cust-1:receipt:def456' } }), send);
      expect(trx.raw).toHaveBeenCalledWith(
        'SELECT pg_advisory_xact_lock(hashtextextended(?, 0))',
        ['billing_text_leg:cust-1:billing:cust-1:receipt:def456'],
      );
      expect(send).toHaveBeenCalledTimes(1);
    });
  });
});
