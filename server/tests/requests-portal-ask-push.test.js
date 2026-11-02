// GATE_PORTAL_ASK_PUSH on POST /api/requests: a customer's own submission also pages the admin phones once its bell
// row exists. A withheld or failed bell pages nobody. (Staff-made requests do not come through this customer route.)
/**
 * A portal request's confirmation text and email give the same reply time as the portal chat: one business
 * hour between 8 AM and 8 PM, urgent or routine (owner 2026-11-02, "match"; it was 2 hours urgent, 24 hours
 * routine). The value is account-membership-email.js REQUEST_RESPONSE_TIME.
 */
jest.mock('express-rate-limit', () => () => (_req, _res, next) => next());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn().mockResolvedValue({ id: 'n' }) }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn().mockResolvedValue({ sent: true }) }));
jest.mock('../services/sms-template-renderer', () => ({ renderRequiredSmsTemplate: jest.fn().mockResolvedValue('body') }));
jest.mock('../services/account-membership-email', () => ({
  sendRequestReceived: jest.fn(async () => ({ sent: false })),
  sendAccountMembershipEmail: jest.fn(),
  scheduleAccountMembershipEmail: jest.fn(),
  REQUEST_RESPONSE_TIME: 'one business hour (8 AM to 8 PM)',
}));
jest.mock('../services/cancellation-processor', () => ({ processCancellationRequest: jest.fn(), PORTAL_CANCEL_REASON_PREFIX: 'portal:' }));
jest.mock('../services/cancellation-confirmations', () => ({ sendCancellationConfirmations: jest.fn() }));
jest.mock('../services/cancellation-eligibility', () => ({ hasCancellableWork: jest.fn().mockResolvedValue(false) }));
jest.mock('../services/cancellation-resolution', () => ({ cancelFlowV2Enabled: () => false, previewCancellationResolution: jest.fn(), openCancellationCase: jest.fn() }));
jest.mock('../services/cancellation-resolution/reason-codes', () => ({ REASON_CODE_VALUES: ['other'] }));
jest.mock('../services/cancellation-resolution/resolve', () => ({ situationalHardStop: jest.fn(() => null) }));
jest.mock('../services/messaging/gsm-normalize', () => ({ gsmSafeName: (s) => s }));
jest.mock('../services/reservice-link', () => ({ reserviceStreamlineAccess: jest.fn(async () => null) }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false), portalAskPushLive: () => process.env.GATE_PORTAL_ASK_PUSH === 'true' }));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => ({ bellWritten: false, push: { sent: 1 } })) }));
jest.mock('../services/customer-photo-id-evidence', () => ({ requestPhotoIdEvidence: jest.fn() }));
jest.mock('../middleware/auth', () => {
  const sign = (req, _res, next) => {
    req.customer = { id: 'cust-1', first_name: 'Jordan', last_name: 'Rivera', phone: '+19415550100', active: true };
    req.customerId = 'cust-1';
    next();
  };
  return { authenticate: sign, authenticateAllowInactive: sign };
});

const express = require('express');
const db = require('../models/db');
const NotificationService = require('../services/notification-service');
const { triggerNotification } = require('../services/notification-triggers');
const router = require('../routes/requests');

function chain(rows) {
  const c = {};
  for (const m of ['where', 'whereRaw', 'whereIn', 'whereNull', 'orWhere', 'orderBy', 'select', 'limit', 'offset']) {
    c[m] = jest.fn((...args) => { if (typeof args[0] === 'function') args[0].call(c, c); return c; });
  }
  c.first = jest.fn(async () => rows[0]);
  c.insert = jest.fn((payload) => ({ returning: jest.fn(async () => [{ id: 'req-1', ...payload, created_at: new Date() }]) }));
  c.count = jest.fn(() => c);
  c.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return c;
}

let server; let baseUrl;
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
  db.mockImplementation(() => chain([]));
});

async function post(body) {
  const res = await fetch(`${baseUrl}/api/requests`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status };
}


const pushes = () => triggerNotification.mock.calls.filter(([key]) => key === 'portal_ask');
const body = { category: 'pest_issue', subject: 'Ants in the kitchen', description: 'Trail along the counter. Call 941-555-0100', urgency: 'routine' };
beforeEach(() => { process.env.GATE_PORTAL_ASK_PUSH = 'true'; require('../services/portal-ask-push').__private.resetPageLimits(); });
afterEach(() => { delete process.env.GATE_PORTAL_ASK_PUSH; });

test('a new request rings the bell and sends one pushOnly page: first name and last initial, no description, no phone', async () => {
  const res = await post(body);
  expect(res.status).toBe(201);
  expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  expect(pushes()).toHaveLength(1);
  const [key, payload, opts] = pushes()[0];
  expect(key).toBe('portal_ask');
  expect(opts).toEqual({ pushOnly: true });
  expect(payload).toEqual(expect.objectContaining({
    itemKey: 'request:req-1',
    title: 'Answer a portal request',
    body: 'Jordan R. sent a pest issue request',
    link: '/admin/customers?customerId=cust-1',
    customerId: 'cust-1',
  }));
  expect(JSON.stringify(payload)).not.toMatch(/941|555|Ants|Trail/);
});

test('an urgent request says so', async () => {
  await post({ ...body, urgency: 'urgent' });
  expect(pushes()[0][1].title).toBe('Answer an urgent portal request');
});

test('gate off: the bell rings and no push is sent', async () => {
  delete process.env.GATE_PORTAL_ASK_PUSH;
  expect((await post(body)).status).toBe(201);
  expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  expect(triggerNotification).not.toHaveBeenCalled();
});

test.each([
  ['a withheld bell (demo account or policy)', { id: null, suppressed: true }],
  ['a failed bell write', null],
])('%s sends no push and the customer still gets their request', async (_label, bell) => {
  NotificationService.notifyAdmin.mockResolvedValueOnce(bell);
  expect((await post(body)).status).toBe(201);
  expect(pushes()).toHaveLength(0);
});

test('a push that throws never fails the customer\'s submission', async () => {
  triggerNotification.mockRejectedValueOnce(new Error('push down'));
  expect((await post(body)).status).toBe(201);
});
