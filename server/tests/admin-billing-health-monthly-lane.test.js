/**
 * admin-billing-health — monthly lane is the LANE, not `monthly_rate > 0`.
 *
 * #3140 residue. Two contracts:
 *
 *  1. POST /customers/:id/charge-now with NO amount means "collect this
 *     month's dues". A customer the lane resolver does NOT put on the
 *     monthly lane (explicit per_visit / annual_prepay / per_application, or
 *     NULL mode with a sentinel tier) has a monthly_rate that is NOT their
 *     dues — the route FAILS CLOSED with 400 and charges nothing. An
 *     explicit amount is still an intentional one-off charge for any lane.
 *
 *  2. Every customers-table population query behind GET /billing-health and
 *     GET /billing-health/at-risk that narrows on monthly_rate > 0 also
 *     applies MONTHLY_LANE_SQL in the same chain — the raw rate shortcut is
 *     what mislabeled 187 accounts as monthly.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql) => sql);
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/stripe', () => ({
  charge: jest.fn(), chargeOneTime: jest.fn(), chargeMonthly: jest.fn(),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true })),
}));
jest.mock('../services/sms-template-renderer', () => ({
  renderRequiredSmsTemplate: jest.fn(async () => 'receipt body'),
}));
jest.mock('../services/autopay-log', () => ({ logAutopay: jest.fn(async () => undefined) }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.technicianId = 'admin-1';
    req.techRole = 'admin';
    return next();
  },
  requireAdmin: (_req, _res, next) => next(),
}));

const express = require('express');
const db = require('../models/db');
const StripeService = require('../services/stripe');
const { MONTHLY_LANE_SQL } = require('../services/billing-lane');
const router = require('../routes/admin-billing-health');

// Recording query builder: every chain method returns the same recorder and
// logs its args; `first` resolves a count row; awaiting the builder itself
// resolves an empty list (the .select(...) queries).
function makeRecorder({ first = { n: 0 }, rows = [] } = {}) {
  const calls = [];
  const rec = {};
  const methods = [
    'where', 'whereIn', 'whereNotIn', 'whereRaw', 'whereNull', 'whereNotNull', 'orWhere',
    'andWhere', 'select', 'orderBy', 'limit', 'count', 'join', 'leftJoin', 'modify', 'groupBy',
  ];
  for (const m of methods) {
    rec[m] = jest.fn((...args) => {
      calls.push([m, ...args]);
      if (typeof args[0] === 'function') args[0].call(rec, rec);
      return rec;
    });
  }
  rec.first = jest.fn(() => Promise.resolve(first));
  rec.catch = jest.fn(() => Promise.resolve(first));
  rec.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  rec.calls = calls;
  rec.has = (method, ...args) => calls.some((c) => c[0] === method && args.every((a, i) => c[i + 1] === a));
  return rec;
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

// Synthetic fixtures only — no real customer data.
const PER_VISIT_EXPLICIT = {
  id: 'cust-pv', first_name: 'Test', phone: null,
  monthly_rate: '89.00', waveguard_tier: 'Silver', billing_mode: 'per_visit',
};
const PREPAY_EXPLICIT = {
  id: 'cust-ap', first_name: 'Test', phone: null,
  monthly_rate: '120.00', waveguard_tier: 'Gold', billing_mode: 'annual_prepay',
};
const SENTINEL_TIER_NULL_MODE = {
  id: 'cust-cm', first_name: 'Test', phone: null,
  monthly_rate: '250.00', waveguard_tier: 'Commercial', billing_mode: null,
};
const INFERRED_MONTHLY = {
  id: 'cust-mm', first_name: 'Test', phone: null,
  monthly_rate: '89.00', waveguard_tier: 'Silver', billing_mode: null,
};

describe('POST /customers/:id/charge-now fails closed off the monthly lane', () => {
  let chargeMock;
  let chargeOneTimeMock;
  let customer;

  beforeEach(() => {
    jest.clearAllMocks();
    StripeService.charge.mockReset();
    StripeService.chargeOneTime.mockReset();
    StripeService.chargeMonthly.mockReset();
    chargeMock = StripeService.charge.mockResolvedValue({ id: 'pay-new', metadata: null });
    chargeOneTimeMock = StripeService.chargeOneTime.mockResolvedValue({ id: 'pay-new', metadata: null });
    db.mockImplementation((table) => {
      if (table === 'customers') return makeRecorder({ first: customer });
      if (table === 'payments') return makeRecorder({ first: null });
      throw new Error(`unexpected table ${table}`);
    });
  });

  async function postChargeNow(baseUrl, id, body) {
    return fetch(`${baseUrl}/admin/customers/${id}/charge-now`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
  }

  test.each([
    ['explicit per_visit', PER_VISIT_EXPLICIT, 'per_visit', 'explicit'],
    ['explicit annual_prepay', PREPAY_EXPLICIT, 'annual_prepay', 'explicit'],
    ['NULL mode + sentinel tier (inferred per_visit)', SENTINEL_TIER_NULL_MODE, 'per_visit', 'inferred'],
  ])('%s: amount-less charge-now 400s and charges NOTHING', async (_label, row, mode, source) => {
    customer = row;
    await withServer(async (baseUrl) => {
      const res = await postChargeNow(baseUrl, row.id, {});
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.billing_mode).toBe(mode);
      expect(body.billing_mode_source).toBe(source);
      expect(body.error).toMatch(/not on the monthly lane/);
      expect(body.error).toMatch(/explicit amount/);
      expect(chargeMock).not.toHaveBeenCalled();
      expect(chargeOneTimeMock).not.toHaveBeenCalled();
      expect(StripeService.chargeMonthly).not.toHaveBeenCalled();
    });
  });

  test('an explicit amount is still an intentional one-off charge for a per-visit customer', async () => {
    customer = PER_VISIT_EXPLICIT;
    await withServer(async (baseUrl) => {
      const res = await postChargeNow(baseUrl, customer.id, { amount: 40, description: 'One-off add-on' });
      expect(res.status).toBe(200);
      expect(chargeOneTimeMock).toHaveBeenCalledWith(customer.id, 40, 'One-off add-on', null, { initiated_by: 'machine' });
      expect(chargeMock).not.toHaveBeenCalled();
    });
  });

  test('an inferred monthly member (NULL mode, real tier, rate) still collects dues', async () => {
    customer = INFERRED_MONTHLY;
    await withServer(async (baseUrl) => {
      const res = await postChargeNow(baseUrl, customer.id, {});
      expect(res.status).toBe(200);
      expect(chargeMock).toHaveBeenCalledWith(customer.id, 89, expect.any(String), expect.objectContaining({
        type: 'manual_charge',
        billed_month: expect.stringMatching(/^\d{4}-\d{2}$/),
      }));
      expect(chargeOneTimeMock).not.toHaveBeenCalled();
    });
  });
});

describe('billing-health population queries select the monthly LANE', () => {
  let customersRecorders;

  beforeEach(() => {
    jest.clearAllMocks();
    StripeService.charge.mockReset();
    StripeService.chargeOneTime.mockReset();
    StripeService.chargeMonthly.mockReset();
    customersRecorders = [];
    db.mockImplementation((table) => {
      const rec = makeRecorder();
      if (String(table).startsWith('customers')) customersRecorders.push(rec);
      return rec;
    });
  });

  const hasRatePredicate = (rec) =>
    rec.calls.some((c) => c[0] === 'where' && /^(c\.)?monthly_rate$/.test(String(c[1])) && c[2] === '>' && c[3] === 0);
  const hasLaneSql = (rec) => rec.calls.some((c) => c[0] === 'whereRaw' && c[1] === MONTHLY_LANE_SQL);

  test('GET /billing-health: every monthly_rate > 0 population query also applies MONTHLY_LANE_SQL', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/billing-health`);
      expect(res.status).toBe(200);
    });
    const rateScoped = customersRecorders.filter(hasRatePredicate);
    // billable, enabled, disabled, paused, chargeable, unchargeable, noMethod
    expect(rateScoped).toHaveLength(7);
    for (const rec of rateScoped) expect(hasLaneSql(rec)).toBe(true);
  });

  test('GET /billing-health/at-risk: the no-payment-method list is lane-scoped', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/billing-health/at-risk`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ no_payment_method: [], in_retry: [], escalated: [] });
    });
    const rateScoped = customersRecorders.filter(hasRatePredicate);
    expect(rateScoped).toHaveLength(1);
    expect(hasLaneSql(rateScoped[0])).toBe(true);
  });
});
