/**
 * AUDIT REPRO r1-races-1 — POST /customers/:id/charge-now has no per-customer
 * serialization: two overlapping amount-less requests both pass the
 * already-collected SELECT and both call StripeService.charge().
 *
 * Expected (correct) behaviour asserted here: for two concurrent {} posts
 * on the same monthly-lane customer, charge() is invoked exactly once and
 * exactly one request 409s already_collected.
 *
 * Setup copied from tests/admin-charge-now-already-collected.test.js.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql) => sql);
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
  adminAuthenticate: (req, res, next) => {
    req.technicianId = 'admin-1';
    req.techRole = 'admin';
    return next();
  },
  requireAdmin: (_req, _res, next) => next(),
}));

const express = require('express');
const db = require('../../models/db');
const StripeService = require('../../services/stripe');
const router = require('../../routes/admin-billing-health');

const CUSTOMER = {
  id: 'cust-1', first_name: 'Pat', phone: null,
  monthly_rate: '89.00', waveguard_tier: 'Silver',
};

// Simulated payments ledger: charge() appends a paid+billed_month row; the
// route's already-collected SELECT reads whatever is there at that moment.
// This mirrors real PG: the read is not locked against the concurrent write.
const ledger = [];

function makeQB({ first = null } = {}) {
  const qb = {};
  ['where', 'whereIn', 'whereRaw', 'whereNull', 'orWhere', 'andWhere', 'select', 'orderBy', 'limit']
    .forEach((m) => {
      qb[m] = jest.fn((...args) => {
        if (typeof args[0] === 'function') args[0].call(qb, qb);
        return qb;
      });
    });
  qb.first = jest.fn(() => Promise.resolve(typeof first === 'function' ? first() : first));
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

describe('AUDIT r1-races-1: concurrent charge-now must be serialized per customer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ledger.length = 0;
    let n = 0;
    // Stripe round-trip barrier: each charge() call waits ~150ms (the
    // PaymentIntent create + confirm) before writing its ledger row.
    StripeService.charge.mockImplementation(async (customerId, amount, desc, metadata) => {
      await new Promise((r) => setTimeout(r, 150));
      const row = { id: `pay-${++n}`, customer_id: customerId, status: 'paid', amount: String(amount), metadata };
      ledger.push(row);
      return row;
    });
    db.mockImplementation((table) => {
      if (table === 'customers') return makeQB({ first: CUSTOMER });
      if (table === 'payments') return makeQB({ first: () => ledger[0] || null });
      // The sibling-unresolved-outcome check (retry-collectibility.js)
      // reads this table too — no fixtures here, so it always clears.
      if (table === 'stripe_orphan_charges') return makeQB({ first: null });
      throw new Error(`unexpected table ${table}`);
    });
  });

  test('two overlapping {} posts -> charge() once, one 200 + one 409 already_collected', async () => {
    await withServer(async (baseUrl) => {
      const post = () => fetch(`${baseUrl}/admin/customers/cust-1/charge-now`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      const [a, b] = await Promise.all([post(), post()]);
      const statuses = [a.status, b.status].sort();
      const bodies = await Promise.all([a.json(), b.json()]);

      // Diagnostics for the audit log.
       
      console.log('statuses=', statuses, 'charge calls=', StripeService.charge.mock.calls.length,
        'ledger rows stamped billed_month=', ledger.map((r) => r.metadata && r.metadata.billed_month));

      expect(StripeService.charge).toHaveBeenCalledTimes(1);
      expect(statuses).toEqual([200, 409]);
      expect(bodies.some((x) => x.already_collected === true)).toBe(true);
      expect(ledger).toHaveLength(1);
    });
  });
});
