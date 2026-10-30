/**
 * POST /api/webhooks/sendgrid/events — rate review letter reconciliation.
 *
 * A signed bounce / dropped / blocked event for the email_messages row a rate
 * review letter created reaches services/rate-review-comms.js
 * handleEmailDeliveryEvent INSIDE the event's own transaction; any other
 * message, a delivered event, and a bad signature never do. The reconciliation
 * itself (notice revoked, prepaid un-staged, ranking row back to approved,
 * idempotency) is pinned in rate-review-comms.test.js; here is the wiring.
 * Invented data only.
 */
const crypto = require('crypto');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
process.env.SENDGRID_WEBHOOK_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

const mockState = { message: null, txOpen: 0, txDone: 0, ledger: new Set(), raw: [], failRaw: false, failLookup: false };

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => {
  // A permissive knex stand-in: every chain method returns the builder; awaiting it resolves per table.
  const make = (inTx) => {
    const db = (table) => {
      let mode = 'list';
      let op = null;
      let fresh = true;
      const b = new Proxy({}, {
        get(_t, prop) {
          if (prop === 'then') {
            return (resolve, reject) => {
              try {
                if (op === 'insert' && table === 'sendgrid_webhook_events') return resolve(fresh ? [{ event_id: 'x' }] : []);
                if (mockState.failLookup && table === 'newsletter_send_deliveries') return reject(new Error('lookup failed'));
                if (op) return resolve(1);
                if (mode === 'first') return resolve(table === 'email_messages' ? mockState.message : null);
                return resolve([]);
              } catch (e) { return reject(e); }
            };
          }
          if (prop === 'first') return () => { mode = 'first'; return b; };
          if (prop === 'insert') return (row) => { op = 'insert'; if (table === 'sendgrid_webhook_events') { fresh = !mockState.ledger.has(row.event_id); mockState.ledger.add(row.event_id); } return b; };
          if (prop === 'update' || prop === 'del' || prop === 'delete' || prop === 'increment') return () => { op = 'update'; return b; };
          return () => b;
        },
      });
      return b;
    };
    db.isTransaction = inTx;
    db.raw = jest.fn(async (sql, bindings) => { if (mockState.failRaw && inTx) throw new Error('lock failed'); if (inTx) mockState.raw.push(String(bindings && bindings[0])); return { rows: [] }; });
    db.fn = { now: () => new Date() };
    db.transaction = async (fn) => {
      mockState.txOpen += 1;
      const before = new Set(mockState.ledger);
      try {
        const r = await fn(make(true));
        mockState.txDone += 1;
        return r;
      } catch (err) {
        mockState.ledger = before; // a rolled-back transaction takes its ledger row with it
        throw err;
      }
    };
    return db;
  };
  return make(false);
});

const mockHandle = jest.fn(async () => []);
const mockRaise = jest.fn(async () => {});
jest.mock('../services/rate-review-comms', () => ({
  isRateReviewMessage: (m) => !!m && m.template_key === 'billing.rate_review_notice',
  handleEmailDeliveryEvent: (...a) => mockHandle(...a),
  raiseDeliveryAlerts: (...a) => mockRaise(...a),
}));

const express = require('express');
const router = require('../routes/webhooks-sendgrid');

function sign(body, ts, key = privateKey) {
  return crypto.sign('sha256', Buffer.concat([Buffer.from(ts), Buffer.from(body)]), key).toString('base64');
}

async function post(events, { signed = true, key = privateKey } = {}) {
  const app = express();
  app.use('/api/webhooks/sendgrid', router);
  const server = app.listen(0, '127.0.0.1');
  try {
    if (!server.listening) await new Promise((r) => server.once('listening', r));
    const body = JSON.stringify(events);
    const ts = String(Math.floor(Date.now() / 1000));
    const headers = { 'content-type': 'application/json' };
    if (signed) {
      headers['x-twilio-email-event-webhook-signature'] = sign(body, ts, key);
      headers['x-twilio-email-event-webhook-timestamp'] = ts;
    }
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/webhooks/sendgrid/events`, { method: 'POST', headers, body });
    return { status: res.status };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const MESSAGE = { id: 'em-1', provider_message_id: 'smsg1', template_key: 'billing.rate_review_notice', recipient_type: 'customer', recipient_id: 'c1', recipient_email_snapshot: 'cust1@example.com', send_attempt_token: null, status: 'sent' };
const event = (over = {}) => ({ event: 'bounce', type: 'bounce', email: 'cust1@example.com', sg_message_id: 'smsg1.filter', sg_event_id: `evt-${Math.random()}`, timestamp: 1790000000, reason: '550 mailbox not found', ...over });

beforeEach(() => { mockState.message = { ...MESSAGE }; mockState.ledger = new Set(); mockState.raw = []; mockHandle.mockReset().mockResolvedValue([]); mockRaise.mockReset(); });

describe('SendGrid event webhook → rate review letter reconciliation', () => {
  test('a signed bounce for a rate review letter reaches the reconciliation inside the event transaction, then raises its alerts', async () => {
    const alerts = [{ noticeId: 'n1', customerId: 'c1' }];
    mockHandle.mockResolvedValue(alerts);
    const ev = event();
    expect((await post([ev])).status).toBe(200);
    expect(mockHandle).toHaveBeenCalledTimes(1);
    const [trx, message, passed] = mockHandle.mock.calls[0];
    expect(trx.isTransaction).toBe(true);
    expect(message).toMatchObject({ id: 'em-1', template_key: 'billing.rate_review_notice' });
    expect(passed).toMatchObject({ event: 'bounce', sg_message_id: 'smsg1.filter' });
    expect(mockRaise).toHaveBeenCalledWith(alerts);
  });

  test('a reconciliation that cannot be recorded answers non-2xx so SendGrid redelivers; the rolled-back event then reconciles on the redelivery', async () => {
    mockHandle.mockRejectedValueOnce(new Error('db down'));
    const ev = event({ sg_event_id: 'evt-retry' });
    expect((await post([ev])).status).toBe(500);
    expect(mockState.ledger.has('evt-retry')).toBe(false); // rolled back with the event ledger row
    mockHandle.mockResolvedValue([{ noticeId: 'n1', customerId: 'c1' }]);
    expect((await post([ev])).status).toBe(200);
    expect(mockHandle).toHaveBeenCalledTimes(2);
    expect(mockRaise).toHaveBeenCalledTimes(1);
  });

  test('a failure ANYWHERE in a rate review letter\'s event transaction (here: the lock) answers non-2xx; an ordinary event\'s failure still answers 200', async () => {
    mockState.failRaw = true;
    try {
      expect((await post([event({ sg_event_id: 'evt-lockfail' })])).status).toBe(500);
      mockState.message = { ...MESSAGE, template_key: 'billing.invoice' };
      expect((await post([event({ event: 'delivered', type: undefined, sg_event_id: 'evt-lockfail2' })])).status).toBe(200);
    } finally {
      mockState.failRaw = false;
    }
  });

  test('a lookup failure BEFORE the message is classified redelivers a bounce (500) but not an ordinary event (200); the redelivery then reconciles', async () => {
    mockState.failLookup = true;
    try {
      expect((await post([event({ sg_event_id: 'evt-look1' })])).status).toBe(500);
      expect((await post([event({ event: 'delivered', type: undefined, sg_event_id: 'evt-look2' })])).status).toBe(200);
    } finally { mockState.failLookup = false; }
    expect((await post([event({ sg_event_id: 'evt-look1' })])).status).toBe(200);
    expect(mockHandle).toHaveBeenCalledTimes(1);
  });

  test('lock order: a rate review event takes customer-comms BEFORE the address key (the sender\'s order); another message takes no customer-comms lock', async () => {
    await post([event()]);
    const comms = mockState.raw.findIndex((k) => k === 'customer-comms:c1');
    const address = mockState.raw.findIndex((k) => k.startsWith('customer-email:'));
    expect(comms).toBeGreaterThanOrEqual(0);
    expect(address).toBeGreaterThan(comms);
    mockState.raw = [];
    mockState.message = { ...MESSAGE, template_key: 'billing.invoice' };
    await post([event()]);
    expect(mockState.raw.some((k) => k.startsWith('customer-comms:'))).toBe(false);
  });

  test('a hard bounce of a rate review letter does not run the generic bounce recovery (its alert would never be closed); another template\'s bounce still does', async () => {
    const recovery = require('../services/email-bounce-recovery');
    const attempt = jest.spyOn(recovery, 'attemptRecovery').mockResolvedValue({ resent: false });
    try {
      expect((await post([event()])).status).toBe(200);
      await new Promise((r) => setTimeout(r, 20));
      expect(mockHandle).toHaveBeenCalledTimes(1);
      expect(attempt).not.toHaveBeenCalled();
      mockState.message = { ...MESSAGE, template_key: 'invoice.sent' };
      expect((await post([event()])).status).toBe(200);
      await new Promise((r) => setTimeout(r, 20));
      expect(attempt).toHaveBeenCalledTimes(1);
    } finally { attempt.mockRestore(); }
  });

  test('a redelivered event (already in the event ledger) does not reconcile or alert again', async () => {
    const ev = event({ sg_event_id: 'evt-dup' });
    mockHandle.mockResolvedValue([{ noticeId: 'n1', customerId: 'c1' }]);
    await post([ev]);
    await post([ev]); // SendGrid redelivers: the ledger insert conflicts, so nothing runs twice
    expect(mockHandle).toHaveBeenCalledTimes(1);
    expect(mockRaise).toHaveBeenCalledTimes(1);
  });

  test('an event for a different message type is passed through (the hook itself ignores it) and raises nothing', async () => {
    mockState.message = { ...MESSAGE, template_key: 'billing.invoice' };
    mockHandle.mockResolvedValue([]);
    expect((await post([event()])).status).toBe(200);
    expect(mockRaise).not.toHaveBeenCalled();
  });

  test('a missing signature is rejected (400), an invalid one is rejected (403); nothing is reconciled', async () => {
    expect((await post([event()], { signed: false })).status).toBe(400);
    const other = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
    expect((await post([event()], { key: other })).status).toBe(403);
    expect(mockHandle).not.toHaveBeenCalled();
  });
});

// GATE_CALL_EMAIL_CHECKS (owner 2026-10-29): SendGrid files "no mail server for
// this domain" as a blocked bounce. Gate off it stays on the sender-retry rail;
// gate on it is a bad address and takes the bounce recovery lane (its alert and
// the call re-check card) instead. Another template than the rate review letter.
describe('SendGrid event webhook → a blocked bounce for a domain with no mail server', () => {
  const deadDomainBounce = () => event({ type: 'blocked', reason: 'unable to get mx info: failed to get IPs from PTR record: lookup <nil>: unrecognized address' });
  afterEach(() => { delete process.env.GATE_CALL_EMAIL_CHECKS; });

  test('the message row: gate off schedules a provider retry; gate on records a bounce with no retry', () => {
    const { computeEmailMessageEventUpdates } = require('../routes/webhooks-sendgrid');
    const message = { ...MESSAGE, template_key: 'appointment.confirmation' };
    const off = computeEmailMessageEventUpdates(deadDomainBounce(), message);
    expect(off.status).toBe('failed');
    process.env.GATE_CALL_EMAIL_CHECKS = 'true';
    const on = computeEmailMessageEventUpdates(deadDomainBounce(), message);
    expect(on.status).toBe('bounced');
    expect(on.bounced_at).toBeInstanceOf(Date);
    expect(on.provider_retry_next_at).toBeUndefined();
  });

  test.each([
    ['gate off: the sender-retry rail, nothing else', undefined, { retry: 1, alert: 0, rescue: 0, recheck: 0 }],
    ['gate on: people only (the alert and the recording re-check), never an automatic recovery, rescue or resend', 'true', { retry: 0, alert: 1, rescue: 0, recheck: 1 }],
  ])('%s', async (_label, gate, want) => {
    if (gate) process.env.GATE_CALL_EMAIL_CHECKS = gate;
    const recovery = require('../services/email-bounce-recovery');
    const rescue = require('../services/email-bounce-rescue');
    const reverify = require('../services/email-bounce-reverify');
    const providerRetry = require('../services/transactional-email-provider-retry');
    const attempt = jest.spyOn(recovery, 'attemptRecovery').mockResolvedValue({ resent: false });
    const alert = jest.spyOn(recovery, 'alertBouncedContactAddress').mockResolvedValue(null);
    const rescueCall = jest.spyOn(rescue, 'rescueBouncedAddress').mockResolvedValue(null);
    const recheck = jest.spyOn(reverify, 'reverifyBouncedEmailFromCall').mockResolvedValue(null);
    const retryAlert = jest.spyOn(providerRetry, 'alertIfProviderRetriesExhausted').mockResolvedValue(null);
    try {
      mockState.message = { ...MESSAGE, template_key: 'appointment.confirmation' };
      expect((await post([deadDomainBounce()])).status).toBe(200);
      await new Promise((r) => setTimeout(r, 20));
      expect(retryAlert).toHaveBeenCalledTimes(want.retry);
      expect(attempt).not.toHaveBeenCalled();
      expect(alert).toHaveBeenCalledTimes(want.alert);
      expect(rescueCall).toHaveBeenCalledTimes(want.rescue);
      expect(recheck).toHaveBeenCalledTimes(want.recheck);
    } finally {
      [attempt, alert, rescueCall, recheck, retryAlert].forEach((spy) => spy.mockRestore());
    }
  });
});
