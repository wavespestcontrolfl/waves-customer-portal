'use strict';
// POST /api/requests/cancel-resolution/accept (C1): the server re-resolves
// and refuses a stale card, mints the committed+accepted case, executes the
// action, confirms by SMS AND email (customer-initiated ⇒ both), and is
// idempotent for 24h on the same accepted template. Executors are mocked —
// they are unit-tested in their own suites.

jest.mock('express-rate-limit', () => () => (_req, _res, next) => next());
jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.customer = { id: 'cust-1', first_name: 'Pat', phone: '+19415550000' }; next(); },
  authenticateAllowInactive: (req, _res, next) => { req.customer = { id: 'cust-1', first_name: 'Pat', phone: '+19415550000' }; next(); },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn().mockResolvedValue({ id: 'n' }) }));

const mockSms = jest.fn().mockResolvedValue({ sent: true });
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: (...a) => mockSms(...a) }));
jest.mock('../services/sms-template-renderer', () => ({ renderRequiredSmsTemplate: jest.fn().mockResolvedValue('body') }));
const mockEmail = jest.fn().mockResolvedValue({ ok: true });
jest.mock('../services/account-membership-email', () => ({
  sendRequestReceived: jest.fn().mockResolvedValue(null),
  sendCancellationReceived: jest.fn().mockResolvedValue(null),
  sendResolutionAccepted: (...a) => mockEmail(...a),
}));
jest.mock('../services/cancellation-processor', () => ({
  processCancellationRequest: jest.fn(),
  planScopedWindDown: jest.fn(),
  CHURN_REASON: 'Customer cancellation request',
  CANCELLABLE_STATUSES: ['pending', 'confirmed', 'rescheduled'],
}));
jest.mock('../services/cancellation-eligibility', () => ({ hasCancellableWork: jest.fn().mockResolvedValue(true) }));

// Minimal db mock: the accept path reads cancellation_cases (dedupe) and
// stashes the receipt. `state.priorCase` drives the dedupe branch.
const state = { priorCase: null, updates: [] };
jest.mock('../models/db', () => {
  const fn = jest.fn(() => {
    const builder = {
      where: jest.fn(() => builder),
      orderBy: jest.fn(() => builder),
      first: jest.fn(async () => state.priorCase),
      select: jest.fn(async () => (state.priorCase ? [state.priorCase] : [])),
      update: jest.fn(async (patch) => { state.updates.push(patch); return 1; }),
    };
    return builder;
  });
  fn.raw = jest.fn((sql, bindings) => ({ __raw: sql, bindings }));
  fn.transaction = async (cb) => cb(Object.assign(((...a) => fn(...a)), { raw: jest.fn(async () => ({})) }));
  return fn;
});

const mockPreview = jest.fn();
const mockOpenCase = jest.fn();
jest.mock('../services/cancellation-resolution', () => ({
  cancelFlowV2Enabled: () => process.env.GATE_CANCEL_FLOW_V2 === 'true',
  previewCancellationResolution: (...a) => mockPreview(...a),
  openCancellationCase: (...a) => mockOpenCase(...a),
}));
const mockExecute = jest.fn();
jest.mock('../services/cancellation-resolution/actions', () => ({
  isAcceptableAction: (action) => !!action && action.type !== 'restart_note' && action.type !== 'none',
  executeAcceptedAction: (...a) => mockExecute(...a),
}));

const express = require('express');
const router = require('../routes/requests');

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/requests', router);
  server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });

async function accept(body) {
  const res = await fetch(`${baseUrl}/api/requests/cancel-resolution/accept`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, body: json || {} };
}

const CARD_PREVIEW = {
  facts: {},
  resolution: {
    kind: 'card', reasonCode: 'away', scope: ['lawn_care'],
    card: { templateId: 'away_hold', headline: 'H', body: 'B', action: { type: 'hold', holdMaxDays: 180 } },
  },
};

beforeEach(() => {
  process.env.GATE_CANCEL_FLOW_V2 = 'true';
  state.priorCase = null;
  state.updates.length = 0;
  mockPreview.mockReset().mockResolvedValue(CARD_PREVIEW);
  mockOpenCase.mockReset().mockResolvedValue({ id: 'case-12345678', reason_code: 'away' });
  mockExecute.mockReset().mockResolvedValue({ actionType: 'hold', effects: ['Lawn Care on hold until December 1, 2026.'] });
  mockSms.mockClear().mockResolvedValue({ sent: true });
  mockEmail.mockClear().mockResolvedValue({ ok: true });
});
afterEach(() => { delete process.env.GATE_CANCEL_FLOW_V2; });

test('gate off → 404, nothing consulted', async () => {
  delete process.env.GATE_CANCEL_FLOW_V2;
  const res = await accept({ reasonCode: 'away', templateId: 'away_hold' });
  expect(res.status).toBe(404);
  expect(mockPreview).not.toHaveBeenCalled();
});

test('happy path: re-resolves, mints accepted case, executes, confirms on both channels', async () => {
  const res = await accept({ reasonCode: 'away', families: ['lawn_care'], templateId: 'away_hold', params: { resumeDate: '2026-12-01' } });
  expect(res.status).toBe(201);
  expect(res.body.ok).toBe(true);
  expect(res.body.receipt).toMatchObject({
    actionType: 'hold',
    reference: 'CASE-123',
    confirmationChannels: ['sms', 'email'],
  });
  expect(mockOpenCase).toHaveBeenCalledWith(expect.objectContaining({ resolutionOutcome: 'accepted', reasonCode: 'away' }));
  expect(mockExecute).toHaveBeenCalledWith(expect.objectContaining({
    action: expect.objectContaining({ type: 'hold' }),
    params: expect.objectContaining({ resumeDate: '2026-12-01' }),
  }));
  // Receipt stashed on the case for the idempotency window.
  expect(state.updates.length).toBeGreaterThan(0);
});

test('a stale/mismatched template is refused and nothing executes', async () => {
  const res = await accept({ reasonCode: 'away', templateId: 'price_offer' });
  expect(res.status).toBe(409);
  expect(res.body.code).toBe('resolution_stale');
  expect(mockOpenCase).not.toHaveBeenCalled();
  expect(mockExecute).not.toHaveBeenCalled();
});

test('an executor coded failure returns its code and sends no confirmation', async () => {
  const err = new Error('Pick the date you are back');
  err.code = 'hold_date_invalid';
  mockExecute.mockRejectedValueOnce(err);
  const res = await accept({ reasonCode: 'away', templateId: 'away_hold' });
  expect(res.status).toBe(409);
  expect(res.body.code).toBe('hold_date_invalid');
  expect(mockSms).not.toHaveBeenCalled();
  expect(mockEmail).not.toHaveBeenCalled();
});

test('same accepted template inside 24h returns the original receipt, no re-execution', async () => {
  state.priorCase = {
    id: 'case-old',
    resolution_action: JSON.stringify({ type: 'hold', holdMaxDays: 180 }),
    scope: JSON.stringify(['lawn_care']),
    snapshot: {
      accept_key: JSON.stringify({ t: 'away_hold', r: 'away', f: [], p: {} }),
      accept_receipt: { reference: 'OLDREF', actionType: 'hold', summary: 'S', effects: [], confirmationChannels: ['sms'] },
    },
  };
  const res = await accept({ reasonCode: 'away', templateId: 'away_hold' });
  expect(res.status).toBe(200);
  expect(res.body.deduped).toBe(true);
  expect(res.body.receipt.reference).toBe('OLDREF');
  expect(mockExecute).not.toHaveBeenCalled();
});

test('a failed email is not claimed: channels list only what accepted', async () => {
  mockEmail.mockResolvedValueOnce({ ok: false });
  const res = await accept({ reasonCode: 'away', templateId: 'away_hold' });
  expect(res.status).toBe(201);
  expect(res.body.receipt.confirmationChannels).toEqual(['sms']);
});
