/**
 * POST /api/pay/:token/plan-choice (GATE_PAY_PLAN_CHOICE): the public-route
 * guards. A dark gate, a malformed token and an unknown invoice answer the
 * 404 an unknown token gets; the only plan with an action is prepay_annual;
 * the route relays the service's answer and never names an amount itself.
 * What the choice mints and what paying it does are covered in
 * pay-plan-choice-postgres.test.js.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ gates: {}, isEnabled: jest.fn(() => false) }));
const mockChoice = { selectAnnualPrepay: jest.fn(), planChoiceForInvoice: jest.fn() };
jest.mock('../services/pay-plan-choice', () => mockChoice);
jest.mock('../services/stripe', () => ({}));
const mockRows = { invoices: null };
jest.mock('../models/db', () => jest.fn((table) => {
  const q = {};
  q.where = jest.fn(() => q);
  q.first = jest.fn(async () => mockRows[table] || null);
  return q;
}));

const express = require('express');
const crypto = require('crypto');
const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');

let server;
let base;
let token;
const post = (path, body) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(async (res) => ({ status: res.status, body: await res.json() }));

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/pay', require('../routes/pay-v2'));
  server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => {
  server.closeAllConnections();
  server.close(() => done());
});

beforeEach(() => {
  jest.clearAllMocks();
  isEnabled.mockImplementation((key) => key === 'payPlanChoice');
  token = crypto.randomBytes(32).toString('hex');
  mockRows.invoices = { id: 'inv-1', customer_id: 'cust-1', status: 'viewed' };
});

const NOT_FOUND = { status: 404, body: { error: 'Invoice not found' } };

test('a dark gate, a malformed token and an unknown invoice all answer the generic 404 and pick nothing', async () => {
  expect(await post('/api/pay/short/plan-choice', { plan: 'prepay_annual' })).toEqual(NOT_FOUND);
  isEnabled.mockReturnValue(false);
  expect(await post(`/api/pay/${token}/plan-choice`, { plan: 'prepay_annual' })).toEqual(NOT_FOUND);
  expect(db).not.toHaveBeenCalled();
  isEnabled.mockImplementation((key) => key === 'payPlanChoice');
  mockRows.invoices = null;
  expect(await post(`/api/pay/${token}/plan-choice`, { plan: 'prepay_annual' })).toEqual(NOT_FOUND);
  expect(mockChoice.selectAnnualPrepay).not.toHaveBeenCalled();
});

test('only prepay_annual is a pick; the service decides from the invoice row and the route relays its answer', async () => {
  expect(await post(`/api/pay/${token}/plan-choice`, { plan: 'per_application', amount: 1 }))
    .toEqual({ status: 400, body: { error: 'invalid_plan' } });
  expect(mockChoice.selectAnnualPrepay).not.toHaveBeenCalled();

  mockChoice.selectAnnualPrepay.mockResolvedValueOnce({ refused: true });
  expect(await post(`/api/pay/${token}/plan-choice`, { plan: 'prepay_annual' }))
    .toEqual({ status: 409, body: { error: 'plan_choice_unavailable' } });

  mockChoice.selectAnnualPrepay.mockResolvedValueOnce({ payUrl: 'https://portal.example/pay/prepay-token' });
  expect(await post(`/api/pay/${token}/plan-choice`, { plan: 'prepay_annual', amount: 1 }))
    .toEqual({ status: 200, body: { success: true, payUrl: 'https://portal.example/pay/prepay-token' } });
  // The invoice row alone: nothing the request sent reaches the service.
  expect(mockChoice.selectAnnualPrepay).toHaveBeenLastCalledWith(mockRows.invoices);
});

test('a failure answers a retryable 503 and logs the invoice id, never the link token', async () => {
  mockChoice.selectAnnualPrepay.mockRejectedValueOnce(new Error('database timeout'));
  expect(await post(`/api/pay/${token}/plan-choice`, { plan: 'prepay_annual' }))
    .toEqual({ status: 503, body: { error: 'Plan choice unavailable — please try again' } });
  const logged = require('../services/logger').warn.mock.calls.map((c) => String(c[0])).join('\n');
  expect(logged).toContain('invoice=inv-1');
  expect(logged).not.toContain(token);
});
