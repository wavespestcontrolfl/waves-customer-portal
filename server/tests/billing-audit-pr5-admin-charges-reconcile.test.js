/**
 * PR 5 Billing audit regression suite — Part 2:
 *   - B-31 & B-56a: `admin-billing-health.js` `charge-now` explicit & monthly
 *                   locking / deterministic idempotency / in-lock guards, and
 *                   `GET /billing-health` ET `monthStart` + surfacing DB errors
 *   - B-32: `POST /api/admin/payments/reconcile` pre-settlement fences
 *           (payer_statement_id, live payer, open-PI retirement + seam,
 *           saved-card reconciliation claim, cancelled visit, chemical hold)
 *           and post-commit `InvoiceFollowUps.stopOnPayment`
 *   - B-56b: `admin-invoices.js` `apply-credit` in-lock payer/withdrawal recheck
 *            + post-commit setup-fee & visit closeout, and `send` CC length cap
 *            + post-send `saveBillingRecipientPreference`
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(30000);

const express = require('express');

async function withServer(mount, router, callback) {
  const app = express();
  app.use(express.json());
  app.use(mount, router);
  app.use((err, _req, res, _next) => res.status(err.status || err.statusCode || 500).json({ error: err.message }));
  const server = app.listen(0, '127.0.0.1');
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    return await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// ============================================================================
// B-31 & B-56a: admin-billing-health charge-now & GET /billing-health
// ============================================================================
describe('B-31 & B-56a: admin-billing-health charge-now guards & GET /billing-health ET/errors', () => {
  let router;
  let ctx;
  let charge;
  let chargeOneTime;
  let withCustomerBillingLock;
  let closeMonthlyAlerts;

  beforeAll(() => {
    jest.resetModules();
    ctx = { customerPre: null, customerInLock: null, lockHeldElsewhere: false, failQueryIndex: null, recordedQueries: [], customerReadCount: 0, queryCount: 0 };

    const dbMock = jest.fn((table) => {
      const qNum = ++ctx.queryCount;
      const conds = [];
      const q = {
        where(a, b, c) { conds.push([a, b, c]); return q; },
        andWhere(a, b, c) { conds.push([a, b, c]); return q; },
        orWhere() { return q; },
        whereIn(col, vals) { conds.push(['whereIn', col, vals]); return q; },
        whereNull(col) { conds.push(['whereNull', col]); return q; },
        whereNotNull(col) { conds.push(['whereNotNull', col]); return q; },
        whereNot() { return q; },
        whereRaw(sql, bindings) { conds.push(['whereRaw', sql, bindings]); return q; },
        join() { return q; },
        count() { return q; },
        orderBy() { return q; },
        limit() { return q; },
        pluck: jest.fn(async () => []),
        update: jest.fn(async () => []),
        first: jest.fn(async (...cols) => {
          ctx.recordedQueries.push({ qNum, table, cols, conds });
          if (ctx.failQueryIndex != null && qNum === ctx.failQueryIndex) {
            throw new Error(`db failure at query ${qNum}`);
          }
          if (table === 'customers' || table === 'customers as c') {
            if (conds.some((c) => c[0] && typeof c[0] === 'object' && 'id' in c[0])) {
              ctx.customerReadCount += 1;
              return ctx.customerReadCount === 1
                ? (ctx.customerPre ? { ...ctx.customerPre } : null)
                : (ctx.customerInLock ? { ...ctx.customerInLock } : null);
            }
            return { n: '1' };
          }
          if (table === 'payments' && conds.some((c) => c[0] === 'whereIn')) {
            return cols.length === 0 && !ctx.customerPre ? { n: '4' } : null;
          }
          return { n: '0' };
        }),
      };
      return q;
    });
    dbMock.raw = jest.fn((sql, b) => ({ sql, b }));

    charge = jest.fn(async () => ({ id: 'pay-m-1', status: 'paid', amount: 79, metadata: {} }));
    chargeOneTime = jest.fn(async () => ({ id: 'pay-ot-1', status: 'paid', amount: 50, metadata: {} }));
    withCustomerBillingLock = jest.fn(async (_cid, fn) => {
      if (ctx.lockHeldElsewhere) {
        const err = new Error('Another billing action is already running for this customer');
        err.code = 'BILLING_CLAIM_HELD_ELSEWHERE';
        throw err;
      }
      return fn();
    });
    closeMonthlyAlerts = jest.fn(async () => 1);

    jest.doMock('../models/db', () => dbMock);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('../middleware/admin-auth', () => ({
      adminAuthenticate: (req, _res, next) => { req.technicianId = 'admin-1'; req.techRole = 'admin'; next(); },
      requireAdmin: (_req, _res, next) => next(),
      requireTechOrAdmin: (_req, _res, next) => next(),
    }));
    jest.doMock('../services/stripe', () => ({ charge, chargeOneTime }));
    jest.doMock('../utils/customer-billing-lock', () => ({ withCustomerBillingLock }));
    jest.doMock('../services/retry-collectibility', () => ({
      hasUnresolvedSiblingStripeOutcome: jest.fn(async () => ({ blocked: false })),
      deriveMonthlyChargeIdempotencyKey: jest.fn(async (cid, m) => `monthly_${cid}_${m}`),
    }));
    jest.doMock('../services/billing-lane', () => ({
      ...jest.requireActual('../services/billing-lane'),
      findLiveStampedDuesInvoice: jest.fn(async () => null),
    }));
    jest.doMock('../services/autopay-log', () => ({ logAutopay: jest.fn(async () => null), getRecent: jest.fn(async () => []) }));
    jest.doMock('../services/payment-failed-alert-close', () => ({ closePaymentFailedAlertsForMonthlyDues: closeMonthlyAlerts }));
    jest.doMock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn(async () => ({ sent: true })) }));
    jest.doMock('../services/sms-template-renderer', () => ({ renderRequiredSmsTemplate: jest.fn(async () => 'Receipt') }));
    jest.doMock('../services/prepaid-pi-guard', () => ({ neutralizeOpenPaymentIntent: jest.fn(async () => ({ ok: true })) }));

    router = require('../routes/admin-billing-health');
  });

  function resetCtx(overrides = {}) {
    jest.clearAllMocks();
    Object.assign(ctx, {
      customerPre: null,
      customerInLock: null,
      lockHeldElsewhere: false,
      failQueryIndex: null,
      recordedQueries: [],
      customerReadCount: 0,
      queryCount: 0,
      ...overrides,
    });
  }

  const activeCustomer = {
    id: 'cust-1', active: true, deleted_at: null, payer_id: null,
    billing_mode: 'monthly_membership', waveguard_tier: 'Core', monthly_rate: 79, billing_day: 1, phone: null,
  };

  test('explicit-amount charge-now runs inside withCustomerBillingLock, uses deterministic idempotency keys, and honors lock contention (409)', async () => {
    await withServer('/api/admin', router, async (baseUrl) => {
      resetCtx({ customerPre: activeCustomer, customerInLock: activeCustomer });
      const r1 = await fetch(`${baseUrl}/api/admin/customers/cust-1/charge-now`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'click-abc-123' },
        body: JSON.stringify({ amount: 50, description: 'Extra bait station' }),
      });
      expect(r1.status).toBe(200);
      ctx.customerReadCount = 0;
      const r2 = await fetch(`${baseUrl}/api/admin/customers/cust-1/charge-now`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'click-abc-123' },
        body: JSON.stringify({ amount: 50, description: 'Extra bait station' }),
      });
      expect(r2.status).toBe(200);
      expect(withCustomerBillingLock).toHaveBeenCalledTimes(2);
      const key1 = chargeOneTime.mock.calls[0][3];
      const key2 = chargeOneTime.mock.calls[1][3];
      expect(key1).toMatch(/^admin_charge_one_time_cust-1_[a-f0-9]{24}$/);
      expect(key2).toBe(key1);

      // Lock contention returns 409 in_progress without calling Stripe
      resetCtx({ customerPre: activeCustomer, customerInLock: activeCustomer, lockHeldElsewhere: true });
      const r3 = await fetch(`${baseUrl}/api/admin/customers/cust-1/charge-now`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 50 }),
      });
      expect(r3.status).toBe(409);
      await expect(r3.json()).resolves.toMatchObject({ in_progress: true });
      expect(chargeOneTime).not.toHaveBeenCalled();
    });
  });

  test('explicit-amount charge-now re-checks active, deleted_at, and payer_id INSIDE the lock', async () => {
    await withServer('/api/admin', router, async (baseUrl) => {
      for (const [mutated, expectedStatus] of [
        [{ ...activeCustomer, active: false }, 409],
        [{ ...activeCustomer, deleted_at: '2026-11-27T00:00:00Z' }, 409],
        [{ ...activeCustomer, payer_id: 'payer-1' }, 400],
      ]) {
        resetCtx({ customerPre: activeCustomer, customerInLock: mutated });
        const res = await fetch(`${baseUrl}/api/admin/customers/cust-1/charge-now`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount: 50 }),
        });
        expect(res.status).toBe(expectedStatus);
        expect(chargeOneTime).not.toHaveBeenCalled();
      }
    });
  });

  test('monthly charge-now re-checks active, deleted_at, payer_id, lane, and monthly_rate INSIDE lock, and closes monthly payment_failed bells on paid', async () => {
    await withServer('/api/admin', router, async (baseUrl) => {
      for (const [mutated, expectedStatus] of [
        [{ ...activeCustomer, active: false }, 409],
        [{ ...activeCustomer, deleted_at: '2026-11-27T00:00:00Z' }, 409],
        [{ ...activeCustomer, payer_id: 'payer-1' }, 400],
        [{ ...activeCustomer, billing_mode: 'per_application' }, 409],
        [{ ...activeCustomer, monthly_rate: 99 }, 409],
      ]) {
        resetCtx({ customerPre: activeCustomer, customerInLock: mutated });
        const res = await fetch(`${baseUrl}/api/admin/customers/cust-1/charge-now`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expectedAmount: 79 }),
        });
        expect(res.status).toBe(expectedStatus);
        expect(charge).not.toHaveBeenCalled();
      }

      // Happy monthly Charge Now triggers B-29 monthly alert close
      resetCtx({ customerPre: activeCustomer, customerInLock: activeCustomer });
      const res = await fetch(`${baseUrl}/api/admin/customers/cust-1/charge-now`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedAmount: 79 }),
      });
      expect(res.status).toBe(200);
      expect(closeMonthlyAlerts).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'cust-1' }));
    });
  });

  test('GET /billing-health computes ET monthStart after UTC month rollover (no false $0 after 8 PM ET) and surfaces DB errors instead of .catch(() => ({ n: 0 }))', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
      // 2026-08-01T02:30:00Z = 2026-07-31 22:30 EDT (still July in ET, August in UTC!)
      jest.setSystemTime(new Date('2026-08-01T02:30:00Z'));
      await withServer('/api/admin', router, async (baseUrl) => {
        resetCtx();
        const res = await fetch(`${baseUrl}/api/admin/billing-health`);
        expect(res.status).toBe(200);
        const chargedMonthQuery = ctx.recordedQueries.find(
          (q) => q.table === 'payments' && q.conds.some((c) => c[0] === 'description'),
        );
        expect(chargedMonthQuery).toBeDefined();
        expect(chargedMonthQuery.conds).toContainEqual(['payment_date', '>=', '2026-07-01']);

        // Query #5 is `chargeable`, #6 is `unchargeable`, #12 is `expiringCards` — DB failure must surface 500, never silent 0
        for (const failIdx of [5, 6, 12]) {
          resetCtx({ failQueryIndex: failIdx });
          const failRes = await fetch(`${baseUrl}/api/admin/billing-health`);
          expect(failRes.status).toBe(500);
        }
      });
    } finally {
      jest.useRealTimers();
    }
  });
});

// ============================================================================
// B-32: POST /api/admin/payments/reconcile pre-settlement fences & follow-ups
// ============================================================================
describe('B-32: POST /api/admin/payments/reconcile pre-settlement fences & InvoiceFollowUps.stopOnPayment', () => {
  let router;
  let ctx;
  let stopOnPayment;
  let retireOpenPi;
  let assertNoClaim;
  let resolveForInvoice;

  beforeAll(() => {
    jest.resetModules();
    ctx = {
      invoicePre: null, invoiceInLock: null, visitRow: null, resolvedPayer: null,
      openPiRefusal: null, claimFenceError: null, invRead: 0, updatedPatches: [],
    };
    stopOnPayment = jest.fn(async () => 1);
    retireOpenPi = jest.fn(async () => ctx.openPiRefusal);
    assertNoClaim = jest.fn(async () => {
      if (ctx.claimFenceError) throw ctx.claimFenceError;
    });
    resolveForInvoice = jest.fn(async () => ctx.resolvedPayer);

    const makeTable = (table, inTx) => {
      const q = {
        where: () => q,
        whereIn: () => q,
        whereNotIn: () => q,
        forUpdate: () => q,
        noWait: () => q,
        orderBy: () => q,
        select: jest.fn(async () => []),
        first: jest.fn(async () => {
          if (table === 'invoices') {
            if (!inTx) {
              ctx.invRead += 1;
              return ctx.invRead === 1 ? { ...ctx.invoicePre } : { ...ctx.invoiceInLock, status: 'paid' };
            }
            return ctx.invoiceInLock ? { ...ctx.invoiceInLock } : null;
          }
          if (table === 'customers') return { id: ctx.invoicePre.customer_id, payer_id: null };
          if (table === 'scheduled_services') return ctx.visitRow;
          return null;
        }),
        update: jest.fn(async (patch) => {
          ctx.updatedPatches.push({ table, patch });
          return 1;
        }),
        insert: jest.fn(async () => [1]),
      };
      return q;
    };
    const trx = Object.assign((t) => makeTable(t, true), { raw: jest.fn(async () => ({})) });
    const dbMock = Object.assign((t) => makeTable(t, false), {
      transaction: jest.fn(async (fn) => fn(trx)),
      raw: jest.fn(async () => ({})),
    });

    jest.doMock('../models/db', () => dbMock);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('../middleware/admin-auth', () => ({
      adminAuthenticate: (req, _res, next) => { req.technicianId = 'admin-1'; req.techRole = 'admin'; next(); },
      requireAdmin: (_req, _res, next) => next(),
    }));
    jest.doMock('../services/audit-log', () => ({
      auditPaymentReconcile: jest.fn(async () => {}),
      ipFromReq: () => '127.0.0.1',
      uaFromReq: () => 'jest',
    }));
    jest.doMock('../services/pay-combined', () => ({
      releaseCombinedSessionBeforeCollection: jest.fn(async () => ({ invoice: ctx.invoicePre })),
    }));
    jest.doMock('../services/invoice-manual-payment', () => ({
      retireOpenPaymentIntentBeforeSettlement: retireOpenPi,
    }));
    jest.doMock('../services/stripe', () => ({
      assertNoInvoiceChargeReconciliationPending: assertNoClaim,
    }));
    jest.doMock('../services/payer', () => ({ resolveForInvoice }));
    jest.doMock('../services/payment-plans', () => ({ completeActivePlansForInvoice: jest.fn(async () => 0) }));
    jest.doMock('../services/invoice-followups', () => ({ stopOnPayment }));
    jest.doMock('../services/annual-prepay-renewals', () => ({ syncTermForInvoicePayment: jest.fn(async () => {}) }));
    jest.doMock('../services/billing-pause', () => ({ maybeResumeBillingPauseOnPayment: jest.fn(async () => {}) }));
    jest.doMock('../services/invoice-issued-closeout', () => ({ closeOutVisitForIssuedInvoice: jest.fn(async () => ({ closed: false })) }));
    jest.doMock('../services/review-request', () => ({ enrollForPaidInvoice: jest.fn(async () => ({ recorded: true })) }));

    router = require('../routes/admin-payments-reconcile');
  });

  function resetCtx(overrides = {}) {
    jest.clearAllMocks();
    Object.assign(ctx, {
      invoicePre: baseInvoice,
      invoiceInLock: overrides.invoicePre || baseInvoice,
      visitRow: null,
      resolvedPayer: null,
      openPiRefusal: null,
      claimFenceError: null,
      invRead: 0,
      updatedPatches: [],
      ...overrides,
    });
  }

  const baseInvoice = {
    id: 'inv-1', invoice_number: 'WPC-1', customer_id: 'cust-1', status: 'sent',
    total: 120, credit_applied: 0, amount_paid: 0, payer_id: null, payer_statement_id: null,
    scheduled_service_id: 'visit-1', stripe_payment_intent_id: null, scheduled_send_error: null,
  };

  test('refuses payer_statement_id, live third-party payer, cancelled visit, chemical-review hold, and pending saved-card claim', async () => {
    await withServer('/api/admin/payments', router, async (baseUrl) => {
      // 1. Pre-lock payer_statement_id -> 400
      resetCtx({ invoicePre: { ...baseInvoice, payer_statement_id: 'stmt-1' } });
      let res = await fetch(`${baseUrl}/api/admin/payments/reconcile`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceId: 'inv-1', collectedVia: 'check' }),
      });
      expect(res.status).toBe(400);
      expect(ctx.updatedPatches).toHaveLength(0);

      // 2. Concurrent payer_statement_id in lock -> 409
      resetCtx({ invoicePre: baseInvoice, invoiceInLock: { ...baseInvoice, payer_statement_id: 'stmt-9' } });
      res = await fetch(`${baseUrl}/api/admin/payments/reconcile`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceId: 'inv-1', collectedVia: 'check' }),
      });
      expect(res.status).toBe(409);
      expect(ctx.updatedPatches).toHaveLength(0);

      // 3. Live third-party payer resolved in lock -> 409
      resetCtx({
        invoicePre: baseInvoice,
        visitRow: { id: 'visit-1', status: 'completed', payer_id: 'payer-live' },
        resolvedPayer: { payerId: 'payer-live' },
      });
      res = await fetch(`${baseUrl}/api/admin/payments/reconcile`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceId: 'inv-1', collectedVia: 'cash' }),
      });
      expect(res.status).toBe(409);
      expect(ctx.updatedPatches).toHaveLength(0);

      // 4. Cancelled linked visit -> 409
      resetCtx({
        invoicePre: baseInvoice,
        visitRow: { id: 'visit-1', status: 'cancelled', payer_id: null },
      });
      res = await fetch(`${baseUrl}/api/admin/payments/reconcile`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceId: 'inv-1', collectedVia: 'cash' }),
      });
      expect(res.status).toBe(409);
      expect(ctx.updatedPatches).toHaveLength(0);

      // 5. Chemical-review hold (assertInvoiceCollectible) -> 409
      resetCtx({ invoicePre: { ...baseInvoice, scheduled_send_error: 'chemical_addon_review:needs check' } });
      res = await fetch(`${baseUrl}/api/admin/payments/reconcile`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceId: 'inv-1', collectedVia: 'cash' }),
      });
      expect(res.status).toBe(409);
      expect(ctx.updatedPatches).toHaveLength(0);

      // 6. Pending saved-card reconciliation claim -> 409
      const claimErr = Object.assign(new Error('Invoice has an unresolved charge attempt'), { code: 'STRIPE_AMBIGUOUS_OUTCOME' });
      resetCtx({
        invoicePre: baseInvoice,
        visitRow: { id: 'visit-1', status: 'completed', payer_id: null },
        claimFenceError: claimErr,
      });
      res = await fetch(`${baseUrl}/api/admin/payments/reconcile`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceId: 'inv-1', collectedVia: 'cash' }),
      });
      expect(res.status).toBe(409);
      expect(ctx.updatedPatches).toHaveLength(0);
    });
  });

  test('retires open PI before settlement, refuses raced new PI in lock, clears PI/processor on off-Stripe reconcile, and stops follow-ups post-commit', async () => {
    await withServer('/api/admin/payments', router, async (baseUrl) => {
      // 1. Open PI in-flight refuses (409)
      resetCtx({
        invoicePre: { ...baseInvoice, stripe_payment_intent_id: 'pi_open_1' },
        openPiRefusal: { status: 409, error: 'Payment in flight' },
      });
      let res = await fetch(`${baseUrl}/api/admin/payments/reconcile`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceId: 'inv-1', collectedVia: 'cash' }),
      });
      expect(res.status).toBe(409);
      expect(retireOpenPi).toHaveBeenCalledTimes(1);
      expect(ctx.updatedPatches).toHaveLength(0);

      // 2. New PI minted in the seam between triage and lock -> 409
      resetCtx({
        invoicePre: { ...baseInvoice, stripe_payment_intent_id: null },
        invoiceInLock: { ...baseInvoice, stripe_payment_intent_id: 'pi_raced_new' },
      });
      res = await fetch(`${baseUrl}/api/admin/payments/reconcile`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceId: 'inv-1', collectedVia: 'cash' }),
      });
      expect(res.status).toBe(409);
      expect(ctx.updatedPatches).toHaveLength(0);

      // 3. Clean off-Stripe reconcile with open PI retires it, clears PI/processor, and calls InvoiceFollowUps.stopOnPayment
      resetCtx({
        invoicePre: { ...baseInvoice, stripe_payment_intent_id: 'pi_old_open', processor: 'stripe' },
        invoiceInLock: { ...baseInvoice, stripe_payment_intent_id: 'pi_old_open', processor: 'stripe' },
        visitRow: { id: 'visit-1', status: 'completed', payer_id: null },
      });
      res = await fetch(`${baseUrl}/api/admin/payments/reconcile`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceId: 'inv-1', collectedVia: 'check' }),
      });
      expect(res.status).toBe(200);
      expect(retireOpenPi).toHaveBeenCalledTimes(1);
      expect(ctx.updatedPatches[0].patch).toMatchObject({
        status: 'paid',
        stripe_payment_intent_id: null,
        processor: null,
      });
      expect(stopOnPayment).toHaveBeenCalledWith('inv-1');
    });
  });
});

// ============================================================================
// B-56b: admin-invoices apply-credit & send hardening
// ============================================================================
describe('B-56b: admin-invoices apply-credit & send hardening', () => {
  let router;
  let ctx;
  let postCreditMovement;
  let reconcileSetupFeeAlertForInvoice;
  let closeOutVisitForIssuedInvoice;
  let sendViaSMSAndEmail;
  let prefUpdateSpy;

  const baseInv = {
    id: 'inv-1', invoice_number: 'WPC-10', customer_id: 'cust-1', status: 'sent',
    total: 99, credit_applied: 0, amount_paid: 0, payer_id: null, payer_statement_id: null,
    scheduled_service_id: 'visit-1', stripe_payment_intent_id: null, scheduled_send_error: null,
  };

  beforeAll(() => {
    jest.resetModules();
    ctx = {
      invoicePre: baseInv, invoiceInLock: baseInv,
      sendResult: { ok: true, sms: { ok: true }, email: { ok: true } },
      sendThrows: null, creditBalance: 200,
    };
    postCreditMovement = jest.fn(async () => ({ balanceAfter: ctx.creditBalance - Number(ctx.invoicePre.total || 0) }));
    reconcileSetupFeeAlertForInvoice = jest.fn(async () => {});
    closeOutVisitForIssuedInvoice = jest.fn(async () => ({ closed: true }));
    prefUpdateSpy = jest.fn();
    sendViaSMSAndEmail = jest.fn(async () => {
      if (ctx.sendThrows) throw ctx.sendThrows;
      return ctx.sendResult;
    });

    const makeTable = (table, inTx) => {
      const q = {
        where: () => q,
        whereIn: () => q,
        whereNull: () => q,
        forUpdate: () => q,
        noWait: () => q,
        select: () => q,
        first: jest.fn(async () => {
          if (table === 'invoices') return inTx ? { ...ctx.invoiceInLock } : { ...ctx.invoicePre };
          if (table === 'customers') return { id: ctx.invoicePre.customer_id };
          if (table === 'notification_prefs') return { id: 'np-1' };
          if (table === 'scheduled_services') return { id: ctx.invoicePre.scheduled_service_id, status: 'completed' };
          return null;
        }),
        update: jest.fn(async (patch) => {
          if (table === 'notification_prefs') prefUpdateSpy(patch);
          return 1;
        }),
        insert: jest.fn(async () => [1]),
        then: (resolve, reject) => Promise.resolve([]).then(resolve, reject),
      };
      return q;
    };
    const trx = Object.assign((t) => makeTable(t, true), { fn: { now: () => 'NOW' }, raw: jest.fn((s) => ({ s })) });
    const dbMock = Object.assign((t) => makeTable(t, false), {
      transaction: jest.fn(async (fn) => fn(trx)),
      fn: { now: () => 'NOW' },
      raw: jest.fn((s) => ({ s })),
    });

    jest.doMock('../models/db', () => dbMock);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('../middleware/admin-auth', () => ({
      adminAuthenticate: (req, _res, next) => { req.technicianId = 'admin-1'; req.techRole = 'admin'; req.technician = { id: 'admin-1', name: 'Admin' }; next(); },
      requireAdmin: (_req, _res, next) => next(),
      requireTechOrAdmin: (_req, _res, next) => next(),
    }));
    jest.doMock('../services/customer-credit', () => ({
      round2: (v) => Math.round(Number(v || 0) * 100) / 100,
      getBalance: jest.fn(async () => ctx.creditBalance),
      postCreditMovement,
    }));
    jest.doMock('../services/invoice', () => ({
      sendViaSMSAndEmail,
    }));
    jest.doMock('../utils/customer-comms-lock', () => ({
      lockAssignedCustomerEmails: jest.fn(async () => {}),
    }));
    jest.doMock('../services/invoice-manual-payment', () => ({
      VALID_PAYMENT_METHODS: ['cash', 'check', 'zelle', 'venmo', 'paypal', 'other'],
      recordManualPayment: jest.fn(),
      retireOpenPaymentIntentBeforeSettlement: jest.fn(async () => null),
    }));
    jest.doMock('../services/stripe', () => ({
      assertNoInvoiceChargeReconciliationPending: jest.fn(async () => {}),
    }));
    jest.doMock('../services/payment-plans', () => ({ completeActivePlansForInvoice: jest.fn(async () => 0) }));
    jest.doMock('../services/invoice-followups', () => ({ stopOnPayment: jest.fn(async () => 0) }));
    jest.doMock('../services/annual-prepay-renewals', () => ({ syncTermForInvoicePayment: jest.fn(async () => {}) }));
    jest.doMock('../services/setup-fee-alert-reconcile', () => ({
      acceptedEstimateIdFromNotes: jest.requireActual('../services/setup-fee-alert-reconcile').acceptedEstimateIdFromNotes,
      reconcileSetupFeeAlert: jest.fn(async () => {}),
      reconcileSetupFeeAlertForInvoice,
    }));
    jest.doMock('../services/invoice-issued-closeout', () => ({ closeOutVisitForIssuedInvoice }));
    jest.doMock('../services/review-request', () => ({ enrollForPaidInvoice: jest.fn(async () => ({ recorded: true })) }));

    router = require('../routes/admin-invoices');
  });

  function resetCtx(overrides = {}) {
    jest.clearAllMocks();
    Object.assign(ctx, {
      invoicePre: baseInv,
      invoiceInLock: overrides.invoicePre || baseInv,
      sendResult: { ok: true, sms: { ok: true }, email: { ok: true } },
      sendThrows: null,
      creditBalance: 200,
      ...overrides,
    });
  }

  test('apply-credit refuses payer_id, payer_statement_id, and withdrawn-to-payer inside the locked transaction without consuming credit', async () => {
    await withServer('/api/admin/invoices', router, async (baseUrl) => {
      for (const mutated of [
        { ...baseInv, payer_id: 'payer-1' },
        { ...baseInv, payer_statement_id: 'stmt-1' },
        { ...baseInv, scheduled_send_error: 'payer_billed:moved to AP' },
      ]) {
        resetCtx({ invoicePre: baseInv, invoiceInLock: mutated });
        const res = await fetch(`${baseUrl}/api/admin/invoices/inv-1/apply-credit`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        expect(res.status).toBe(409);
        expect(postCreditMovement).not.toHaveBeenCalled();
      }
    });
  });

  test('apply-credit post-commit invokes reconcileSetupFeeAlertForInvoice AND closeOutVisitForIssuedInvoice({ trigger: "paid" })', async () => {
    await withServer('/api/admin/invoices', router, async (baseUrl) => {
      resetCtx({ invoicePre: baseInv, invoiceInLock: baseInv });
      const res = await fetch(`${baseUrl}/api/admin/invoices/inv-1/apply-credit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      expect(res.status).toBe(200);
      expect(postCreditMovement).toHaveBeenCalledTimes(1);
      expect(reconcileSetupFeeAlertForInvoice).toHaveBeenCalledWith(expect.objectContaining({ id: 'inv-1' }));
      expect(closeOutVisitForIssuedInvoice).toHaveBeenCalledWith({
        invoiceId: 'inv-1',
        trigger: 'paid',
        actorTechnicianId: 'admin-1',
      });
    });
  });

  test('send rejects invoiceCcEmail over 200 chars (400 invalid_cc) and only saves billing recipient preference AFTER send succeeds', async () => {
    await withServer('/api/admin/invoices', router, async (baseUrl) => {
      // 1. Over-length CC email -> 400 invalid_cc before send or save
      resetCtx({ invoicePre: baseInv });
      const longCc = `${'a'.repeat(195)}@example.test`;
      let res = await fetch(`${baseUrl}/api/admin/invoices/inv-1/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceCcEmail: longCc, invoiceRecipientEmail: 'billing@example.test', saveBillingRecipient: true }),
      });
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ code: 'invalid_cc' });
      expect(sendViaSMSAndEmail).not.toHaveBeenCalled();
      expect(prefUpdateSpy).not.toHaveBeenCalled();

      // 2. Failed send (ok: false) must NOT overwrite saved billing recipient preference
      resetCtx({
        invoicePre: baseInv,
        sendResult: { ok: false, sms: { ok: false }, email: { ok: false, error: 'Rejected' } },
      });
      res = await fetch(`${baseUrl}/api/admin/invoices/inv-1/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceRecipientEmail: 'billing@example.test', saveBillingRecipient: true }),
      });
      expect(res.status).toBe(400);
      expect(prefUpdateSpy).not.toHaveBeenCalled();

      // 3. Thrown send error must NOT overwrite saved billing recipient preference
      resetCtx({
        invoicePre: baseInv,
        sendThrows: new Error('Invoice send already in progress'),
      });
      res = await fetch(`${baseUrl}/api/admin/invoices/inv-1/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceRecipientEmail: 'billing@example.test', saveBillingRecipient: true }),
      });
      expect(res.status).toBe(409);
      expect(prefUpdateSpy).not.toHaveBeenCalled();

      // 4. Successful send saves billing recipient preference ONLY AFTER send succeeds
      resetCtx({
        invoicePre: baseInv,
        sendResult: { ok: true, sms: { ok: true }, email: { ok: true } },
      });
      res = await fetch(`${baseUrl}/api/admin/invoices/inv-1/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceRecipientEmail: 'billing@example.test', invoiceRecipientName: 'AP Desk', saveBillingRecipient: true }),
      });
      expect(res.status).toBe(200);
      expect(sendViaSMSAndEmail).toHaveBeenCalledTimes(1);
      expect(prefUpdateSpy).toHaveBeenCalledWith(expect.objectContaining({
        billing_email: 'billing@example.test',
        billing_contact_name: 'AP Desk',
      }));
      expect(sendViaSMSAndEmail.mock.invocationCallOrder[0]).toBeLessThan(prefUpdateSpy.mock.invocationCallOrder[0]);

      // 5. Payer-billed invoice send does NOT persist customer billing recipient preference
      resetCtx({
        invoicePre: { ...baseInv, payer_id: 'payer-1' },
        sendResult: { ok: true, sms: { ok: false }, email: { ok: true } },
      });
      res = await fetch(`${baseUrl}/api/admin/invoices/inv-1/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceRecipientEmail: 'ap@example.test', saveBillingRecipient: true }),
      });
      expect(res.status).toBe(200);
      expect(prefUpdateSpy).not.toHaveBeenCalled();
    });
  });
});

// ============================================================================
// Round-4 charge-now idempotency key retirement, amount mismatch & replay dedupe
// ============================================================================
describe('Round-4 charge-now idempotency & replay dedupe', () => {
  let router;
  let state;
  let chargeOneTime;
  let sendCustomerMessage;
  let logAutopay;

  beforeAll(() => {
    jest.resetModules();
    state = {
      customer: {
        id: 'cust-1',
        active: true,
        deleted_at: null,
        payer_id: null,
        billing_mode: 'monthly_membership',
        waveguard_tier: 'Core',
        monthly_rate: 79,
        billing_day: 1,
        phone: '+19415550100',
      },
      priorPayment: null,
      failPaymentLookup: false,
      autopayLogRow: null,
      smsMessageRow: null,
    };
    const dbMock = jest.fn((table) => {
      const conds = [];
      const q = {
        where(a, b, c) { conds.push([a, b, c]); return q; },
        andWhere(a, b, c) { conds.push([a, b, c]); return q; },
        whereIn(col, vals) { conds.push(['whereIn', col, vals]); return q; },
        whereNull() { return q; },
        whereRaw(sql, bindings) { conds.push(['whereRaw', sql, bindings]); return q; },
        orderBy() { return q; },
        first: jest.fn(async () => {
          if (table === 'customers') return { ...state.customer };
          if (table === 'payments') {
            if (state.failPaymentLookup) throw new Error('payments read failed');
            return state.priorPayment ? { ...state.priorPayment } : null;
          }
          if (table === 'autopay_log') return state.autopayLogRow ? { ...state.autopayLogRow } : null;
          if (table === 'messaging_audit_log') return state.smsMessageRow ? { ...state.smsMessageRow } : null;
          return null;
        }),
      };
      return q;
    });
    dbMock.raw = jest.fn((sql, b) => ({ sql, b }));

    chargeOneTime = jest.fn(async () => ({ id: 'pay-new', status: 'paid', amount: 50, metadata: {} }));
    sendCustomerMessage = jest.fn(async () => ({ sent: true }));
    logAutopay = jest.fn(async () => null);

    jest.doMock('../models/db', () => dbMock);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('../middleware/admin-auth', () => ({
      adminAuthenticate: (req, _res, next) => { req.technicianId = 'admin-1'; req.techRole = 'admin'; next(); },
      requireAdmin: (_req, _res, next) => next(),
      requireTechOrAdmin: (_req, _res, next) => next(),
    }));
    jest.doMock('../services/stripe', () => ({ charge: jest.fn(), chargeOneTime }));
    jest.doMock('../utils/customer-billing-lock', () => ({
      withCustomerBillingLock: jest.fn(async (_cid, fn) => fn()),
    }));
    jest.doMock('../services/retry-collectibility', () => ({
      hasUnresolvedSiblingStripeOutcome: jest.fn(async () => ({ blocked: false })),
      deriveMonthlyChargeIdempotencyKey: jest.fn(),
    }));
    jest.doMock('../services/billing-lane', () => ({
      ...jest.requireActual('../services/billing-lane'),
      findLiveStampedDuesInvoice: jest.fn(async () => null),
    }));
    jest.doMock('../services/autopay-log', () => ({ logAutopay, getRecent: jest.fn(async () => []) }));
    jest.doMock('../services/payment-failed-alert-close', () => ({ closePaymentFailedAlertsForMonthlyDues: jest.fn() }));
    jest.doMock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage }));
    jest.doMock('../services/sms-template-renderer', () => ({ renderRequiredSmsTemplate: jest.fn(async () => 'Receipt') }));
    jest.doMock('../services/prepaid-pi-guard', () => ({ neutralizeOpenPaymentIntent: jest.fn(async () => ({ ok: true })) }));

    router = require('../routes/admin-billing-health');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    state.priorPayment = null;
    state.failPaymentLookup = false;
    state.autopayLogRow = null;
    state.smsMessageRow = null;
  });

  test('returns 409 IDEMPOTENCY_KEY_RETIRED on refunded/disputed prior key and 409 IDEMPOTENCY_AMOUNT_MISMATCH on amount change', async () => {
    await withServer('/api/admin', router, async (baseUrl) => {
      state.priorPayment = {
        id: 'pay-refunded', status: 'refunded', base_amount_cents: 5000, amount: 50,
        payment_method: 'card', stripe_payment_intent_id: 'pi_old', stripe_charge_id: 'ch_old', metadata: {},
      };
      const retiredRes = await fetch(`${baseUrl}/api/admin/customers/cust-1/charge-now`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'key-retired' },
        body: JSON.stringify({ amount: 50, description: 'Retry refunded key' }),
      });
      expect(retiredRes.status).toBe(409);
      await expect(retiredRes.json()).resolves.toMatchObject({ code: 'IDEMPOTENCY_KEY_RETIRED' });

      state.priorPayment = {
        id: 'pay-paid', status: 'paid', base_amount_cents: 5000, amount: 50,
        payment_method: 'card', stripe_payment_intent_id: 'pi_ok', stripe_charge_id: 'ch_ok', metadata: {},
      };
      const mismatchRes = await fetch(`${baseUrl}/api/admin/customers/cust-1/charge-now`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'key-paid' },
        body: JSON.stringify({ amount: 75, description: 'Changed amount' }),
      });
      expect(mismatchRes.status).toBe(409);
      await expect(mismatchRes.json()).resolves.toMatchObject({ code: 'IDEMPOTENCY_AMOUNT_MISMATCH' });
      expect(chargeOneTime).not.toHaveBeenCalled();
    });
  });

  test('fails closed on prior payment lookup DB error and deduplicates replay log/SMS when already recorded', async () => {
    await withServer('/api/admin', router, async (baseUrl) => {
      state.failPaymentLookup = true;
      const errRes = await fetch(`${baseUrl}/api/admin/customers/cust-1/charge-now`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'key-db-err' },
        body: JSON.stringify({ amount: 50 }),
      });
      expect(errRes.status).toBe(500);
      expect(chargeOneTime).not.toHaveBeenCalled();

      state.failPaymentLookup = false;
      state.priorPayment = {
        id: 'pay-paid-2', status: 'paid', base_amount_cents: 5000, amount: 50,
        payment_method: 'card', stripe_payment_intent_id: 'pi_ok2', stripe_charge_id: 'ch_ok2', metadata: {},
      };
      state.autopayLogRow = { id: 'log-1' };
      state.smsMessageRow = { id: 'sms-1' };
      const replayRes = await fetch(`${baseUrl}/api/admin/customers/cust-1/charge-now`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'key-replay' },
        body: JSON.stringify({ amount: 50, send_receipt: true }),
      });
      expect(replayRes.status).toBe(200);
      await expect(replayRes.json()).resolves.toMatchObject({ idempotent_replay: true });
      expect(logAutopay).not.toHaveBeenCalled();
      expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
        purpose: 'payment_receipt',
        metadata: expect.objectContaining({
          notificationEventKey: 'admin_manual_charge_receipt:pay-paid-2',
        }),
      }));
    });
  });
});
