/**
 * POST /customers/:id/charge-now — already-collected-this-month guard.
 *
 * The Customer 360 "Charge now" button posts {} (= collect this month's
 * monthly rate). It stamps metadata.billed_month so the cron dedupes
 * against it — but nothing guarded the reverse direction: clicking the
 * button AFTER the 10AM cron already collected charged the month twice.
 *
 * Contract: an amount-less charge-now runs the cron's exact dedupe
 * (metadata.billed_month match, plus the legacy unstamped
 * payment_date-window + 'WaveGuard Monthly' marker) and 409s when the
 * month is already collected. An explicit amount skips the guard — that
 * is the operator intentionally charging something additional.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql) => sql);
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/payment-router', () => ({ getServiceForCustomer: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true })),
}));
jest.mock('../services/sms-template-renderer', () => ({
  renderRequiredSmsTemplate: jest.fn(async () => 'receipt body'),
}));
jest.mock('../services/autopay-log', () => ({ logAutopay: jest.fn(async () => undefined) }));
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
const PaymentRouter = require('../services/payment-router');
const { logAutopay } = require('../services/autopay-log');
const router = require('../routes/admin-billing-health');

const CUSTOMER = {
  id: 'cust-1', first_name: 'Pat', phone: null,
  monthly_rate: '89.00', waveguard_tier: 'Silver',
};

function makeQB({ first = null } = {}) {
  const qb = {};
  ['where', 'whereIn', 'whereRaw', 'whereNull', 'orWhere', 'andWhere', 'select', 'orderBy', 'limit']
    .forEach((m) => {
      qb[m] = jest.fn((...args) => {
        // Grouped wheres: run the callback against this same recorder so
        // nested whereRaw/andWhere calls are visible to assertions.
        if (typeof args[0] === 'function') args[0].call(qb, qb);
        return qb;
      });
    });
  qb.first = jest.fn(() => Promise.resolve(first));
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

describe('charge-now already-collected guard', () => {
  let chargeMock;
  let chargeOneTimeMock;
  let paymentsQB;

  beforeEach(() => {
    jest.clearAllMocks();
    chargeMock = jest.fn(async () => ({ id: 'pay-new', metadata: null }));
    chargeOneTimeMock = jest.fn(async () => ({ id: 'pay-new', metadata: null }));
    PaymentRouter.getServiceForCustomer.mockResolvedValue({
      charge: chargeMock,
      chargeOneTime: chargeOneTimeMock,
    });
    paymentsQB = makeQB({ first: null });
    db.mockImplementation((table) => {
      if (table === 'customers') return makeQB({ first: CUSTOMER });
      if (table === 'payments') return paymentsQB;
      throw new Error(`unexpected table ${table}`);
    });
  });

  test('409s an amount-less charge when this month is already collected', async () => {
    paymentsQB.first.mockResolvedValue({ id: 'pay-cron' });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/customers/cust-1/charge-now`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.already_collected).toBe(true);
      expect(body.payment_id).toBe('pay-cron');
      expect(chargeMock).not.toHaveBeenCalled();
      expect(chargeOneTimeMock).not.toHaveBeenCalled();
      expect(logAutopay).toHaveBeenCalledWith('cust-1', 'skipped_already_paid', expect.objectContaining({
        paymentId: 'pay-cron',
      }));
    });
  });

  test('guard queries the cron dedupe shape (billed_month metadata-first)', async () => {
    paymentsQB.first.mockResolvedValue({ id: 'pay-cron' });
    await withServer(async (baseUrl) => {
      await fetch(`${baseUrl}/admin/customers/cust-1/charge-now`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      expect(paymentsQB.whereIn).toHaveBeenCalledWith('status', ['paid', 'processing']);
      const monthKey = new Date().toISOString().slice(0, 7);
      // The grouped where-callback runs against the same recorded builder,
      // so the metadata-first clause lands in whereRaw's call list.
      const rawCalls = paymentsQB.whereRaw.mock.calls.map((c) => c[0]);
      expect(rawCalls).toContain("metadata->>'billed_month' = ?");
      void monthKey;
    });
  });

  test('charges normally when the month is not collected yet, stamping billed_month', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/customers/cust-1/charge-now`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      expect(res.status).toBe(200);
      expect(chargeMock).toHaveBeenCalledWith('cust-1', 89, expect.any(String), expect.objectContaining({
        billed_month: expect.stringMatching(/^\d{4}-\d{2}$/),
      }));
    });
  });

  test('an explicit amount skips the guard (intentional extra charge)', async () => {
    paymentsQB.first.mockResolvedValue({ id: 'pay-cron' });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/customers/cust-1/charge-now`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 25, description: 'One-off flea add-on' }),
      });
      expect(res.status).toBe(200);
      expect(chargeOneTimeMock).toHaveBeenCalledWith('cust-1', 25, 'One-off flea add-on');
    });
  });
});
