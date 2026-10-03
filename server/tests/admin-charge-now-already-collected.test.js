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
jest.mock('../services/autopay-sca-parked', () => ({ settleParkedForPaidPayment: jest.fn(async () => []) }));
const mockCloseAdminAlertKeys = jest.fn(async () => 1);
jest.mock('../services/admin-alert-episodes', () => ({ closeAdminAlertKeys: (...a) => mockCloseAdminAlertKeys(...a) }));
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
const { settleParkedForPaidPayment } = require('../services/autopay-sca-parked');
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
    StripeService.charge.mockReset();
    StripeService.chargeOneTime.mockReset();
    StripeService.chargeMonthly.mockReset();
    chargeMock = StripeService.charge.mockResolvedValue({ id: 'pay-new', metadata: null });
    chargeOneTimeMock = StripeService.chargeOneTime.mockResolvedValue({ id: 'pay-new', metadata: null });
    paymentsQB = makeQB({ first: null });
    db.mockImplementation((table) => {
      if (table === 'customers') return makeQB({ first: CUSTOMER });
      if (table === 'payments') return paymentsQB;
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
      // B16: the already-collected path hands that paid payment to the shared cleanup step
      expect(settleParkedForPaidPayment).toHaveBeenCalledWith(expect.objectContaining({ id: 'pay-cron' }));
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

  // B16: the office follows the "autopay parked on card authentication" alert and collects the
  // month with an amount-less Charge now. A payment that is paid at once runs the SAME shared
  // step the Stripe succeeded hook runs for an ACH replacement that settles later (which
  // recognizes monthly dues by the persisted billed_month and resolves the parked rows).
  describe('B16: a paid Charge now runs the shared paid-payment step', () => {
    const post = (baseUrl, body = '{}') => fetch(`${baseUrl}/admin/customers/cust-1/charge-now`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });

    test('paid: hands the recorded payment to the shared step', async () => {
      const row = { id: 'pay-new', customer_id: 'cust-1', status: 'paid', amount: '89.00', metadata: JSON.stringify({ billed_month: '2026-10' }) };
      chargeMock.mockResolvedValue(row);
      await withServer(async (baseUrl) => { expect((await post(baseUrl)).status).toBe(200); });
      expect(settleParkedForPaidPayment).toHaveBeenCalledTimes(1);
      expect(settleParkedForPaidPayment).toHaveBeenCalledWith(row);
    });

    test('a bank payment still processing is not collected money: the step is NOT run here (the succeeded webhook runs it at settlement)', async () => {
      chargeMock.mockResolvedValue({ id: 'pay-new', status: 'processing', amount: '89.00', metadata: null });
      await withServer(async (baseUrl) => { expect((await post(baseUrl)).status).toBe(200); });
      expect(settleParkedForPaidPayment).not.toHaveBeenCalled();
    });
  });

  // B16: a webhook redelivery is skipped by the event-id dedupe, and a second Charge now used to
  // answer already_collected before reaching any cleanup. So cleanup that failed when the month
  // was collected (here: the alert close threw after the supersede committed) is retried by
  // pressing Charge now again, which now reconciles from the already-collected path.
  describe('B16: already-collected Charge now retries parked-row cleanup (real route + real shared step)', () => {
    const { settleParkedForPaidPayment: mockedSettle } = require('../services/autopay-sca-parked');
    const actualSettle = jest.requireActual('../services/autopay-sca-parked').settleParkedForPaidPayment;
    const PARKED = { id: 'pay-sca-1', customer_id: 'cust-1', stripe_payment_intent_id: 'pi_sca_orig' };
    const PAID = { id: 'pay-new', customer_id: 'cust-1', status: 'paid', amount: '89.00', metadata: JSON.stringify({ billed_month: '2026-10' }) };
    let ledger;

    // A payments builder with the ledger behaviour the shared step needs: the supersede update
    // returns the open parked rows once, and the "already superseded by this payment" read
    // returns them after that.
    function ledgerQB() {
      const qb = {};
      ['where', 'whereIn', 'whereRaw', 'whereNull', 'whereNot', 'orWhere', 'andWhere', 'orderBy', 'limit'].forEach((m) => {
        qb[m] = jest.fn((...args) => { if (typeof args[0] === 'function') args[0].call(qb, qb); return qb; });
      });
      qb.first = jest.fn(() => Promise.resolve(ledger.firstResult));
      qb.update = jest.fn(() => { ledger.updated += 1; return qb; });
      qb.returning = jest.fn(() => Promise.resolve(ledger.updated === 1 ? [PARKED] : []));
      qb.select = jest.fn(() => qb);
      qb.then = (resolve, reject) => Promise.resolve(ledger.updated >= 1 ? [PARKED] : []).then(resolve, reject);
      return qb;
    }

    beforeEach(() => {
      ledger = { firstResult: null, updated: 0 };
      mockedSettle.mockImplementation(actualSettle);
      mockCloseAdminAlertKeys.mockReset();
      mockCloseAdminAlertKeys.mockResolvedValue(1);
      db.mockImplementation((table) => {
        if (table === 'customers') return makeQB({ first: CUSTOMER });
        if (table === 'payments') return ledgerQB();
        if (table === 'stripe_orphan_charges') return makeQB({ first: null });
        throw new Error(`unexpected table ${table}`);
      });
    });
    afterEach(() => { mockedSettle.mockImplementation(async () => []); });

    const post = (baseUrl) => fetch(`${baseUrl}/admin/customers/cust-1/charge-now`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });

    test('first call: supersede commits, alert close fails (swallowed, 200). Second call: already_collected -> the close is retried and succeeds', async () => {
      chargeMock.mockResolvedValue(PAID);
      mockCloseAdminAlertKeys.mockRejectedValueOnce(new Error('notifications down')); // the FIRST close attempt
      await withServer(async (baseUrl) => {
        const first = await post(baseUrl);
        expect(first.status).toBe(200);
        expect(ledger.updated).toBe(1); // the parked row was superseded
        const closedAfterFirst = mockCloseAdminAlertKeys.mock.calls.filter((c) => c[1].includes('autopay-sca-parked:cust-1:pi_sca_orig'));
        expect(closedAfterFirst).toHaveLength(1); // attempted, and it threw
        mockCloseAdminAlertKeys.mockClear();

        // the month is now collected; the supersede above will not match again
        ledger.firstResult = PAID;
        const second = await post(baseUrl);
        expect(second.status).toBe(409);
        expect((await second.json()).already_collected).toBe(true);
        expect(ledger.updated).toBe(2); // the update ran again and matched no new rows
        const retried = mockCloseAdminAlertKeys.mock.calls.flatMap((c) => c[1]);
        expect(retried).toEqual(expect.arrayContaining(['autopay-sca-parked:cust-1:pi_sca_orig', 'autopay-sca-parked:cust-1:pay-sca-1']));
      });
    });

    test('an already-collected month whose payment is still PROCESSING (ACH not settled) cleans up nothing and still answers 409', async () => {
      ledger.firstResult = { ...PAID, status: 'processing' };
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl);
        expect(res.status).toBe(409);
      });
      expect(ledger.updated).toBe(0);
      expect(mockCloseAdminAlertKeys).not.toHaveBeenCalled();
    });

    test('a cleanup failure on the already-collected path never changes the 409 response', async () => {
      ledger.firstResult = PAID;
      mockCloseAdminAlertKeys.mockRejectedValue(new Error('down'));
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl);
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ already_collected: true, payment_id: 'pay-new' });
      });
    });
  });
});
