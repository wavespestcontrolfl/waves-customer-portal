/**
 * PUT /api/customer/profile through the REAL auth middleware (GATE_CUSTOMER_PROFILE_EDIT): a cancelled account is
 * answered 403 by the handler, not 401 by the middleware (a 401 makes the app try to refresh its token), and no
 * write or email is attempted. The route's other behavior is in customer-profile.test.js with auth stubbed.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'customer-profile-auth-test-secret';

let mockCustomer;
function mockChain() {
  const chain = new Proxy(function chainFn() {}, {
    get(_t, prop) {
      if (prop === 'first') return jest.fn(async () => mockCustomer);
      if (prop === 'then') return (resolve) => resolve(mockCustomer ? [mockCustomer] : []);
      return jest.fn(() => chain);
    },
  });
  return chain;
}
const mockTransaction = jest.fn();
const mockDb = jest.fn(() => mockChain());
mockDb.transaction = (...a) => mockTransaction(...a);
mockDb.raw = jest.fn();
mockDb.fn = { now: jest.fn() };
jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockSend = jest.fn();
jest.mock('../services/account-membership-email', () => ({ sendAccountUpdated: (...a) => mockSend(...a) }));

const express = require('express');
const auth = require('../middleware/auth');

const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222';
let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/customer/profile', require('../routes/customer-profile'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  server = app.listen(0, '127.0.0.1', () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll((done) => { server.close(done); });

const savedGate = process.env.GATE_CUSTOMER_PROFILE_EDIT;
beforeEach(() => {
  process.env.GATE_CUSTOMER_PROFILE_EDIT = 'true';
  mockTransaction.mockReset();
  mockSend.mockReset();
});
afterAll(() => {
  if (savedGate === undefined) delete process.env.GATE_CUSTOMER_PROFILE_EDIT; else process.env.GATE_CUSTOMER_PROFILE_EDIT = savedGate;
});

const put = async (body, withAuth = true) => {
  const res = await fetch(`${baseUrl}/api/customer/profile`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...(withAuth ? { Authorization: `Bearer ${auth.generateToken(CUSTOMER_ID, CUSTOMER_ID)}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

test('a cancelled account gets the handler 403 (not the middleware 401), with no transaction and no email', async () => {
  mockCustomer = { id: CUSTOMER_ID, account_id: CUSTOMER_ID, active: false, deleted_at: null };
  const res = await put({ firstName: 'Sam' });
  expect(res).toMatchObject({ status: 403, body: { error: 'This account is not active.' } });
  expect(mockTransaction).not.toHaveBeenCalled();
  expect(mockSend).not.toHaveBeenCalled();
});

test('no token is still 401', async () => {
  mockCustomer = { id: CUSTOMER_ID, account_id: CUSTOMER_ID, active: true, deleted_at: null };
  expect((await put({ firstName: 'Sam' }, false)).status).toBe(401);
});

test('an active account reaches the transaction', async () => {
  mockCustomer = { id: CUSTOMER_ID, account_id: CUSTOMER_ID, active: true, deleted_at: null };
  mockTransaction.mockResolvedValue({ before: { first_name: 'Pat' }, after: { first_name: 'Sam' }, changes: {}, items: [], emailSync: null });
  expect((await put({ firstName: 'Sam' })).status).toBe(200);
  expect(mockTransaction).toHaveBeenCalledTimes(1);
});
