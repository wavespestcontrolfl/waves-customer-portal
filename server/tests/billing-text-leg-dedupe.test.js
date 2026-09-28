// Text-leg idempotency for the explicit billing-channel router
// (billing-channel-routing.js). Covers the module's own guard scoping
// (explicit billing Text legs only), the nonblocking-claim shape (a short
// transaction: try-lock, prior-acceptance lookup, live-claim lookup, claim
// insert — never a connection held across send()), the accepted/in-flight/
// stale classification, and the fail-closed infra-failure hold. The
// concurrency guarantee itself (two genuinely concurrent attempts, one
// sends) and the real-database claim/lookup shapes are covered against a
// real sms_log table in billing-text-leg-dedupe-postgres.test.js.
jest.mock('../models/db', () => {
  const dbMock = jest.fn();
  return dbMock;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const logger = require('../services/logger');
const {
  withBillingTextLegLock, findAcceptedBillingTextLeg, ACCEPTED_STATUSES, CLAIM_STALE_MS,
} = require('../services/messaging/billing-text-leg-dedupe');

// A minimal chainable sms_log query-builder stub. `kind` is inferred from
// the chain (a whereIn('status', ACCEPTED_STATUSES) call marks the
// prior-acceptance lookup; a where({..., status: 'sending'}) call marks
// the live-claim lookup) so one factory serves both queries
// claimOrResolve issues per attempt, plus the insert/del calls.
function makeSmsLogTable({ acceptedRow = null, liveClaimRow = null, insertedId = 'claim-1', onInsert, onDel } = {}) {
  const calls = [];
  function table(name) {
    const query = {};
    let kind = null;
    query.where = (...args) => {
      calls.push(['where', ...args]);
      if (args[0] && typeof args[0] === 'object' && args[0].status === 'sending') kind = 'liveClaim';
      return query;
    };
    query.whereRaw = (...args) => { calls.push(['whereRaw', ...args]); return query; };
    query.whereIn = (...args) => { calls.push(['whereIn', ...args]); kind = 'accepted'; return query; };
    query.orderBy = (...args) => { calls.push(['orderBy', ...args]); return query; };
    query.first = async (...args) => {
      calls.push(['first', ...args]);
      return kind === 'liveClaim' ? liveClaimRow : acceptedRow;
    };
    query.insert = (row) => {
      calls.push(['insert', row]);
      if (onInsert) onInsert(row);
      return { returning: async () => [insertedId] };
    };
    query.del = async () => { calls.push(['del']); if (onDel) onDel(); return 1; };
    return query;
  }
  table.__calls = calls;
  return table;
}

function makeTrx({ locked = true, ...tableOpts } = {}) {
  const table = makeSmsLogTable(tableOpts);
  const trx = (name) => table(name);
  trx.raw = jest.fn(async (sql) => (String(sql).includes('pg_try_advisory_xact_lock') ? { rows: [{ locked }] } : {}));
  trx.__calls = table.__calls;
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
      const table = makeSmsLogTable({ acceptedRow: { twilio_sid: 'SM1', created_at: new Date('2026-09-01T00:00:00Z') } });
      const row = await findAcceptedBillingTextLeg(table, 'cust-1', 'billing:cust-1:billing_reminder:abc123');
      expect(table.__calls).toEqual(expect.arrayContaining([
        ['where', { customer_id: 'cust-1', direction: 'outbound' }],
        ['whereRaw', "metadata->>'notificationEventKey' = ?", ['billing:cust-1:billing_reminder:abc123']],
        ['where', expect.any(Function)],
        ['whereIn', 'status', ACCEPTED_STATUSES],
      ]));
      expect(ACCEPTED_STATUSES).toEqual(['queued', 'sent', 'delivered']);
      expect(row).toEqual({ twilio_sid: 'SM1', created_at: new Date('2026-09-01T00:00:00Z') });
    });

    test('the leg clause: an explicit Text leg, or a pre-marker row carrying a real Twilio message SID', async () => {
      const knex = require('knex')({ client: 'pg' });
      // Capture the built SQL at .first() instead of running it.
      const conn = (table) => {
        const qb = knex(table);
        qb.first = function first() { return Promise.resolve(this.toSQL()); };
        return qb;
      };
      const { sql } = await findAcceptedBillingTextLeg(conn, 'cust-1', 'billing:key');
      expect(sql).toContain("(metadata->>'billingDeliveryLeg' = 'sms' or (metadata->>'billingDeliveryLeg' IS NULL and (twilio_sid LIKE 'SM%' OR twilio_sid LIKE 'MM%')))");
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

    test('a prior accepted row for the key dedupes — no provider call, no claim written', async () => {
      const trx = makeTrx({ acceptedRow: { twilio_sid: 'SMprior00000000000000000000000000', created_at: new Date('2026-09-01T00:00:00Z') } });
      db.transaction = jest.fn(async (cb) => cb(trx));
      const send = jest.fn(async () => ({ sent: true, provider: 'twilio', deliveryOutcome: 'accepted', providerMessageId: 'SM-new' }));

      const result = await withBillingTextLegLock(baseInput(), send);

      expect(send).not.toHaveBeenCalled();
      expect(trx.raw).toHaveBeenCalledWith(
        'SELECT pg_try_advisory_xact_lock(hashtextextended(?, 0)) AS locked',
        ['billing_text_leg:cust-1:billing:cust-1:billing_reminder:abc123'],
      );
      expect(trx.__calls.some((c) => c[0] === 'insert')).toBe(false);
      expect(result).toEqual({
        sent: true,
        provider: 'twilio',
        deliveryOutcome: 'accepted',
        deduped: true,
        providerMessageId: 'SMprior00000000000000000000000000',
        sentAt: new Date('2026-09-01T00:00:00Z'),
      });
    });

    test('no prior row and no live claim: claims, calls send() with no connection held, then releases the claim once the accepted row is durable', async () => {
      let insertedRow = null;
      const trx = makeTrx({ insertedId: 'claim-42', onInsert: (row) => { insertedRow = row; } });
      db.transaction = jest.fn(async (cb) => cb(trx));
      let deletedWhere = null;
      let deleted = 0;
      // After send(), settleClaim's durable-acceptance lookup finds the row
      // twilio.js wrote — only then is the claim deleted.
      const releaseTable = makeSmsLogTable({
        acceptedRow: { twilio_sid: 'SM-new', created_at: new Date() },
        onDel: () => { deleted += 1; },
      });
      db.mockImplementation((name) => {
        const q = releaseTable(name);
        const originalWhere = q.where;
        q.where = (...args) => { deletedWhere = args[0]; return originalWhere(...args); };
        return q;
      });
      const send = jest.fn(async () => ({ sent: true, provider: 'twilio', deliveryOutcome: 'accepted', providerMessageId: 'SM-new' }));

      const result = await withBillingTextLegLock(baseInput(), send);

      expect(send).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ sent: true, provider: 'twilio', deliveryOutcome: 'accepted', providerMessageId: 'SM-new' });
      // The claim itself is a plain sms_log row with its own marker — never
      // one of review-ask-reservation.js's REPLY_RESERVATION_MARKERS, and
      // never scheduled_for (so scheduler.js's stale-scheduled-sms sweeps
      // structurally cannot pick it up).
      expect(insertedRow).toMatchObject({
        customer_id: 'cust-1', direction: 'outbound', status: 'sending',
        metadata: JSON.stringify({
          billing_text_leg_claim: true, billingDeliveryLeg: 'sms',
          notificationEventKey: 'billing:cust-1:billing_reminder:abc123',
        }),
      });
      expect(insertedRow.scheduled_for).toBeUndefined();
      // The claim is released (deleted) by its own id after send() settles —
      // on the plain db pool, not inside the (already-committed) claim trx.
      expect(deleted).toBe(1);
      expect(deletedWhere).toEqual({ id: 'claim-42', status: 'sending' });
    });

    test('accepted with no durable row: the claim is stamped with the SID, never deleted', async () => {
      const trx = makeTrx({ insertedId: 'claim-43' });
      db.transaction = jest.fn(async (cb) => cb(trx));
      let deleted = 0;
      let updatedWith = null;
      const table = makeSmsLogTable({ acceptedRow: null, onDel: () => { deleted += 1; } });
      db.mockImplementation((name) => {
        const q = table(name);
        q.update = async (patch) => { updatedWith = patch; return 1; };
        return q;
      });
      db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
      const send = jest.fn(async () => ({ sent: true, provider: 'twilio', deliveryOutcome: 'accepted', providerMessageId: 'SM-late' }));

      await withBillingTextLegLock(baseInput(), send);

      expect(deleted).toBe(0);
      expect(updatedWith.twilio_sid).toBeUndefined();
      expect(JSON.parse(updatedWith.metadata.bindings[0])).toMatchObject({ acceptedProviderMessageId: 'SM-late' });
    });

    test('a not_sent release whose delete keeps failing retries once, then marks the claim release_pending', async () => {
      const trx = makeTrx({ insertedId: 'claim-45' });
      db.transaction = jest.fn(async (cb) => cb(trx));
      let dels = 0;
      let patch = null;
      const table = makeSmsLogTable({ onDel: () => { dels += 1; throw new Error('connection reset'); } });
      db.mockImplementation((name) => {
        const q = table(name);
        q.update = async (p) => { patch = p; return 1; };
        return q;
      });
      db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
      const send = jest.fn(async () => ({ sent: false, provider: 'twilio', deliveryOutcome: 'not_sent', code: 'DELIVERY_SUPPRESSED' }));

      await withBillingTextLegLock(baseInput(), send);

      expect(dels).toBe(2);
      expect(JSON.parse(patch.metadata.bindings[0])).toEqual({ release_pending: true });
    });

    test('a release that succeeds on its retry never marks release_pending', async () => {
      const trx = makeTrx({ insertedId: 'claim-46' });
      db.transaction = jest.fn(async (cb) => cb(trx));
      let dels = 0;
      let updated = 0;
      const table = makeSmsLogTable({ onDel: () => { dels += 1; if (dels === 1) throw new Error('connection reset'); } });
      db.mockImplementation((name) => {
        const q = table(name);
        q.update = async () => { updated += 1; return 1; };
        return q;
      });
      const send = jest.fn(async () => ({ sent: false, provider: 'twilio', deliveryOutcome: 'not_sent', code: 'DELIVERY_SUPPRESSED' }));

      await withBillingTextLegLock(baseInput(), send);

      expect(dels).toBe(2);
      expect(updated).toBe(0);
    });

    test('an adapter-returned uncertain outcome keeps the claim — no delete, no stamp', async () => {
      const trx = makeTrx({ insertedId: 'claim-44' });
      db.transaction = jest.fn(async (cb) => cb(trx));
      let deleted = 0;
      let updated = 0;
      const table = makeSmsLogTable({ onDel: () => { deleted += 1; } });
      db.mockImplementation((name) => {
        const q = table(name);
        q.update = async () => { updated += 1; return 1; };
        return q;
      });
      const send = jest.fn(async () => ({ sent: false, provider: 'twilio', deliveryOutcome: 'uncertain', error: 'ETIMEDOUT' }));

      const result = await withBillingTextLegLock(baseInput(), send);

      expect(result.deliveryOutcome).toBe('uncertain');
      expect(deleted).toBe(0);
      expect(updated).toBe(0);
    });

    test('a live, fresh claim for the same key is an in-flight hold — schedulable, never a send', async () => {
      const trx = makeTrx({ liveClaimRow: { id: 'claim-1', created_at: new Date(Date.now() - 5000) } });
      db.transaction = jest.fn(async (cb) => cb(trx));
      const send = jest.fn();

      const result = await withBillingTextLegLock(baseInput(), send);

      expect(send).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'BILLING_TEXT_LEG_IN_FLIGHT',
        retryable: true, deferred: true,
      });
      expect(Date.parse(result.nextAllowedAt)).toBeGreaterThan(Date.now());
      expect(require('../services/messaging/billing-channel-routing').REPLAY_HOLD_CODES)
        .toContain('BILLING_TEXT_LEG_IN_FLIGHT');
    });

    test('the non-blocking try-lock losing to a concurrent attempt is also an in-flight hold — never blocks waiting', async () => {
      const trx = makeTrx({ locked: false });
      db.transaction = jest.fn(async (cb) => cb(trx));
      const send = jest.fn();

      const result = await withBillingTextLegLock(baseInput(), send);

      expect(send).not.toHaveBeenCalled();
      expect(result).toMatchObject({ code: 'BILLING_TEXT_LEG_IN_FLIGHT', retryable: true, deferred: true });
      // Losing the try-lock is the FIRST thing claimOrResolve does — no
      // further lookup is even attempted, and importantly no BLOCKING wait:
      // pg_try_advisory_xact_lock returns immediately either way.
      expect(trx.__calls.filter((c) => c[0] === 'whereIn' || c[0] === 'insert')).toHaveLength(0);
    });

    test('a live claim older than CLAIM_STALE_MS is delivery-uncertain, non-retryable, and logs an error naming customer + key — never resent', async () => {
      const staleClaim = { id: 'claim-old', created_at: new Date(Date.now() - CLAIM_STALE_MS - 1000) };
      const trx = makeTrx({ liveClaimRow: staleClaim });
      db.transaction = jest.fn(async (cb) => cb(trx));
      const send = jest.fn();

      const result = await withBillingTextLegLock(baseInput(), send);

      expect(send).not.toHaveBeenCalled();
      expect(result).toEqual({
        sent: false, blocked: true, deliveryOutcome: 'uncertain', code: 'BILLING_TEXT_LEG_CLAIM_STALE',
        reason: expect.stringContaining('delivery is unknown'),
        retryable: false,
      });
      // Never a schedulable replay hold — a stale claim must surface to an
      // operator, not silently retry (which could double-text a customer
      // whose earlier attempt actually went out).
      expect(result.deferred).toBeUndefined();
      expect(require('../services/messaging/billing-channel-routing').REPLAY_HOLD_CODES)
        .not.toContain('BILLING_TEXT_LEG_CLAIM_STALE');
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('cust-1'));
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('billing:cust-1:billing_reminder:abc123'));
    });

    test('lock/lookup/claim infra failure fails closed with a schedulable hold and never sends', async () => {
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

    test('a throw from send() keeps the claim (delivery unknown), and the error propagates', async () => {
      const trx = makeTrx({ insertedId: 'claim-7' });
      db.transaction = jest.fn(async (cb) => cb(trx));
      let deletedWhere = null;
      db.mockImplementation((name) => {
        const q = makeSmsLogTable()(name);
        const originalWhere = q.where;
        q.where = (...args) => { deletedWhere = args[0]; return originalWhere(...args); };
        return q;
      });
      const send = jest.fn(async () => { throw new Error('twilio SDK exploded'); });

      await expect(withBillingTextLegLock(baseInput(), send)).rejects.toThrow('twilio SDK exploded');
      expect(send).toHaveBeenCalledTimes(1);
      expect(deletedWhere).toBeNull();
    });

    test('a different notificationEventKey for the same customer is a separate lock/lookup and sends', async () => {
      const trx = makeTrx({});
      db.transaction = jest.fn(async (cb) => cb(trx));
      db.mockImplementation(() => makeSmsLogTable()('sms_log'));
      const send = jest.fn(async () => ({ sent: true }));
      await withBillingTextLegLock(baseInput({ metadata: { billingDeliveryLeg: 'sms', notificationEventKey: 'billing:cust-1:receipt:def456' } }), send);
      expect(trx.raw).toHaveBeenCalledWith(
        'SELECT pg_try_advisory_xact_lock(hashtextextended(?, 0)) AS locked',
        ['billing_text_leg:cust-1:billing:cust-1:receipt:def456'],
      );
      expect(send).toHaveBeenCalledTimes(1);
    });
  });
});
