// Regression tests for PR 6 Billing Audit Remediation: B-17, B-18, B-19, and B-43 (setup-fee-obligation leg).
// Covers:
//   B-17: Bill-and-send open-lead pre-check, deferred alert reconcile on Step 1, alert reopen with draft number
//         on Step 2 failure/conflict/unconfirmed, reconcile guard on standing unsent bill-button drafts,
//         aligned global lock order in InvoiceService.create, and 40P01/pg_try_advisory_xact_lock in sendVerify.
//   B-18 & B-43: setupFeeSettledElsewhere date lower bound, property scope (invoices & annual prepay terms),
//         credit-settled status='prepaid', setup_fee_waived column, settled-status requirement for $0 waived
//         lines, and partial refund handling (payments.refund_amount / status='partially_refunded').
//   B-19: restoreRodentSetupObligationForReversedInvoice routes /secure plan-choice Pest/Mosquito claims to
//         the WaveGuard branch (never re-arming refunded fees or minting "Bait Station Setup" drafts).

'use strict';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const EST = '00000000-0000-4000-8000-0000000e6001';
const EST_PROP_A = '00000000-0000-4000-8000-0000000e600a';
const VISIT = '00000000-0000-4000-8000-0000000a6001';
const RECORD = '00000000-0000-4000-8000-0000000c6001';
const CUST = '00000000-0000-4000-8000-0000000b6001';
const INV = '00000000-0000-4000-8000-0000000d6001';

// ── B-18 & B-43: setupFeeSettledElsewhere ───────────────────────

function makeObligationConn(tables = {}) {
  const handler = (table) => {
    const state = { whereObj: {}, whereRawSql: '' };
    const chain = {};
    ['where', 'whereRaw', 'whereIn', 'whereNot', 'whereNull', 'whereNotNull', 'orWhere', 'orWhereIn', 'orWhereRaw', 'orWhereNotNull', 'whereExists', 'orderBy', 'forUpdate', 'leftJoin', 'whereNotIn', 'andWhere'].forEach((m) => {
      chain[m] = jest.fn((...args) => {
        if (m === 'where' && args[0] && typeof args[0] === 'object') Object.assign(state.whereObj, args[0]);
        if (m === 'whereRaw') state.whereRawSql += String(args[0] || '');
        if (m !== 'whereExists' && typeof args[0] === 'function') args[0].call(chain, chain);
        return chain;
      });
    });
    const resolve = () => {
      const spec = tables[table];
      if (typeof spec === 'function') return spec(state);
      return spec ?? null;
    };
    chain.first = jest.fn(async () => {
      const v = resolve();
      return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
    });
    chain.select = jest.fn(async () => {
      const v = resolve();
      return Array.isArray(v) ? v : (v ? [v] : []);
    });
    return chain;
  };
  return Object.assign((table) => handler(table), {
    raw: jest.fn((sql) => ({ __raw: sql })),
    fn: { now: jest.fn(() => 'NOW') },
  });
}

describe('B-18 & B-43: setupFeeSettledElsewhere date lower bound, property scope, prepaid, setup_fee_waived, and partial refunds', () => {
  const { setupFeeSettledElsewhere } = require('../services/setup-fee-obligation');
  const recent = '2026-11-20T15:00:00Z';

  test('rejects an 8-month-old paid setup-fee invoice prior to the estimate creation/accept date', async () => {
    const conn = makeObligationConn({
      estimates: { id: EST, created_at: '2026-11-01T15:00:00Z', accepted_at: '2026-11-05T15:00:00Z', property_id: 'prop-a', address: '100 Oak St, Testville, FL 34200' },
      invoices: [{
        id: 'inv-old', status: 'paid', created_at: '2026-03-01T15:00:00Z',
        line_items: [{ description: 'WaveGuard Membership', amount: 99 }],
      }],
      'annual_prepay_terms as t': [],
    });
    const res = await setupFeeSettledElsewhere(conn, { customerId: CUST, expectedFeeCents: 9900, sourceEstimateId: EST });
    expect(res.settled).toBe(false);
  });

  test('rejects a paid setup-fee invoice from Property A when checking Property B (both visit link and address snapshot)', async () => {
    const connVisit = makeObligationConn({
      estimates: { id: EST, created_at: '2026-11-01T15:00:00Z', property_id: 'prop-b', address: '200 Pine St, Testville, FL 34200' },
      invoices: [{
        id: 'inv-prop-a', status: 'paid', created_at: recent, scheduled_service_id: 'ss-prop-a',
        line_items: [{ description: 'WaveGuard Membership', amount: 99 }],
      }],
      scheduled_services: { id: 'ss-prop-a', property_id: 'prop-a', service_address_line1: '100 Oak St', service_address_city: 'Testville', service_address_zip: '34200' },
      'annual_prepay_terms as t': [],
    });
    expect((await setupFeeSettledElsewhere(connVisit, { customerId: CUST, expectedFeeCents: 9900, sourceEstimateId: EST })).settled).toBe(false);

    const connSnap = makeObligationConn({
      estimates: { id: EST, created_at: '2026-11-01T15:00:00Z', property_id: 'prop-b', address: '200 Pine St, Testville, FL 34200' },
      invoices: [{
        id: 'inv-snap-a', status: 'paid', created_at: recent,
        customer_address_snapshot: { address_line1: '100 Oak St', city: 'Testville', state: 'FL', zip: '34200' },
        line_items: [{ description: 'WaveGuard Membership', amount: 99 }],
      }],
      'annual_prepay_terms as t': [],
    });
    expect((await setupFeeSettledElsewhere(connSnap, { customerId: CUST, expectedFeeCents: 9900, sourceEstimateId: EST })).settled).toBe(false);

    // Same property DOES settle.
    const connSame = makeObligationConn({
      estimates: { id: EST, created_at: '2026-11-01T15:00:00Z', property_id: 'prop-b', address: '200 Pine St, Testville, FL 34200' },
      invoices: [{
        id: 'inv-prop-b', status: 'paid', created_at: recent, scheduled_service_id: 'ss-prop-b',
        line_items: [{ description: 'WaveGuard Membership', amount: 99 }],
      }],
      scheduled_services: { id: 'ss-prop-b', property_id: 'prop-b', service_address_line1: '200 Pine St', service_address_city: 'Testville', service_address_zip: '34200' },
      'annual_prepay_terms as t': [],
    });
    expect(await setupFeeSettledElsewhere(connSame, { customerId: CUST, expectedFeeCents: 9900, sourceEstimateId: EST }))
      .toMatchObject({ settled: true, reason: 'paid_fee', invoiceId: 'inv-prop-b' });
  });

  test('rejects an annual prepay term sourced from Property A when checking Property B', async () => {
    const conn = makeObligationConn({
      estimates: ({ whereObj }) => (whereObj.id === EST_PROP_A
        ? { id: EST_PROP_A, property_id: 'prop-a', address: '100 Oak St, Testville, FL 34200' }
        : { id: EST, created_at: '2026-11-01T15:00:00Z', property_id: 'prop-b', address: '200 Pine St, Testville, FL 34200' }),
      invoices: [],
      'annual_prepay_terms as t': [{ id: 'term-prop-a', source_estimate_id: EST_PROP_A, status: 'active' }],
    });
    expect((await setupFeeSettledElsewhere(conn, { customerId: CUST, expectedFeeCents: 9900, sourceEstimateId: EST })).settled).toBe(false);
  });

  test('treats status="prepaid" identically to "paid" and honors invoices.setup_fee_waived=true', async () => {
    const prepaidWaived = makeObligationConn({
      invoices: [{ id: 'inv-cred-waived', status: 'prepaid', setup_fee_waived: true, created_at: recent, line_items: [{ description: 'Pest Control', amount: 97 }] }],
      'annual_prepay_terms as t': [],
    });
    expect(await setupFeeSettledElsewhere(prepaidWaived, { customerId: CUST, expectedFeeCents: 9900 }))
      .toMatchObject({ settled: true, reason: 'waived', invoiceId: 'inv-cred-waived' });

    const prepaidZeroLine = makeObligationConn({
      invoices: [{ id: 'inv-cred-zero', status: 'prepaid', created_at: recent, line_items: [{ description: 'WaveGuard setup fee (waived)', amount: 0 }] }],
      'annual_prepay_terms as t': [],
    });
    expect(await setupFeeSettledElsewhere(prepaidZeroLine, { customerId: CUST, expectedFeeCents: 9900 }))
      .toMatchObject({ settled: true, reason: 'waived', invoiceId: 'inv-cred-zero' });

    // Unpaid invoice with setup_fee_waived=true or $0 waived line does NOT settle.
    const unpaid = makeObligationConn({
      invoices: [{ id: 'inv-unpaid', status: 'sent', setup_fee_waived: true, created_at: recent, line_items: [{ description: 'WaveGuard setup fee (waived)', amount: 0 }] }],
      'annual_prepay_terms as t': [],
    });
    expect((await setupFeeSettledElsewhere(unpaid, { customerId: CUST, expectedFeeCents: 9900 })).settled).toBe(false);
  });

  test('B-43: detects partial refunds on combined paid invoices and handles status="partially_refunded"', async () => {
    // Combined setup+app invoice paid via Stripe then $99 partially refunded (invoice stays status='paid').
    const combinedPartialRefund = makeObligationConn({
      invoices: [{
        id: 'inv-combo', status: 'paid', created_at: recent, stripe_payment_intent_id: 'pi_combo_1',
        line_items: [{ description: 'First service application', amount: 45 }, { description: 'WaveGuard Membership', amount: 99 }],
      }],
      payments: [{ id: 'pay-1', stripe_payment_intent_id: 'pi_combo_1', refund_amount: 99, refund_status: 'partial' }],
      'annual_prepay_terms as t': [],
    });
    expect(await setupFeeSettledElsewhere(combinedPartialRefund, { customerId: CUST, expectedFeeCents: 9900 }))
      .toMatchObject({ settled: true, reason: 'paid_fee', invoiceId: 'inv-combo', partiallyRefunded: true });

    // Invoice with status='partially_refunded' and positive setup fee line is recognized cleanly.
    const statusPartiallyRefunded = makeObligationConn({
      invoices: [{
        id: 'inv-pr', status: 'partially_refunded', created_at: recent,
        line_items: [{ description: 'WaveGuard Membership', amount: 99 }],
      }],
      'annual_prepay_terms as t': [],
    });
    expect(await setupFeeSettledElsewhere(statusPartiallyRefunded, { customerId: CUST, expectedFeeCents: 9900 }))
      .toMatchObject({ settled: true, reason: 'paid_fee', invoiceId: 'inv-pr', partiallyRefunded: true });

    // Partially refunded annual-prepay / waived bundle (status stays 'paid') MUST NOT falsely settle the setup fee.
    const refundedBundle = makeObligationConn({
      invoices: [{
        id: 'inv-bundle-pr', status: 'paid', setup_fee_waived: true, created_at: recent, stripe_payment_intent_id: 'pi_bundle_1',
        line_items: [{ description: 'WaveGuard Membership — 12 months prepaid (setup fee waived)', category: 'Annual prepay', amount: 388 }],
      }],
      payments: [{ id: 'pay-2', stripe_payment_intent_id: 'pi_bundle_1', refund_amount: 99, refund_status: 'partial' }],
      'annual_prepay_terms as t': [],
    });
    expect((await setupFeeSettledElsewhere(refundedBundle, { customerId: CUST, expectedFeeCents: 9900 })).settled).toBe(false);
  });
});

// ── B-19: restoreRodentSetupObligationForReversedInvoice ────────

describe('B-19: /secure plan-choice Pest/Mosquito setup-fee reversal stays in WaveGuard branch', () => {
  const InvoiceService = require('../services/invoice');

  function makeReversalConn({ claimRow, seriesRow, liveChild = null }) {
    const writes = [];
    const conn = (table) => {
      const state = { whereObj: {} };
      const q = {};
      ['where', 'whereNull', 'whereNotNull', 'whereIn', 'whereNotIn', 'whereRaw', 'orderBy', 'forUpdate', 'leftJoin'].forEach((m) => {
        q[m] = jest.fn((...args) => {
          if (m === 'where' && args[0] && typeof args[0] === 'object') Object.assign(state.whereObj, args[0]);
          return q;
        });
      });
      q.first = jest.fn(async () => {
        if (table === 'setup_fee_claims') return claimRow;
        if (table === 'annual_prepay_terms') return null;
        if (table === 'scheduled_services') {
          if (state.whereObj.recurring_parent_id) return liveChild;
          return seriesRow;
        }
        if (table === 'estimates') return { id: EST, estimate_data: {} };
        return null;
      });
      q.select = jest.fn(async () => {
        if (table === 'scheduled_services') return seriesRow ? [seriesRow] : [];
        return [];
      });
      q.update = jest.fn(async (patch) => { writes.push({ table, op: 'update', where: state.whereObj, patch }); return 1; });
      q.delete = jest.fn(async () => { writes.push({ table, op: 'delete', where: state.whereObj }); return 1; });
      q.insert = jest.fn((row) => {
        writes.push({ table, op: 'insert', row });
        return Object.assign(Promise.resolve([row]), { returning: async () => [row], onConflict: () => ({ ignore: async () => 1 }) });
      });
      return q;
    };
    conn.raw = jest.fn((sql) => ({ __raw: sql }));
    conn.writes = writes;
    return conn;
  }

  test('refunding a /secure Pest Control setup-fee invoice on an ACTIVE series never re-arms pending_setup_fee', async () => {
    const createSpy = jest.spyOn(InvoiceService, 'create');
    try {
      const conn = makeReversalConn({
        claimRow: { id: 'claim-wg-1', amount: '99.00', scheduled_service_id: 'ss-pest-root', estimate_id: EST },
        seriesRow: { id: 'ss-pest-root', recurring_parent_id: null, service_type: 'Quarterly Pest Control', service_id: null, status: 'confirmed' },
      });
      const res = await InvoiceService.restoreRodentSetupObligationForReversedInvoice(conn, {
        id: 'inv-wg-1', customer_id: CUST, status: 'refunded', scheduled_service_id: 'ss-pest-root',
        line_items: [{ description: 'WaveGuard Membership — one-time setup fee', amount: 99 }],
      });
      expect(res).toBeNull();
      expect(conn.writes.filter((w) => w.table === 'scheduled_services')).toEqual([]);
      expect(createSpy).not.toHaveBeenCalled();
    } finally {
      createSpy.mockRestore();
    }
  });

  test('refunding a /secure Mosquito setup-fee invoice on a DEAD series never mints a "Bait Station Setup" draft', async () => {
    const createSpy = jest.spyOn(InvoiceService, 'create');
    try {
      const conn = makeReversalConn({
        claimRow: { id: 'claim-wg-2', amount: '99.00', scheduled_service_id: 'ss-mosq-root', estimate_id: EST },
        seriesRow: { id: 'ss-mosq-root', recurring_parent_id: null, service_type: 'Mosquito Control', service_id: null, status: 'cancelled' },
        liveChild: null,
      });
      const res = await InvoiceService.restoreRodentSetupObligationForReversedInvoice(conn, {
        id: 'inv-wg-2', customer_id: CUST, status: 'refunded', scheduled_service_id: 'ss-mosq-root',
        line_items: [{ description: 'WaveGuard Membership — one-time setup fee', amount: 99 }],
      });
      expect(res).toBeNull();
      expect(createSpy).not.toHaveBeenCalled();
    } finally {
      createSpy.mockRestore();
    }
  });

  test('voiding a /secure Pest Control setup-fee invoice on a DEAD series parks for office instead of minting Bait Station Setup', async () => {
    const createSpy = jest.spyOn(InvoiceService, 'create');
    const obligationMod = require('../services/setup-fee-obligation');
    const parkSpy = jest.spyOn(obligationMod, 'parkSetupFeeStampForOffice').mockResolvedValue({});
    try {
      const conn = makeReversalConn({
        claimRow: { id: 'claim-wg-3', amount: '99.00', scheduled_service_id: 'ss-pest-dead', estimate_id: EST },
        seriesRow: { id: 'ss-pest-dead', recurring_parent_id: null, service_type: 'Quarterly Pest Control', service_id: null, status: 'cancelled' },
        liveChild: null,
      });
      const res = await InvoiceService.restoreRodentSetupObligationForReversedInvoice(conn, {
        id: 'inv-wg-3', customer_id: CUST, status: 'void', scheduled_service_id: 'ss-pest-dead',
        line_items: [{ description: 'WaveGuard Membership — one-time setup fee', amount: 99 }],
      });
      expect(res).toEqual({ scheduledServiceId: 'ss-pest-dead', amount: 99 });
      expect(createSpy).not.toHaveBeenCalled();
      expect(parkSpy).toHaveBeenCalledWith(conn, expect.objectContaining({
        parentId: 'ss-pest-dead', rawAmount: 99, customerId: CUST,
      }));
    } finally {
      createSpy.mockRestore();
      parkSpy.mockRestore();
    }
  });
});

// ── B-17: Bill-and-send partial failure, open leads, unsent draft reconcile guard & lock order ──

describe('B-17: Bill-and-send open-lead pre-check, deferred reconcile, unsent-draft bell reopen & lock ordering', () => {
  test('open-lead pre-check refuses BEFORE creating draft, and Step 2 failure reopens alert instead of closing RESOLVED', async () => {
    await jest.isolateModulesAsync(async () => {
      const mockNotifUpdates = [];
      let mockLeadTargets = { leadIds: ['open-lead-1'] };
      let mockInvRow = {
        status: 'draft', total: '144.00', sent_at: null, updated_at: new Date('2026-11-24T12:00:00Z'),
        line_items: [
          { description: 'First service application', amount: 45 },
          { description: 'WaveGuard Membership — one-time setup fee', amount: 99 },
        ],
      };
      const mockReconcile = jest.fn(async () => {});
      const mockPlanDraft = jest.fn(async () => ({
        _version: { v: 1 }, _approved: { visitInvoices: [], expectedTotalCents: 14400, scheduledServiceId: VISIT },
      }));
      const mockCommitDraft = jest.fn(async () => ({
        success: true, invoice_id: INV, invoice_number: 'WPC-B17-1', amount: '$144.00',
        invoice_version: mockInvRow.updated_at.getTime(),
      }));
      const mockPlanSend = jest.fn(async () => ({ error: 'SMS provider down' }));
      const mockCommitSend = jest.fn(async () => ({ text: { status: 'sent' } }));

      jest.doMock('../services/lead-estimate-link', () => ({
        invoiceSentConversionTargets: jest.fn(async () => mockLeadTargets),
      }));
      jest.doMock('../services/setup-fee-alert-reconcile', () => ({
        reconcileSetupFeeAlert: mockReconcile,
        acceptedEstimateIdFromNotes: () => EST,
      }));
      jest.doMock('../services/intelligence-bar/create-invoice-tools', () => ({
        planDraftInvoice: mockPlanDraft, commitDraftInvoice: mockCommitDraft,
      }));
      jest.doMock('../services/intelligence-bar/invoice-action-tools', () => ({
        planInvoiceSend: mockPlanSend, commitInvoiceSend: mockCommitSend,
        billingChannelState: jest.fn(async () => ({ supported: true })),
        messagingHold: jest.fn(async () => false),
      }));
      jest.doMock('../routes/admin-sms-templates', () => ({ isTemplateActive: jest.fn(async () => true) }));
      jest.doMock('../models/db', () => {
        const makeQ = (table) => {
          const q = {
            where: jest.fn(() => q), whereRaw: jest.fn(() => q), whereNot: jest.fn(() => q),
            whereNotIn: jest.fn(() => q), orderBy: jest.fn(() => q), forUpdate: jest.fn(() => q), noWait: jest.fn(() => q),
            select: jest.fn(async () => []),
            update: jest.fn(async (payload) => { if (table === 'notifications') mockNotifUpdates.push(payload); return 1; }),
            first: jest.fn(async () => ({
              scheduled_services: { id: VISIT, customer_id: CUST, source_estimate_id: EST, status: 'completed', estimated_price: '45.00', primary_line_price: null, scheduled_date: '2026-11-23' },
              notifications: { id: 'n1', done_at: null, metadata: {} },
              invoices: mockInvRow,
              customers: { id: CUST, phone: '+19415550100' },
              notification_prefs: null,
              messaging_suppression: null,
            })[table]),
          };
          return q;
        };
        return Object.assign(jest.fn((t) => makeQ(t)), { raw: jest.fn((sql, params) => ({ __raw: sql, params })) });
      });

      const { buttonHandler, billButtons } = require('../services/setup-fee-bill-button');
      const PRICED = { estimated_price: '45.00', primary_line_price: null, scheduled_date: '2026-11-23' };
      const buttons = billButtons({ applicationCents: 4500, feeCents: 9900, visit: PRICED });
      const row = {
        id: 'n1',
        metadata: {
          dedupeKey: `unminted_setup_fee_manual_billing:${EST}`, sourceEstimateId: EST, scheduledServiceId: VISIT,
          serviceRecordId: RECORD, customerId: CUST, expectedSetupFeeCents: 9900,
          expectedApplicationCentsByVisit: { [VISIT]: 4500 }, buttons,
        },
      };

      // 1. Open lead refuses BEFORE any draft invoice is created.
      const refused = await buttonHandler.run({ row, item: buttons.items[0], technicianId: 'admin-1' });
      expect(refused.ok).toBe(false);
      expect(refused.message).toMatch(/open lead/i);
      expect(mockCommitDraft).not.toHaveBeenCalled();

      // 2. When no open lead, Step 1 defers alert reconcile; Step 2 SMS failure reopens the alert naming the draft.
      mockLeadTargets = { leadIds: [] };
      mockReconcile.mockClear();
      const failedSend = await buttonHandler.run({ row, item: buttons.items[0], technicianId: 'admin-1' });
      expect(failedSend.ok).toBe(true);
      expect(mockCommitDraft).toHaveBeenCalledWith(expect.objectContaining({ _deferSetupFeeReconcile: true }));
      // Pre-check reconcile ran once before create; post-send reconcile MUST NOT run on failed send.
      expect(mockReconcile).toHaveBeenCalledTimes(1);
      expect(mockNotifUpdates).toHaveLength(1);
      expect(mockNotifUpdates[0]).toMatchObject({ done_at: null, done_by: null, resolution: null, read_at: null });
      expect(mockNotifUpdates[0].detail || mockNotifUpdates[0].body).toContain('WPC-B17-1');
      const metaPatch = JSON.parse(mockNotifUpdates[0].metadata.params[0]);
      expect(metaPatch).toMatchObject({ resolvedCovered: false, billButtonDraftInvoiceId: INV, billButtonDraftInvoiceNumber: 'WPC-B17-1' });

      // 3. Alert with standing billButtonDraftInvoiceId hides the Bill and send button.
      const visible = await buttonHandler.visibleItems([{ id: 'n1', metadata: { ...row.metadata, billButtonDraftInvoiceId: INV } }]);
      expect(visible.size).toBe(0);
    });
  });

  test('sendVerify catches 40P01 deadlocks and pg_try_advisory_xact_lock contention without throwing', async () => {
    const { _private: { sendVerify } } = require('../services/setup-fee-bill-button');
    const facts = { estimateId: EST, visitId: VISIT, serviceRecordId: RECORD, customerId: CUST, feeCents: 9900, applicationCents: 4500, priceCents: 4500, primaryCents: -1 };
    const check = sendVerify(facts);
    const makeDb = (rawFn) => {
      const q = {
        where: jest.fn(() => q), whereNot: jest.fn(() => q), whereNotIn: jest.fn(() => q),
        orderBy: jest.fn(() => q), forUpdate: jest.fn(() => q), noWait: jest.fn(() => q),
        first: jest.fn(async () => ({
          id: VISIT, customer_id: CUST, source_estimate_id: EST, status: 'completed',
          estimated_price: '45.00', primary_line_price: null, scheduled_date: '2026-11-23',
        })),
        select: jest.fn(async () => []),
      };
      const d = Object.assign((table) => {
        if (table === 'scheduled_service_addons' || table === 'retention_offers') return { where: () => ({ first: async () => null }) };
        if (table === 'customers') return { where: () => ({ first: async () => ({ id: CUST, billing_lane: 'per_application' }) }) };
        return q;
      }, {
        raw: rawFn,
        transaction: async (fn) => fn(d),
      });
      return d;
    };
    const Credit = require('../services/customer-credit');
    const Lane = require('../services/billing-lane');
    const Prepay = require('../services/annual-prepay-renewals');
    const Recovery = require('../services/billing-recovery-bill');
    const FirstApp = require('../services/estimate-first-application-invoice');
    const spies = [
      jest.spyOn(Credit, 'autoApplyWouldApply').mockResolvedValue(false),
      jest.spyOn(Lane, 'resolveBillingLane').mockReturnValue({ mode: 'per_application' }),
      jest.spyOn(Lane, 'acquireMembershipDuesMonthLockBounded').mockResolvedValue(true),
      jest.spyOn(Lane, 'monthlyDuesCollected').mockResolvedValue(false),
      jest.spyOn(Prepay, 'prepayYearBillingVisit').mockResolvedValue(null),
      jest.spyOn(Recovery, 'liveCardHoldForVisit').mockResolvedValue(null),
      jest.spyOn(Recovery, 'currentDisposition').mockResolvedValue(null),
      jest.spyOn(FirstApp, 'refuseCoveredMemberMintInTrx').mockResolvedValue(undefined),
    ];
    try {
      // pg_try_advisory_xact_lock returns acquired: false -> returns conflict message
      const busyMsg = await check.verify({ id: INV, customer_id: CUST }, makeDb(async () => ({ rows: [{ acquired: false }] })));
      expect(busyMsg).toMatch(/being changed right now/);
      expect(check.conflict).toBe(true);

      // 40P01 deadlock caught cleanly
      const check2 = sendVerify(facts);
      const dlMsg = await check2.verify({ id: INV, customer_id: CUST }, makeDb(async () => {
        throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
      }));
      expect(dlMsg).toMatch(/being changed right now/);
      expect(check2.conflict).toBe(true);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });

  test('reconcileSetupFeeAlert keeps alert open while billButtonDraftInvoiceId is an unsent draft, then resolves once sent or rewrites once voided', async () => {
    jest.resetModules();
    jest.dontMock('../services/setup-fee-alert-reconcile');
    jest.dontMock('../models/db');
    await jest.isolateModulesAsync(async () => {
      const updates = [];
      let invoiceState = {
        id: INV, status: 'draft', sent_at: null, scheduled_service_id: VISIT,
        notes: `accepted estimate #${EST}`,
        line_items: [
          { client_id: `scheduled_${VISIT}_primary`, description: 'First service application', amount: 45 },
          { description: 'WaveGuard Membership — one-time setup fee', amount: 99 },
        ],
      };
      const alert = {
        id: 'alert-b17',
        body: 'ACTION NEEDED: draft invoice WPC-B17-1 was created from this alert but not sent.',
        metadata: {
          dedupeKey: `unminted_setup_fee_manual_billing:${EST}`,
          customerId: CUST,
          scheduledServiceId: VISIT,
          expectedSetupFeeCents: 9900,
          expectedApplicationCentsByVisit: { [VISIT]: 4500 },
          resolvedCovered: false,
          billButtonDraftInvoiceId: INV,
        },
      };
      let notifCalls = 0;
      const makeHandler = (table) => {
        const q = {};
        ['where', 'whereRaw', 'whereIn', 'whereNot', 'whereNull', 'whereNotNull', 'orWhere', 'orWhereRaw', 'orWhereIn', 'orWhereNotNull', 'whereExists', 'orderBy', 'forUpdate', 'leftJoin', 'andWhere', 'whereNotIn'].forEach((m) => {
          q[m] = jest.fn((...args) => {
            if (m !== 'whereExists' && typeof args[0] === 'function') args[0].call(q, q);
            return q;
          });
        });
        q.first = jest.fn(async () => {
          if (table === 'notifications') { notifCalls += 1; return notifCalls <= 3 ? alert : null; }
          return null;
        });
        q.select = jest.fn(async () => {
          if (table === 'notifications') { notifCalls += 1; return notifCalls <= 2 ? [alert] : []; }
          if (table === 'invoices') return invoiceState ? [invoiceState] : [];
          return [];
        });
        q.update = jest.fn(async (payload) => { updates.push(payload); return 1; });
        return q;
      };
      jest.doMock('../models/db', () => Object.assign(jest.fn((t) => makeHandler(t)), {
        transaction: jest.fn(async (fn) => fn(Object.assign((t) => makeHandler(t), {
          raw: jest.fn((sql, params) => ({ __raw: sql, params })),
          fn: { now: jest.fn(() => 'NOW') },
        }))),
        raw: jest.fn((sql, params) => ({ __raw: sql, params })),
        fn: { now: jest.fn(() => 'NOW') },
      }));

      const { reconcileSetupFeeAlert } = require('../services/setup-fee-alert-reconcile');

      // Unsent draft -> reconcile must NOT resolve the alert.
      await reconcileSetupFeeAlert({ customerId: CUST, sourceEstimateId: EST });
      expect(updates).toHaveLength(0);

      // Sent draft -> reconcile RESOLVES the alert and clears billButtonDraftInvoiceId.
      notifCalls = 0;
      invoiceState = { ...invoiceState, status: 'sent', sent_at: new Date().toISOString() };
      await reconcileSetupFeeAlert({ customerId: CUST, sourceEstimateId: EST });
      expect(updates).toHaveLength(1);
      expect(updates[0].detail || updates[0].body).toContain('RESOLVED');

      // Voided draft -> reconcile rewrites as still owed instead of leaving stale draft message.
      updates.length = 0;
      notifCalls = 0;
      invoiceState = { ...invoiceState, status: 'void', sent_at: null };
      await reconcileSetupFeeAlert({ customerId: CUST, sourceEstimateId: EST });
      expect(updates).toHaveLength(1);
      expect(updates[0].detail || updates[0].body).toContain('still owed');
    });
  });

  test('InvoiceService.create acquires advisory locks (mint -> alert -> setup_fee_account) BEFORE acquireScheduledMintLockChain', async () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../services/invoice.js'), 'utf8');
    const helperStart = src.indexOf('async function acquireInvoiceCreateLocks');
    const helperEnd = src.indexOf('async function claimSeriesIsRodentBait');
    const helper = src.slice(helperStart, helperEnd);
    const mintLockIdx = helper.indexOf('acquireScheduledInvoiceMintLock');
    const alertLockIdx = helper.indexOf('unminted_setup_fee_manual_billing:');
    const feeLockIdx = helper.indexOf('setup_fee_account:');
    const chainLockIdx = helper.indexOf('acquireScheduledMintLockChain');
    expect(mintLockIdx).toBeGreaterThan(-1);
    expect(alertLockIdx).toBeGreaterThan(mintLockIdx);
    expect(feeLockIdx).toBeGreaterThan(alertLockIdx);
    expect(chainLockIdx).toBeGreaterThan(feeLockIdx);
  });

  test('setupFeeSettledElsewhere resolves property scope via service_record_id and matches cancelled covered prepay terms', async () => {
    const { setupFeeSettledElsewhere } = require('../services/setup-fee-obligation');
    const recent = '2026-11-20T15:00:00Z';
    const connRecordPropA = makeObligationConn({
      estimates: { id: EST, created_at: '2026-11-01T15:00:00Z', property_id: 'prop-b', address: '200 Pine St, Testville, FL 34200' },
      invoices: [{
        id: 'inv-sr-a', status: 'paid', created_at: recent, scheduled_service_id: null, service_record_id: 'sr-a',
        line_items: [{ description: 'WaveGuard Membership', amount: 99 }],
      }],
      service_records: { id: 'sr-a', scheduled_service_id: 'ss-prop-a' },
      scheduled_services: { id: 'ss-prop-a', property_id: 'prop-a', service_address_line1: '100 Oak St', service_address_city: 'Testville', service_address_zip: '34200' },
      'annual_prepay_terms as t': [],
    });
    expect((await setupFeeSettledElsewhere(connRecordPropA, { customerId: CUST, expectedFeeCents: 9900, sourceEstimateId: EST })).settled).toBe(false);

    const connCancelledTerm = makeObligationConn({
      estimates: { id: EST, created_at: '2026-11-01T15:00:00Z', property_id: 'prop-a', address: '100 Oak St, Testville, FL 34200' },
      invoices: [],
      'annual_prepay_terms as t': [{
        id: 'term-cancelled-active-period', status: 'cancelled', covered_until: '2027-06-01', property_id: 'prop-a',
        invoice_id: 'inv-term-1', invoice_status: 'paid',
      }],
    });
    expect((await setupFeeSettledElsewhere(connCancelledTerm, { customerId: CUST, expectedFeeCents: 9900, sourceEstimateId: EST })).settled).toBe(true);
  });
});
