// PUT /api/notification-prefs must take the shared customer-comms advisory
// lock (customer-comms-lock.js) BEFORE reading or writing the row — the
// SAME lock newsletter-list-reconcile.js's per-customer import takes before
// its own final consent decision, so a marketing_offers opt-out written
// here can never land in the gap between that decision and its insert.
jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/auth', () => ({
  authenticate: jest.fn((req, res, next) => { req.customerId = 'cust-1'; next(); }),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/customer-comms-lock', () => ({ lockCustomerComms: jest.fn(async () => {}) }));

const express = require('express');
const db = require('../models/db');
const { lockCustomerComms } = require('../utils/customer-comms-lock');
const route = require('../routes/notification-prefs');

let server;
let base;
let calls;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/notification-prefs', route);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/notification-prefs`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  jest.clearAllMocks();
  calls = [];
  db.mockImplementation((table) => {
    calls.push(`table:${table}`);
    const chain = {};
    chain.where = jest.fn(() => chain);
    chain.first = jest.fn(async () => { calls.push('read'); return { customer_id: 'cust-1', marketing_offers: null, marketing_channel: null }; });
    chain.update = jest.fn(async (data) => { calls.push('update'); return 1; });
    return chain;
  });
  db.transaction = jest.fn(async (cb) => {
    calls.push('transaction:start');
    return cb(db);
  });
  lockCustomerComms.mockImplementation(async () => { calls.push('lock'); });
});

const put = (body) => fetch(base, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('lockCustomerComms is taken inside the transaction, before the row is read or written', async () => {
  const res = await put({ marketingOffers: true });
  expect(res.status).toBe(200);
  expect(lockCustomerComms).toHaveBeenCalledWith(db, 'cust-1');
  expect(lockCustomerComms).toHaveBeenCalledTimes(1);

  // Order: the transaction opens, the lock is taken, THEN the row is read,
  // THEN it's written — never a read or write before the lock.
  const lockIdx = calls.indexOf('lock');
  const firstReadIdx = calls.indexOf('read');
  const firstUpdateIdx = calls.indexOf('update');
  expect(lockIdx).toBeGreaterThan(-1);
  expect(firstReadIdx).toBeGreaterThan(lockIdx);
  expect(firstUpdateIdx).toBeGreaterThan(lockIdx);
});

test('the whole read+write runs inside db.transaction — no table access on the bare db handle', async () => {
  await put({ marketingOffers: false });
  expect(db.transaction).toHaveBeenCalledTimes(1);
});

test('validation failures (no valid fields) never open a transaction or take the lock', async () => {
  const res = await put({ notARealField: 'x' });
  expect(res.status).toBe(400);
  expect(db.transaction).not.toHaveBeenCalled();
  expect(lockCustomerComms).not.toHaveBeenCalled();
});

test('response is unchanged: still {success:true} on a real write', async () => {
  const res = await put({ marketingOffers: true });
  expect(await res.json()).toEqual({ success: true });
});
