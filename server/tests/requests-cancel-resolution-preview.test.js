'use strict';

// POST /api/requests/cancel-resolution (PR E — POST so the moving address
// stays out of URL logs): dark = 404; gate on = the
// resolver's verdict serialized WITHOUT raw facts; moving address verdicts
// map onto the resolver context. The engine itself is unit-tested in
// cancellation-resolution-engine.test.js — here it is mocked.

jest.mock('express-rate-limit', () => () => (_req, _res, next) => next());
jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.customer = { id: 'cust-1', first_name: 'Pat', last_name: 'T' }; next(); },
  authenticateAllowInactive: (req, _res, next) => { req.customer = { id: 'cust-1', first_name: 'Pat', last_name: 'T' }; next(); },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn().mockResolvedValue({ id: 'n' }) }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn().mockResolvedValue({ sent: false }) }));
jest.mock('../services/sms-template-renderer', () => ({ renderRequiredSmsTemplate: jest.fn().mockResolvedValue('body') }));
jest.mock('../services/account-membership-email', () => ({
  sendRequestReceived: jest.fn().mockResolvedValue(null),
  sendCancellationReceived: jest.fn().mockResolvedValue(null),
}));
// The portal cancellation paths serialize on the shared admin cancel lock.
jest.mock('../services/admin-cancellation', () => ({
  acquireCancelCommitLock: jest.fn(async () => async () => {}),
}));
jest.mock('../services/cancellation-processor', () => ({
  processCancellationRequest: jest.fn(),
  CHURN_REASON: 'Customer cancellation request',
  PORTAL_CANCEL_REASON_PREFIX: 'Portal cancellation request',
  CANCELLABLE_STATUSES: ['pending', 'confirmed', 'rescheduled'],
}));
jest.mock('../services/cancellation-eligibility', () => ({ hasCancellableWork: jest.fn().mockResolvedValue(true) }));
jest.mock('../models/db', () => jest.fn());

const mockPreview = jest.fn();
jest.mock('../services/cancellation-resolution', () => ({
  cancelFlowV2Enabled: () => process.env.GATE_CANCEL_FLOW_V2 === 'true',
  previewCancellationResolution: (...args) => mockPreview(...args),
  openCancellationCase: jest.fn(),
}));

const mockValidateAddress = jest.fn();
jest.mock('../services/address-validation', () => ({
  validateAddress: (...args) => mockValidateAddress(...args),
  STATUSES: { VALIDATED_ACCEPT: 'validated_accept', CORRECTED: 'corrected', OUT_OF_SERVICE_AREA: 'out_of_service_area' },
}));

const express = require('express');
const router = require('../routes/requests');

// Real listen + fetch round-trips (repo has no supertest at the root).
let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/requests', router);
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll((done) => { server.close(done); });

async function post(body) {
  const res = await fetch(`${baseUrl}/api/requests/cancel-resolution`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, body: json || {} };
}

afterEach(() => {
  delete process.env.GATE_CANCEL_FLOW_V2;
  mockPreview.mockReset();
  mockValidateAddress.mockReset();
});

test('gate off → 404, resolver never consulted', async () => {
  const res = await post({ reason: 'price' });
  expect(res.status).toBe(404);
  expect(mockPreview).not.toHaveBeenCalled();
});

test('gate on → card verdict serialized without facts', async () => {
  process.env.GATE_CANCEL_FLOW_V2 = 'true';
  mockPreview.mockResolvedValue({
    facts: { customerId: 'cust-1', monthlyRate: 140 },
    resolution: {
      kind: 'card',
      reasonCode: 'price',
      card: { templateId: 'price_offer', headline: 'H', body: 'B', slots: { family: 'pest_control' }, action: { type: 'retention_offer' } },
    },
  });
  const res = await post({ reason: 'price', families: ['pest_control'] });
  expect(res.status).toBe(200);
  expect(res.body).toEqual({
    kind: 'card',
    reasonCode: 'price',
    scope: [],
    card: { templateId: 'price_offer', headline: 'H', body: 'B', action: { type: 'retention_offer' } },
  });
  expect(JSON.stringify(res.body)).not.toContain('monthlyRate');
  expect(mockPreview).toHaveBeenCalledWith(expect.objectContaining({
    customerId: 'cust-1',
    reasonCode: 'price',
    families: ['pest_control'],
  }));
});

test('hard stop serializes reviewType only', async () => {
  process.env.GATE_CANCEL_FLOW_V2 = 'true';
  mockPreview.mockResolvedValue({ facts: {}, resolution: { kind: 'hard_stop', reasonCode: 'billing_issue', reviewType: 'billing' } });
  const res = await post({ reason: 'billing_issue' });
  expect(res.body).toEqual({ kind: 'hard_stop', reasonCode: 'billing_issue', reviewType: 'billing', scope: [] });
});

test('new_address verdicts map to the resolver context', async () => {
  process.env.GATE_CANCEL_FLOW_V2 = 'true';
  mockPreview.mockResolvedValue({ facts: {}, resolution: { kind: 'none', reasonCode: 'moving_or_property_change' } });

  mockValidateAddress.mockResolvedValueOnce({ status: 'validated_accept', inServiceArea: true });
  await post({ reason: 'moving_or_property_change', new_address: '123 Main St Parrish FL' });
  expect(mockPreview).toHaveBeenLastCalledWith(expect.objectContaining({ context: expect.objectContaining({ newAddressInServiceArea: true }) }));

  mockValidateAddress.mockResolvedValueOnce({ inServiceArea: null, status: 'api_unavailable' });
  await post({ reason: 'moving_or_property_change', new_address: 'somewhere' });
  expect(mockPreview).toHaveBeenLastCalledWith(expect.objectContaining({ context: expect.objectContaining({ newAddressInServiceArea: null }) }));

  // A resolved OUT-of-area address is a reliable false (clean-cancel hard stop).
  mockValidateAddress.mockResolvedValueOnce({ inServiceArea: false, status: 'out_of_service_area' });
  await post({ reason: 'moving_or_property_change', new_address: 'far away' });
  expect(mockPreview).toHaveBeenLastCalledWith(expect.objectContaining({ context: expect.objectContaining({ newAddressInServiceArea: false }) }));

  // A partially validated in-area address (confirm_needed) must NOT verify.
  mockValidateAddress.mockResolvedValueOnce({ inServiceArea: true, status: 'confirm_needed' });
  await post({ reason: 'moving_or_property_change', new_address: 'partial addr' });
  expect(mockPreview).toHaveBeenLastCalledWith(expect.objectContaining({ context: expect.objectContaining({ newAddressInServiceArea: null }) }));
});

test('invalid reason 400s before any work', async () => {
  process.env.GATE_CANCEL_FLOW_V2 = 'true';
  const res = await post({ reason: 'nope' });
  expect(res.status).toBe(400);
  expect(mockPreview).not.toHaveBeenCalled();
});
