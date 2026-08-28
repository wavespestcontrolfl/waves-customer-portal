// Consent scope on the two direct-write Auto Pay paths: PUT /billing/autopay
// (existing-method selection / re-enable) and PUT /billing/cards/:id/default
// (the default role carries Auto Pay). Neither goes through
// enrollConsentedMethod, so each must enforce hasEnrollmentScopedConsent
// itself — otherwise a card saved only for an estimate hold becomes the
// recurring method with no authorization of record. 409 consent_required
// without an acceptance; a consent_accepted retry records the audit row
// BEFORE any flag moves.

jest.mock('stripe', () => jest.fn(() => ({})));
// The router's per-customer write limiter (6/min) is shared across every
// test in this file; it is not under test here.
jest.mock('express-rate-limit', () => () => (_req, _res, next) => next());
jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.customerId = 'cust-1';
    next();
  },
}));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/stripe-config', () => ({}));
jest.mock('../services/stripe', () => ({}));
jest.mock('../services/payment-router', () => ({ getServiceForCustomer: jest.fn() }));
jest.mock('../services/autopay-log', () => ({
  logAutopay: jest.fn().mockResolvedValue(null),
  getRecent: jest.fn().mockResolvedValue([]),
}));
jest.mock('../services/payment-lifecycle-email', () => ({
  sendAutopayEnabled: jest.fn().mockResolvedValue(null),
  sendAutopayDisabled: jest.fn().mockResolvedValue(null),
  sendPaymentMethodUpdated: jest.fn().mockResolvedValue(null),
  sendPaymentMethodRemoved: jest.fn().mockResolvedValue(null),
}));
jest.mock('../services/card-enrollment-email', () => ({
  sendAutopayEnrollmentConfirmation: jest.fn().mockResolvedValue(null),
}));
jest.mock('../services/payment-method-consents', () => ({
  hasEnrollmentScopedConsent: jest.fn().mockResolvedValue(false),
  recordConsent: jest.fn().mockResolvedValue({ id: 'consent-1' }),
}));

const express = require('express');
const db = require('../models/db');
const ConsentService = require('../services/payment-method-consents');

let state;

function builderFor(table) {
  const b = {};
  const conds = [];
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
  b.first = jest.fn(async () => rows()[0] || null);
  b.update = jest.fn(async (vals) => {
    const matched = rows();
    matched.forEach((r) => Object.assign(r, vals));
    return matched.length;
  });
  b.then = (resolve, reject) => Promise.resolve(rows()).then(resolve, reject);
  return b;
}

async function withServer(mount, router, callback) {
  const app = express();
  app.use(express.json());
  app.use(mount, router);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0, '127.0.0.1');
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    return await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

beforeEach(() => {
  state = {
    customers: [{ id: 'cust-1', autopay_enabled: false, autopay_payment_method_id: null, billing_day: 1, ach_status: null }],
    payment_methods: [
      { id: 'pm-hold', customer_id: 'cust-1', processor: 'stripe', stripe_payment_method_id: 'pm_stripe_hold', method_type: 'card', exp_month: 12, exp_year: 2032, is_default: false, autopay_enabled: false },
      { id: 'pm-old', customer_id: 'cust-1', processor: 'stripe', stripe_payment_method_id: 'pm_stripe_old', method_type: 'card', exp_month: 11, exp_year: 2031, is_default: true, autopay_enabled: false },
    ],
  };
  db.mockImplementation((table) => builderFor(table));
  db.transaction = async (fn) => fn((table) => builderFor(table));
  ConsentService.hasEnrollmentScopedConsent.mockResolvedValue(false);
});

afterEach(() => jest.clearAllMocks());

describe('PUT /billing/autopay — selected method re-verified under lock (pre-push r1 P0)', () => {
  const router = () => require('../routes/customer-autopay');

  test('a method deleted between the pre-read and the transaction → 409 payment_method_removed, nothing written', () =>
    withServer('/billing/autopay', router(), async (baseUrl) => {
      ConsentService.hasEnrollmentScopedConsent.mockResolvedValue(true);
      db.transaction = async (fn) => {
        // Simulate a concurrent portal removal committing first.
        state.payment_methods = state.payment_methods.filter((p) => p.id !== 'pm-hold');
        return fn((table) => builderFor(table));
      };
      const res = await fetch(`${baseUrl}/billing/autopay`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autopay_enabled: true, autopay_payment_method_id: 'pm-hold' }),
      });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('payment_method_removed');
      expect(state.customers[0].autopay_enabled).toBe(false);
      expect(state.customers[0].autopay_payment_method_id).toBe(null);
    }));
});

describe('PUT /billing/autopay — Auto Pay-off notice sent once (GH codex r1 P2)', () => {
  const router = () => require('../routes/customer-autopay');
  const PaymentLifecycleEmail = require('../services/payment-lifecycle-email');
  const disable = (baseUrl) => fetch(`${baseUrl}/billing/autopay`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autopay_enabled: false }),
  });

  test('the request that flips enabled→disabled under the lock sends the notice', () =>
    withServer('/billing/autopay', router(), async (baseUrl) => {
      state.customers[0].autopay_enabled = true;
      state.customers[0].autopay_payment_method_id = 'pm-old';
      const res = await disable(baseUrl);
      expect(res.status).toBe(200);
      expect(PaymentLifecycleEmail.sendAutopayDisabled).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'cust-1', paymentMethodId: 'pm-old' }));
    }));

  test('a NULL autopay_enabled customer turning Auto Pay off IS a transition (only explicit false is off) → notice sent', () =>
    withServer('/billing/autopay', router(), async (baseUrl) => {
      state.customers[0].autopay_enabled = null;
      state.customers[0].autopay_payment_method_id = 'pm-old';
      const res = await disable(baseUrl);
      expect(res.status).toBe(200);
      expect(state.customers[0].autopay_enabled).toBe(false);
      expect(PaymentLifecycleEmail.sendAutopayDisabled).toHaveBeenCalledTimes(1);
    }));

  test('no pointer (legacy enrollment) → the notice names the default+enabled fallback collection would bill', () =>
    withServer('/billing/autopay', router(), async (baseUrl) => {
      state.customers[0].autopay_enabled = true;
      state.customers[0].autopay_payment_method_id = null;
      state.payment_methods.find((p) => p.id === 'pm-old').autopay_enabled = true; // is_default already true
      const res = await disable(baseUrl);
      expect(res.status).toBe(200);
      expect(PaymentLifecycleEmail.sendAutopayDisabled).toHaveBeenCalledWith(expect.objectContaining({ paymentMethodId: 'pm-old' }));
    }));

  test('the notice names the method in charge UNDER THE LOCK, not the stale pre-read pointer', () =>
    withServer('/billing/autopay', router(), async (baseUrl) => {
      state.customers[0].autopay_enabled = true;
      state.customers[0].autopay_payment_method_id = 'pm-old';
      db.transaction = async (fn) => {
        // A concurrent switch moved Auto Pay to pm-hold between pre-read and lock.
        state.customers[0].autopay_payment_method_id = 'pm-hold';
        return fn((table) => builderFor(table));
      };
      const res = await disable(baseUrl);
      expect(res.status).toBe(200);
      expect(PaymentLifecycleEmail.sendAutopayDisabled).toHaveBeenCalledWith(expect.objectContaining({ paymentMethodId: 'pm-hold' }));
    }));

  test('an overlapping disable that finds the flag already off under the lock does NOT send a second notice', () =>
    withServer('/billing/autopay', router(), async (baseUrl) => {
      state.customers[0].autopay_enabled = true;
      db.transaction = async (fn) => {
        // The first disable committed between this request's pre-read and its lock.
        state.customers[0].autopay_enabled = false;
        return fn((table) => builderFor(table));
      };
      const res = await disable(baseUrl);
      expect(res.status).toBe(200);
      expect(PaymentLifecycleEmail.sendAutopayDisabled).not.toHaveBeenCalled();
    }));
});

describe('PUT /billing/autopay consent scope', () => {
  const router = () => require('../routes/customer-autopay');

  const putAutopay = (baseUrl, body) => fetch(`${baseUrl}/billing/autopay`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  test('enabling with a non-consented method → 409 consent_required, nothing written', () =>
    withServer('/billing/autopay', router(), async (baseUrl) => {
      const res = await putAutopay(baseUrl, { autopay_enabled: true, autopay_payment_method_id: 'pm-hold' });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('consent_required');
      expect(ConsentService.recordConsent).not.toHaveBeenCalled();
      expect(state.customers[0].autopay_enabled).toBe(false);
      expect(state.payment_methods.find((p) => p.id === 'pm-hold').autopay_enabled).toBe(false);
    }));

  test('consent_accepted retry records portal_autopay_enable consent then enrolls', () =>
    withServer('/billing/autopay', router(), async (baseUrl) => {
      const res = await putAutopay(baseUrl, { autopay_enabled: true, autopay_payment_method_id: 'pm-hold', consent_accepted: true });
      expect(res.status).toBe(200);
      expect(ConsentService.recordConsent).toHaveBeenCalledWith(expect.objectContaining({
        customerId: 'cust-1',
        paymentMethodId: 'pm-hold',
        stripePaymentMethodId: 'pm_stripe_hold',
        source: 'portal_autopay_enable',
        methodType: 'card',
      }));
      expect(state.customers[0].autopay_enabled).toBe(true);
      expect(state.payment_methods.find((p) => p.id === 'pm-hold').autopay_enabled).toBe(true);
    }));

  test('already-consented method enables without a fresh consent row', () =>
    withServer('/billing/autopay', router(), async (baseUrl) => {
      ConsentService.hasEnrollmentScopedConsent.mockResolvedValue(true);
      const res = await putAutopay(baseUrl, { autopay_enabled: true, autopay_payment_method_id: 'pm-hold' });
      expect(res.status).toBe(200);
      expect(ConsentService.recordConsent).not.toHaveBeenCalled();
    }));

  test('disabling never consent-checks', () =>
    withServer('/billing/autopay', router(), async (baseUrl) => {
      state.customers[0].autopay_enabled = true;
      const res = await putAutopay(baseUrl, { autopay_enabled: false });
      expect(res.status).toBe(200);
      expect(ConsentService.hasEnrollmentScopedConsent).not.toHaveBeenCalled();
    }));
});

describe('PUT /billing/cards/:id/default consent scope', () => {
  const router = () => require('../routes/billing-v2');

  const putDefault = (baseUrl, id, body) => fetch(`${baseUrl}/billing/cards/${id}/default`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : { body: JSON.stringify({}) }),
  });

  test('carrying Auto Pay onto a non-consented card → 409, flags untouched', () =>
    withServer('/billing', router(), async (baseUrl) => {
      state.payment_methods.find((p) => p.id === 'pm-old').autopay_enabled = true;
      const res = await putDefault(baseUrl, 'pm-hold');
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('consent_required');
      expect(state.payment_methods.find((p) => p.id === 'pm-hold').is_default).toBe(false);
      expect(state.payment_methods.find((p) => p.id === 'pm-old').autopay_enabled).toBe(true);
    }));

  test('consent_accepted retry records portal_set_default consent then carries', () =>
    withServer('/billing', router(), async (baseUrl) => {
      state.payment_methods.find((p) => p.id === 'pm-old').autopay_enabled = true;
      const res = await putDefault(baseUrl, 'pm-hold', { consent_accepted: true });
      expect(res.status).toBe(200);
      expect(ConsentService.recordConsent).toHaveBeenCalledWith(expect.objectContaining({
        customerId: 'cust-1',
        paymentMethodId: 'pm-hold',
        stripePaymentMethodId: 'pm_stripe_hold',
        source: 'portal_set_default',
        methodType: 'card',
      }));
      const hold = state.payment_methods.find((p) => p.id === 'pm-hold');
      expect(hold.is_default).toBe(true);
      expect(hold.autopay_enabled).toBe(true);
      expect(state.customers[0].autopay_payment_method_id).toBe('pm-hold');
    }));

  test('a bare default swap (incumbent not on Auto Pay) never consent-checks', () =>
    withServer('/billing', router(), async (baseUrl) => {
      const res = await putDefault(baseUrl, 'pm-hold');
      expect(res.status).toBe(200);
      expect(ConsentService.hasEnrollmentScopedConsent).not.toHaveBeenCalled();
      expect(state.payment_methods.find((p) => p.id === 'pm-hold').is_default).toBe(true);
    }));
});

test('the two new audit sources are registered in the real consent service', () => {
  const real = jest.requireActual('../services/payment-method-consents');
  expect(real.VALID_SOURCES).toEqual(expect.arrayContaining(['portal_autopay_enable', 'portal_set_default']));
  // And neither is enrollment-excluded — the whole point is that this copy
  // DOES authorize recurring charges.
  expect(real.NON_ENROLLMENT_CONSENT_SOURCES.has('portal_autopay_enable')).toBe(false);
  expect(real.NON_ENROLLMENT_CONSENT_SOURCES.has('portal_set_default')).toBe(false);
});

describe('PUT /billing/autopay clearing the method', () => {
  const router = () => require('../routes/customer-autopay');

  // The client sends autopay_payment_method_id: '' to mean "clear". The
  // column is a uuid — '' must be normalized to null before the write or
  // Postgres rejects the update (500) and the disable never lands.
  test("autopay_payment_method_id '' disables and writes NULL, never ''", () =>
    withServer('/billing/autopay', router(), async (baseUrl) => {
      Object.assign(state.customers[0], { autopay_enabled: true, autopay_payment_method_id: 'pm-old' });
      const res = await fetch(`${baseUrl}/billing/autopay`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autopay_enabled: false, autopay_payment_method_id: '' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.changes).toEqual(expect.arrayContaining(['autopay_enabled', 'autopay_payment_method_id']));
      expect(state.customers[0].autopay_enabled).toBe(false);
      expect(state.customers[0].autopay_payment_method_id).toBeNull();
      expect(state.payment_methods.every((p) => p.autopay_enabled === false)).toBe(true);
    }));
});
