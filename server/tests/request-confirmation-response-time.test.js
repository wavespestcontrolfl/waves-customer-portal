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
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false) }));
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
const { renderRequiredSmsTemplate } = require('../services/sms-template-renderer');
const AccountMembershipEmail = require('../services/account-membership-email');
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

test.each(['urgent', 'routine'])('a %s request is told one business hour by text and by email', async (urgency) => {
  const res = await post({ category: 'pest_issue', subject: 'Ants in the kitchen', description: 'Trail along the counter', urgency });
  expect(res.status).toBe(201);
  const [key, vars] = renderRequiredSmsTemplate.mock.calls[0];
  expect(key).toBe('service_request_confirmation');
  expect(vars.response_time).toBe('one business hour (8 AM to 8 PM)');
  expect(AccountMembershipEmail.sendRequestReceived).toHaveBeenCalledWith(expect.objectContaining({ responseTime: 'one business hour (8 AM to 8 PM)' }));
});
