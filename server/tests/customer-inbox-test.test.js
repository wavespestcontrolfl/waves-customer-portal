const express = require('express');
jest.mock('../models/db', () => Object.assign(jest.fn(), { transaction: jest.fn() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/push-notifications', () => ({ sendToCustomer: jest.fn() }));
jest.mock('../services/dashboard-alerts', () => ({ computeDashboardAlerts: jest.fn() }));
jest.mock('../services/admin-unread', () => ({}));
jest.mock('../middleware/admin-auth', () => ({
  ...jest.requireActual('../middleware/admin-auth'),
  adminAuthenticate(req, res, next) {
    if (!['Bearer admin', 'Bearer technician'].includes(req.headers.authorization)) return res.sendStatus(401);
    req.techRole = req.headers.authorization === 'Bearer admin' ? 'admin' : 'technician';
    req.technicianId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    next();
  },
}));
const db = require('../models/db');
const router = require('../routes/admin-notifications');
const customerId = '11111111-1111-4111-8111-111111111111';
let server;
let url;
const originalGate = process.env.GATE_CUSTOMER_INBOX_TEST;
const originalTarget = process.env.CUSTOMER_INBOX_TEST_CUSTOMER_ID;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/notifications', router);
  app.use((err, req, res, next) => res.status(err.type === 'entity.parse.failed' ? 400 : 500).json({ error: 'Unavailable' }));
  server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  url = `http://127.0.0.1:${server.address().port}/api/admin/notifications/customer-inbox-test`;
});
afterAll(async () => {
  for (const [key, value] of [['GATE_CUSTOMER_INBOX_TEST', originalGate], ['CUSTOMER_INBOX_TEST_CUSTOMER_ID', originalTarget]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await new Promise(resolve => server.close(resolve));
});
beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_CUSTOMER_INBOX_TEST = 'true';
  process.env.CUSTOMER_INBOX_TEST_CUSTOMER_ID = customerId;
});
async function post(body = { customerId }, authorization = 'Bearer admin') {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}) }, body: JSON.stringify(body) });
}

test.each([['', 401], ['Bearer customer', 401], ['Bearer technician', 403]])('requires admin authority: %s', async (authorization, status) => {
  expect((await post({ customerId, execute: true }, authorization)).status).toBe(status);
  expect(db.transaction).not.toHaveBeenCalled();
});
test.each([undefined, 'false', 'not-enabled'])('stays dark for gate %s', async value => {
  if (value === undefined) delete process.env.GATE_CUSTOMER_INBOX_TEST; else process.env.GATE_CUSTOMER_INBOX_TEST = value;
  const response = await post();
  expect(response.status).toBe(404);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(db.transaction).not.toHaveBeenCalled();
});
test.each(['', 'not-a-uuid', `${customerId},22222222-2222-4222-8222-222222222222`])('refuses invalid target config %s', async value => {
  process.env.CUSTOMER_INBOX_TEST_CUSTOMER_ID = value;
  expect((await post()).status).toBe(404);
  expect(db.transaction).not.toHaveBeenCalled();
});
test('cannot select a different customer', async () => {
  expect((await post({ customerId: '22222222-2222-4222-8222-222222222222', execute: true })).status).toBe(404);
  expect(db.transaction).not.toHaveBeenCalled();
});
test.each([
  {}, null, [], { customerId: 'invalid' }, { customerId, execute: 'true' },
  { customerId, execute: 1 }, { customerId, title: 'Custom' },
  { customerId, push: true }, { customerId, count: 3 }, { customerId, runId: 'new-pair' },
])('rejects malformed or expanded input %j', async body => {
  expect((await post(body)).status).toBe(400);
  expect(db.transaction).not.toHaveBeenCalled();
});
test('registers the startup gate as default-off', () => {
  delete process.env.GATE_CUSTOMER_INBOX_TEST;
  jest.isolateModules(() => expect(require('../config/feature-gates').gates.customerInboxTest).toBe(false));
});
