// Owner ruling 2026-09-26: customers cannot turn payment receipts off, so
// PUT /api/notification-prefs never writes payment_receipt.
jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/auth', () => ({
  authenticate: jest.fn((req, res, next) => { req.customerId = 'cust-1'; next(); }),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/customer-comms-lock', () => ({ lockCustomerComms: jest.fn(async () => {}) }));

const express = require('express');
const db = require('../models/db');
const route = require('../routes/notification-prefs');

let server;
let base;
let updates;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/notification-prefs', route);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/notification-prefs`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  updates = [];
  db.mockImplementation(() => {
    const chain = {};
    chain.where = jest.fn(() => chain);
    chain.first = jest.fn(async () => ({ customer_id: 'cust-1', payment_receipt: true, payment_receipt_channel: 'sms' }));
    chain.update = jest.fn(async (data) => { updates.push(data); return 1; });
    return chain;
  });
  // The PUT handler now runs its read+write inside db.transaction(trx => ...)
  // — trx behaves exactly like db for every table/mock purpose here.
  db.transaction = jest.fn(async (cb) => cb(db));
});

test('GET always reports receipts on, even for a legacy opt-out row', async () => {
  db.mockImplementation(() => {
    const chain = {};
    chain.where = jest.fn(() => chain);
    chain.first = jest.fn(async () => ({ customer_id: 'cust-1', payment_receipt: false }));
    return chain;
  });
  const body = await (await fetch(base)).json();
  expect(JSON.stringify(body)).toContain('"paymentReceipt":true');
});

const put = (body) => fetch(base, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('paymentReceipt=false alone is not a valid field and writes nothing', async () => {
  const res = await put({ paymentReceipt: false });
  expect(res.status).toBe(400);
  expect(updates).toHaveLength(0);
});

test('paymentReceipt=true clears a legacy opt-out', async () => {
  const res = await put({ paymentReceipt: true });
  expect(res.status).toBe(200);
  expect(updates[0]).toMatchObject({ payment_receipt: true });
});

test('a full save never writes payment_receipt=false but keeps the receipt channel', async () => {
  const res = await put({ paymentReceipt: false, paymentReceiptChannel: 'email', weatherAlerts: false });
  expect(res.status).toBe(200);
  expect(updates).toHaveLength(1);
  expect(updates[0]).not.toHaveProperty('payment_receipt');
  expect(updates[0]).toMatchObject({ payment_receipt_channel: 'email', weather_alerts: false });
});
