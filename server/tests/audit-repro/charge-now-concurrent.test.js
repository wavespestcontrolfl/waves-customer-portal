/**
 * AUDIT REPRO r1-races-1: two concurrent amount-less POST /customers/:id/charge-now
 * requests for the same monthly-lane customer both pass the unlocked
 * already-collected read and both call StripeService.charge (no idempotency key).
 * Expected (if guarded): charge called once, second request 409 already_collected.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql) => sql);
  fn.transaction = jest.fn();
  return fn;
});
jest.mock('../../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../services/stripe', () => ({
  charge: jest.fn(), chargeOneTime: jest.fn(), chargeMonthly: jest.fn(),
}));
jest.mock('../../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true })),
}));
jest.mock('../../services/sms-template-renderer', () => ({
  renderRequiredSmsTemplate: jest.fn(async () => 'receipt body'),
}));
jest.mock('../../services/autopay-log', () => ({ logAutopay: jest.fn(async () => undefined) }));
jest.mock('../../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => { req.technicianId = 'admin-1'; req.techRole = 'admin'; return next(); },
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../../services/billing-lane', () => ({
  MONTHLY_LANE_SQL: '1=1',
  resolveBillingLane: () => ({ mode: 'monthly_membership', source: 'test' }),
}));

const express = require('express');
const db = require('../../models/db');
const StripeService = require('../../services/stripe');
const router = require('../../routes/admin-billing-health');

const CUSTOMER = { id: 'cust-1', first_name: 'Pat', phone: null, monthly_rate: '89.00', waveguard_tier: 'Silver' };

function makeQB({ first = null } = {}) {
  const qb = {};
  ['where', 'whereIn', 'whereRaw', 'whereNull', 'orWhere', 'andWhere', 'select', 'orderBy', 'limit', 'update']
    .forEach((m) => { qb[m] = jest.fn((...args) => { if (typeof args[0] === 'function') args[0].call(qb, qb); return qb; }); });
  qb.first = jest.fn(() => Promise.resolve(first));
  return qb;
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(baseUrl); } finally { await new Promise((r) => server.close(r)); }
}

test('two overlapping amount-less charge-now requests both reach StripeService.charge', async () => {
  // Simulated ledger: the payments read sees whatever charge() has already written.
  const ledger = [];
  db.mockImplementation((table) => {
    if (table === 'customers') return makeQB({ first: CUSTOMER });
    if (table === 'payments') {
      const qb = makeQB();
      qb.first = jest.fn(() => Promise.resolve(ledger[0] || null));
      return qb;
    }
    return makeQB();
  });

  let release;
  const barrier = new Promise((r) => { release = r; });
  let n = 0;
  StripeService.charge.mockImplementation(async (customerId, amount, desc, metadata) => {
    await barrier; // both requests are inside the Stripe round-trip simultaneously
    n += 1;
    const row = { id: `pay-${n}`, customer_id: customerId, status: 'paid', amount, metadata: { billed_month: metadata.billed_month } };
    ledger.push(row);
    return row;
  });

  const results = await withServer(async (baseUrl) => {
    const post = () => fetch(`${baseUrl}/admin/customers/cust-1/charge-now`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    const p = Promise.all([post(), post()]);
    // Let both requests pass the guard and enter charge() before releasing.
    await new Promise((r) => setTimeout(r, 150));
    release();
    const [a, b] = await p;
    return [[a.status, await a.json()], [b.status, await b.json()]];
  });

  console.log(JSON.stringify({ results, chargeCalls: StripeService.charge.mock.calls.length,
    idempotencyKeys: StripeService.charge.mock.calls.map((c) => c[4] ?? null), ledger }, null, 1));

  // The intended contract: one charge, one 409.
  expect(StripeService.charge).toHaveBeenCalledTimes(1);
  expect(results.map((r) => r[0]).sort()).toEqual([200, 409]);
});
