'use strict';

// POST /api/push/native-unsubscribe for a contact session (GATE_CONTACT_LOGIN,
// codex #6363 r5 security P2): a contact may release only the device it
// presents. The token-less form deactivates every one of the profile's
// native devices — the holder's — so a contact gets 400 and nothing is
// written; the holder keeps both forms.

const mockSession = { contact: null };
jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.customerId = 'cust-1';
    req.accountId = 'acct-1';
    req.customer = { id: 'cust-1', account_id: 'acct-1' };
    if (mockSession.contact) req.contactSession = mockSession.contact;
    next();
  },
}));
jest.mock('../models/db', () => jest.fn());

const express = require('express');
const db = require('../models/db');
const pushRouter = require('../routes/push');

const updates = [];
function wire() {
  db.mockImplementation((table) => {
    const q = { filters: [] };
    q.whereIn = (col, vals) => { q.filters.push([col, vals]); return q; };
    q.andWhere = (obj) => { q.filters.push(obj); return q; };
    q.where = () => q;
    q.select = async () => (table === 'customers' ? [{ id: 'cust-1' }, { id: 'cust-2' }] : []);
    q.catch = () => q;
    q.update = async (patch) => { updates.push({ table, filters: q.filters, patch }); return 1; };
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
beforeEach(() => { updates.length = 0; mockSession.contact = null; wire(); });

const post = async (body) => {
  const res = await fetch(`${base}/api/push/native-unsubscribe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

test('a contact without a device token is refused and nothing is deactivated', async () => {
  mockSession.contact = { slot: 1, phoneKey: '9415550202' };
  const res = await post({});
  expect(res.status).toBe(400);
  expect(res.body.code).toBe('DEVICE_TOKEN_REQUIRED');
  expect(updates).toEqual([]);
});

test('a contact presenting its token releases exactly that token (account-scoped, as any device does)', async () => {
  mockSession.contact = { slot: 1, phoneKey: '9415550202' };
  const res = await post({ token: 'apns-device-1' });
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ ok: true, deactivated: 1 });
  expect(updates).toHaveLength(1);
  expect(updates[0].filters).toEqual(expect.arrayContaining([['customer_id', ['cust-1', 'cust-2']], { device_token: 'apns-device-1' }]));
});

test('the holder keeps the token-less "all my devices" form', async () => {
  const res = await post({});
  expect(res.status).toBe(200);
  expect(updates).toHaveLength(1);
  expect(updates[0].filters).toEqual([['customer_id', ['cust-1']], ['platform', ['ios', 'android']]]);
});
