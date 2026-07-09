jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/invoice', () => ({
  settleInvoiceAsAnnualPrepayCovered: jest.fn(),
  reopenAnnualPrepayCoveredInvoicesForTerm: jest.fn(),
}));
jest.mock('../services/customer-credit', () => ({
  postCreditMovement: jest.fn().mockResolvedValue(undefined),
  reverseAppliedCredit: jest.fn().mockResolvedValue(0),
  autoApplyAccountCreditIfEnabled: jest.fn().mockResolvedValue(null),
}));

const db = require('../models/db');
const logger = require('../services/logger');
const { settleInvoiceAsAnnualPrepayCovered } = require('../services/invoice');
const { postCreditMovement } = require('../services/customer-credit');
const AnnualPrepayRenewals = require('../services/annual-prepay-renewals');
const { _private } = AnnualPrepayRenewals;

function query({ first, returning, columnInfo, rows = [] } = {}) {
  const q = {};
  [
    'whereIn', 'whereNull', 'whereBetween', 'whereNotIn', 'whereNotNull',
    'orderBy', 'select', 'join', 'leftJoin', 'distinct', 'forUpdate',
    'whereRaw', 'orWhere', 'orWhereNotNull', 'limit', 'whereNot',
  ].forEach((method) => {
    q[method] = jest.fn(() => q);
  });
  q.modify = jest.fn((fn) => { if (typeof fn === 'function') fn(q); return q; });
  q.where = jest.fn((arg) => {
    if (typeof arg === 'function') arg.call(q);
    return q;
  });
  q.update = jest.fn(() => q);
  q.insert = jest.fn(() => q);
  q.first = jest.fn(async () => first);
  q.returning = jest.fn(async () => returning || []);
  q.columnInfo = jest.fn(async () => columnInfo || {});
  q.catch = jest.fn(() => Promise.resolve());
  q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return q;
}

// Standalone connection mock (deliberately !== db): reversePendingWindow-
// CompletionCredits and the credit grant run their work directly on the
// passed conn instead of opening db.transaction, so no trx mock is needed.
function makeConn(queues) {
  const tableQueues = new Map(Object.entries(queues));
  const conn = jest.fn((table) => {
    const queue = tableQueues.get(table);
    if (!queue || !queue.length) throw new Error(`Unexpected conn table ${table}`);
    return queue.shift();
  });
  return conn;
}

const SS_COLS = {
  scheduled_date: {}, service_type: {}, prepaid_amount: {}, prepaid_method: {},
  prepaid_at: {}, prepaid_note: {}, annual_prepay_term_id: {}, updated_at: {},
};

const COVERED_TERM = {
  id: 'term-1',
  customer_id: 'cust-1',
  prepay_invoice_id: 'prepay-inv-1',
  status: 'active',
  term_start: '2026-07-01',
  term_end: '2027-07-01',
  prepay_amount: '480.00',
  coverage_visit_count: 4,
  coverage_service_type: 'Pest Control',
};

const COMPLETED_VISIT = {
  id: 'visit-1',
  customer_id: 'cust-1',
  scheduled_date: '2026-07-05',
  status: 'completed',
  service_type: 'Pest Control',
  prepaid_amount: null,
  prepaid_method: null,
  annual_prepay_term_id: null,
};

describe('annual prepay late-payment gap fixes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.schema = { hasTable: jest.fn().mockResolvedValue(true) };
    db.transaction = jest.fn(async (work) => work(db));
    _private.resetCachesForTests();
  });

  describe('reconcilePendingWindowCompletions payer guard', () => {
    test('payer-billed visit invoice: no settle, no credit, warn for operator', async () => {
      const conn = makeConn({
        scheduled_services: [query({ columnInfo: SS_COLS, rows: [{ ...COMPLETED_VISIT }] })],
        invoices: [query({ first: { id: 'inv-1', status: 'sent', payer_id: 'payer-9' } })],
      });
      // scheduled_services columnInfo is read via db (module-level cache)
      db.mockImplementation(() => query({ columnInfo: SS_COLS }));

      const summary = await AnnualPrepayRenewals.reconcilePendingWindowCompletions({ ...COVERED_TERM }, conn);

      expect(summary).toEqual({ settled: 0, credited: 0 });
      expect(settleInvoiceAsAnnualPrepayCovered).not.toHaveBeenCalled();
      expect(postCreditMovement).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('payer-billed'));
    });

    test('control: self-pay PAID visit invoice still credits the slice', async () => {
      const conn = makeConn({
        scheduled_services: [query({ columnInfo: SS_COLS, rows: [{ ...COMPLETED_VISIT }] })],
        invoices: [query({ first: { id: 'inv-1', status: 'paid', payer_id: null } })],
        payments: [query({ first: undefined })], // no refund activity
        customers: [query({ first: { id: 'cust-1' } })], // row lock
        customer_credit_ledger: [query({ first: undefined })], // no dup marker
      });
      db.mockImplementation(() => query({ columnInfo: SS_COLS }));

      const summary = await AnnualPrepayRenewals.reconcilePendingWindowCompletions({ ...COVERED_TERM }, conn);

      expect(summary).toEqual({ settled: 0, credited: 1 });
      expect(postCreditMovement).toHaveBeenCalledWith(expect.objectContaining({
        customerId: 'cust-1',
        delta: 120, // 480 / 4 visits
        invoiceId: 'inv-1',
      }), conn);
    });
  });

  describe('suspendActiveTermsForDisputedInvoice', () => {
    test('flips active/renewal_pending to payment_pending, clears stamps, restores billing mode for suspended AND decided terms', async () => {
      const suspendQ = query({ returning: [{ ...COVERED_TERM, status: 'payment_pending' }] });
      const stampClearQ = query();
      const replacementQ = query({ first: undefined }); // no replacement coverage
      const priorQ = query({ first: { prior_billing_mode: 'per_application' } });
      const customerResetQ = query();
      const decidedQ = query({ rows: [{ id: 'term-decided', customer_id: 'cust-2', status: 'renewed', source_estimate_id: null }] });
      const decidedReplacementQ = query({ first: undefined });
      const decidedPriorQ = query({ first: { prior_billing_mode: 'none' } });
      const decidedCustomerResetQ = query();
      const conn = makeConn({
        annual_prepay_terms: [suspendQ, replacementQ, priorQ, decidedQ, decidedReplacementQ, decidedPriorQ],
        scheduled_services: [stampClearQ],
        customers: [customerResetQ, decidedCustomerResetQ],
      });
      conn.schema = { hasColumn: jest.fn().mockResolvedValue(true) };
      db.mockImplementation(() => query({ columnInfo: SS_COLS })); // scheduledServiceColumns cache

      const suspended = await AnnualPrepayRenewals.suspendActiveTermsForDisputedInvoice('prepay-inv-1', conn);

      expect(suspended).toHaveLength(1);
      expect(suspendQ.whereIn).toHaveBeenCalledWith('status', ['active', 'renewal_pending']);
      expect(suspendQ.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'payment_pending' }));
      // Future-visit stamps must clear (method-scoped) or a visit billed
      // mid-dispute is skipped by the won-dispute reconcile as "already
      // covered" and the customer double-pays.
      expect(stampClearQ.where).toHaveBeenCalledWith('prepaid_method', 'annual_prepay_invoice');
      expect(stampClearQ.update).toHaveBeenCalledWith(expect.objectContaining({ prepaid_amount: null }));
      // Mid-dispute completions must BILL: the customer's billing_mode is
      // restored to the recorded prior (guarded on currently-annual_prepay),
      // exactly like the cancel path — for the suspended term AND the
      // decided-coverage term ('none' prior restores legacy NULL).
      expect(customerResetQ.where).toHaveBeenCalledWith({ id: 'cust-1', billing_mode: 'annual_prepay' });
      expect(customerResetQ.update).toHaveBeenCalledWith(expect.objectContaining({ billing_mode: 'per_application' }));
      expect(decidedCustomerResetQ.where).toHaveBeenCalledWith({ id: 'cust-2', billing_mode: 'annual_prepay' });
      expect(decidedCustomerResetQ.update).toHaveBeenCalledWith(expect.objectContaining({ billing_mode: null }));
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('term term-1 suspended'));
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('term term-decided has decided coverage'));
    });

    test('GUARD 5 suppression excludes dispute-suspended terms (prior_billing_mode recorded) when the column exists', async () => {
      const colsQ = query({ columnInfo: { prior_billing_mode: {} } });
      const pendingQ = query({ rows: [] });
      const conn = makeConn({
        annual_prepay_terms: [colsQ],
        'annual_prepay_terms as t': [pendingQ],
      });

      await AnnualPrepayRenewals.getPaymentPendingCustomerIds('2026-07-09', conn);

      // Accept-pending terms have prior_billing_mode NULL (it is only written
      // at activation), so this filter keeps them suppressed while letting
      // dispute-suspended (once-active) terms bill normally mid-dispute.
      expect(pendingQ.whereNull).toHaveBeenCalledWith('t.prior_billing_mode');
    });

    test('GUARD 5 keeps legacy shape when the prior_billing_mode column is absent', async () => {
      const colsQ = query({ columnInfo: {} });
      const pendingQ = query({ rows: [] });
      const conn = makeConn({
        annual_prepay_terms: [colsQ],
        'annual_prepay_terms as t': [pendingQ],
      });

      await AnnualPrepayRenewals.getPaymentPendingCustomerIds('2026-07-09', conn);

      expect(pendingQ.whereNull).not.toHaveBeenCalledWith('t.prior_billing_mode');
    });

    test('no invoice id → no-op', async () => {
      const conn = makeConn({});
      const suspended = await AnnualPrepayRenewals.suspendActiveTermsForDisputedInvoice(null, conn);
      expect(suspended).toEqual([]);
      expect(conn).not.toHaveBeenCalled();
    });
  });

  describe('reconcileCoveredTermsSweep', () => {
    test('re-runs the reconcile per covered term and re-attempts lost reversals for refunded grant invoices', async () => {
      // Term with NO coverage config: reconcile leg early-returns, isolating
      // the reversal-recovery leg.
      const bareTerm = {
        id: 'term-1', customer_id: 'cust-1', status: 'active',
        term_start: '2026-07-01', term_end: '2027-07-01',
        prepay_amount: '480.00', coverage_visit_count: null, coverage_service_type: null,
      };
      const grant = {
        note: 'Annual prepay paid after this visit already billed — the visit\'s prepay share returned as account credit (term term-1, visit ab12cd34-5678-90ab-cdef-1234567890ab)',
        invoice_id: 'inv-1',
        delta: '120.00',
      };
      const conn = makeConn({
        'annual_prepay_terms as t': [query({ rows: [bareTerm] })],
        customer_credit_ledger: [
          query({ rows: [grant] }), // sweep grant scan
          query({ rows: [{ ...grant, id: 'ledger-1' }] }), // reversal: grants for term+visit
          query({ rows: [] }), // reversal: existing reversal notes
        ],
        invoices: [query({ first: { id: 'inv-1', status: 'refunded' } })],
        customers: [query({ first: { id: 'cust-1', account_credits: '120.00' } })],
      });

      const summary = await AnnualPrepayRenewals.reconcileCoveredTermsSweep({ today: '2026-07-09', conn });

      expect(summary.terms).toBe(1);
      expect(summary.reversed).toBe(1);
      expect(postCreditMovement).toHaveBeenCalledWith(expect.objectContaining({
        customerId: 'cust-1',
        delta: -120,
      }), conn);
    });

    test('grant invoice still collectible → nothing reversed', async () => {
      const bareTerm = {
        id: 'term-1', customer_id: 'cust-1', status: 'active',
        term_start: '2026-07-01', term_end: '2027-07-01',
        prepay_amount: '480.00', coverage_visit_count: null, coverage_service_type: null,
      };
      const grant = {
        note: 'Annual prepay paid after this visit already billed — the visit\'s prepay share returned as account credit (term term-1, visit ab12cd34-5678-90ab-cdef-1234567890ab)',
        invoice_id: 'inv-1',
      };
      const conn = makeConn({
        'annual_prepay_terms as t': [query({ rows: [bareTerm] })],
        customer_credit_ledger: [query({ rows: [grant] })],
        invoices: [query({ first: { id: 'inv-1', status: 'paid' } })],
      });

      const summary = await AnnualPrepayRenewals.reconcileCoveredTermsSweep({ today: '2026-07-09', conn });

      expect(summary.reversed).toBe(0);
      expect(postCreditMovement).not.toHaveBeenCalled();
    });

    test('sweep query failure degrades to empty summary, never throws', async () => {
      const conn = jest.fn(() => { throw new Error('boom'); });
      const summary = await AnnualPrepayRenewals.reconcileCoveredTermsSweep({ today: '2026-07-09', conn });
      expect(summary).toEqual({ terms: 0, settled: 0, credited: 0, reversed: 0 });
    });
  });

  describe('coveredTermsAsOf status guard — decided coverage requires a PAID invoice', () => {
    // Capture the real statusGuard where-callback off coveredTermsAsOf, then
    // evaluate it against synthetic rows with a minimal knex-semantics
    // interpreter (where/andWhere/whereIn/whereNull = AND; orWhere* = OR;
    // nested callbacks = groups). This pins the lost-chargeback behavior:
    // the dispute reopen flips the prepay invoice to 'overdue' with its PI
    // linkage CLEARED, so this guard is the only thing that can revoke
    // decided coverage.
    function captureStatusGuard() {
      let guard = null;
      const b = {};
      ['leftJoin', 'whereRaw', 'whereIn', 'select', 'distinct', 'first'].forEach((m) => {
        b[m] = () => b;
      });
      b.where = (arg) => {
        if (typeof arg === 'function' && !guard) guard = arg;
        return b;
      };
      AnnualPrepayRenewals.coveredTermsAsOf(() => b, null);
      if (!guard) throw new Error('statusGuard callback not captured');
      return guard;
    }

    function evaluateGuard(guard, row) {
      function makeGroup() {
        const g = {
          val: null,
          comb(op, v) { g.val = g.val === null ? v : (op === 'and' ? (g.val && v) : (g.val || v)); return g; },
        };
        const pred = (a, b2) => {
          if (typeof a === 'function') { const inner = makeGroup(); a.call(inner); return !!inner.val; }
          return row[a] === b2;
        };
        g.where = (a, b2) => g.comb('and', pred(a, b2));
        g.andWhere = (a, b2) => g.comb('and', pred(a, b2));
        g.orWhere = (a, b2) => g.comb('or', pred(a, b2));
        g.whereIn = (col, arr) => g.comb('and', arr.includes(row[col]));
        g.whereNull = (col) => g.comb('and', row[col] == null);
        g.orWhereNotNull = (col) => g.comb('or', row[col] != null);
        return g;
      }
      const root = makeGroup();
      guard.call(root);
      return !!root.val;
    }

    const rows = {
      renewedPaid: { 't.status': 'renewed', 't.prepay_invoice_id': 'inv-1', 'i.status': 'paid', 'i.paid_at': '2026-01-01' },
      renewedDisputeReopened: { 't.status': 'renewed', 't.prepay_invoice_id': 'inv-1', 'i.status': 'overdue', 'i.paid_at': null },
      switchPlanDisputeReopened: { 't.status': 'switch_plan', 't.prepay_invoice_id': 'inv-1', 'i.status': 'overdue', 'i.paid_at': null },
      decidedLapsePaid: { 't.status': 'cancelled', 't.renewal_decision': 'cancel', 't.prepay_invoice_id': 'inv-1', 'i.status': 'paid', 'i.paid_at': '2026-01-01' },
      decidedLapseDisputeReopened: { 't.status': 'cancelled', 't.renewal_decision': 'cancel', 't.prepay_invoice_id': 'inv-1', 'i.status': 'overdue', 'i.paid_at': null },
      decidedLegacyNoInvoice: { 't.status': 'renewed', 't.prepay_invoice_id': null, 'i.status': undefined, 'i.paid_at': undefined },
      activeAnyInvoice: { 't.status': 'active', 't.prepay_invoice_id': 'inv-1', 'i.status': 'overdue', 'i.paid_at': null },
      pendingPaidInvoice: { 't.status': 'payment_pending', 't.prepay_invoice_id': 'inv-1', 'i.status': 'paid', 'i.paid_at': '2026-01-01' },
      pendingOpenInvoice: { 't.status': 'payment_pending', 't.prepay_invoice_id': 'inv-1', 'i.status': 'sent', 'i.paid_at': null },
      trueCancel: { 't.status': 'cancelled', 't.renewal_decision': null, 't.prepay_invoice_id': 'inv-1', 'i.status': 'refunded', 'i.paid_at': null },
    };

    test('decided terms lose coverage when the prepay invoice reopens (lost/open chargeback)', () => {
      const guard = captureStatusGuard();
      expect(evaluateGuard(guard, rows.renewedDisputeReopened)).toBe(false);
      expect(evaluateGuard(guard, rows.switchPlanDisputeReopened)).toBe(false);
      expect(evaluateGuard(guard, rows.decidedLapseDisputeReopened)).toBe(false);
    });

    test('paid decided coverage, legacy no-invoice decided coverage, and live/pending semantics are unchanged', () => {
      const guard = captureStatusGuard();
      expect(evaluateGuard(guard, rows.renewedPaid)).toBe(true);
      expect(evaluateGuard(guard, rows.decidedLapsePaid)).toBe(true);
      expect(evaluateGuard(guard, rows.decidedLegacyNoInvoice)).toBe(true);
      expect(evaluateGuard(guard, rows.activeAnyInvoice)).toBe(true); // ACTIVE carries no invoice condition here (dispute suspend + NOT-EXISTS handle it)
      expect(evaluateGuard(guard, rows.pendingPaidInvoice)).toBe(true);
      expect(evaluateGuard(guard, rows.pendingOpenInvoice)).toBe(false);
      expect(evaluateGuard(guard, rows.trueCancel)).toBe(false);
    });
  });
});
