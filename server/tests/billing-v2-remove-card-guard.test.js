// DELETE /api/billing/cards/:id under GATE_PORTAL_METHOD_REMOVAL_GUARD
// (owner ruling 2026-08-27): the method Auto Pay is USING → 409
// autopay_method_in_use, no mutation; anything else → detach with NO Auto
// Pay side effect. "Using" = getAutopaySelectedMethodIds (charge resolver
// pick + enrollment pointer — expired and paused included). Gate off = the
// legacy remove-and-cascade path, unchanged.

let mockGateOn = true;
jest.mock('../config/feature-gates', () => ({
  isEnabled: (name) => (name === 'portalMethodRemovalGuard' ? mockGateOn : false),
  gates: {},
}));
jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.customerId = 'cust-1';
    next();
  },
}));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/stripe-config', () => ({}));
jest.mock('../services/stripe', () => ({ removeCard: jest.fn().mockResolvedValue({ success: true }) }));
jest.mock('../services/payment-router', () => ({ getServiceForCustomer: jest.fn() }));
jest.mock('../services/autopay-log', () => ({ logAutopay: jest.fn().mockResolvedValue(null) }));
jest.mock('../services/payment-lifecycle-email', () => ({
  sendPaymentMethodUpdated: jest.fn().mockResolvedValue(null),
  sendPaymentMethodRemoved: jest.fn().mockResolvedValue(null),
}));

const express = require('express');
const db = require('../models/db');
const StripeService = require('../services/stripe');
const PaymentLifecycleEmail = require('../services/payment-lifecycle-email');

let state;
let failPaymentMethodReadsAfter = Infinity;
let paymentMethodReads = 0;
let lastBuilders = [];
let trxDepth = 0;

function builderFor(table) {
  const b = { table };
  const conds = [];
  if (table === 'payment_methods') {
    paymentMethodReads += 1;
    if (paymentMethodReads > failPaymentMethodReadsAfter) throw new Error('db down');
  }
  const rows = () => (state[table] || []).filter((r) => conds.every((c) => c(r)));
  b.where = jest.fn((criteria, opOrVal, maybeVal) => {
    if (typeof criteria === 'object' && criteria !== null) {
      Object.entries(criteria).forEach(([k, v]) => conds.push((r) => r[k] === v));
    } else if (typeof criteria === 'string') {
      conds.push((r) => r[criteria] === (maybeVal === undefined ? opOrVal : maybeVal));
    }
    return b;
  });
  for (const method of ['select', 'orderBy', 'whereNotNull', 'whereIn', 'forUpdate']) {
    b[method] = jest.fn(() => b);
  }
  lastBuilders.push(b);
  b.first = jest.fn(async () => rows()[0] || null);
  b.then = (resolve, reject) => Promise.resolve(rows()).then(resolve, reject);
  return b;
}

async function withServer(callback) {
  const app = express();
  app.use(express.json());
  app.use('/billing', require('../routes/billing-v2'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0, '127.0.0.1');
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    return await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const del = (baseUrl, id) => fetch(`${baseUrl}/billing/cards/${id}`, { method: 'DELETE' });

const card = (overrides) => ({
  customer_id: 'cust-1', processor: 'stripe', method_type: 'card',
  exp_month: 12, exp_year: 2032, is_default: false, autopay_enabled: false,
  card_brand: 'VISA', last_four: '4242', ach_status: null, ...overrides,
});

beforeEach(() => {
  mockGateOn = true;
  paymentMethodReads = 0;
  failPaymentMethodReadsAfter = Infinity;
  state = {
    customers: [{ id: 'cust-1', autopay_enabled: true, autopay_payment_method_id: 'pm-live', autopay_paused_until: null, ach_status: null }],
    payment_methods: [
      card({ id: 'pm-live', stripe_payment_method_id: 'pm_stripe_live', is_default: true, autopay_enabled: true }),
      card({ id: 'pm-spare', stripe_payment_method_id: 'pm_stripe_spare', last_four: '1881' }),
    ],
  };
  lastBuilders = [];
  trxDepth = 0;
  db.mockImplementation((table) => builderFor(table));
  db.transaction = async (fn) => {
    trxDepth += 1;
    try { return await fn((table) => builderFor(table)); } finally { trxDepth -= 1; }
  };
  // removeCard is mocked — record that it ran INSIDE the transaction.
  StripeService.removeCard.mockImplementation(async () => {
    if (trxDepth !== 1) throw new Error('removeCard ran outside the locking transaction');
    return { success: true };
  });
});

afterEach(() => jest.clearAllMocks());

describe('DELETE /billing/cards/:id — removal guard', () => {
  test('the pointer method (what charge() bills) → 409 autopay_method_in_use, nothing detached', () =>
    withServer(async (baseUrl) => {
      const res = await del(baseUrl, 'pm-live');
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('autopay_method_in_use');
      expect(body.error).toMatch(/turn off Auto Pay before removing/i);
      expect(body.autopay).toEqual({ enabled: true, paused: false, methodId: 'pm-live' });
      expect(StripeService.removeCard).not.toHaveBeenCalled();
      expect(PaymentLifecycleEmail.sendPaymentMethodRemoved).not.toHaveBeenCalled();
      // The refusal is observable: audit row for the firsts watch / 360 feed.
      const { logAutopay } = require('../services/autopay-log');
      await new Promise((r) => setImmediate(r));
      expect(logAutopay).toHaveBeenCalledWith('cust-1', 'removal_refused', expect.objectContaining({
        paymentMethodId: 'pm-live',
        details: { source: 'portal_delete', paused: false },
      }));
    }));

  test('no pointer, default+enabled row → still 409 (mirrors charge() fallback walk)', () =>
    withServer(async (baseUrl) => {
      state.customers[0].autopay_payment_method_id = null;
      const res = await del(baseUrl, 'pm-live');
      expect(res.status).toBe(409);
      expect(StripeService.removeCard).not.toHaveBeenCalled();
    }));

  test('EXPIRED in-charge card → 409 (no escape hatch: Replace or Turn off first)', () =>
    withServer(async (baseUrl) => {
      const live = state.payment_methods.find((p) => p.id === 'pm-live');
      live.exp_month = 1;
      live.exp_year = 2020;
      const res = await del(baseUrl, 'pm-live');
      expect(res.status).toBe(409);
      expect(StripeService.removeCard).not.toHaveBeenCalled();
    }));

  test('PAUSED Auto Pay still counts as using the method → 409 with the paused copy', () =>
    withServer(async (baseUrl) => {
      state.customers[0].autopay_paused_until = '2099-01-01';
      const res = await del(baseUrl, 'pm-live');
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toMatch(/paused, not off/i);
      expect(body.autopay.paused).toBe(true);
    }));

  test('a stale PAST autopay_paused_until is not paused (isPaused, ET-aware) → plain in-use copy', () =>
    withServer(async (baseUrl) => {
      state.customers[0].autopay_paused_until = '2000-01-01';
      const res = await del(baseUrl, 'pm-live');
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).not.toMatch(/paused/i);
      expect(body.autopay.paused).toBe(false);
    }));

  test('a non-autopay row → detached with cascadeAutopay:false and a removed notice, no Auto Pay mutation', () =>
    withServer(async (baseUrl) => {
      const res = await del(baseUrl, 'pm-spare');
      expect(res.status).toBe(200);
      expect(StripeService.removeCard).toHaveBeenCalledWith('cust-1', 'pm-spare', expect.objectContaining({ cascadeAutopay: false }));
      // The customer and card rows were locked FOR UPDATE before the check,
      // customer FIRST (shared lock order across every Auto Pay mutation).
      const locked = lastBuilders.filter((b) => b.forUpdate.mock.calls.length > 0);
      expect(locked.length).toBeGreaterThanOrEqual(2);
      expect(locked[0].table).toBe('customers');
      expect(locked[1].table).toBe('payment_methods');
      expect(PaymentLifecycleEmail.sendPaymentMethodRemoved).toHaveBeenCalledWith(expect.objectContaining({
        customerId: 'cust-1',
        method: expect.objectContaining({ id: 'pm-spare', last_four: '1881' }),
        autopayDisabled: false,
      }));
      // The route itself never touches customers.autopay_* (no update
      // builder is even exercised — the only customers read is the guard).
      expect(state.customers[0].autopay_enabled).toBe(true);
      expect(state.customers[0].autopay_payment_method_id).toBe('pm-live');
    }));

  test('after Auto Pay is turned OFF the former in-charge card is removable', () =>
    withServer(async (baseUrl) => {
      state.customers[0].autopay_enabled = false;
      const res = await del(baseUrl, 'pm-live');
      expect(res.status).toBe(200);
      expect(StripeService.removeCard).toHaveBeenCalledWith('cust-1', 'pm-live', expect.objectContaining({ cascadeAutopay: false }));
    }));

  test('after Auto Pay MOVES to another card the old card is removable', () =>
    withServer(async (baseUrl) => {
      const live = state.payment_methods.find((p) => p.id === 'pm-live');
      const spare = state.payment_methods.find((p) => p.id === 'pm-spare');
      live.is_default = false; live.autopay_enabled = false;
      spare.is_default = true; spare.autopay_enabled = true;
      state.customers[0].autopay_payment_method_id = 'pm-spare';
      const res = await del(baseUrl, 'pm-live');
      expect(res.status).toBe(200);
      const res2 = await del(baseUrl, 'pm-spare');
      expect(res2.status).toBe(409);
    }));

  test('a stale non-default row flagged autopay_enabled is NOT in use → removable, and the legacy cascade is not invoked', () =>
    withServer(async (baseUrl) => {
      state.payment_methods.push(card({ id: 'pm-stale', stripe_payment_method_id: 'pm_stripe_stale', autopay_enabled: true }));
      const res = await del(baseUrl, 'pm-stale');
      expect(res.status).toBe(200);
      expect(StripeService.removeCard).toHaveBeenCalledWith('cust-1', 'pm-stale', expect.objectContaining({ cascadeAutopay: false }));
    }));

  test('guard read failure → 503, nothing detached (fail closed)', () =>
    withServer(async (baseUrl) => {
      failPaymentMethodReadsAfter = 1; // the locked card lookup succeeds; the resolver read fails
      const res = await del(baseUrl, 'pm-spare');
      expect(res.status).toBe(503);
      expect(StripeService.removeCard).not.toHaveBeenCalled();
    }));

  test('unknown card → 404', () =>
    withServer(async (baseUrl) => {
      const res = await del(baseUrl, 'pm-nope');
      expect(res.status).toBe(404);
    }));
});

describe('DELETE /billing/cards/:id — gate OFF (legacy)', () => {
  test('removes the in-charge card unconditionally with the legacy cascade; autopayDisabled reflects what the cascade COMMITTED', () =>
    withServer(async (baseUrl) => {
      mockGateOn = false;
      // The cascade actually flipped the customer row.
      StripeService.removeCard.mockImplementation(async () => {
        state.customers[0].autopay_enabled = false;
        state.customers[0].autopay_payment_method_id = null;
        return { success: true };
      });
      const res = await del(baseUrl, 'pm-live');
      expect(res.status).toBe(200);
      expect(StripeService.removeCard).toHaveBeenCalledWith('cust-1', 'pm-live', expect.objectContaining({ cascadeAutopay: true }));
      expect(PaymentLifecycleEmail.sendPaymentMethodRemoved).toHaveBeenCalledWith(expect.objectContaining({
        autopayDisabled: true,
      }));
    }));

  test('NULL autopay_enabled (on, per the nullable rule) + cascade flipped it → autopayDisabled true', () =>
    withServer(async (baseUrl) => {
      mockGateOn = false;
      state.customers[0].autopay_enabled = null;
      StripeService.removeCard.mockImplementation(async () => {
        state.customers[0].autopay_enabled = false;
        return { success: true };
      });
      const res = await del(baseUrl, 'pm-live');
      expect(res.status).toBe(200);
      expect(PaymentLifecycleEmail.sendPaymentMethodRemoved).toHaveBeenCalledWith(expect.objectContaining({ autopayDisabled: true }));
    }));

  test('cascade swallowed a failure (customer still enabled) → the notice must NOT claim Auto Pay went off', () =>
    withServer(async (baseUrl) => {
      mockGateOn = false;
      StripeService.removeCard.mockImplementation(async () => ({ success: true })); // row gone, customer untouched
      const res = await del(baseUrl, 'pm-live');
      expect(res.status).toBe(200);
      expect(PaymentLifecycleEmail.sendPaymentMethodRemoved).toHaveBeenCalledWith(expect.objectContaining({
        autopayDisabled: false,
      }));
    }));
});
