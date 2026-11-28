/**
 * PR 5 Billing audit regression suite — Part 1:
 *   - B-29: Monthly Auto Pay `payment_failed` alert auto-close, repair sweep,
 *           delayed push suppression, and dues-invoice manual-undo reopen
 *   - B-30: `PUT /api/billing/cards/:id/default` TOCTOU serialization inside
 *           the `customers FOR UPDATE` transaction
 *   - B-51: `billing_day` 29/30/31 month-end clamping in shorter months
 *   - B-54: Canonical recurring lineage (`isRecurringLineageVisit`) across
 *           terminal-save-card, appointment-card-request, and completion-charge-verdict
 *   - B-59: `secure-card-public` code-only error logs (no raw `err.message`)
 *           and `card-public` router-top `Cache-Control: private, no-store` on
 *           200, 404, and 429 responses
 */

const express = require('express');

async function withServer(mount, router, callback) {
  const app = express();
  app.use(express.json());
  app.use(mount, router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0, '127.0.0.1');
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    return await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// ============================================================================
// B-29: Monthly Auto Pay payment_failed settlement, alert close, push suppress
// ============================================================================
describe('B-29: Monthly Auto Pay payment_failed settlement, alert close & push suppression', () => {
  function makeAllocationConn({ payments = [], invoices = [], notifications = [] } = {}) {
    const state = { payments, invoices, notifications, updates: [] };
    const conn = jest.fn((table) => {
      const conds = [];
      const inConds = [];
      const filterRows = () => {
        const src = table === 'payments' ? state.payments
          : table === 'invoices' ? state.invoices
          : table === 'notifications' ? state.notifications
          : [];
        return src.filter((r) => {
          if (!conds.every((fn) => fn(r))) return false;
          if (!inConds.every(([col, vals]) => vals.map(String).includes(String(r[col])))) return false;
          return true;
        });
      };
      const q = {
        where(arg, opOrVal, maybeVal) {
          if (typeof arg === 'function') {
            arg.call(q, q);
          } else if (typeof arg === 'object' && arg !== null) {
            Object.entries(arg).forEach(([k, v]) => conds.push((r) => String(r[k]) === String(v)));
          } else if (typeof arg === 'string') {
            const val = maybeVal === undefined ? opOrVal : maybeVal;
            const op = maybeVal === undefined ? '=' : opOrVal;
            if (op === '=') conds.push((r) => String(r[arg]) === String(val));
            else if (op === '>') conds.push((r) => String(r[arg]) > String(val));
            else if (op === '>=') conds.push((r) => String(r[arg]) >= String(val));
            else if (op === '<=') conds.push((r) => String(r[arg]) <= String(val));
            else if (op === 'like') {
              const needle = String(val).replace(/%/g, '');
              conds.push((r) => String(r[arg] || '').includes(needle));
            }
          }
          return q;
        },
        andWhere(...args) { return q.where(...args); },
        orWhere() { return q; },
        whereIn(col, vals) { inConds.push([col, vals]); return q; },
        whereNotIn(col, vals) { conds.push((r) => !vals.includes(r[col])); return q; },
        whereNull(col) { conds.push((r) => r[col] == null); return q; },
        whereNotNull(col) { conds.push((r) => r[col] != null); return q; },
        whereRaw(sql, bindings = []) {
          if (sql.includes("metadata->>'billed_month' = ?")) {
            const month = bindings[0];
            conds.push((r) => {
              const meta = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {});
              return meta.billed_month === month;
            });
          } else if (sql.includes('status IN (')) {
            conds.push((r) => bindings.includes(r.status));
          } else if (sql.includes('status NOT IN (')) {
            conds.push((r) => !bindings.includes(r.status));
          } else if (sql.includes('payer_id IS NULL')) {
            conds.push((r) => r.payer_id == null);
          } else if (sql.includes('line_items::jsonb @>')) {
            const target = JSON.parse(bindings[0])[0];
            conds.push((r) => Array.isArray(r.line_items)
              && r.line_items.some((li) => Object.entries(target).every(([k, v]) => li[k] === v)));
          }
          return q;
        },
        orWhereRaw() { return q; },
        orderBy() { return q; },
        limit() { return q; },
        modify(fn) { fn(q); return q; },
        select: jest.fn(async () => filterRows().map((r) => ({ ...r }))),
        first: jest.fn(async () => {
          const hit = filterRows()[0];
          return hit ? { ...hit } : undefined;
        }),
        insert: jest.fn(() => ({ onConflict: () => ({ merge: jest.fn(async () => 1) }) })),
        update: jest.fn(async (patch) => {
          const hits = filterRows();
          hits.forEach((r) => Object.assign(r, patch));
          state.updates.push({ table, ids: hits.map((r) => r.id), patch });
          return hits.length;
        }),
      };
      return q;
    });
    conn.fn = { now: () => 'NOW' };
    conn.raw = (sql) => ({ __raw: sql });
    conn.transaction = async (fn) => fn(conn);
    return { conn, state };
  }

  test('classifySettledFailedAttempt distinguishes superseded paid, self-supersede, processing ACH, and dues-invoice settlement', async () => {
    jest.resetModules();
    const { classifySettledFailedAttempt, isFailedAllocationSettled } = require('../services/payment-failed-allocation');

    // 1. Superseded by a DIFFERENT paid payment row -> settled ('monthly')
    {
      const { conn } = makeAllocationConn({
        payments: [
          {
            id: 'pay-fail', customer_id: 'cust-1', status: 'failed',
            stripe_payment_intent_id: 'pi_fail_1', superseded_by_payment_id: 'pay-retry',
            payment_date: '2026-11-01', description: 'WaveGuard Monthly',
            metadata: { billed_month: '2026-11' },
          },
          {
            id: 'pay-retry', customer_id: 'cust-1', status: 'paid',
            stripe_payment_intent_id: 'pi_retry_1', superseded_by_payment_id: null,
            payment_date: '2026-11-04', description: 'WaveGuard Monthly (Retry)',
            metadata: { billed_month: '2026-11' },
          },
        ],
      });
      await expect(classifySettledFailedAttempt(conn, { paymentIntentId: 'pi_fail_1' })).resolves.toBe('monthly');
      await expect(isFailedAllocationSettled(conn, { paymentIntentId: 'pi_fail_1' })).resolves.toBe(true);
    }

    // 2. Self-supersede (SCA park) -> NOT settled
    {
      const { conn } = makeAllocationConn({
        payments: [
          {
            id: 'pay-sca', customer_id: 'cust-1', status: 'failed',
            stripe_payment_intent_id: 'pi_sca_1', superseded_by_payment_id: 'pay-sca',
            payment_date: '2026-11-01', description: 'WaveGuard Monthly',
            metadata: { billed_month: '2026-11' },
          },
        ],
      });
      await expect(classifySettledFailedAttempt(conn, { paymentIntentId: 'pi_sca_1' })).resolves.toBeNull();
    }

    // 3. Superseded by an in-flight ACH `processing` row -> NOT settled yet
    {
      const { conn } = makeAllocationConn({
        payments: [
          {
            id: 'pay-fail', customer_id: 'cust-1', status: 'failed',
            stripe_payment_intent_id: 'pi_fail_ach', superseded_by_payment_id: 'pay-ach',
            payment_date: '2026-11-01', description: 'WaveGuard Monthly',
            metadata: { billed_month: '2026-11' },
          },
          {
            id: 'pay-ach', customer_id: 'cust-1', status: 'processing',
            stripe_payment_intent_id: 'pi_ach_2', superseded_by_payment_id: null,
            payment_date: '2026-11-04', description: 'WaveGuard Monthly',
            metadata: { billed_month: '2026-11' },
          },
        ],
      });
      await expect(isFailedAllocationSettled(conn, { paymentIntentId: 'pi_fail_ach' })).resolves.toBe(false);
    }

    // 4. Settled via a paid/prepaid stamped dues invoice for the same (customer, billed_month)
    {
      const { conn } = makeAllocationConn({
        payments: [
          {
            id: 'pay-fail', customer_id: 'cust-1', status: 'failed',
            stripe_payment_intent_id: 'pi_fail_inv', superseded_by_payment_id: null,
            payment_date: '2026-11-01', description: 'WaveGuard Monthly',
            metadata: { billed_month: '2026-11' },
          },
        ],
        invoices: [
          {
            id: '00000000-0000-4000-8000-000000000099',
            customer_id: 'cust-1',
            payer_id: null,
            status: 'paid',
            line_items: [{ description: 'WaveGuard Monthly Membership (2026-11)', membership_dues_month: '2026-11', amount: 79 }],
          },
        ],
      });
      await expect(classifySettledFailedAttempt(conn, { paymentIntentId: 'pi_fail_inv' })).resolves.toBe('monthly');
    }

    // 5. Open (unpaid) stamped dues invoice does NOT settle the failure bell
    {
      const { conn } = makeAllocationConn({
        payments: [
          {
            id: 'pay-fail', customer_id: 'cust-1', status: 'failed',
            stripe_payment_intent_id: 'pi_fail_open', superseded_by_payment_id: null,
            payment_date: '2026-11-01', description: 'WaveGuard Monthly',
            metadata: { billed_month: '2026-11' },
          },
        ],
        invoices: [
          {
            id: '00000000-0000-4000-8000-000000000098',
            customer_id: 'cust-1',
            payer_id: null,
            status: 'sent',
            line_items: [{ description: 'WaveGuard Monthly Membership (2026-11)', membership_dues_month: '2026-11', amount: 79 }],
          },
        ],
      });
      await expect(isFailedAllocationSettled(conn, { paymentIntentId: 'pi_fail_open' })).resolves.toBe(false);
    }
  });

  test('sweepSettledPaymentFailedAlerts closes legacy and modern monthly bells with MONTHLY_RESOLUTION and invoice bells with RESOLUTION', async () => {
    jest.resetModules();
    const invId = '00000000-0000-4000-8000-000000000011';
    const doneColumns = jest.fn(({ resolution }) => ({ done_by: 'payments', resolution }));
    jest.doMock('../services/notification-service', () => ({
      _private: { doneColumns, openToCloser: (q) => q },
    }));
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

    const { conn, state } = makeAllocationConn({
      payments: [
        // Legacy monthly failure (bell payload has NO billedMonth — derived from ledger row)
        {
          id: 'pay-legacy-fail', customer_id: 'cust-1', status: 'failed',
          stripe_payment_intent_id: 'pi_legacy_m', superseded_by_payment_id: 'pay-legacy-ok',
          payment_date: '2026-10-05', description: 'WaveGuard Monthly',
          metadata: { billed_month: '2026-10' },
        },
        {
          id: 'pay-legacy-ok', customer_id: 'cust-1', status: 'paid',
          stripe_payment_intent_id: 'pi_legacy_ok', superseded_by_payment_id: null,
          payment_date: '2026-10-08', description: 'WaveGuard Monthly',
          metadata: { billed_month: '2026-10' },
        },
      ],
      invoices: [{ id: invId, status: 'paid' }],
      notifications: [
        {
          id: '00000000-0000-4000-8000-000000000101',
          recipient_type: 'admin', category: 'payment',
          metadata: { triggerKey: 'payment_failed', payload: { paymentIntentId: 'pi_legacy_m', customerId: 'cust-1' } },
        },
        {
          id: '00000000-0000-4000-8000-000000000102',
          recipient_type: 'admin', category: 'payment',
          metadata: { triggerKey: 'payment_failed', payload: { invoiceId: invId, paymentIntentId: 'pi_inv_1' } },
        },
      ],
    });

    const { sweepSettledPaymentFailedAlerts, RESOLUTION, MONTHLY_RESOLUTION } = require('../services/payment-failed-alert-close');
    const closed = await sweepSettledPaymentFailedAlerts({ conn });
    expect(closed).toBe(2);
    expect(state.notifications[0].resolution).toBe(MONTHLY_RESOLUTION);
    expect(state.notifications[1].resolution).toBe(RESOLUTION);
  });

  test('closePaymentFailedAlertsForMonthlyDues closes monthly bells and refuses to touch invoice-bearing bells', async () => {
    jest.resetModules();
    const invId = '00000000-0000-4000-8000-000000000022';
    jest.doMock('../services/notification-service', () => ({
      _private: {
        doneColumns: ({ resolution }) => ({ done_by: 'payments', resolution }),
        openToCloser: (q) => q,
      },
    }));
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

    const { conn, state } = makeAllocationConn({
      payments: [
        {
          id: 'pay-m-paid', customer_id: 'cust-1', status: 'paid',
          stripe_payment_intent_id: 'pi_m_ok', superseded_by_payment_id: null,
          payment_date: '2026-11-05', description: 'WaveGuard Monthly',
          metadata: { billed_month: '2026-11' },
        },
      ],
      invoices: [{ id: invId, status: 'paid' }],
      notifications: [
        {
          id: 'bell-monthly',
          recipient_type: 'admin', category: 'payment',
          metadata: { triggerKey: 'payment_failed', payload: { customerId: 'cust-1', billedMonth: '2026-11', paymentIntentId: 'pi_m_fail' } },
        },
        // Combined invoice bell with empty invoiceId but non-empty allocationInvoiceIds: must NOT be closed with MONTHLY_RESOLUTION
        {
          id: 'bell-combined-inv',
          recipient_type: 'admin', category: 'payment',
          metadata: { triggerKey: 'payment_failed', payload: { customerId: 'cust-1', allocationInvoiceIds: [invId], paymentIntentId: 'pi_comb' } },
        },
      ],
    });

    const { closePaymentFailedAlertsForMonthlyDues, MONTHLY_RESOLUTION } = require('../services/payment-failed-alert-close');
    const closed = await closePaymentFailedAlertsForMonthlyDues({ customerId: 'cust-1', billedMonth: '2026-11' }, conn);
    expect(closed).toBe(1);
    expect(state.notifications[0].resolution).toBe(MONTHLY_RESOLUTION);
    expect(state.notifications[1].resolution).toBeUndefined();
  });

  test('payment-failure-notifications suppresses delayed monthly failure push once dues settle and stamps billedMonth only on invoice-less alerts', async () => {
    jest.resetModules();
    const triggerNotification = jest.fn(async () => ({ bellWritten: true, push: { sent: 1 } }));
    const isFailedAllocationSettled = jest.fn();
    jest.doMock('../services/notification-triggers', () => ({ triggerNotification }));
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('../services/payment-failed-allocation', () => ({
      ...jest.requireActual('../services/payment-failed-allocation'),
      isFailedAllocationSettled,
    }));

    const inserted = [];
    const jobRow = {
      payment_intent_id: 'pi_monthly_fail',
      outcome: 'failed',
      attempt_id: 'ch_1',
      pending_payload: { amount: 79, customerId: 'cust-1', invoiceId: null, billedMonth: '2026-11', reason: 'Card declined' },
    };
    const dbMock = jest.fn((table) => {
      const q = {
        where: () => q,
        whereNotNull: () => q,
        whereIn: () => q,
        forUpdate: () => q,
        skipLocked: () => q,
        orderBy: () => q,
        limit: () => q,
        select: jest.fn(async () => (table === 'stripe_payment_notification_log' ? [{ payment_intent_id: jobRow.payment_intent_id, outcome: jobRow.outcome, attempt_id: jobRow.attempt_id }] : [])),
        first: jest.fn(async () => {
          if (table === 'stripe_payment_notification_log') return { ...jobRow };
          if (table === 'payments') return { id: 'pay-f', customer_id: 'cust-1', status: 'failed', metadata: { billed_month: '2026-11' } };
          if (table === 'customers') return { id: 'cust-1', first_name: 'Pat', last_name: 'Sample' };
          return null;
        }),
        insert: jest.fn((row) => {
          inserted.push(row);
          return { onConflict: () => ({ ignore: async () => 1 }) };
        }),
        update: jest.fn(async (patch) => {
          Object.assign(jobRow, patch);
          return 1;
        }),
      };
      return q;
    });
    dbMock.fn = { now: () => 'NOW' };
    dbMock.transaction = async (fn) => fn(dbMock);
    jest.doMock('../models/db', () => dbMock);

    const svc = require('../services/payment-failure-notifications');

    // Enqueue records billedMonth from PI metadata
    await svc.enqueuePaymentFailureNotification({
      id: 'pi_m_enq',
      amount: 7900,
      latest_charge: 'ch_enq',
      metadata: { waves_customer_id: 'cust-1', billed_month: '2026-11' },
    }, 'Card declined', 'evt_1');
    expect(inserted[0].pending_payload.billedMonth).toBe('2026-11');

    // When monthly dues are already settled, delayed notification is suppressed without calling triggerNotification
    isFailedAllocationSettled.mockResolvedValueOnce(true);
    await svc.processPendingPaymentFailureNotifications();
    expect(triggerNotification).not.toHaveBeenCalled();
    expect(isFailedAllocationSettled).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      paymentIntentId: 'pi_monthly_fail',
      customerId: 'cust-1',
      billedMonth: '2026-11',
    }));
    expect(jobRow.pending_payload).toBeNull();
  });

  test('reopenPaymentFailedBells reopens a monthly bell closed with MONTHLY_RESOLUTION when a stamped dues invoice manual payment is undone', async () => {
    jest.resetModules();
    const invId = '00000000-0000-4000-8000-000000000077';
    const since = new Date('2026-11-10T12:00:00Z');
    const { MONTHLY_RESOLUTION } = require('../services/payment-failed-alert-close');
    const { conn, state } = makeAllocationConn({
      invoices: [
        {
          id: invId,
          customer_id: 'cust-1',
          payer_id: null,
          status: 'sent', // already restored to unpaid by undoManualPayment
          line_items: [{ description: 'WaveGuard Monthly Membership (2026-11)', membership_dues_month: '2026-11', amount: 79 }],
        },
      ],
      payments: [
        {
          id: 'pay-f-m',
          customer_id: 'cust-1',
          status: 'failed',
          stripe_payment_intent_id: 'pi_m_fail_undo',
          payment_date: '2026-11-01',
          description: 'WaveGuard Monthly',
          metadata: { billed_month: '2026-11' },
        },
      ],
      notifications: [
        {
          id: 'bell-m-1',
          recipient_type: 'admin',
          category: 'payment',
          done_by: 'payments',
          done_at: new Date('2026-11-10T12:01:00Z'),
          resolution: MONTHLY_RESOLUTION,
          metadata: { triggerKey: 'payment_failed', payload: { customerId: 'cust-1', billedMonth: '2026-11', paymentIntentId: 'pi_m_fail_undo' } },
        },
      ],
    });
    const { reopenPaymentFailedBells } = require('../services/invoice-manual-payment-undo');
    const reopened = await reopenPaymentFailedBells(conn, invId, since);
    expect(reopened).toBe(1);
    expect(state.notifications[0]).toMatchObject({ done_at: null, done_by: null, resolution: null });
  });
});

// ============================================================================
// B-30: PUT /api/billing/cards/:id/default TOCTOU serialization
// ============================================================================
describe('B-30: PUT /api/billing/cards/:id/default TOCTOU races under customers FOR UPDATE', () => {
  function loadDefaultRoute({ customers, paymentMethods, hasConsent = false, onCustomerLock = null }) {
    jest.resetModules();
    const state = {
      customers: customers.map((c) => ({ ...c })),
      payment_methods: paymentMethods.map((m) => ({ ...m })),
      locks: [],
    };

    const builderFor = (table, inTx) => {
      const conds = [];
      let locked = false;
      const rows = () => (state[table] || []).filter((r) => conds.every((c) => c(r)));
      const b = {
        where: jest.fn((criteria, opOrVal, maybeVal) => {
          if (typeof criteria === 'object' && criteria !== null) {
            Object.entries(criteria).forEach(([k, v]) => conds.push((r) => r[k] === v));
          } else if (typeof criteria === 'string') {
            conds.push((r) => r[criteria] === (maybeVal === undefined ? opOrVal : maybeVal));
          }
          return b;
        }),
        select: jest.fn(() => b),
        orderBy: jest.fn(() => b),
        whereNotNull: jest.fn(() => b),
        whereIn: jest.fn(() => b),
        forUpdate: jest.fn(() => { locked = true; return b; }),
        first: jest.fn(async () => {
          if (locked && table === 'customers') {
            state.locks.push(`${inTx ? 'tx:' : 'out:'}customers`);
            if (onCustomerLock) onCustomerLock(state);
          }
          return rows()[0] ? { ...rows()[0] } : null;
        }),
        update: jest.fn(async (vals) => {
          const matched = rows();
          matched.forEach((r) => Object.assign(r, vals));
          return matched.length;
        }),
        then: (resolve, reject) => {
          if (locked) state.locks.push(`${inTx ? 'tx:' : 'out:'}${table}`);
          return Promise.resolve(rows().map((r) => ({ ...r }))).then(resolve, reject);
        },
      };
      return b;
    };

    const trx = Object.assign((t) => builderFor(t, true), { fn: { now: () => 'NOW' } });
    const dbMock = Object.assign((t) => builderFor(t, false), {
      transaction: jest.fn(async (fn) => fn(trx)),
      fn: { now: () => 'NOW' },
    });

    const hasEnrollmentScopedConsent = jest.fn(async () => hasConsent);
    const recordConsent = jest.fn(async () => ({ id: 'consent-1' }));

    jest.doMock('stripe', () => jest.fn(() => ({})));
    jest.doMock('express-rate-limit', () => () => (_req, _res, next) => next());
    jest.doMock('../middleware/auth', () => ({
      authenticate: (req, _res, next) => { req.customerId = 'cust-1'; next(); },
      isCancelledCustomerRow: () => false,
    }));
    jest.doMock('../models/db', () => dbMock);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('../config/stripe-config', () => ({}));
    jest.doMock('../services/stripe', () => ({}));
    jest.doMock('../services/autopay-log', () => ({ logAutopay: jest.fn().mockResolvedValue(null), getRecent: jest.fn().mockResolvedValue([]) }));
    jest.doMock('../services/payment-lifecycle-email', () => ({
      sendAutopayEnabled: jest.fn().mockResolvedValue(null),
      sendAutopayDisabled: jest.fn().mockResolvedValue(null),
      sendPaymentMethodUpdated: jest.fn().mockResolvedValue(null),
      sendPaymentMethodRemoved: jest.fn().mockResolvedValue(null),
    }));
    jest.doMock('../services/card-enrollment-email', () => ({ sendAutopayEnrollmentConfirmation: jest.fn().mockResolvedValue(null) }));
    jest.doMock('../services/payment-method-consents', () => ({ hasEnrollmentScopedConsent, recordConsent }));

    const router = require('../routes/billing-v2');
    const { CONSENT_VERSION } = require('../services/payment-method-consent-text');
    return { router, state, hasEnrollmentScopedConsent, recordConsent, trx, CONSENT_VERSION };
  }

  test('concurrent Auto Pay disable before customers FOR UPDATE does NOT re-enable Auto Pay or stamp autopay_enabled on the new default', async () => {
    const { router, state, hasEnrollmentScopedConsent } = loadDefaultRoute({
      customers: [{ id: 'cust-1', autopay_enabled: true, autopay_payment_method_id: 'pm-old', ach_status: null }],
      paymentMethods: [
        { id: 'pm-old', customer_id: 'cust-1', processor: 'stripe', stripe_payment_method_id: 'pm_old', method_type: 'card', exp_month: 12, exp_year: 2032, is_default: true, autopay_enabled: true },
        { id: 'pm-new', customer_id: 'cust-1', processor: 'stripe', stripe_payment_method_id: 'pm_new', method_type: 'card', exp_month: 12, exp_year: 2032, is_default: false, autopay_enabled: false },
      ],
      onCustomerLock: (st) => {
        // Concurrent PUT /autopay disable committed just before this tx acquired customers FOR UPDATE
        st.customers[0].autopay_enabled = false;
        st.customers[0].autopay_payment_method_id = null;
        st.payment_methods.forEach((m) => { m.autopay_enabled = false; });
      },
    });

    await withServer('/api/billing', router, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/billing/cards/pm-new/default`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(200);
    });
    expect(state.locks).toEqual(['tx:customers', 'tx:payment_methods']);
    expect(hasEnrollmentScopedConsent).not.toHaveBeenCalled();
    expect(state.customers[0].autopay_enabled).toBe(false);
    expect(state.customers[0].autopay_payment_method_id).toBeNull();
    expect(state.payment_methods.find((m) => m.id === 'pm-new')).toMatchObject({ is_default: true, autopay_enabled: false });
    expect(state.payment_methods.find((m) => m.id === 'pm-old')).toMatchObject({ is_default: false, autopay_enabled: false });
  });

  test('concurrent Auto Pay enable before customers FOR UPDATE enforces enrollment consent (409) instead of splitting pointers', async () => {
    const { router, state, hasEnrollmentScopedConsent, trx } = loadDefaultRoute({
      customers: [{ id: 'cust-1', autopay_enabled: false, autopay_payment_method_id: null, ach_status: null }],
      paymentMethods: [
        { id: 'pm-old', customer_id: 'cust-1', processor: 'stripe', stripe_payment_method_id: 'pm_old', method_type: 'card', exp_month: 12, exp_year: 2032, is_default: true, autopay_enabled: false },
        { id: 'pm-new', customer_id: 'cust-1', processor: 'stripe', stripe_payment_method_id: 'pm_new', method_type: 'card', exp_month: 12, exp_year: 2032, is_default: false, autopay_enabled: false },
      ],
      hasConsent: false,
      onCustomerLock: (st) => {
        // Concurrent Auto Pay enable committed before lock acquisition
        st.customers[0].autopay_enabled = true;
        st.customers[0].autopay_payment_method_id = 'pm-old';
        st.payment_methods[0].autopay_enabled = true;
      },
    });

    await withServer('/api/billing', router, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/billing/cards/pm-new/default`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({ code: 'consent_required' });
    });
    expect(hasEnrollmentScopedConsent).toHaveBeenCalledWith('cust-1', 'pm_new', { dbh: trx });
    // Nothing mutated on refusal
    expect(state.payment_methods.find((m) => m.id === 'pm-old')).toMatchObject({ is_default: true, autopay_enabled: true });
    expect(state.payment_methods.find((m) => m.id === 'pm-new')).toMatchObject({ is_default: false, autopay_enabled: false });
  });

  test('carrying Auto Pay clears autopay_enabled on ALL other customer cards inside the lock (no duplicate autopay_enabled=true rows)', async () => {
    const { router, state, recordConsent, trx, CONSENT_VERSION } = loadDefaultRoute({
      customers: [{ id: 'cust-1', autopay_enabled: true, autopay_payment_method_id: 'pm-old', ach_status: null }],
      paymentMethods: [
        { id: 'pm-old', customer_id: 'cust-1', processor: 'stripe', stripe_payment_method_id: 'pm_old', method_type: 'card', exp_month: 12, exp_year: 2032, is_default: true, autopay_enabled: true },
        { id: 'pm-stray', customer_id: 'cust-1', processor: 'stripe', stripe_payment_method_id: 'pm_stray', method_type: 'card', exp_month: 12, exp_year: 2032, is_default: false, autopay_enabled: true },
        { id: 'pm-new', customer_id: 'cust-1', processor: 'stripe', stripe_payment_method_id: 'pm_new', method_type: 'card', exp_month: 12, exp_year: 2032, is_default: false, autopay_enabled: false },
      ],
      hasConsent: false,
    });

    await withServer('/api/billing', router, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/billing/cards/pm-new/default`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ consent_accepted: true, consentTextVersion: CONSENT_VERSION }),
      });
      expect(res.status).toBe(200);
    });
    expect(recordConsent).toHaveBeenCalledWith(expect.objectContaining({ database: trx, stripePaymentMethodId: 'pm_new' }));
    const autopayOn = state.payment_methods.filter((m) => m.autopay_enabled);
    expect(autopayOn.map((m) => m.id)).toEqual(['pm-new']);
    expect(state.customers[0].autopay_payment_method_id).toBe('pm-new');
  });
});

// ============================================================================
// B-51: billing_day 29/30/31 clamping in shorter months
// ============================================================================
describe('B-51: billing_day 29/30/31 clamps to month end in shorter months', () => {
  test('daysInMonth, effectiveBillingDay, and isBillingDayMatch clamp 29/30/31 to the target month end', () => {
    jest.resetModules();
    const { daysInMonth, effectiveBillingDay, isBillingDayMatch } = require('../services/billing-helpers');

    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 11)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);

    expect(effectiveBillingDay(31, 28)).toBe(28);
    expect(effectiveBillingDay(30, 28)).toBe(28);
    expect(effectiveBillingDay(29, 28)).toBe(28);
    expect(effectiveBillingDay(31, 29)).toBe(29);
    expect(effectiveBillingDay(31, 30)).toBe(30);
    expect(effectiveBillingDay(15, 28)).toBe(15);

    // Non-leap Feb 28 bills 28, 29, 30, 31
    expect(isBillingDayMatch(28, 28, 28)).toBe(true);
    expect(isBillingDayMatch(29, 28, 28)).toBe(true);
    expect(isBillingDayMatch(30, 28, 28)).toBe(true);
    expect(isBillingDayMatch(31, 28, 28)).toBe(true);
    expect(isBillingDayMatch(27, 28, 28)).toBe(false);

    // Leap Feb: day 28 does NOT bill 29/30/31; day 29 DOES bill 29/30/31
    expect(isBillingDayMatch(29, 28, 29)).toBe(false);
    expect(isBillingDayMatch(31, 28, 29)).toBe(false);
    expect(isBillingDayMatch(29, 29, 29)).toBe(true);
    expect(isBillingDayMatch(30, 29, 29)).toBe(true);
    expect(isBillingDayMatch(31, 29, 29)).toBe(true);

    // 30-day months (Apr/Jun/Sep/Nov): day 30 bills 30 & 31
    expect(isBillingDayMatch(31, 30, 30)).toBe(true);
    expect(isBillingDayMatch(30, 30, 30)).toBe(true);
    expect(isBillingDayMatch(31, 29, 30)).toBe(false);

    // 31-day months: day 30 does NOT bill 31; day 31 DOES
    expect(isBillingDayMatch(31, 30, 31)).toBe(false);
    expect(isBillingDayMatch(31, 31, 31)).toBe(true);
  });

  test('processMonthlyBilling on Feb 28 (non-leap) and Apr 30 bills billing_day 29/30/31 customers via clamped isBillingDayMatch', async () => {
    jest.resetModules();
    const chargedIds = [];
    const customers = [
      { id: 'c28', billing_day: 28, autopay_enabled: true, active: true, deleted_at: null, monthly_rate: 79, autopay_payment_method_id: 'pm28', billing_mode: 'monthly_membership', first_name: 'A', last_name: 'One', phone: null, email: null },
      { id: 'c29', billing_day: 29, autopay_enabled: true, active: true, deleted_at: null, monthly_rate: 79, autopay_payment_method_id: 'pm29', billing_mode: 'monthly_membership', first_name: 'B', last_name: 'Two', phone: null, email: null },
      { id: 'c31', billing_day: 31, autopay_enabled: true, active: true, deleted_at: null, monthly_rate: 79, autopay_payment_method_id: 'pm31', billing_mode: 'monthly_membership', first_name: 'C', last_name: 'Three', phone: null, email: null },
    ];
    const dbMock = jest.fn((table) => {
      let targetId = null;
      const q = {
        where: (...a) => {
          if (a[0] === 'id') targetId = a[1];
          else if (a[0] && typeof a[0] === 'object' && a[0].id !== undefined) targetId = a[0].id;
          return q;
        },
        whereNull: () => q,
        whereNotNull: () => q,
        whereIn: () => q,
        whereNot: () => q,
        whereRaw: () => q,
        andWhere: () => q,
        orWhere: () => q,
        orderBy: () => q,
        distinct: () => q,
        select: () => q,
        first: jest.fn(async () => (table === 'customers' ? customers.find((c) => c.id === targetId) || null : null)),
        pluck: jest.fn(async () => []),
        then: (resolve, reject) => Promise.resolve(table === 'customers' ? customers : []).then(resolve, reject),
      };
      return q;
    });
    dbMock.raw = jest.fn(async () => ({ rows: [{ acquired: true }] }));
    dbMock.schema = { hasTable: jest.fn(async () => true) };
    dbMock.fn = { now: () => new Date() };
    jest.doMock('../models/db', () => dbMock);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
    jest.doMock('../services/annual-prepay-renewals', () => ({
      activatePaidPendingTerms: jest.fn(async () => {}),
      getActivelyCoveredCustomerIds: jest.fn(async () => new Set()),
      getPaymentPendingCustomerIds: jest.fn(async () => new Set()),
    }));
    jest.doMock('../utils/customer-billing-lock', () => ({
      withCustomerBillingLock: jest.fn(async (_cid, fn) => fn()),
    }));
    jest.doMock('../services/retry-collectibility', () => ({
      ...jest.requireActual('../services/retry-collectibility'),
      findCollectedMonthlyPayment: jest.fn(async () => null),
      monthlyAttemptHasRecovery: jest.fn(async () => false),
      hasUnresolvedSiblingStripeOutcome: jest.fn(async () => ({ blocked: false })),
      deriveMonthlyChargeIdempotencyKey: jest.fn(async (cid, m) => `monthly_${cid}_${m}`),
    }));
    jest.doMock('../services/billing-lane', () => ({
      ...jest.requireActual('../services/billing-lane'),
      findLiveStampedDuesInvoice: jest.fn(async () => null),
      acquireMembershipDuesMonthLock: jest.fn(async () => true),
      tryAcquireMembershipDuesMonthLock: jest.fn(async () => true),
      acquireMembershipDuesMonthLockBounded: jest.fn(async () => true),
    }));
    jest.doMock('../services/autopay-log', () => ({ logAutopay: jest.fn(async () => null) }));
    jest.doMock('../services/health-alert-insert', () => ({ insertHealthAlert: jest.fn(async () => null) }));
    jest.doMock('../services/payment-failed-alert-close', () => ({ closePaymentFailedAlertsForMonthlyDues: jest.fn(async () => 0) }));
    jest.doMock('../services/stripe', () => ({
      chargeMonthly: jest.fn(async (cid) => {
        chargedIds.push(cid);
        return { id: `pay-${cid}`, status: 'paid', amount: 79 };
      }),
    }));

    const { processMonthlyBilling } = require('../services/billing-cron');
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
      jest.setSystemTime(new Date('2026-02-28T15:00:00Z'));
      await processMonthlyBilling({ billingDate: '2026-02-28' });
      expect(chargedIds.sort()).toEqual(['c28', 'c29', 'c31']);

      chargedIds.length = 0;
      jest.setSystemTime(new Date('2026-04-30T15:00:00Z'));
      await processMonthlyBilling({ billingDate: '2026-04-30' });
      expect(chargedIds).toEqual(['c31']);
    } finally {
      jest.useRealTimers();
    }
  });
});

// ============================================================================
// B-54: Canonical recurring lineage predicate across card/completion rails
// ============================================================================
describe('B-54: Canonical isRecurringLineageVisit across terminal-save-card, appointment-card-request & completion-charge-verdict', () => {
  test('saveCardEligibility / disclosedCapEligibility accepts booster (recurring_parent_id) and pattern (recurring_pattern) visits even when is_recurring is false', async () => {
    const req = { id: 'req-1', status: 'pending', kind: 'visit', scheduled_service_id: 'visit-1', customer_id: 'cust-1', accepted_amount: null };
    for (const visit of [
      { is_recurring: false, recurring_parent_id: 'parent-visit-1', recurring_pattern: null },
      { is_recurring: false, recurring_parent_id: null, recurring_pattern: 'quarterly' },
    ]) {
      jest.resetModules();
      jest.doMock('../models/db', () => jest.fn(() => ({
        where: () => ({ first: jest.fn(async () => visit) }),
      })));
      jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
      jest.doMock('../services/appointment-card-request', () => ({ secureVisitStillNeedsCard: jest.fn(async () => ({ ok: true })) }));
      jest.doMock('../services/secure-appointment-plans', () => ({ buildSecurePlanContext: jest.fn(async () => null) }));
      const { saveCardEligibility } = require('../services/terminal-save-card');
      await expect(saveCardEligibility(req)).resolves.toEqual({ ok: true });
    }

    // Genuine one-time visit without accepted_amount is still refused
    jest.resetModules();
    jest.doMock('../models/db', () => jest.fn(() => ({
      where: () => ({ first: jest.fn(async () => ({ is_recurring: false, recurring_parent_id: null, recurring_pattern: null })) }),
    })));
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('../services/appointment-card-request', () => ({ secureVisitStillNeedsCard: jest.fn(async () => ({ ok: true })) }));
    jest.doMock('../services/secure-appointment-plans', () => ({ buildSecurePlanContext: jest.fn(async () => null) }));
    const { saveCardEligibility } = require('../services/terminal-save-card');
    await expect(saveCardEligibility(req)).resolves.toEqual({ ok: false, code: 'price_not_disclosed' });
  });

  test('resolveAppointmentCardLane treats booster and pattern visits (is_recurring=false) as recurring (not one-time capped lane)', async () => {
    jest.resetModules();
    jest.doMock('../config/feature-gates', () => ({ isEnabled: () => true }));
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    const conn = jest.fn();
    jest.doMock('../models/db', () => conn);
    const { resolveAppointmentCardLane } = require('../services/completion-charge-verdict');

    for (const svc of [
      { id: 'v-booster', customer_id: 'c1', is_recurring: false, recurring_parent_id: 'v-parent', recurring_pattern: null },
      { id: 'v-pattern', customer_id: 'c1', is_recurring: false, recurring_parent_id: null, recurring_pattern: 'bi_monthly' },
    ]) {
      const verdict = await resolveAppointmentCardLane({
        svc,
        invoice: { id: 'inv-1', total: 149, subtotal: 149, payer_id: null },
        alreadyPaid: false,
        visitPerformed: true,
        perApplicationBilling: false,
        annualPrepayBilling: false,
        explicitMembershipLane: false,
        conn,
      });
      expect(verdict.apptCardOneTimeCharge).toBe(false);
    }
    expect(conn).not.toHaveBeenCalled();
  });

  test('chargeAppointmentCardForRecapCompletion returns not_one_time for booster and pattern visits (is_recurring=false)', async () => {
    for (const visit of [
      { id: 'v1', customer_id: 'c1', is_recurring: false, recurring_parent_id: 'v-parent', recurring_pattern: null, service_type: 'General Pest' },
      { id: 'v2', customer_id: 'c1', is_recurring: false, recurring_parent_id: null, recurring_pattern: 'monthly', service_type: 'General Pest' },
    ]) {
      jest.resetModules();
      jest.dontMock('../services/appointment-card-request');
      jest.doMock('../config/feature-gates', () => ({ isEnabled: () => true }));
      jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
      const dbMock = jest.fn((table) => ({
        where: () => ({
          whereIn: () => ({ first: jest.fn(async () => ({ id: 'req-1', customer_id: 'c1', accepted_amount: 149 })) }),
          first: jest.fn(async () => {
            if (table === 'scheduled_services') return visit;
            if (table === 'estimate_card_holds') return null;
            return null;
          }),
        }),
      }));
      jest.doMock('../models/db', () => dbMock);
      const { chargeAppointmentCardForRecapCompletion } = require('../services/appointment-card-request');
      const res = await chargeAppointmentCardForRecapCompletion({ scheduledServiceId: visit.id, serviceRecordId: 'sr-1' });
      expect(res).toEqual({ charged: false, reason: 'not_one_time' });
    }
  });
});

// ============================================================================
// B-59: secure-card-public safe error logs & card-public no-store on 200/404/429
// ============================================================================
describe('B-59: secure-card-public safe error logs & card-public Cache-Control: private, no-store', () => {
  const VALID_TOKEN = 'a'.repeat(64);
  const SECRET_LEAK = 'select * from appointment_card_requests where token = secret_bearer_xyz';

  test('secure-card-public logs only error code/name (never raw err.message) on all catch handlers', async () => {
    jest.resetModules();
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const boom = Object.assign(new Error(SECRET_LEAK), { code: 'ECONNRESET' });

    jest.doMock('express-rate-limit', () => () => (_req, _res, next) => next());
    jest.doMock('../services/logger', () => logger);
    jest.doMock('../models/db', () => jest.fn());
    jest.doMock('../services/appointment-card-request', () => ({
      loadSecureCardPageData: jest.fn().mockRejectedValue(boom),
      recordSecureCardView: jest.fn(),
      completeSecureCardCapture: jest.fn().mockRejectedValue(boom),
      replaceSecureCardIntent: jest.fn().mockRejectedValue(boom),
    }));
    jest.doMock('../services/secure-appointment-plans', () => ({
      selectSecurePlan: jest.fn().mockRejectedValue(boom),
    }));
    const { CONSENT_VERSION } = require('../services/payment-method-consent-text');
    const router = require('../routes/secure-card-public');

    await withServer('/api/secure-card', router, async (baseUrl) => {
      const r1 = await fetch(`${baseUrl}/api/secure-card/${VALID_TOKEN}?consentTextVersion=${encodeURIComponent(CONSENT_VERSION)}`);
      expect(r1.status).toBe(500);
      const r2 = await fetch(`${baseUrl}/api/secure-card/${VALID_TOKEN}/select-plan`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan: 'per_application' }),
      });
      expect(r2.status).toBe(500);
      const r3 = await fetch(`${baseUrl}/api/secure-card/${VALID_TOKEN}/replace-intent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ consentTextVersion: CONSENT_VERSION }),
      });
      expect(r3.status).toBe(500);
      const r4 = await fetch(`${baseUrl}/api/secure-card/${VALID_TOKEN}/complete`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ consentTextVersion: CONSENT_VERSION }),
      });
      expect(r4.status).toBe(500);
    });

    expect(logger.error).toHaveBeenCalledTimes(4);
    for (const [msg] of logger.error.mock.calls) {
      expect(msg).not.toContain(SECRET_LEAK);
      expect(msg).not.toContain('secret_bearer_xyz');
      expect(msg).toContain('ECONNRESET');
    }
  });

  test('card-public stamps Cache-Control: private, no-store on 200, 404 (all endpoints), and 429 rate-limit responses', async () => {
    jest.resetModules();
    let hitCount = 0;
    jest.doMock('express-rate-limit', () => () => (_req, res, next) => {
      hitCount += 1;
      if (hitCount > 4) return res.status(429).json({ error: 'Too many requests' });
      return next();
    });
    jest.doMock('../models/db', () => jest.fn(() => ({ where: () => ({ first: jest.fn(async () => null) }) })));
    jest.doMock('../services/customer-card', () => ({
      getCardData: jest.fn(async (tok) => (tok === VALID_TOKEN ? { ok: true } : null)),
      buildVcard: jest.fn(() => 'BEGIN:VCARD\nEND:VCARD'),
    }));
    jest.doMock('../services/wallet-pass', () => ({
      walletConfigured: () => false,
      generateForToken: jest.fn(async () => null),
    }));

    const router = require('../routes/card-public');
    await withServer('/api/card', router, async (baseUrl) => {
      // 1. 200 JSON
      const ok = await fetch(`${baseUrl}/api/card/${VALID_TOKEN}`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get('cache-control')).toBe('private, no-store');

      // 2. 404 JSON (unknown token)
      const notFound = await fetch(`${baseUrl}/api/card/${'b'.repeat(64)}`);
      expect(notFound.status).toBe(404);
      expect(notFound.headers.get('cache-control')).toBe('private, no-store');

      // 3. 404 vCard (malformed token)
      const badVcf = await fetch(`${baseUrl}/api/card/not-a-valid-token/contact.vcf`);
      expect(badVcf.status).toBe(404);
      expect(badVcf.headers.get('cache-control')).toBe('private, no-store');

      // 4. 404 wallet pass (not configured)
      const noWallet = await fetch(`${baseUrl}/api/card/${VALID_TOKEN}/wallet.pkpass`);
      expect(noWallet.status).toBe(404);
      expect(noWallet.headers.get('cache-control')).toBe('private, no-store');

      // 5. 429 rate-limited response
      const limited = await fetch(`${baseUrl}/api/card/${VALID_TOKEN}`);
      expect(limited.status).toBe(429);
      expect(limited.headers.get('cache-control')).toBe('private, no-store');
    });
  });
});
