// POST /api/admin/customers/:id/autopay-setup-link — thin operator route:
// delivery defaults to inline (no comm), 'sms' and 'email' are the only other values, and
// the service outcome is reported verbatim (with the link) so the Customers
// page can say WHY nothing was sent.
jest.mock('../models/db', () => {
  const dbFn = jest.fn();
  dbFn.transaction = jest.fn();
  dbFn.fn = { now: () => 'NOW' };
  return dbFn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technicianId = 'admin-1'; req.techRole = 'admin'; return next(); },
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
const mockRequest = jest.fn();
jest.mock('../services/autopay-setup-link', () => ({
  requestAutopaySetupLink: (...args) => mockRequest(...args),
}));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderRequiredSmsTemplate: jest.fn() }));
jest.mock('../services/autopay-log', () => ({ logAutopay: jest.fn() }));
jest.mock('../services/autopay-eligibility', () => ({ isPaused: jest.fn(() => false), autopayActivePredicate: jest.fn() }));
jest.mock('../services/billing-lane', () => ({ MONTHLY_LANE_SQL: '', resolveBillingLane: jest.fn() }));

const express = require('express');
const router = require('../routes/admin-billing-health');

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', router);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/admin`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));
beforeEach(() => { jest.clearAllMocks(); });

test('defaults to inline delivery, trigger admin, and echoes the outcome + link', async () => {
  mockRequest.mockResolvedValue({ requested: true, action: 'link_created', reason: 'created', secureUrl: 'https://p/secure/tok', expiresAt: '2026-10-01T00:00:00Z' });
  const res = await fetch(`${base}/customers/cust-1/autopay-setup-link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ requested: true, action: 'link_created', reason: 'created', channel: null, secureUrl: 'https://p/secure/tok', expiresAt: '2026-10-01T00:00:00Z' });
  expect(mockRequest).toHaveBeenCalledWith({ customerId: 'cust-1', delivery: 'inline', trigger: 'admin' });
});

test('sms and email deliveries pass through (echoing the channel); anything else collapses to inline', async () => {
  mockRequest.mockResolvedValue({ requested: true, action: 'sent', reason: 'sent', channel: 'sms', secureUrl: 'https://p/secure/tok' });
  await fetch(`${base}/customers/cust-1/autopay-setup-link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delivery: 'sms' }) });
  expect(mockRequest).toHaveBeenLastCalledWith(expect.objectContaining({ delivery: 'sms' }));
  mockRequest.mockResolvedValue({ requested: true, action: 'sent', reason: 'sent', channel: 'email', secureUrl: 'https://p/secure/tok' });
  const res = await fetch(`${base}/customers/cust-1/autopay-setup-link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delivery: 'email' }) });
  expect(mockRequest).toHaveBeenLastCalledWith(expect.objectContaining({ delivery: 'email' }));
  expect(await res.json()).toEqual(expect.objectContaining({ action: 'sent', channel: 'email' }));
  await fetch(`${base}/customers/cust-1/autopay-setup-link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delivery: 'fax' }) });
  expect(mockRequest).toHaveBeenLastCalledWith(expect.objectContaining({ delivery: 'inline' }));
});

test('skips are reported verbatim with null link fields', async () => {
  mockRequest.mockResolvedValue({ requested: false, action: 'skipped', reason: 'gate_off' });
  const res = await fetch(`${base}/customers/cust-1/autopay-setup-link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  expect(await res.json()).toEqual({ requested: false, action: 'skipped', reason: 'gate_off', channel: null, secureUrl: null, expiresAt: null });
});
