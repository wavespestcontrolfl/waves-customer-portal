/**
 * POST /customers/:id/charge-now with expectedAmount (owner 2026-11-06, "fix"): Customer 360's Charge now confirm
 * shows the rate loaded with the profile, and the route charges the rate stored when the click lands. The page now
 * posts the amount it confirmed. A confirmed amount that no longer matches the stored rate refuses (409
 * rate_changed, naming the current amount) and charges nothing; so does a rate that moves while the request waits
 * on the billing lock and its guards (re-read in the lock). A matching amount charges exactly as before, and a
 * request with no expectedAmount keeps today's behavior. expectedAmount is refused with an explicit amount, and
 * when it is not a positive number.
 *
 * Harness copied from admin-charge-now-past-month.test.js. The clock is pinned to Fri Oct 30, 2026, 11 AM Eastern.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql) => sql);
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/stripe', () => ({
  charge: jest.fn(), chargeOneTime: jest.fn(), chargeMonthly: jest.fn(), retrievePaymentIntent: jest.fn(),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true })),
}));
jest.mock('../services/sms-template-renderer', () => ({
  renderRequiredSmsTemplate: jest.fn(async () => 'receipt body'),
}));
jest.mock('../services/autopay-log', () => ({ logAutopay: jest.fn(async () => undefined) }));
jest.mock('../services/annual-prepay-renewals', () => ({ getActivelyCoveredCustomerIds: jest.fn(async () => new Set()) }));

jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    req.technicianId = 'admin-1';
    req.techRole = 'admin';
    return next();
  },
  requireAdmin: (_req, _res, next) => next(),
}));

const express = require('express');
const db = require('../models/db');
const StripeService = require('../services/stripe');
const router = require('../routes/admin-billing-health');

const CUSTOMER = {
  id: 'cust-1', first_name: 'Pat', phone: null,
  monthly_rate: '89.00', waveguard_tier: 'Silver',
};

function makeQB({ first = null } = {}) {
  const qb = {};
  ['where', 'whereIn', 'whereRaw', 'whereNull', 'whereNot', 'orWhere', 'andWhere', 'select', 'orderBy', 'limit']
    .forEach((m) => {
      qb[m] = jest.fn((...args) => {
        if (typeof args[0] === 'function') args[0].call(qb, qb);
        return qb;
      });
    });
  qb.first = jest.fn(() => Promise.resolve(first));
  qb.pluck = jest.fn(() => Promise.resolve([]));
  qb.update = jest.fn(() => Promise.resolve([]));
  return qb;
}

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/admin', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}
async function withServer(fn) {
  const { server, baseUrl } = appServer();
  try { return await fn(baseUrl); } finally { await new Promise((r) => server.close(r)); }
}

const NOW = new Date('2026-10-30T15:00:00Z');
const post = (baseUrl, body) => fetch(`${baseUrl}/admin/customers/cust-1/charge-now`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

describe('charge-now with the confirmed amount', () => {
  let chargeMock;
  let chargeOneTimeMock;
  let paymentsQB;
  // monthly_rate per customers read, in order: [0] = the route's first read, [1] = the in-lock re-read.
  let customerRates;
  let customerReads;

  beforeEach(() => {
    jest.useFakeTimers({
      now: NOW,
      doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask',
        'setImmediate', 'setInterval', 'setTimeout',
        'clearImmediate', 'clearInterval', 'clearTimeout'],
    });
    jest.clearAllMocks();
    StripeService.charge.mockReset();
    StripeService.chargeOneTime.mockReset();
    chargeMock = StripeService.charge.mockResolvedValue({ id: 'pay-new', status: 'processing', metadata: null });
    chargeOneTimeMock = StripeService.chargeOneTime.mockResolvedValue({ id: 'pay-new', status: 'processing', metadata: null });
    paymentsQB = makeQB({ first: null });
    customerRates = ['89.00', '89.00'];
    customerReads = [];
    db.mockImplementation((table) => {
      if (table === 'customers') {
        const qb = makeQB();
        qb.first = jest.fn((...columns) => {
          const rate = customerRates[Math.min(customerReads.length, customerRates.length - 1)];
          customerReads.push(columns);
          return Promise.resolve({ ...CUSTOMER, monthly_rate: rate });
        });
        return qb;
      }
      if (table === 'payments') return paymentsQB;
      if (table === 'invoices') return makeQB({ first: null });
      if (table === 'stripe_orphan_charges') return makeQB({ first: null });
      throw new Error(`unexpected table ${table}`);
    });
  });
  afterEach(() => { jest.useRealTimers(); });

  test('a confirmed amount that matches the stored rate charges that amount, unchanged otherwise', async () => {
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { billedMonth: '2026-10', expectedAmount: 89 });
      expect(res.status).toBe(200);
      expect(chargeMock).toHaveBeenCalledTimes(1);
      expect(chargeMock).toHaveBeenCalledWith(
        'cust-1', 89, 'Manual charge — WaveGuard Silver',
        expect.objectContaining({ billed_month: '2026-10', type: 'manual_charge' }),
        'autopay_monthly_cust-1_2026-10-30',
        expect.objectContaining({ operatorOverride: true }),
      );
      // the rate is read again inside the billing lock, just before the charge
      expect(customerReads).toEqual([[], ['monthly_rate']]);
    });
  });

  test('cents compare: a stored 89.10 matches a confirmed 89.1', async () => {
    customerRates = ['89.10', '89.10'];
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { expectedAmount: 89.1 });
      expect(res.status).toBe(200);
      expect(chargeMock).toHaveBeenCalledWith('cust-1', 89.1, expect.any(String), expect.any(Object), expect.any(String), expect.any(Object));
    });
  });

  test('a rate edited after the page loaded refuses with the current amount, and charges nothing', async () => {
    customerRates = ['120.00', '120.00'];
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { billedMonth: '2026-10', expectedAmount: 89 });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: 'The monthly rate changed to $120.00 after you confirmed $89.00. Nothing was charged. Check the rate and confirm again.',
        rate_changed: true,
        current_amount: 120,
      });
      expect(chargeMock).not.toHaveBeenCalled();
      expect(chargeOneTimeMock).not.toHaveBeenCalled();
      // decided on the rate re-read inside the billing lock, just before the charge
      expect(customerReads).toEqual([[], ['monthly_rate']]);
      expect(paymentsQB.update).not.toHaveBeenCalled();
    });
  });

  test.each([
    ['with the confirmed amount', { expectedAmount: 89 }, 'The monthly rate changed to $99.00 after you confirmed $89.00. Nothing was charged. Check the rate and confirm again.'],
    ['without one', {}, 'The monthly rate changed to $99.00. Nothing was charged. Check the rate and confirm again.'],
  ])('a rate that moves while the request waits on the lock refuses %s, and charges nothing', async (_label, body, message) => {
    customerRates = ['89.00', '99.00'];
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, body);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: message, rate_changed: true, current_amount: 99 });
      expect(customerReads).toEqual([[], ['monthly_rate']]);
      expect(chargeMock).not.toHaveBeenCalled();
      expect(paymentsQB.update).not.toHaveBeenCalled();
    });
  });

  test('no expectedAmount keeps the plain button: the stored rate charges', async () => {
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, {});
      expect(res.status).toBe(200);
      expect(chargeMock).toHaveBeenCalledWith('cust-1', 89, expect.any(String), expect.any(Object), expect.any(String), expect.any(Object));
    });
  });

  test('an explicit amount still charges that amount and never reads the rate again', async () => {
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { amount: 25 });
      expect(res.status).toBe(200);
      expect(chargeOneTimeMock).toHaveBeenCalledWith('cust-1', 25, expect.any(String), null, expect.any(Object), expect.objectContaining({ operatorOverride: true }));
      expect(customerReads).toHaveLength(1);
      expect(chargeMock).not.toHaveBeenCalled();
    });
  });

  test.each([
    ['with an explicit amount', { amount: 25, expectedAmount: 25 }, /A confirmed amount applies only to the monthly dues charge/],
    ['as a string', { expectedAmount: '89.00' }, /The confirmed amount must be a positive number of dollars/],
    ['as zero', { expectedAmount: 0 }, /The confirmed amount must be a positive number of dollars/],
    ['as a negative number', { expectedAmount: -89 }, /The confirmed amount must be a positive number of dollars/],
  ])('refuses a confirmed amount %s before anything is read or charged', async (_label, body, message) => {
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(message);
      expect(customerReads).toHaveLength(0);
      expect(chargeMock).not.toHaveBeenCalled();
      expect(chargeOneTimeMock).not.toHaveBeenCalled();
    });
  });
});
