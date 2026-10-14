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
  let invoicesQB;

  beforeEach(() => {
    jest.clearAllMocks();
    StripeService.charge.mockReset();
    StripeService.chargeOneTime.mockReset();
    StripeService.chargeMonthly.mockReset();
    chargeMock = StripeService.charge.mockResolvedValue({ id: 'pay-new', metadata: null });
    chargeOneTimeMock = StripeService.chargeOneTime.mockResolvedValue({ id: 'pay-new', metadata: null });
    paymentsQB = makeQB({ first: null });
    invoicesQB = makeQB({ first: null });
    db.mockImplementation((table) => {
      if (table === 'customers') return makeQB({ first: CUSTOMER });
      if (table === 'payments') return paymentsQB;
      // B08: the live completion-minted membership-dues invoice lookup
      // (billing-lane findLiveStampedDuesInvoice).
      if (table === 'invoices') return invoicesQB;
      // The sibling-unresolved-outcome check (retry-collectibility.js)
      // reads this table too — no fixtures here, so it always clears.
      if (table === 'stripe_orphan_charges') return makeQB({ first: null });
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

  test('guard dedupes on the ET month key — not UTC — at the ET/UTC month boundary', async () => {
    // 2026-08-01T02:30Z is still 2026-07-31 22:30 in ET: the month of
    // obligation is July. A UTC-keyed regression would check/stamp August,
    // miss the cron's July billed_month stamp, and double-charge the month.
    jest.useFakeTimers({
      now: new Date('2026-08-01T02:30:00Z'),
      doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask',
        'setImmediate', 'setInterval', 'setTimeout',
        'clearImmediate', 'clearInterval', 'clearTimeout'],
    });
    try {
      paymentsQB.first.mockResolvedValue({ id: 'pay-cron' });
      await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/admin/customers/cust-1/charge-now`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        expect(res.status).toBe(409);
        expect(paymentsQB.whereIn).toHaveBeenCalledWith('status', ['paid', 'processing']);
        // The grouped where-callback runs against the same recorded builder,
        // so the metadata-first clause lands in whereRaw's call list — assert
        // the BOUND month value, not just the SQL text.
        expect(paymentsQB.whereRaw).toHaveBeenCalledWith("metadata->>'billed_month' = ?", ['2026-07']);
        // The legacy unstamped fallback window must span the same ET month.
        expect(paymentsQB.andWhere).toHaveBeenCalledWith('payment_date', '>=', '2026-07-01');
        expect(paymentsQB.andWhere).toHaveBeenCalledWith('payment_date', '<=', '2026-07-31');
      });
    } finally {
      jest.useRealTimers();
    }
  });

  test('charges normally when the month is not collected yet, stamping billed_month', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/customers/cust-1/charge-now`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      expect(res.status).toBe(200);
      // 5th arg: the SAME autopay_monthly_<cid>_<ET date> idempotency key
      // chargeMonthly() defaults to (ADMIN-BUG-R11 fix) — a duplicate that
      // slips past the in-process charge-now lock (a genuine second Railway
      // instance) still replays the SAME PaymentIntent as that day's cron
      // run instead of minting a new one.
      expect(chargeMock).toHaveBeenCalledWith('cust-1', 89, expect.any(String), expect.objectContaining({
        billed_month: expect.stringMatching(/^\d{4}-\d{2}$/),
        initiated_by: 'machine',
      }), expect.stringMatching(/^autopay_monthly_cust-1_\d{4}-\d{2}-\d{2}$/), CHARGE_NOW_OVERRIDE);
    });
  });

  test('a prior failed attempt today (e.g. a cron decline) gets a fresh attempt-scoped key and still succeeds', async () => {
    // .first() calls on 'payments', in order: (0) the already-collected
    // check — no paid/processing row; (1) the sibling-unresolved-outcome
    // check — no ambiguous sibling; (2) the latest-failed-attempt lookup
    // for key derivation — simulating a decline recorded earlier today (by
    // the cron or a prior click) whose OWN idempotency key was the bare
    // autopay_monthly_<cid>_<date> one.
    let call = 0;
    const priorFailedRow = {
      id: 'pay-failed-1',
      status: 'failed',
      metadata: JSON.stringify({ idempotency_key: 'autopay_monthly_cust-1_2026-09-23', billed_month: '2026-09' }),
    };
    paymentsQB.first = jest.fn(() => Promise.resolve(call++ === 2 ? priorFailedRow : null));
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/customers/cust-1/charge-now`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      expect(res.status).toBe(200);
      // A FRESH key (never used for the bare-key first attempt) — Stripe
      // treats it as a brand new charge instead of rejecting a replay with
      // different parameters (manual_charge vs. the cron's monthly_autopay).
      expect(chargeMock).toHaveBeenCalledWith('cust-1', 89, expect.any(String), expect.any(Object),
        expect.stringMatching(/^autopay_monthly_cust-1_\d{4}-\d{2}-\d{2}_r1$/), CHARGE_NOW_OVERRIDE);
    });
  });

  test('a second same-day failed attempt advances the key suffix to r2', async () => {
    let call = 0;
    const priorFailedRow = {
      id: 'pay-failed-2',
      status: 'failed',
      metadata: JSON.stringify({ idempotency_key: 'autopay_monthly_cust-1_2026-09-23_r1', billed_month: '2026-09' }),
    };
    paymentsQB.first = jest.fn(() => Promise.resolve(call++ === 2 ? priorFailedRow : null));
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/customers/cust-1/charge-now`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      expect(res.status).toBe(200);
      expect(chargeMock).toHaveBeenCalledWith('cust-1', 89, expect.any(String), expect.any(Object),
        expect.stringMatching(/^autopay_monthly_cust-1_\d{4}-\d{2}-\d{2}_r2$/), CHARGE_NOW_OVERRIDE);
    });
  });

  // B08: a completion-minted dues invoice (membership_dues_month) is the
  // month's bill. Its payment carries invoice_id, not billed_month, so the
  // payments check cannot see it — the shared stamped-invoice lookup does.
  test.each([
    ['sent', /still open — collect that invoice instead/],
    ['paid', /which is paid — nothing is owed/],
  ])('409s an amount-less charge when a %s stamped dues invoice already bills the month (no Stripe call)', async (status, message) => {
    invoicesQB.first.mockResolvedValue({ id: 'inv-dues', status, invoice_number: 'WPC-2026-0042', scheduled_service_id: 'visit-1' });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/customers/cust-1/charge-now`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body).toMatchObject({ already_collected: true, payment_id: null, dues_invoice_id: 'inv-dues' });
      expect(body.error).toContain('WPC-2026-0042');
      expect(body.error).toMatch(message);
      expect(chargeMock).not.toHaveBeenCalled();
      expect(chargeOneTimeMock).not.toHaveBeenCalled();
      expect(logAutopay).toHaveBeenCalledWith('cust-1', 'skipped_already_paid', expect.objectContaining({
        details: expect.objectContaining({ source: 'manual_charge', dues_invoice_id: 'inv-dues' }),
      }));
    });
  });

  test('the stamped-invoice lookup excludes void / refunded / canceled invoices, so a voided dues invoice charges', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/customers/cust-1/charge-now`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      expect(res.status).toBe(200);
      expect(chargeMock).toHaveBeenCalled();
      const statusClause = invoicesQB.whereRaw.mock.calls.find(([sql]) => /status NOT IN/.test(sql));
      expect(statusClause[1]).toEqual(expect.arrayContaining(['void', 'refunded', 'canceled', 'cancelled']));
    });
  });

  test('an explicit amount never consults the dues invoice (intentional extra charge)', async () => {
    invoicesQB.first.mockResolvedValue({ id: 'inv-dues', status: 'sent', invoice_number: 'WPC-2026-0042' });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/customers/cust-1/charge-now`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: 25 }),
      });
      expect(res.status).toBe(200);
      expect(chargeOneTimeMock).toHaveBeenCalled();
      expect(invoicesQB.first).not.toHaveBeenCalled();
    });
  });

  test('the payments-based already-collected response is unchanged and wins before the invoice lookup', async () => {
    paymentsQB.first.mockResolvedValue({ id: 'pay-cron' });
    invoicesQB.first.mockResolvedValue({ id: 'inv-dues', status: 'sent', invoice_number: 'WPC-2026-0042' });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/customers/cust-1/charge-now`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ already_collected: true, payment_id: 'pay-cron' });
      expect(invoicesQB.first).not.toHaveBeenCalled();
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
      expect(chargeOneTimeMock).toHaveBeenCalledWith('cust-1', 25, 'One-off flea add-on', null, { initiated_by: 'machine' }, CHARGE_NOW_OVERRIDE);
    });
  });

  test.each(['processing', 'paid'])('%s returns the ledger amount and only receipts settlement', async status => {
    const original = CUSTOMER.phone;
    CUSTOMER.phone = '+19415550101';
    chargeMock.mockResolvedValue({ id: 'pay-new', status, amount: '91.58', metadata: null });
    try {
      await withServer(async baseUrl => {
        const res = await fetch(`${baseUrl}/admin/customers/cust-1/charge-now`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        expect(res.status).toBe(200);
        expect((await res.json()).payment).toMatchObject({ status, amount: '91.58' });
        expect(logAutopay).toHaveBeenCalledWith('cust-1', status === 'paid' ? 'manual_charge' : 'manual_charge_processing', expect.objectContaining({ amountCents: 9158 }));
        const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
        expect(sendCustomerMessage).toHaveBeenCalledTimes(status === 'paid' ? 1 : 0);
      });
    } finally { CUSTOMER.phone = original; }
  });

});
