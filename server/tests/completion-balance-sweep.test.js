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
 *   - invoices for a visit not yet performed are skipped (owner ruling
 *     2026-09-26): a linked visit must be 'completed'; an unlinked invoice
 *     must not carry a future service_date
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
}));

const stoppedResults = { rows: [] };
// scheduled_services lookups: every queried visit counts as completed unless
// the test lists it here as not performed.
const mockVisitState = { unperformed: new Set() };
jest.mock('../models/db', () => {
  const mkChain = (table) => {
    const q = {};
    let ids = [];
    q.whereIn = (_col, values) => { ids = values; return q; };
    for (const m of ['where', 'select']) q[m] = () => q;
    q.then = (onOk, onErr) => {
      const rows = table === 'scheduled_services'
        ? ids.filter((id) => !mockVisitState.unperformed.has(id)).map((id) => ({ id }))
        : stoppedResults.rows;
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
      { id: 'old-1', invoice_number: 'INV-1', subtotal: '107.10', discount_amount: '7.10', total: '100.00', scheduled_service_id: 'svc-old-1' },
      { id: 'old-2', invoice_number: 'INV-2', subtotal: null, total: '62.10', discount_amount: null, scheduled_service_id: null },
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
      { id: 'old-1', invoice_number: 'INV-1', subtotal: '50.00', total: '50.00' },
      { id: 'old-2', invoice_number: 'INV-2', subtotal: '60.00', total: '60.00' },
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
      { id: 'old-1', invoice_number: 'INV-1', subtotal: '50.00', total: '50.00' },
      { id: 'old-2', invoice_number: 'INV-2', subtotal: '60.00', total: '60.00' },
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
      { id: 'old-stopped', invoice_number: 'INV-1', subtotal: '50.00', total: '50.00' },
      { id: 'old-live', invoice_number: 'INV-2', subtotal: '60.00', total: '60.00' },
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
      { id: 'old-1', invoice_number: 'INV-1', subtotal: '50.00', total: '50.00' },
      { id: 'old-2', invoice_number: 'INV-2', subtotal: '60.00', total: '60.00' },
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
      { id: 'old-1', invoice_number: 'INV-1', subtotal: '50.00', total: '50.00' },
      { id: 'old-2', invoice_number: 'INV-2', subtotal: '60.00', total: '60.00' },
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
      { id: 'future-visit', invoice_number: 'INV-1', subtotal: '106.20', total: '106.20', scheduled_service_id: 'svc-future' },
      { id: 'done-visit', invoice_number: 'INV-2', subtotal: '60.00', total: '60.00', scheduled_service_id: 'svc-done' },
    ];
    mockVisitState.unperformed = new Set(['svc-future']);
    const result = await runCompletionBalanceSweep(baseArgs);
    expect(result.skipped).toBe(1);
    expect(result.charged).toBe(1);
    expect(mockCharge).toHaveBeenCalledTimes(1);
    expect(mockCharge.mock.calls[0][0]).toBe('done-visit');
  });

  test('an unlinked invoice dated in the future waits; today or earlier is collected', async () => {
    openBalanceResults.rows = [
      { id: 'dated-future', invoice_number: 'INV-1', subtotal: '99.00', total: '99.00', scheduled_service_id: null, service_date: '2999-01-01' },
      { id: 'dated-past', invoice_number: 'INV-2', subtotal: '60.00', total: '60.00', scheduled_service_id: null, service_date: '2020-01-01' },
    ];
    const result = await runCompletionBalanceSweep(baseArgs);
    expect(result.skipped).toBe(1);
    expect(mockCharge).toHaveBeenCalledTimes(1);
    expect(mockCharge.mock.calls[0][0]).toBe('dated-past');
  });

  test('unperformedVisitInvoiceIds: only a completed visit releases its bill', async () => {
    const { unperformedVisitInvoiceIds } = require('../services/completion-balance-sweep');
    mockVisitState.unperformed = new Set(['svc-cancelled', 'svc-pending']);
    const skip = await unperformedVisitInvoiceIds([
      { id: 'a', scheduled_service_id: 'svc-done' },
      { id: 'b', scheduled_service_id: 'svc-cancelled' },
      { id: 'c', scheduled_service_id: 'svc-pending' },
      { id: 'd', scheduled_service_id: null, service_date: new Date('2026-10-02T04:00:00Z') },
      { id: 'e', scheduled_service_id: null, service_date: null },
    ], { today: '2026-09-26' });
    expect([...skip].sort()).toEqual(['b', 'c', 'd']);
  });

  test('a DATE column read as UTC midnight still counts as its own calendar day', async () => {
    // On a UTC server pg hands back tomorrow's service_date as tomorrow
    // 00:00Z — 8 PM ET today. It must still read as tomorrow.
    const { unperformedVisitInvoiceIds } = require('../services/completion-balance-sweep');
    const skip = await unperformedVisitInvoiceIds([
      { id: 'tomorrow', scheduled_service_id: null, service_date: new Date('2026-09-27T00:00:00Z') },
      { id: 'today', scheduled_service_id: null, service_date: new Date('2026-09-26T00:00:00Z') },
    ], { today: '2026-09-26' });
    expect([...skip]).toEqual(['tomorrow']);
  });

  test('missing method or customer → no-op, never throws', async () => {
    const result = await runCompletionBalanceSweep({ ...baseArgs, paymentMethodId: null });
    expect(result).toEqual({ charged: 0, pending: 0, failed: 0, skipped: 0, considered: 0 });
    expect(mockCharge).not.toHaveBeenCalled();
  });
});
