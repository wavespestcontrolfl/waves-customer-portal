/**
 * completion-balance-sweep.js — the full-balance Auto Pay pull
 * (owner ruling 2026-08-08: after a successful completion auto-charge,
 * collect everything else the customer owes).
 *
 * Contract:
 *   - gate OFF → nothing charged, nothing queried against Stripe
 *   - charges oldest-first, one chargeInvoiceWithSavedCard per invoice, each
 *     with maxAuthorizedSubtotal = that invoice's own subtotal net of
 *     discounts, requireAutopayForCustomerId, and the invoice's OWN
 *     scheduled_service_id for the self-pay re-verification
 *   - STOP-ON-FAILURE: a decline/guard refusal ends the sweep; later
 *     invoices are not attempted
 *   - invoices with an admin-STOPPED follow-up sequence are skipped
 *   - only bills tied to performed work are collected (owner ruling
 *     2026-09-26): a bill on a visit (its own or its service record's) once
 *     that visit is 'completed', re-checked under the charge's visit lock;
 *     an unlinked bill only when dated before today and not an
 *     estimate-acceptance or setup-fee bill
 *   - every outcome logs an autopay_log row under
 *     source 'completion_balance_sweep'
 *   - never throws (completion must not depend on the sweep)
 */
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../services/autopay-log', () => ({ logAutopay: jest.fn(async () => {}) }));

const openBalanceResults = { rows: [] };
jest.mock('../services/open-balance', () => ({
  openBalanceInvoices: jest.fn(async () => openBalanceResults.rows),
  __rows: () => openBalanceResults.rows,
}));

const stoppedResults = { rows: [] };
// The invoice row read (performedWorkPlan) defaults to the candidate row the
// open-balance mock returns, overlaid with `invoiceDocs[id]`. `recordVisits`
// maps service_record id -> scheduled_service_id. Every queried visit counts
// as completed unless listed in `unperformed`. `visitQueries` records each
// scheduled_services whereIn(ids); `dbError` makes that query reject.
const mockVisitState = {
  unperformed: new Set(), visitQueries: [], dbError: null, invoiceDocs: {}, recordVisits: {},
};
jest.mock('../models/db', () => {
  const mkChain = (table) => {
    const q = {};
    let ids = [];
    q.whereIn = (_column, values) => {
      ids = values;
      if (table === 'scheduled_services') mockVisitState.visitQueries.push(values);
      return q;
    };
    for (const m of ['where', 'select']) q[m] = () => q;
    q.then = (onOk, onErr) => {
      let rows;
      if (table === 'invoices') {
        const candidates = require('../services/open-balance').__rows();
        rows = ids.map((id) => ({
          service_record_id: null, notes: null, line_items: [],
          ...(candidates.find((c) => String(c.id) === String(id)) || { id }),
          ...(mockVisitState.invoiceDocs[String(id)] || {}),
        }));
      } else if (table === 'service_records') {
        rows = ids.map((id) => ({ id, scheduled_service_id: mockVisitState.recordVisits[String(id)] || null }));
      } else if (table === 'scheduled_services') {
        if (mockVisitState.dbError) return Promise.reject(mockVisitState.dbError).then(onOk, onErr);
        rows = ids.filter((id) => !mockVisitState.unperformed.has(String(id))).map((id) => ({ id }));
      } else {
        rows = stoppedResults.rows;
      }
      return Promise.resolve(rows).then(onOk, onErr);
    };
    return q;
  };
  const dbFn = jest.fn((table) => mkChain(table));
  dbFn.raw = (sql) => sql;
  return dbFn;
});

const mockCharge = jest.fn(async () => ({ status: 'paid' }));
jest.mock('../services/stripe', () => ({
  chargeInvoiceWithSavedCard: (...args) => mockCharge(...args),
  savedCardChargeSuppressesAlternateCollection: (err) => !!err?.fenced,
  savedCardChargeNeedsReconciliation: (err) => !!err?.reconcile,
}));

const { isEnabled } = require('../config/feature-gates');
const { logAutopay } = require('../services/autopay-log');
const { runCompletionBalanceSweep } = require('../services/completion-balance-sweep');

const baseArgs = {
  customerId: 'cust-1',
  excludeInvoiceId: 'inv-current',
  paymentMethodId: 'pm-1',
  triggerScheduledServiceId: 'svc-1',
};

describe('completion balance sweep', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isEnabled.mockImplementation(() => true);
    openBalanceResults.rows = [];
    stoppedResults.rows = [];
    mockVisitState.unperformed = new Set();
    mockVisitState.visitQueries = [];
    mockVisitState.dbError = null;
    mockVisitState.invoiceDocs = {};
    mockVisitState.recordVisits = {};
    mockCharge.mockImplementation(async () => ({ status: 'paid' }));
  });

  test('gate off: no charges, no candidate lookup', async () => {
    isEnabled.mockImplementation(() => false);
    openBalanceResults.rows = [{ id: 'old-1', subtotal: '100.00' }];
    const result = await runCompletionBalanceSweep(baseArgs);
    expect(result.gateOff).toBe(true);
    expect(mockCharge).not.toHaveBeenCalled();
  });

  test('charges each open invoice with its own cap, autopay + self-pay guards', async () => {
    openBalanceResults.rows = [
      { id: 'old-1', invoice_number: 'INV-1', subtotal: '107.10', discount_amount: '7.10', total: '100.00', scheduled_service_id: 'svc-old-1', service_date: null },
      { id: 'old-2', invoice_number: 'INV-2', subtotal: null, total: '62.10', discount_amount: null, scheduled_service_id: null, service_date: '2020-01-01' },
    ];
    const result = await runCompletionBalanceSweep(baseArgs);
    expect(result.charged).toBe(2);
    expect(mockCharge).toHaveBeenNthCalledWith(1, 'old-1', 'pm-1', {
      // 107.10 − 7.10 in integer cents → exactly 100.
      maxAuthorizedSubtotal: 100,
      // Full charge-base ceiling = the snapshot's amount due, in cents.
      maxAuthorizedChargeCents: 10000,
      requireAutopayForCustomerId: 'cust-1',
      requireSelfPayScheduledServiceId: 'svc-old-1',
      // Linked bill: the performed-visit verdict is re-checked under the
      // charge's visit lock, and the invoice must still be that visit's.
      requireCompletedVisit: true,
      requireInvoiceScheduledServiceBinding: true,
      requireSelfPayCustomerId: 'cust-1',
      refuseWhenDunningStopped: true,
    });
    expect(mockCharge).toHaveBeenNthCalledWith(2, 'old-2', 'pm-1', {
      // No subtotal column value → cap falls back to the total.
      maxAuthorizedSubtotal: 62.1,
      maxAuthorizedChargeCents: 6210,
      requireAutopayForCustomerId: 'cust-1',
      // No visit on the invoice → the customer-default payer check inside
      // the charge transaction is the binding self-pay guard.
      requireSelfPayScheduledServiceId: null,
      requireSelfPayCustomerId: 'cust-1',
      refuseWhenDunningStopped: true,
    });
    expect(logAutopay).toHaveBeenCalledTimes(2);
    expect(logAutopay).toHaveBeenCalledWith('cust-1', 'charge_success', expect.objectContaining({
      details: expect.objectContaining({ source: 'completion_balance_sweep', invoice_id: 'old-1' }),
    }));
  });

  test('stop-on-failure: a decline ends the sweep before later invoices', async () => {
    openBalanceResults.rows = [
      { id: 'old-1', invoice_number: 'INV-1', subtotal: '50.00', total: '50.00', scheduled_service_id: null, service_date: '2020-01-01' },
      { id: 'old-2', invoice_number: 'INV-2', subtotal: '60.00', total: '60.00', scheduled_service_id: null, service_date: '2020-01-01' },
    ];
    mockCharge.mockImplementationOnce(async () => { throw new Error('card_declined'); });
    const result = await runCompletionBalanceSweep(baseArgs);
    expect(result.charged).toBe(0);
    expect(result.failed).toBe(1);
    expect(mockCharge).toHaveBeenCalledTimes(1);
    expect(logAutopay).toHaveBeenCalledWith('cust-1', 'charge_failed', expect.objectContaining({
      details: expect.objectContaining({
        source: 'completion_balance_sweep',
        invoice_id: 'old-1',
        collection_fenced: false,
      }),
    }));
  });

  test('a fenced (ambiguous/orphaned) outcome stops the sweep and flags it', async () => {
    openBalanceResults.rows = [
      { id: 'old-1', invoice_number: 'INV-1', subtotal: '50.00', total: '50.00', scheduled_service_id: null, service_date: '2020-01-01' },
      { id: 'old-2', invoice_number: 'INV-2', subtotal: '60.00', total: '60.00', scheduled_service_id: null, service_date: '2020-01-01' },
    ];
    mockCharge.mockImplementationOnce(async () => {
      const err = new Error('ambiguous');
      err.fenced = true;
      err.reconcile = true;
      throw err;
    });
    const result = await runCompletionBalanceSweep(baseArgs);
    expect(result.failed).toBe(1);
    expect(mockCharge).toHaveBeenCalledTimes(1);
    expect(logAutopay).toHaveBeenCalledWith('cust-1', 'charge_failed', expect.objectContaining({
      details: expect.objectContaining({ collection_fenced: true, reconciliation_required: true }),
    }));
  });

  test('admin-stopped dunning sequences are never collected', async () => {
    openBalanceResults.rows = [
      { id: 'old-stopped', invoice_number: 'INV-1', subtotal: '50.00', total: '50.00', scheduled_service_id: null, service_date: '2020-01-01' },
      { id: 'old-live', invoice_number: 'INV-2', subtotal: '60.00', total: '60.00', scheduled_service_id: null, service_date: '2020-01-01' },
    ];
    stoppedResults.rows = [{ invoice_id: 'old-stopped' }];
    const result = await runCompletionBalanceSweep(baseArgs);
    expect(result.skipped).toBe(1);
    expect(result.charged).toBe(1);
    expect(mockCharge).toHaveBeenCalledTimes(1);
    expect(mockCharge.mock.calls[0][0]).toBe('old-live');
  });

  test('an in-flight (processing) outcome stops the sweep before later invoices', async () => {
    // A resolved charge is NOT necessarily settled: a bank debit resolves
    // 'processing' and can still fail — the sweep must never fan out more
    // debits behind money in flight (pre-push r3 P0).
    openBalanceResults.rows = [
      { id: 'old-1', invoice_number: 'INV-1', subtotal: '50.00', total: '50.00', scheduled_service_id: null, service_date: '2020-01-01' },
      { id: 'old-2', invoice_number: 'INV-2', subtotal: '60.00', total: '60.00', scheduled_service_id: null, service_date: '2020-01-01' },
    ];
    mockCharge.mockImplementationOnce(async () => ({ status: 'processing' }));
    const result = await runCompletionBalanceSweep(baseArgs);
    expect(result.charged).toBe(0);
    expect(result.pending).toBe(1);
    expect(mockCharge).toHaveBeenCalledTimes(1);
    expect(logAutopay).toHaveBeenCalledWith('cust-1', 'charge_success', expect.objectContaining({
      details: expect.objectContaining({ in_flight: true, outcome_status: 'processing' }),
    }));
  });

  test('a credit-covered (prepaid) outcome is final and the sweep continues', async () => {
    openBalanceResults.rows = [
      { id: 'old-1', invoice_number: 'INV-1', subtotal: '50.00', total: '50.00', scheduled_service_id: null, service_date: '2020-01-01' },
      { id: 'old-2', invoice_number: 'INV-2', subtotal: '60.00', total: '60.00', scheduled_service_id: null, service_date: '2020-01-01' },
    ];
    mockCharge.mockImplementationOnce(async () => ({ covered_by_credit: true, status: 'prepaid' }));
    const result = await runCompletionBalanceSweep(baseArgs);
    expect(result.charged).toBe(2);
    expect(mockCharge).toHaveBeenCalledTimes(2);
  });

  test('a bill for a visit that has not happened yet is never collected early', async () => {
    // The Oct 2 pest bill minted at estimate accept must wait for Oct 2's
    // own completion, not ride a lawn visit's Auto Pay charge.
    openBalanceResults.rows = [
      { id: 'future-visit', invoice_number: 'INV-1', subtotal: '106.20', total: '106.20', scheduled_service_id: 'svc-future', service_date: '2026-10-02' },
      { id: 'done-visit', invoice_number: 'INV-2', subtotal: '60.00', total: '60.00', scheduled_service_id: 'svc-done', service_date: null },
    ];
    mockVisitState.unperformed = new Set(['svc-future']);
    const result = await runCompletionBalanceSweep(baseArgs);
    expect(result.skipped).toBe(1);
    expect(mockCharge).toHaveBeenCalledTimes(1);
    expect(mockCharge.mock.calls[0][0]).toBe('done-visit');
  });

  test('a bill linked only through its service record is held to that visit, under the lock', async () => {
    openBalanceResults.rows = [
      { id: 'rec-done', invoice_number: 'INV-1', subtotal: '50.00', total: '50.00', scheduled_service_id: null, service_date: null },
      { id: 'rec-reopened', invoice_number: 'INV-2', subtotal: '60.00', total: '60.00', scheduled_service_id: null, service_date: '2020-01-01' },
    ];
    mockVisitState.invoiceDocs = { 'rec-done': { service_record_id: 'sr-1' }, 'rec-reopened': { service_record_id: 'sr-2' } };
    mockVisitState.recordVisits = { 'sr-1': 'svc-a', 'sr-2': 'svc-b' };
    mockVisitState.unperformed = new Set(['svc-b']);
    const result = await runCompletionBalanceSweep(baseArgs);
    expect(result.skipped).toBe(1);
    expect(mockCharge).toHaveBeenCalledTimes(1);
    expect(mockCharge).toHaveBeenCalledWith('rec-done', 'pm-1', expect.objectContaining({
      requireSelfPayScheduledServiceId: 'svc-a',
      requireCompletedVisit: true,
      // Not the invoice's own visit column — only the record ties them.
      requireInvoiceScheduledServiceBinding: false,
    }));
  });

  test('an unlinked bill is collected only when dated before today', async () => {
    const { performedWorkPlan } = require('../services/completion-balance-sweep');
    openBalanceResults.rows = [
      { id: 'yesterday', scheduled_service_id: null, service_date: '2026-09-25' },
      { id: 'today', scheduled_service_id: null, service_date: '2026-09-26' },
      { id: 'tomorrow', scheduled_service_id: null, service_date: '2026-09-27' },
      { id: 'undated', scheduled_service_id: null, service_date: null },
    ];
    const plan = await performedWorkPlan(['yesterday', 'today', 'tomorrow', 'undated'], { today: '2026-09-26' });
    expect([...plan.keys()]).toEqual(['yesterday']);
    expect(plan.get('yesterday')).toEqual({ visitId: null, ownVisit: false });
  });

  test('service_date reads as its calendar day whether pg returns UTC or ET midnight', async () => {
    const { performedWorkPlan } = require('../services/completion-balance-sweep');
    openBalanceResults.rows = [
      // Yesterday as UTC midnight (UTC server) and as ET midnight (EDT/EST).
      { id: 'utc-yesterday', scheduled_service_id: null, service_date: new Date('2026-09-25T00:00:00Z') },
      { id: 'edt-yesterday', scheduled_service_id: null, service_date: new Date('2026-09-25T04:00:00Z') },
      { id: 'utc-today', scheduled_service_id: null, service_date: new Date('2026-09-26T00:00:00Z') },
      { id: 'edt-today', scheduled_service_id: null, service_date: new Date('2026-09-26T04:00:00Z') },
      { id: 'est-yesterday', scheduled_service_id: null, service_date: new Date('2026-01-14T05:00:00Z') },
      { id: 'est-today', scheduled_service_id: null, service_date: new Date('2026-01-15T05:00:00Z') },
    ];
    const sep = await performedWorkPlan(['utc-yesterday', 'edt-yesterday', 'utc-today', 'edt-today'], { today: '2026-09-26' });
    expect([...sep.keys()].sort()).toEqual(['edt-yesterday', 'utc-yesterday']);
    const jan = await performedWorkPlan(['est-yesterday', 'est-today'], { today: '2026-01-15' });
    expect([...jan.keys()]).toEqual(['est-yesterday']);
  });

  test('estimate-acceptance and setup-fee bills without a visit link are never swept', async () => {
    const { performedWorkPlan } = require('../services/completion-balance-sweep');
    openBalanceResults.rows = ['auto', 'manual', 'fee', 'waived', 'plain'].map((id) => ({ id, scheduled_service_id: null, service_date: '2020-01-01' }));
    mockVisitState.invoiceDocs = {
      auto: { notes: 'Auto-generated from accepted estimate #11111111-2222-3333-4444-555555555555. Customer selected pay per application — $99.00 setup fee only.' },
      // The setup-fee alert tells staff to stamp manual invoices this way.
      manual: { notes: 'Setup fee for accepted estimate #11111111-2222-3333-4444-555555555555' },
      fee: { line_items: [{ description: 'WaveGuard Membership — one-time setup fee', quantity: 1, unit_price: 99 }] },
      waived: { line_items: [{ description: 'WaveGuard Membership — setup fee waived', quantity: 1, unit_price: 0 }] },
      plain: { notes: 'Rodent follow-up' },
    };
    const plan = await performedWorkPlan(['auto', 'manual', 'fee', 'waived', 'plain'], { today: '2026-09-26' });
    expect([...plan.keys()].sort()).toEqual(['plain', 'waived']);
  });

  test('only a completed visit releases a linked bill; numeric ids normalize', async () => {
    const { performedWorkPlan } = require('../services/completion-balance-sweep');
    openBalanceResults.rows = [
      { id: 'done', scheduled_service_id: 'svc-done', service_date: null },
      { id: 'cancelled', scheduled_service_id: 'svc-cancelled', service_date: '2020-01-01' },
      { id: 'num', scheduled_service_id: 501, service_date: null },
    ];
    mockVisitState.unperformed = new Set(['svc-cancelled']);
    const plan = await performedWorkPlan(['done', 'cancelled', 'num'], { today: '2026-09-26' });
    expect([...plan.keys()].sort()).toEqual(['done', 'num']);
    expect(plan.get('num')).toEqual({ visitId: '501', ownVisit: true });
  });

  test('bills sharing one visit resolve off a single scheduled_services query', async () => {
    openBalanceResults.rows = [
      { id: 'a', invoice_number: 'INV-A', subtotal: '10.00', total: '10.00', scheduled_service_id: 'svc-shared', service_date: null },
      { id: 'b', invoice_number: 'INV-B', subtotal: '20.00', total: '20.00', scheduled_service_id: 'svc-shared', service_date: null },
    ];
    const result = await runCompletionBalanceSweep(baseArgs);
    expect(result.charged).toBe(2);
    expect(mockVisitState.visitQueries).toEqual([['svc-shared']]);
  });

  test('a visit lookup failure stops the sweep before any charge', async () => {
    openBalanceResults.rows = [
      { id: 'old-1', invoice_number: 'INV-1', subtotal: '50.00', total: '50.00', scheduled_service_id: 'svc-1', service_date: null },
    ];
    mockVisitState.dbError = new Error('connection terminated');
    const result = await runCompletionBalanceSweep(baseArgs);
    expect(mockCharge).not.toHaveBeenCalled();
    expect(result.charged).toBe(0);
  });

  test('every candidate unproven → nothing charged, all counted as skipped', async () => {
    openBalanceResults.rows = [
      { id: 'old-1', invoice_number: 'INV-1', subtotal: '50.00', total: '50.00', scheduled_service_id: 'svc-not-done', service_date: null },
      { id: 'old-2', invoice_number: 'INV-2', subtotal: '60.00', total: '60.00', scheduled_service_id: null, service_date: '2999-01-01' },
    ];
    mockVisitState.unperformed = new Set(['svc-not-done']);
    const result = await runCompletionBalanceSweep(baseArgs);
    expect(result.skipped).toBe(2);
    expect(mockCharge).not.toHaveBeenCalled();
  });

  test('missing method or customer → no-op, never throws', async () => {
    const result = await runCompletionBalanceSweep({ ...baseArgs, paymentMethodId: null });
    expect(result).toEqual({ charged: 0, pending: 0, failed: 0, skipped: 0, considered: 0 });
    expect(mockCharge).not.toHaveBeenCalled();
  });
});
