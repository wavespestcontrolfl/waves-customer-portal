'use strict';

// POST /api/push/live-activity-token (GATE_VISIT_LIVE_ACTIVITY): the iPhone app reports its ActivityKit
// push-to-start token so the server can start the Lock Screen visit card on that phone. The route must
// write only this session's own active account-holder iPhone row, store nothing while the gate is off,
// and clear the token when the phone says Live Activities are off.

jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.customerId = 'cust-1';
    req.accountId = 'acct-1';
    next();
  },
}));
jest.mock('../models/db', () => jest.fn());
const mockContext = { value: { enabled: true, ids: ['cust-1', 'cust-2'] } };
jest.mock('../services/push-notifications', () => ({
  customerPushContext: jest.fn(async () => mockContext.value),
}));

const express = require('express');
const db = require('../models/db');
const push = require('../services/push-notifications');
const pushRouter = require('../routes/push');

const START = 'a1b2c3d4'.repeat(8); // 64 hex characters
const updates = [];
let matched = 1;
function wire() {
  db.fn = { now: () => 'NOW' };
  db.mockImplementation((table) => {
    const q = { filters: [] };
    q.whereIn = (col, vals) => { q.filters.push([col, vals]); return q; };
    q.where = (obj) => { q.filters.push(obj); return q; };
    q.whereNull = (col) => { q.filters.push(['null', col]); return q; };
    q.update = async (patch) => { updates.push({ table, filters: q.filters, patch }); return matched; };
    return q;
  });
}

let server; let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/push', pushRouter);
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
beforeEach(() => {
  updates.length = 0;
  matched = 1;
  mockContext.value = { enabled: true, ids: ['cust-1', 'cust-2'] };
  push.customerPushContext.mockClear();
  process.env.GATE_VISIT_LIVE_ACTIVITY = 'true';
  wire();
});
afterAll(() => { delete process.env.GATE_VISIT_LIVE_ACTIVITY; });

const post = async (body) => {
  const res = await fetch(`${base}/api/push/live-activity-token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json(), cache: res.headers.get('cache-control') };
};

test('stores the start token and iOS major on this phone\'s own active holder iPhone row, inside the push device scope', async () => {
  const res = await post({ deviceToken: 'apns-device-1', startToken: START.toUpperCase(), osVersion: '18.5.1', enabled: true });
  expect(res).toEqual({ status: 200, body: { ok: true, stored: true }, cache: 'no-store' });
  expect(push.customerPushContext).toHaveBeenCalledWith('cust-1');
  expect(updates).toHaveLength(1);
  expect(updates[0].table).toBe('push_subscriptions');
  expect(updates[0].filters).toEqual([
    ['customer_id', ['cust-1', 'cust-2']],
    { device_token: 'apns-device-1', platform: 'ios', role: 'customer', active: true },
    ['null', 'contact_phone_key'],
  ]);
  expect(updates[0].patch).toEqual({ live_activity_start_token: START, live_activity_os_major: 18, live_activity_token_at: 'NOW' });
});

test('gate off: answers ok, reads nothing and writes nothing', async () => {
  delete process.env.GATE_VISIT_LIVE_ACTIVITY;
  const res = await post({ deviceToken: 'apns-device-1', startToken: START, osVersion: '18.5' });
  expect(res.body).toEqual({ ok: true, stored: false });
  expect(push.customerPushContext).not.toHaveBeenCalled();
  expect(updates).toEqual([]);
});

test('Live Activities off on the phone, or no start token, clears what was stored', async () => {
  const off = await post({ deviceToken: 'apns-device-1', startToken: START, osVersion: '18.5', enabled: false });
  expect(off.body).toEqual({ ok: true, stored: false });
  const none = await post({ deviceToken: 'apns-device-1', osVersion: '18.5' });
  expect(none.body).toEqual({ ok: true, stored: false });
  expect(updates.map((u) => u.patch)).toEqual([
    { live_activity_start_token: null, live_activity_os_major: null, live_activity_token_at: 'NOW' },
    { live_activity_start_token: null, live_activity_os_major: null, live_activity_token_at: 'NOW' },
  ]);
});

test('a start token that is not hex is refused before any write', async () => {
  for (const startToken of ['not-a-token', 'zz'.repeat(32), 'ab12', 42, { a: 1 }]) {
    const res = await post({ deviceToken: 'apns-device-1', startToken, osVersion: '18.5' });
    expect(res.status).toBe(400);
  }
  expect(updates).toEqual([]);
});

test('the device token is required, and it must be a string', async () => {
  expect((await post({ startToken: START })).status).toBe(400);
  expect((await post({ deviceToken: { a: 1 }, startToken: START })).status).toBe(400);
  expect(updates).toEqual([]);
});

test('a token for a row this session does not hold reports stored false', async () => {
  matched = 0;
  const res = await post({ deviceToken: 'someone-elses-device', startToken: START, osVersion: '18.5' });
  expect(res.body).toEqual({ ok: true, stored: false });
});

test('an inactive customer (no push context) stores nothing', async () => {
  mockContext.value = null;
  const res = await post({ deviceToken: 'apns-device-1', startToken: START, osVersion: '18.5' });
  expect(res.body).toEqual({ ok: true, stored: false });
  expect(updates).toEqual([]);
});

test('an unreadable iOS version stores the token with no major, so the phone gets no card until it reports one', async () => {
  await post({ deviceToken: 'apns-device-1', startToken: START, osVersion: 'beta' });
  await post({ deviceToken: 'apns-device-1', startToken: START });
  expect(updates.map((u) => u.patch.live_activity_os_major)).toEqual([null, null]);
});
