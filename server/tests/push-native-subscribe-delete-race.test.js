'use strict';

jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.customerId = 'cust-1';
    req.accountId = 'acct-1';
    next();
  },
}));
jest.mock('../models/db', () => jest.fn());

const db = require('../models/db');
const pushRouter = require('../routes/push');

function invokeRoute(method, url, body) {
  return new Promise((resolve, reject) => {
    const req = {
      method,
      url,
      body,
      headers: { 'user-agent': 'WavesApp/1.9' },
    };
    let statusCode = 200;
    const res = {
      set: () => res,
      status(code) { statusCode = code; return res; },
      json(payload) { resolve({ status: statusCode, body: payload }); return res; },
    };
    pushRouter.handle(req, res, (err) => (err ? reject(err) : resolve({ status: 404, body: null })));
  });
}

describe('POST /api/push/native-subscribe — account deletion race serialization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.fn = { now: () => 'NOW' };
  });

  test('locks the customer row FOR UPDATE and refuses registration if deleted_at was committed concurrently', async () => {
    let lockedForUpdate = false;
    let pushInsertCalled = false;
    db.transaction = jest.fn(async (cb) => {
      const trx = (table) => {
        if (table === 'customers') {
          return {
            where: () => ({
              forUpdate: () => {
                lockedForUpdate = true;
                return { first: async () => ({ id: 'cust-1', deleted_at: new Date().toISOString() }) };
              },
            }),
          };
        }
        if (table === 'push_subscriptions') {
          return {
            insert: () => {
              pushInsertCalled = true;
              return { onConflict: () => ({ merge: () => ({ returning: async () => [{ id: 'sub-1' }] }) }) };
            },
          };
        }
        throw new Error(`unexpected table ${table}`);
      };
      trx.fn = { now: () => 'NOW' };
      return cb(trx);
    });

    const res = await invokeRoute('POST', '/native-subscribe', { platform: 'ios', token: 'apns-token-123' });
    expect(lockedForUpdate).toBe(true);
    expect(pushInsertCalled).toBe(false);
    expect(res.status).toBe(401);
  });

  test('locks the customer row FOR UPDATE and saves the subscription when the customer is not deleted', async () => {
    let lockedForUpdate = false;
    let insertedRow = null;
    db.transaction = jest.fn(async (cb) => {
      const trx = (table) => {
        if (table === 'customers') {
          return {
            where: () => ({
              forUpdate: () => {
                lockedForUpdate = true;
                return { first: async () => ({ id: 'cust-1', deleted_at: null }) };
              },
            }),
          };
        }
        if (table === 'push_subscriptions') {
          return {
            insert: (row) => {
              insertedRow = row;
              return { onConflict: () => ({ merge: () => ({ returning: async () => [{ id: 'sub-ok' }] }) }) };
            },
          };
        }
        throw new Error(`unexpected table ${table}`);
      };
      trx.fn = { now: () => 'NOW' };
      return cb(trx);
    });

    const res = await invokeRoute('POST', '/native-subscribe', {
      platform: 'android',
      token: 'fcm-token-456',
      disabledChannels: ['waves_billing', 'unknown_channel'],
    });
    expect(lockedForUpdate).toBe(true);
    expect(insertedRow).toMatchObject({ customer_id: 'cust-1', platform: 'android', device_token: 'fcm-token-456', active: true });
    expect(JSON.parse(insertedRow.subscription_data)).toEqual({
      token: 'fcm-token-456',
      disabledChannels: ['waves_billing'],
    });
    expect(res).toEqual({ status: 200, body: { ok: true, id: 'sub-ok' } });
  });
});
