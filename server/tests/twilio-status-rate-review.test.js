/**
 * POST /api/webhooks/twilio/status — a failed/undelivered text is reconciled
 * onto its rate review notice (services/rate-review-comms.js
 * handleSmsDeliveryFailure) before the callback is acknowledged. A reconciliation
 * that fails answers 500 (never a silent 200 that would lose the failure); a
 * delivered status never reaches it. Invented data only.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => {
  const make = () => {
    const db = () => new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') return (resolve, reject) => Promise.resolve([]).then(resolve, reject);
        if (prop === 'catch') return (reject) => Promise.resolve([]).catch(reject);
        if (prop === 'first') return () => Promise.resolve(null);
        return () => db();
      },
    });
    db.raw = jest.fn(async () => ({ rows: [] }));
    db.transaction = async (fn) => fn(db);
    db.fn = { now: () => new Date() };
    return db;
  };
  return make();
});
jest.mock('../services/twilio-failure-alerts', () => ({ alertTwilioFailure: jest.fn(async () => {}), isFailureStatus: (s) => ['failed', 'undelivered'].includes(String(s)) }));
jest.mock('../services/appointment-reminders', () => ({ handleUndeliveredSms: jest.fn(async () => {}) }));
const mockReconcile = jest.fn(async () => []);
jest.mock('../services/rate-review-comms', () => ({ handleSmsDeliveryFailure: (...a) => mockReconcile(...a) }));

const express = require('express');
const router = require('../routes/twilio-webhook');

async function status(body) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use('/api/webhooks/twilio', router);
  const server = app.listen(0, '127.0.0.1');
  try {
    if (!server.listening) await new Promise((r) => server.once('listening', r));
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/webhooks/twilio/status`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString(),
    });
    return res.status;
  } finally {
    await new Promise((r) => server.close(r));
  }
}

beforeEach(() => mockReconcile.mockReset().mockResolvedValue([]));

describe('Twilio status callback → rate review text reconciliation', () => {
  test('an undelivered status is reconciled (strict) before the callback is acknowledged', async () => {
    expect(await status({ MessageSid: 'SM1', MessageStatus: 'undelivered', ErrorCode: '30003', To: '+15555550101' })).toBe(200);
    expect(mockReconcile).toHaveBeenCalledWith({ sid: 'SM1', status: 'undelivered', errorCode: '30003' }, { strict: true });
  });

  test('a reconciliation that fails answers 500 so the failure is not silently lost', async () => {
    mockReconcile.mockRejectedValue(new Error('db down'));
    expect(await status({ MessageSid: 'SM1', MessageStatus: 'failed', To: '+15555550101' })).toBe(500);
  });

  test('a delivered status never reaches the reconciliation', async () => {
    expect(await status({ MessageSid: 'SM1', MessageStatus: 'delivered', To: '+15555550101' })).toBe(200);
    expect(mockReconcile).not.toHaveBeenCalled();
  });
});
