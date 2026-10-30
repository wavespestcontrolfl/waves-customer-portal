/**
 * POST /customers/:id/charge-now with billedMonth (owner 2026-10-30, "BUILD"): Customer 360's Charge now can
 * collect an EARLIER month's dues — e.g. a month whose bank payment was canceled — stamped with that month, the
 * billed_month every dues-coverage reader trusts (the cron, the retry sweep, plan-visit completion). Every guard on
 * the monthly path reads the picked month; the key and description name it; the current month picked is the plain
 * button unchanged; a future month, a month older than the window, a bad format, or a month with an explicit
 * amount is refused before anything charges. An earlier month an annual prepay covered is refused, a month whose
 * parked attempt may still settle at Stripe is refused, and a collected month's failed attempts stop counting as
 * owed (one autopay_log event each).
 *
 * Harness copied from admin-charge-now-already-collected.test.js. The clock is pinned to Fri Oct 30, 2026,
 * 11 AM Eastern, so the window is 2026-10, 2026-09 and 2026-08.
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
// B10: staff-ordered charge-now passes the operator override (exempt from the
// collections dispute-hold guard) plus an audit trail naming the admin + route.
const CHARGE_NOW_OVERRIDE = expect.objectContaining({
  operatorOverride: true,
  overrideTrail: expect.objectContaining({ actorId: 'admin-1', route: 'admin_charge_now' }),
});

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
const logger = require('../services/logger');
const { logAutopay } = require('../services/autopay-log');
const { getActivelyCoveredCustomerIds } = require('../services/annual-prepay-renewals');
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
        // Grouped wheres: run the callback against this same recorder so
        // nested whereRaw/andWhere calls are visible to assertions.
        if (typeof args[0] === 'function') args[0].call(qb, qb);
        return qb;
      });
    });
  qb.first = jest.fn(() => Promise.resolve(first));
  qb.update = jest.fn(() => Promise.resolve([{ id: 'pay-old' }]));
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

describe('charge-now with a picked month', () => {
  let chargeMock;
  let chargeOneTimeMock;
  let paymentsQB;
  let invoicesQB;

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
    chargeOneTimeMock = StripeService.chargeOneTime.mockResolvedValue({ id: 'pay-new', metadata: null });
    getActivelyCoveredCustomerIds.mockResolvedValue(new Set());
    paymentsQB = makeQB({ first: null });
    invoicesQB = makeQB({ first: null });
    db.mockImplementation((table) => {
      if (table === 'customers') return makeQB({ first: CUSTOMER });
      if (table === 'payments') return paymentsQB;
      if (table === 'invoices') return invoicesQB;
      if (table === 'stripe_orphan_charges') return makeQB({ first: null });
      throw new Error(`unexpected table ${table}`);
    });
  });
  afterEach(() => { jest.useRealTimers(); });

  test('September picked: every monthly guard reads September; the charge is stamped, keyed and described as September', async () => {
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { billedMonth: '2026-09' });
      expect(res.status).toBe(200);
      expect(paymentsQB.whereRaw).toHaveBeenCalledWith("metadata->>'billed_month' = ?", ['2026-09']);
      expect(paymentsQB.whereRaw).not.toHaveBeenCalledWith("metadata->>'billed_month' = ?", ['2026-10']);
      expect(paymentsQB.andWhere).toHaveBeenCalledWith('payment_date', '>=', '2026-09-01');
      expect(paymentsQB.andWhere).toHaveBeenCalledWith('payment_date', '<=', '2026-09-30');
      // prepay coverage is read on the day September's dues were due (no billing_day = the 1st)
      expect(getActivelyCoveredCustomerIds).toHaveBeenCalledWith('2026-09-01', db, { throwOnError: true });
      expect(chargeMock).toHaveBeenCalledTimes(1);
      expect(chargeMock).toHaveBeenCalledWith(
        'cust-1', 89, 'Manual charge — WaveGuard Silver — September 2026 dues',
        expect.objectContaining({ billed_month: '2026-09', type: 'manual_charge' }),
        'autopay_monthly_cust-1_2026-10-30_2026-09',
        CHARGE_NOW_OVERRIDE,
      );
    });
  });

  test("this month picked is the plain button: same key, stamp and description, and no prepay read (today's lane decides)", async () => {
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { billedMonth: '2026-10' });
      expect(res.status).toBe(200);
      expect(getActivelyCoveredCustomerIds).not.toHaveBeenCalled();
      expect(chargeMock).toHaveBeenCalledWith(
        'cust-1', 89, 'Manual charge — WaveGuard Silver',
        expect.objectContaining({ billed_month: '2026-10' }),
        'autopay_monthly_cust-1_2026-10-30',
        CHARGE_NOW_OVERRIDE,
      );
    });
  });

  test("the collected month's failed attempts stop counting as owed: resolved against the new payment, one event each", async () => {
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { billedMonth: '2026-09' });
      expect(res.status).toBe(200);
      expect(paymentsQB.where).toHaveBeenCalledWith({ customer_id: 'cust-1', status: 'failed' });
      expect(paymentsQB.whereNot).toHaveBeenCalledWith({ id: 'pay-new' });
      expect(paymentsQB.update).toHaveBeenCalledTimes(1);
      expect(paymentsQB.update).toHaveBeenCalledWith(expect.objectContaining({
        next_retry_at: null,
        superseded_by_payment_id: 'pay-new',
      }), ['id']);
      // the resolve runs after the charge, never before it
      expect(chargeMock.mock.invocationCallOrder[0]).toBeLessThan(paymentsQB.update.mock.invocationCallOrder[0]);
      // the event the retry sweep writes for the same resolution, naming the payment that collected the month
      expect(logAutopay).toHaveBeenCalledWith('cust-1', 'skipped_already_paid', {
        paymentId: 'pay-old',
        details: expect.objectContaining({ source: 'manual_charge', collected_by_payment_id: 'pay-new', billed_month: '2026-09', ladder_stopped: true }),
      });
    });
  });

  test("a month whose parked attempt may still settle at Stripe is refused, and nothing charges", async () => {
    // only the parked-attempt lookup finds a row; every other payments lookup finds none
    paymentsQB.first.mockImplementation(async (column) => (column === 'stripe_payment_intent_id' ? { stripe_payment_intent_id: 'pi_parked' } : null));
    StripeService.retrievePaymentIntent.mockResolvedValue({ id: 'pi_parked', status: 'requires_action', next_action: { type: 'verify_with_microdeposits' } });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { billedMonth: '2026-09' });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ live_payment_intent: 'pi_parked', error: expect.stringMatching(/^2026-09 has an earlier charge still waiting/) });
      expect(paymentsQB.whereRaw).toHaveBeenCalledWith("metadata->>'billed_month' = ? AND COALESCE(metadata->>'requires_action', '') = 'true'", ['2026-09']);
      expect(chargeMock).not.toHaveBeenCalled();
      expect(paymentsQB.update).not.toHaveBeenCalled();
    });
  });

  test('a parked attempt Stripe shows canceled does not block: the month charges and the parked row is resolved', async () => {
    paymentsQB.first.mockImplementation(async (column) => (column === 'stripe_payment_intent_id' ? { stripe_payment_intent_id: 'pi_parked' } : null));
    StripeService.retrievePaymentIntent.mockResolvedValue({ id: 'pi_parked', status: 'canceled' });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { billedMonth: '2026-09' });
      expect(res.status).toBe(200);
      expect(chargeMock).toHaveBeenCalledTimes(1);
      expect(paymentsQB.update).toHaveBeenCalledTimes(1);
    });
  });

  test('a failed resolve write leaves the charge standing: 200 and a logged error', async () => {
    paymentsQB.update.mockRejectedValueOnce(new Error('db down'));
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { billedMonth: '2026-09' });
      expect(res.status).toBe(200);
      expect((await res.json()).payment).toMatchObject({ id: 'pay-new' });
      expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/could not resolve 2026-09 failed attempts/));
    });
  });

  test("an earlier month inside the customer's annual prepay is refused, and nothing charges", async () => {
    getActivelyCoveredCustomerIds.mockResolvedValue(new Set(['cust-1']));
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { billedMonth: '2026-08' });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ prepay_covered: true, error: expect.stringMatching(/^2026-08 was covered by this customer's annual prepay/) });
      expect(chargeMock).not.toHaveBeenCalled();
    });
  });

  test('a picked month that is already collected refuses with that month named, and charges nothing', async () => {
    paymentsQB.first.mockResolvedValue({ id: 'pay-sep' });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { billedMonth: '2026-09' });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toMatch(/^2026-09 is already collected for this customer \(payment pay-sep\)/);
      expect(chargeMock).not.toHaveBeenCalled();
    });
  });

  test.each([
    ['a future month', { billedMonth: '2026-11' }, /Pick this month or one of the previous 2: 2026-10, 2026-09, 2026-08\./],
    ['a month older than the window', { billedMonth: '2026-07' }, /Pick this month or one of the previous 2/],
    ['a bad format', { billedMonth: '2026-9' }, /Pick this month or one of the previous 2/],
    ['a month with an explicit amount', { billedMonth: '2026-09', amount: 25 }, /A month applies only to the monthly dues charge/],
  ])('refuses %s before anything charges', async (_label, body, message) => {
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(message);
      expect(chargeMock).not.toHaveBeenCalled();
      expect(chargeOneTimeMock).not.toHaveBeenCalled();
    });
  });
});
