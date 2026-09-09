/**
 * POST /requests under a saved-property selection (GATE_APP_PROPERTY_SCOPE):
 * the re-service guard steps aside for a SECONDARY selection and the ticket
 * persists / surfaces / dedupes on the server-validated property.
 */
jest.mock('express-rate-limit', () => () => (_req, _res, next) => next());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn().mockResolvedValue({ id: 'n' }) }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn().mockResolvedValue({ sent: false }) }));
jest.mock('../services/sms-template-renderer', () => ({ renderRequiredSmsTemplate: jest.fn().mockResolvedValue('body') }));
jest.mock('../services/account-membership-email', () => ({ sendRequestReceived: jest.fn(async () => ({ sent: false })), sendAccountMembershipEmail: jest.fn(), scheduleAccountMembershipEmail: jest.fn() }));
jest.mock('../services/cancellation-processor', () => ({ processCancellationRequest: jest.fn(), PORTAL_CANCEL_REASON_PREFIX: 'portal:' }));
jest.mock('../services/cancellation-confirmations', () => ({ sendCancellationConfirmations: jest.fn() }));
jest.mock('../services/cancellation-eligibility', () => ({ hasCancellableWork: jest.fn().mockResolvedValue(false) }));
jest.mock('../services/cancellation-resolution', () => ({ cancelFlowV2Enabled: () => false, previewCancellationResolution: jest.fn(), openCancellationCase: jest.fn() }));
jest.mock('../services/cancellation-resolution/reason-codes', () => ({ REASON_CODE_VALUES: ['other'] }));
jest.mock('../services/cancellation-resolution/resolve', () => ({ situationalHardStop: jest.fn(() => null) }));
jest.mock('../services/messaging/gsm-normalize', () => ({ gsmSafeName: (s) => s }));
jest.mock('../services/reservice-link', () => ({ reserviceStreamlineAccess: jest.fn(async () => ({ token: 'tok-reservice', lanes: ['pest'] })) }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/account-properties', () => {
  const actual = jest.requireActual('../services/account-properties');
  return { ...actual, resolveSessionScope: jest.fn(async () => global.__SCOPE__) };
});
jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.customer = { id: 'cust-1', first_name: 'Jordan', last_name: 'Rivera', active: true }; req.customerId = 'cust-1'; next(); },
  authenticateAllowInactive: (req, _res, next) => { req.customer = { id: 'cust-1', first_name: 'Jordan', last_name: 'Rivera', active: true }; req.customerId = 'cust-1'; next(); },
}));

const express = require('express');
const db = require('../models/db');
const { notifyAdmin } = require('../services/notification-service');
const router = require('../routes/requests');

const SECONDARY = { customerId: 'cust-1', enabled: true, multi: true, scoped: true, property: { id: 'prop-b', is_primary: false, label: null, address_line1: '418 Oak Ave', address_line2: null, city: 'Bradenton', state: 'FL', zip: '34205' } };
const PRIMARY = { customerId: 'cust-1', enabled: true, multi: true, scoped: true, property: { id: 'prop-a', is_primary: true, label: 'Primary', address_line1: '1200 Palm Row Ct', address_line2: null, city: 'Parrish', state: 'FL', zip: '34219' } };

function chain(rows, log) {
  const c = {};
  for (const m of ['where', 'whereRaw', 'whereIn', 'whereNull', 'orWhere', 'orderBy', 'select', 'limit', 'offset']) {
    c[m] = jest.fn((...args) => { log.push([m, ...args]); if (typeof args[0] === 'function') args[0].call(c, c); return c; });
  }
  c.first = jest.fn(async () => rows[0]);
  c.insert = jest.fn((payload) => { log.push(['insert', payload]); return { returning: jest.fn(async () => [{ id: 'req-1', ...payload, created_at: new Date() }]) }; });
  c.count = jest.fn(() => c);
  c.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return c;
}

let server; let baseUrl; let log;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/requests', router);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  server = app.listen(0, '127.0.0.1', () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });
beforeEach(() => {
  jest.clearAllMocks();
  log = [];
  process.env.GATE_RESERVICE_STREAMLINE = 'true';
  db.mockImplementation((table) => {
    if (table === 'service_requests') return chain([], log);
    return chain([], log);
  });
});

async function post(body) {
  const res = await fetch(`${baseUrl}/api/requests`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, body: json || {} };
}

test('a covered pest issue under a SECONDARY selection files as a ticket that names its house, dedupes per property, and tells staff', async () => {
  global.__SCOPE__ = SECONDARY;
  const res = await post({ category: 'pest_issue', subject: 'Ants in the kitchen', description: 'Trail along the counter' });
  expect(res.status).toBe(201);
  expect(res.body.code).not.toBe('use_reservice_picker');
  const insert = log.find((e) => e[0] === 'insert');
  expect(insert).toBeTruthy();
  const meta = JSON.parse(insert[1].metadata);
  expect(meta.propertyId).toBe('prop-b');
  expect(meta.property).toMatchObject({ id: 'prop-b', isPrimary: false, address: '418 Oak Ave, Bradenton, FL 34205' });
  const dedupe = log.find((e) => e[0] === 'whereRaw');
  expect(dedupe[1]).toMatch(/metadata->>'propertyId'/);
  expect(dedupe[2]).toEqual(['prop-b']);
  const alertBody = notifyAdmin.mock.calls[0][2];
  expect(alertBody).toMatch(/Property: 418 Oak Ave, Bradenton, FL 34205 \(not the primary address\)/);
  expect(notifyAdmin.mock.calls[0][3].metadata).toMatchObject({ propertyId: 'prop-b', propertyAddress: '418 Oak Ave, Bradenton, FL 34205' });
});

test('the same covered issue under the PRIMARY selection is still steered to the re-service picker', async () => {
  global.__SCOPE__ = PRIMARY;
  const res = await post({ category: 'pest_issue', subject: 'Ants in the kitchen' });
  expect(res.status).toBe(409);
  expect(res.body.code).toBe('use_reservice_picker');
  expect(log.find((e) => e[0] === 'insert')).toBeUndefined();
});
