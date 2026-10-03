// B07: a Tap to Pay collection must retire the customer's open /pay PaymentIntent
// (services/prepaid-pi-guard, the same helper every other settlement rail runs)
// before binding its card-present PI — otherwise the pointer overwrite leaves the
// pay-page client secret live, and a still-open tab (Apple Pay / ACH confirm) can
// charge the customer a second time.
const mockCreate = jest.fn();
const mockCancelCreated = jest.fn();
const mockRetrieve = jest.fn();
const mockCancelPi = jest.fn();

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config', () => ({ jwt: { secret: 'test-secret' } }));
jest.mock('../config/stripe-config', () => ({ secretKey: 'sk_test' }));
jest.mock('jsonwebtoken', () => ({ verify: jest.fn(() => ({ technicianId: 'tech-1' })), sign: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  isStaffAccessToken: jest.fn(() => true),
  staffTokenVersionMatches: jest.fn(() => true),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false) }));
jest.mock('../services/audit-log', () => ({
  auditTerminalHandoffMint: jest.fn(), auditTerminalHandoffRateLimited: jest.fn(),
  auditTerminalHandoffValidate: jest.fn(), ipFromReq: jest.fn(), uaFromReq: jest.fn(),
}));
jest.mock('../services/estimate-deposits', () => ({ assertInvoiceDepositSettlementReady: jest.fn() }));
jest.mock('../services/pay-combined', () => ({
  releaseCombinedSessionBeforeCollection: jest.fn(async () => ({ released: false })),
  clearPaymentIntentStamps: jest.fn(async () => 0),
}));
jest.mock('../services/stripe', () => ({
  assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined),
  parkInvoiceForSavedCardReconciliation: jest.fn(),
  retrievePaymentIntent: (...args) => mockRetrieve(...args),
  cancelPaymentIntent: (...args) => mockCancelPi(...args),
}));
jest.mock('stripe', () => jest.fn(() => ({
  paymentIntents: { create: (...args) => mockCreate(...args), cancel: (...args) => mockCancelCreated(...args) },
})));

const express = require('express');
const db = require('../models/db');
const router = require('../routes/stripe-terminal');

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/stripe/terminal', router);
  const server = await new Promise((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.once('error', reject);
  });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const TERMINAL_PI = { id: 'pi_terminal_new', client_secret: 'pi_terminal_new_secret' };
let invoiceUpdates;
let handoffUpdates;

// Minimal knex-ish table router: reads return the row, writes are recorded.
function setup({ invoice, handoff }) {
  jest.clearAllMocks();
  invoiceUpdates = [];
  handoffUpdates = [];
  mockCreate.mockResolvedValue(TERMINAL_PI);
  mockCancelCreated.mockResolvedValue({});
  mockCancelPi.mockResolvedValue({});
  const rowQuery = (row, updates) => {
    const q = {};
    q.where = () => q;
    q.whereNull = () => q;
    q.forUpdate = () => q;
    q.first = async () => row;
    q.update = async (patch) => { if (updates) updates.push(patch); return 1; };
    return q;
  };
  db.mockImplementation((table) => {
    if (table === 'technicians') return rowQuery({ id: 'tech-1', active: true, role: 'technician' });
    if (table === 'terminal_handoff_tokens') return rowQuery(handoff, handoffUpdates);
    if (table === 'invoices') return rowQuery(invoice, invoiceUpdates);
    throw new Error(`unexpected table ${table}`);
  });
  db.fn = { now: () => 'now()' };
  db.transaction = jest.fn(async (callback) => callback(db));
}

function baseInvoice(extra = {}) {
  return {
    id: 'inv-1', customer_id: 'cust-1', status: 'sent', total: '100.00',
    credit_applied: '0.00', stripe_payment_intent_id: null, ...extra,
  };
}
function baseHandoff(extra = {}) {
  const used = new Date('2026-10-03T12:00:00Z');
  return {
    jti: 'jti-1', used_at: used, expires_at: new Date(used.getTime() + 600000), tech_user_id: 'tech-1',
    invoice_id: 'inv-1', amount_cents: 10000, stripe_payment_intent_id: null, ...extra,
  };
}

async function postPaymentIntent() {
  return withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/stripe/terminal/payment-intent`, {
      method: 'POST',
      headers: { authorization: 'Bearer staff-token', 'content-type': 'application/json' },
      body: JSON.stringify({ jti: 'jti-1' }),
    });
    return { status: response.status, body: await response.json() };
  });
}

const boundPointer = () => invoiceUpdates.find((u) => u.stripe_payment_intent_id === TERMINAL_PI.id);

describe('POST /payment-intent retires the open pay-page PaymentIntent (B07)', () => {
  test('an open pay-page PI is cancelled before the card-present PI is bound', async () => {
    setup({ invoice: baseInvoice({ stripe_payment_intent_id: 'pi_pay_page' }), handoff: baseHandoff() });
    mockRetrieve.mockResolvedValue({ id: 'pi_pay_page', status: 'requires_payment_method', metadata: {} });

    const { status, body } = await postPaymentIntent();

    expect(status).toBe(200);
    expect(body).toEqual({ clientSecret: TERMINAL_PI.client_secret, paymentIntentId: TERMINAL_PI.id, amount: 10000 });
    expect(mockCancelPi).toHaveBeenCalledTimes(1);
    expect(mockCancelPi).toHaveBeenCalledWith('pi_pay_page', { cancellation_reason: 'abandoned' });
    expect(boundPointer()).toBeTruthy();
    // Retire happens before the pointer is overwritten.
    expect(mockCancelPi.mock.invocationCallOrder[0]).toBeLessThan(db.mock.invocationCallOrder[db.mock.invocationCallOrder.length - 1]);
    expect(mockCancelCreated).not.toHaveBeenCalled();
  });

  test.each(['processing', 'succeeded', 'requires_capture'])(
    'a pay-page PI already %s refuses the terminal collection and binds nothing',
    async (piStatus) => {
      setup({ invoice: baseInvoice({ stripe_payment_intent_id: 'pi_pay_page' }), handoff: baseHandoff() });
      mockRetrieve.mockResolvedValue({ id: 'pi_pay_page', status: piStatus, metadata: {} });

      const { status, body } = await postPaymentIntent();

      expect(status).toBe(409);
      expect(body).toMatchObject({ code: 'payment_in_flight', newHandoffRequired: true });
      expect(body.error).toMatch(/already in progress/);
      expect(mockCancelPi).not.toHaveBeenCalledWith('pi_pay_page', expect.anything());
      // Nothing bound: invoice pointer untouched, the freshly minted PI cancelled, handoff burned.
      expect(boundPointer()).toBeUndefined();
      expect(handoffUpdates.some((u) => u.stripe_payment_intent_id === TERMINAL_PI.id)).toBe(false);
      expect(mockCancelCreated).toHaveBeenCalledWith(TERMINAL_PI.id, { cancellation_reason: 'abandoned' });
      expect(handoffUpdates.some((u) => 'expires_at' in u)).toBe(true);
    },
  );

  test('an unverifiable pay-page PI fails closed with no bind', async () => {
    setup({ invoice: baseInvoice({ stripe_payment_intent_id: 'pi_pay_page' }), handoff: baseHandoff() });
    mockRetrieve.mockRejectedValue(new Error('stripe timeout'));

    const { status, body } = await postPaymentIntent();

    expect(status).toBe(409);
    expect(body).toMatchObject({ code: 'payment_session_unverifiable', newHandoffRequired: true });
    expect(boundPointer()).toBeUndefined();
    expect(mockCancelCreated).toHaveBeenCalledWith(TERMINAL_PI.id, { cancellation_reason: 'abandoned' });
  });

  test('no prior PI: unchanged, guard never touches Stripe', async () => {
    setup({ invoice: baseInvoice(), handoff: baseHandoff() });

    const { status, body } = await postPaymentIntent();

    expect(status).toBe(200);
    expect(body.paymentIntentId).toBe(TERMINAL_PI.id);
    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(mockCancelPi).not.toHaveBeenCalled();
    expect(boundPointer()).toBeTruthy();
  });

  test('retry with the terminal\'s own PI already on the handoff: 409 as before, nothing cancelled', async () => {
    setup({
      invoice: baseInvoice({ stripe_payment_intent_id: TERMINAL_PI.id }),
      handoff: baseHandoff({ stripe_payment_intent_id: TERMINAL_PI.id }),
    });

    const { status, body } = await postPaymentIntent();

    expect(status).toBe(409);
    expect(body).toMatchObject({ code: 'payment_intent_already_created', paymentIntentId: TERMINAL_PI.id });
    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(mockCancelPi).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('Stripe idempotent replay: pointer already equals the replayed terminal PI, so it is not retired', async () => {
    setup({ invoice: baseInvoice({ stripe_payment_intent_id: TERMINAL_PI.id }), handoff: baseHandoff() });

    const { status, body } = await postPaymentIntent();

    expect(status).toBe(200);
    expect(body.paymentIntentId).toBe(TERMINAL_PI.id);
    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(mockCancelPi).not.toHaveBeenCalled();
    expect(mockCancelCreated).not.toHaveBeenCalled();
  });
});
