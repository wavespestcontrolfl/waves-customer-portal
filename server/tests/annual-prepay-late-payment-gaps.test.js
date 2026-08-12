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
  WAVEGUARD_EXTENSION_CREDIT_BY: 'system:waveguard_tier_extension',
  WAVEGUARD_EXTENSION_REVERSAL_BY: 'system:waveguard_tier_extension_reversal',
  WAVEGUARD_EXTENSION_RESTORE_BY: 'system:waveguard_tier_extension_restore',
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
    const TERM_COLS = { prior_billing_mode: {}, dispute_suspended_at: {} };

    test('flips active/renewal_pending to payment_pending, stamps the dispute marker, clears stamps, restores billing mode for suspended AND decided terms', async () => {
      const colsQ = query({ columnInfo: TERM_COLS });
      const suspendQ = query({ returning: [{ ...COVERED_TERM, status: 'payment_pending' }] });
      const reselectQ = query({ rows: [{ ...COVERED_TERM, status: 'payment_pending' }] });
      const stampClearQ = query();
      const replacementQ = query({ first: undefined }); // no replacement coverage
      const priorQ = query({ first: { prior_billing_mode: 'per_application' } });
      const customerResetQ = query();
      const decidedQ = query({ rows: [{ id: 'term-decided', customer_id: 'cust-2', status: 'renewed', source_estimate_id: null }] });
      const decidedMarkerQ = query();
      const decidedStampClearQ = query();
      const decidedReplacementQ = query({ first: undefined });
      const decidedPriorQ = query({ first: { prior_billing_mode: 'none' } });
      const decidedCustomerResetQ = query();
      const conn = makeConn({
        annual_prepay_terms: [colsQ, suspendQ, reselectQ, replacementQ, priorQ, decidedQ, decidedMarkerQ, decidedReplacementQ, decidedPriorQ],
        scheduled_services: [stampClearQ, decidedStampClearQ],
        customers: [customerResetQ, decidedCustomerResetQ],
      });
      conn.schema = { hasColumn: jest.fn().mockResolvedValue(true) };
      db.mockImplementation(() => query({ columnInfo: SS_COLS })); // scheduledServiceColumns cache

      const suspended = await AnnualPrepayRenewals.suspendActiveTermsForDisputedInvoice('prepay-inv-1', conn);

      expect(suspended).toHaveLength(1);
      expect(suspendQ.whereIn).toHaveBeenCalledWith('status', ['active', 'renewal_pending']);
      // The demotion stamps the marker so a crashed attempt is re-selectable
      // and GUARD 5 can classify the suspension without the prior heuristic.
      expect(suspendQ.update).toHaveBeenCalledWith(expect.objectContaining({
        status: 'payment_pending',
        dispute_suspended_at: expect.any(Date),
      }));
      expect(reselectQ.whereNotNull).toHaveBeenCalledWith('dispute_suspended_at');
      // Future-visit stamps must clear (method-scoped) or a visit billed
      // mid-dispute is skipped by the won-dispute reconcile as "already
      // covered" and the customer double-pays.
      expect(stampClearQ.where).toHaveBeenCalledWith('prepaid_method', 'annual_prepay_invoice');
      expect(stampClearQ.update).toHaveBeenCalledWith(expect.objectContaining({ prepaid_amount: null }));
      // Decided terms get the dispute marker too (status untouched): it
      // anchors the won-dispute dues claw-back window and flags an
      // incomplete restore for the daily sweep. whereNull = replay-safe.
      expect(decidedMarkerQ.whereNull).toHaveBeenCalledWith('dispute_suspended_at');
      expect(decidedMarkerQ.update).toHaveBeenCalledWith(expect.objectContaining({ dispute_suspended_at: expect.any(Date) }));
      // Same double-pay exists for DECIDED coverage (Codex round-2 P1): its
      // stamps must clear at suspension too.
      expect(decidedStampClearQ.where).toHaveBeenCalledWith('prepaid_method', 'annual_prepay_invoice');
      expect(decidedStampClearQ.update).toHaveBeenCalledWith(expect.objectContaining({ prepaid_amount: null }));
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

    test('retry safety (Codex round-2 P1): a term demoted by a crashed earlier attempt still gets its stamp clear + mode reset', async () => {
      const colsQ = query({ columnInfo: TERM_COLS });
      // The retry's conditional UPDATE matches nothing — the term is already
      // payment_pending from the crashed first attempt.
      const suspendQ = query({ returning: [] });
      const reselectQ = query({
        rows: [{ ...COVERED_TERM, status: 'payment_pending', dispute_suspended_at: new Date('2026-07-09T10:00:00Z') }],
      });
      const stampClearQ = query();
      const replacementQ = query({ first: undefined });
      const priorQ = query({ first: { prior_billing_mode: 'per_application' } });
      const customerResetQ = query();
      const decidedQ = query({ rows: [] });
      const conn = makeConn({
        annual_prepay_terms: [colsQ, suspendQ, reselectQ, replacementQ, priorQ, decidedQ],
        scheduled_services: [stampClearQ],
        customers: [customerResetQ],
      });
      conn.schema = { hasColumn: jest.fn().mockResolvedValue(true) };
      db.mockImplementation(() => query({ columnInfo: SS_COLS }));

      const suspended = await AnnualPrepayRenewals.suspendActiveTermsForDisputedInvoice('prepay-inv-1', conn);

      expect(suspended).toHaveLength(1);
      expect(stampClearQ.update).toHaveBeenCalledWith(expect.objectContaining({ prepaid_amount: null }));
      expect(customerResetQ.update).toHaveBeenCalledWith(expect.objectContaining({ billing_mode: 'per_application' }));
    });

    test('fail-fast: a stamp-clear failure propagates so the webhook fails and Stripe retries', async () => {
      const colsQ = query({ columnInfo: TERM_COLS });
      const suspendQ = query({ returning: [{ ...COVERED_TERM, status: 'payment_pending' }] });
      const reselectQ = query({ rows: [{ ...COVERED_TERM, status: 'payment_pending' }] });
      const failingClearQ = query();
      failingClearQ.then = (resolve, reject) => Promise.reject(new Error('db down')).then(resolve, reject);
      const conn = makeConn({
        annual_prepay_terms: [colsQ, suspendQ, reselectQ],
        scheduled_services: [failingClearQ],
      });
      conn.schema = { hasColumn: jest.fn().mockResolvedValue(true) };
      db.mockImplementation(() => query({ columnInfo: SS_COLS }));

      await expect(
        AnnualPrepayRenewals.suspendActiveTermsForDisputedInvoice('prepay-inv-1', conn),
      ).rejects.toThrow('db down');
    });

    test('pre-migration fallback: no marker column → demotion carries no marker and follow-ups run on the demoted rows alone', async () => {
      const colsQ = query({ columnInfo: { prior_billing_mode: {} } });
      const suspendQ = query({ returning: [{ ...COVERED_TERM, status: 'payment_pending' }] });
      const stampClearQ = query();
      const replacementQ = query({ first: undefined });
      const priorQ = query({ first: { prior_billing_mode: 'per_application' } });
      const customerResetQ = query();
      const decidedQ = query({ rows: [] });
      const conn = makeConn({
        annual_prepay_terms: [colsQ, suspendQ, replacementQ, priorQ, decidedQ],
        scheduled_services: [stampClearQ],
        customers: [customerResetQ],
      });
      conn.schema = { hasColumn: jest.fn().mockResolvedValue(true) };
      db.mockImplementation(() => query({ columnInfo: SS_COLS }));

      const suspended = await AnnualPrepayRenewals.suspendActiveTermsForDisputedInvoice('prepay-inv-1', conn);

      expect(suspended).toHaveLength(1);
      expect(Object.keys(suspendQ.update.mock.calls[0][0])).not.toContain('dispute_suspended_at');
      expect(stampClearQ.update).toHaveBeenCalledWith(expect.objectContaining({ prepaid_amount: null }));
    });

    test('GUARD 5 suppression excludes dispute-suspended terms by the marker when the column exists (legacy NULL-prior terms included — Codex round-2 P2)', async () => {
      const colsQ = query({ columnInfo: TERM_COLS });
      const pendingQ = query({ rows: [] });
      const conn = makeConn({
        annual_prepay_terms: [colsQ],
        'annual_prepay_terms as t': [pendingQ],
      });

      await AnnualPrepayRenewals.getPaymentPendingCustomerIds('2026-07-09', conn);

      // Accept-pending terms never carry the marker (only the dispute
      // demotion stamps it), so they stay suppressed while suspended terms —
      // including legacy ones whose prior_billing_mode was never backfilled —
      // bill normally mid-dispute.
      expect(pendingQ.whereNull).toHaveBeenCalledWith('t.dispute_suspended_at');
      expect(pendingQ.whereNull).not.toHaveBeenCalledWith('t.prior_billing_mode');
    });

    test('GUARD 5 falls back to the prior-recorded heuristic when only prior_billing_mode exists', async () => {
      const colsQ = query({ columnInfo: { prior_billing_mode: {} } });
      const pendingQ = query({ rows: [] });
      const conn = makeConn({
        annual_prepay_terms: [colsQ],
        'annual_prepay_terms as t': [pendingQ],
      });

      await AnnualPrepayRenewals.getPaymentPendingCustomerIds('2026-07-09', conn);

      expect(pendingQ.whereNull).toHaveBeenCalledWith('t.prior_billing_mode');
      expect(pendingQ.whereNull).not.toHaveBeenCalledWith('t.dispute_suspended_at');
    });

    test('GUARD 5 keeps legacy shape when neither column is present', async () => {
      const colsQ = query({ columnInfo: {} });
      const pendingQ = query({ rows: [] });
      const conn = makeConn({
        annual_prepay_terms: [colsQ],
        'annual_prepay_terms as t': [pendingQ],
      });

      await AnnualPrepayRenewals.getPaymentPendingCustomerIds('2026-07-09', conn);

      expect(pendingQ.whereNull).not.toHaveBeenCalledWith('t.prior_billing_mode');
      expect(pendingQ.whereNull).not.toHaveBeenCalledWith('t.dispute_suspended_at');
    });

    test('no invoice id → no-op', async () => {
      const conn = makeConn({});
      const suspended = await AnnualPrepayRenewals.suspendActiveTermsForDisputedInvoice(null, conn);
      expect(suspended).toEqual([]);
      expect(conn).not.toHaveBeenCalled();
    });
  });

  describe('won-dispute decided-coverage restore (Codex round-2 P1)', () => {
    test('a live decided term re-stamps its remaining visits and settles mid-dispute per-visit invoices', async () => {
      const DECIDED_TERM = {
        id: 'term-d',
        customer_id: 'cust-1',
        prepay_invoice_id: 'prepay-inv-1',
        status: 'renewed',
        term_start: '2026-07-01',
        term_end: '2027-07-01',
        prepay_amount: '480.00',
        coverage_visit_count: 4,
        coverage_service_type: 'Pest Control',
      };
      // Dispute suspension cleared both stamps; the completed visit billed
      // per-visit while the dispute was open.
      const FUTURE_VISIT = {
        id: 'visit-f', customer_id: 'cust-1', scheduled_date: '2026-08-01',
        status: 'scheduled', service_type: 'Pest Control',
        prepaid_amount: null, prepaid_method: null, annual_prepay_term_id: 'term-d',
      };
      const MID_DISPUTE_COMPLETED = {
        id: 'visit-c', customer_id: 'cust-1', scheduled_date: '2026-07-05',
        status: 'completed', service_type: 'Pest Control',
        prepaid_amount: null, prepaid_method: null, annual_prepay_term_id: 'term-d',
      };
      const visitStampQ = query({ returning: [{ id: 'visit-f' }] });
      const priorWriteQ = query();
      const stampModeQ = query();
      settleInvoiceAsAnnualPrepayCovered.mockResolvedValue({ settled: true });
      const conn = makeConn({
        annual_prepay_terms: [
          query({ rows: [] }), // pending/active terms on the paid invoice: none
          query({ rows: [] }), // dispute-cancel revival lookup — none
          query({ rows: [DECIDED_TERM] }), // decided-coverage select
          priorWriteQ, // first-stamp-wins prior record
        ],
        'annual_prepay_terms as t': [
          query({ first: { id: 'term-d' } }), // coveredTermsAsOf live check
        ],
        scheduled_services: [
          query({ rows: [FUTURE_VISIT, MID_DISPUTE_COMPLETED] }), // applyPrepaidCoverage rows
          visitStampQ, // future-visit re-stamp
          query({ rows: [FUTURE_VISIT, MID_DISPUTE_COMPLETED] }), // reconcile rows
        ],
        invoices: [
          query({ first: { id: 'inv-visit', status: 'sent', payer_id: null } }), // mid-dispute per-visit invoice
          query({ first: { id: 'prepay-inv-1', scheduled_service_id: null } }), // visit-invoice hook lookup
        ],
        customers: [
          query({ first: { id: 'cust-1' } }), // extension-restore row lock
          query({ first: { billing_mode: 'per_application' } }), // prior-mode read
          stampModeQ, // billing_mode re-stamp
        ],
        customer_credit_ledger: [
          query({ rows: [] }), // extension-restore reversal lookup: none
        ],
      });
      conn.schema = { hasColumn: jest.fn().mockResolvedValue(true) };
      db.mockImplementation(() => query({ columnInfo: SS_COLS }));

      await AnnualPrepayRenewals.syncTermForInvoicePayment(
        { id: 'prepay-inv-1', status: 'paid', paid_at: '2026-07-09' },
        conn,
      );

      // Coverage stamps return to the remaining future visits...
      expect(visitStampQ.update).toHaveBeenCalledWith(expect.objectContaining({
        prepaid_method: 'annual_prepay_invoice',
        prepaid_amount: 120, // 480 / 4 visits
      }));
      // ...the mid-dispute per-visit invoice settles as coverage (no
      // double-pay: the won annual IS that visit's payment)...
      expect(settleInvoiceAsAnnualPrepayCovered).toHaveBeenCalledWith('inv-visit', 'term-d');
      // ...and the customer's billing classification is restored.
      expect(stampModeQ.update).toHaveBeenCalledWith(expect.objectContaining({ billing_mode: 'annual_prepay' }));
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
          query({ rows: [] }), // extension-restore reversal lookup: none
          query({ rows: [grant] }), // sweep grant scan
          query({ rows: [{ ...grant, id: 'ledger-1' }] }), // reversal: grants for term+visit
          query({ rows: [] }), // reversal: existing reversal notes
        ],
        invoices: [query({ first: { id: 'inv-1', status: 'refunded' } })],
        customers: [
          query({ first: { id: 'cust-1' } }), // extension-restore row lock
          query({ first: { id: 'cust-1', account_credits: '120.00' } }),
        ],
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

    // WaveGuard extension-credit recovery pass — the refunded ANCHOR is the
    // whole evidence (codex #3344 r1 P1): a refunded term that already
    // decided renewal keeps 'renewed'/'switch_plan' status, so a
    // status='cancelled' filter would permanently strand exactly the grants
    // a lost refund sync leaves behind.
    test('extension grant on a DECIDED (renewed) term with a refunded prepay anchor still recovers', async () => {
      const extGrant = {
        note: 'WaveGuard Silver extension — prepaid-term difference (term term-9, estimate est-1)',
        invoice_id: 'inv-prepay',
        delta: '4.90',
      };
      const conn = makeConn({
        'annual_prepay_terms as t': [query({ rows: [] })], // dated loop — no covered terms
        annual_prepay_terms: [
          query({ columnInfo: {} }), // expired-window marker pass column probe → skipped
          query({ first: { id: 'term-9', customer_id: 'cust-1', status: 'renewed' } }),
        ],
        customer_credit_ledger: [
          query({ rows: [extGrant] }), // extension grant class scan
          query({ rows: [{ ...extGrant, id: 'lg-1' }] }), // reversal: per-term grants
          query({ rows: [] }), // reversal: legacy-shape grants — none
          query({ rows: [{ ...extGrant, id: 'lg-1' }] }), // reversal: marker events (grant-last → clawable)
        ],
        invoices: [
          query({ first: { id: 'inv-prepay', status: 'refunded' } }), // unlocked pre-check
          query({ first: { id: 'inv-prepay', status: 'refunded' } }), // in-lock recheck
        ],
        customers: [
          query({ first: { id: 'cust-1' } }), // hoisted customer lock (r5 P2)
          query({ first: { id: 'cust-1', account_credits: '10.00' } }), // reversal's own lock
        ],
      });

      const summary = await AnnualPrepayRenewals.reconcileCoveredTermsSweep({ today: '2026-07-09', conn });

      expect(summary.reversed).toBe(1);
      expect(postCreditMovement).toHaveBeenCalledWith(expect.objectContaining({
        customerId: 'cust-1',
        delta: -4.9,
        createdBy: 'system:waveguard_tier_extension_reversal',
      }), conn);
      // Lock order (codex #3344 r5 P2): the customer lock must precede the
      // in-lock anchor recheck — the grant path holds the customer FOR
      // UPDATE and takes KEY SHARE on the anchor via the ledger FK, so
      // anchor-first here would deadlock against it.
      const tables = conn.mock.calls.map((call) => call[0]);
      const firstAnchorIdx = tables.indexOf('invoices'); // unlocked pre-check
      const inLockAnchorIdx = tables.indexOf('invoices', firstAnchorIdx + 1);
      const customerLockIdx = tables.indexOf('customers');
      expect(customerLockIdx).toBeGreaterThan(firstAnchorIdx);
      expect(customerLockIdx).toBeLessThan(inLockAnchorIdx);
    });

    // TOCTOU guard (codex #3344 r2): the unlocked pre-check can observe
    // 'refunded' while a lost-dispute REPAYMENT is mid-flight — the in-lock
    // recheck must see the repaid anchor and stand down, or the sweep would
    // claw a credit whose backing payment was just restored.
    test('anchor repaid between pre-check and lock → the in-lock recheck stands down', async () => {
      const extGrant = {
        note: 'WaveGuard Silver extension — prepaid-term difference (term term-9, estimate est-1)',
        invoice_id: 'inv-prepay',
        delta: '4.90',
      };
      const conn = makeConn({
        'annual_prepay_terms as t': [query({ rows: [] })],
        annual_prepay_terms: [query({ columnInfo: {} })],
        customer_credit_ledger: [query({ rows: [extGrant] })],
        invoices: [
          query({ first: { id: 'inv-prepay', status: 'refunded' } }), // stale pre-check
          query({ first: { id: 'inv-prepay', status: 'paid' } }), // repayment won the race
        ],
        customers: [query({ first: { id: 'cust-1' } })], // hoisted customer lock (r5 P2)
      });

      const summary = await AnnualPrepayRenewals.reconcileCoveredTermsSweep({ today: '2026-07-09', conn });

      expect(summary.reversed).toBe(0);
      expect(postCreditMovement).not.toHaveBeenCalled();
    });

    // Final lost dispute (codex #3344 r9 P1): closed(lost) leaves the
    // prepay invoice 'overdue' for recollection — never a terminal status —
    // so a cancelled-statuses-only filter permanently skips exactly the
    // grants a transiently-failed inline clawback strands. The durable
    // evidence is the payment row the webhook stamped
    // (metadata.dispute_final='lost' bound to the anchor).
    test('extension grant whose anchor sits overdue under a FINAL lost dispute claws back', async () => {
      const extGrant = {
        note: 'WaveGuard Silver extension — prepaid-term difference (term term-9, estimate est-1)',
        invoice_id: 'inv-prepay',
        delta: '4.90',
      };
      const overdueAnchor = { id: 'inv-prepay', status: 'overdue', stripe_payment_intent_id: null };
      const conn = makeConn({
        'annual_prepay_terms as t': [query({ rows: [] })], // dated loop — no covered terms
        annual_prepay_terms: [
          query({ columnInfo: {} }), // expired-window marker pass column probe → skipped
          query({ first: { id: 'term-9', customer_id: 'cust-1', status: 'cancelled' } }),
        ],
        customer_credit_ledger: [
          query({ rows: [extGrant] }), // extension grant class scan
          query({ rows: [{ ...extGrant, id: 'lg-1' }] }), // reversal: per-term grants
          query({ rows: [] }), // reversal: legacy-shape grants — none
          query({ rows: [{ ...extGrant, id: 'lg-1' }] }), // reversal: marker events (grant-last → clawable)
        ],
        invoices: [
          query({ first: overdueAnchor }), // unlocked pre-check
          query({ first: overdueAnchor }), // in-lock recheck
        ],
        payments: [
          query({ first: { id: 'pay-1' } }), // pre-check: dispute_final='lost' evidence
          query({ first: { id: 'pay-1' } }), // in-lock re-proof
        ],
        customers: [
          query({ first: { id: 'cust-1' } }), // hoisted customer lock (r5 P2)
          query({ first: { id: 'cust-1', account_credits: '10.00' } }), // reversal's own lock
        ],
      });

      const summary = await AnnualPrepayRenewals.reconcileCoveredTermsSweep({ today: '2026-07-09', conn });

      expect(summary.reversed).toBe(1);
      expect(postCreditMovement).toHaveBeenCalledWith(expect.objectContaining({
        customerId: 'cust-1',
        delta: -4.9,
        createdBy: 'system:waveguard_tier_extension_reversal',
      }), conn);
    });

    // An OPEN dispute parks the invoice at 'overdue' too, but writes no
    // dispute_final — the sweep must never claw mid-dispute.
    test('overdue anchor under an OPEN dispute (no dispute_final) is left alone', async () => {
      const extGrant = {
        note: 'WaveGuard Silver extension — prepaid-term difference (term term-9, estimate est-1)',
        invoice_id: 'inv-prepay',
        delta: '4.90',
      };
      const conn = makeConn({
        'annual_prepay_terms as t': [query({ rows: [] })],
        annual_prepay_terms: [query({ columnInfo: {} })],
        customer_credit_ledger: [query({ rows: [extGrant] })],
        invoices: [
          query({ first: { id: 'inv-prepay', status: 'overdue', stripe_payment_intent_id: 'pi_disputed' } }),
        ],
        payments: [query({ first: undefined })], // no dispute_final='lost' row
      });

      const summary = await AnnualPrepayRenewals.reconcileCoveredTermsSweep({ today: '2026-07-09', conn });

      expect(summary.reversed).toBe(0);
      expect(postCreditMovement).not.toHaveBeenCalled();
    });

    // Recollection TOCTOU: the customer re-pays the lost-dispute invoice
    // between the pre-check and the lock — the in-lock recheck sees 'paid'
    // (lost-dispute evidence short-circuits on any non-overdue status) and
    // stands down; the restore machinery owns the repaid state.
    test('lost-dispute anchor recollected between pre-check and lock → stands down', async () => {
      const extGrant = {
        note: 'WaveGuard Silver extension — prepaid-term difference (term term-9, estimate est-1)',
        invoice_id: 'inv-prepay',
        delta: '4.90',
      };
      const conn = makeConn({
        'annual_prepay_terms as t': [query({ rows: [] })],
        annual_prepay_terms: [query({ columnInfo: {} })],
        customer_credit_ledger: [query({ rows: [extGrant] })],
        invoices: [
          query({ first: { id: 'inv-prepay', status: 'overdue', stripe_payment_intent_id: null } }), // pre-check
          query({ first: { id: 'inv-prepay', status: 'paid', stripe_payment_intent_id: 'pi_new' } }), // recollected
        ],
        payments: [query({ first: { id: 'pay-1' } })], // pre-check evidence only
        customers: [query({ first: { id: 'cust-1' } })], // hoisted customer lock
      });

      const summary = await AnnualPrepayRenewals.reconcileCoveredTermsSweep({ today: '2026-07-09', conn });

      expect(summary.reversed).toBe(0);
      expect(postCreditMovement).not.toHaveBeenCalled();
    });

    // Unanchored grants (pre-push P0, codex r5 round): the accept path
    // posts the grant with invoice_id NULL when its best-effort anchor
    // lookup failed — the sweep must resolve the anchor from the term's
    // CURRENT prepay invoice or exactly those grants have no recovery.
    test('a grant with NO ledger anchor resolves the term prepay invoice and still claws back', async () => {
      const unanchoredGrant = {
        note: 'WaveGuard Silver extension — prepaid-term difference (term term-9, estimate est-1)',
        invoice_id: null,
        delta: '4.90',
        customer_id: 'cust-1',
      };
      const conn = makeConn({
        'annual_prepay_terms as t': [query({ rows: [] })],
        annual_prepay_terms: [
          query({ columnInfo: {} }), // expired-window marker pass probe
          query({ first: { id: 'term-9', prepay_invoice_id: 'inv-prepay' } }), // anchor resolve
          query({ first: { id: 'term-9', customer_id: 'cust-1', status: 'renewed' } }), // in-lock term fetch
        ],
        customer_credit_ledger: [
          query({ rows: [unanchoredGrant] }), // grant class scan
          query({ rows: [{ ...unanchoredGrant, id: 'lg-1' }] }), // reversal: per-term grants
          query({ rows: [] }), // reversal: legacy-shape grants
          query({ rows: [{ ...unanchoredGrant, id: 'lg-1', created_by: 'system:waveguard_tier_extension' }] }), // marker events
        ],
        invoices: [
          query({ first: { id: 'inv-prepay', status: 'refunded' } }), // pre-check on the RESOLVED anchor
          query({ first: { id: 'inv-prepay', status: 'refunded' } }), // in-lock recheck
        ],
        customers: [
          query({ first: { id: 'cust-1' } }),
          query({ first: { id: 'cust-1', account_credits: '10.00' } }),
        ],
      });

      const summary = await AnnualPrepayRenewals.reconcileCoveredTermsSweep({ today: '2026-07-09', conn });

      expect(summary.reversed).toBe(1);
      expect(postCreditMovement).toHaveBeenCalledWith(expect.objectContaining({
        customerId: 'cust-1',
        delta: -4.9,
      }), conn);
    });

    test('extension grant whose prepay anchor is still collectible is never clawed by the sweep', async () => {
      const extGrant = {
        note: 'WaveGuard Silver extension — prepaid-term difference (term term-9, estimate est-1)',
        invoice_id: 'inv-prepay',
        delta: '4.90',
      };
      const conn = makeConn({
        'annual_prepay_terms as t': [query({ rows: [] })],
        customer_credit_ledger: [query({ rows: [extGrant] })],
        invoices: [query({ first: { id: 'inv-prepay', status: 'paid' } })],
      });

      const summary = await AnnualPrepayRenewals.reconcileCoveredTermsSweep({ today: '2026-07-09', conn });

      expect(summary.reversed).toBe(0);
      expect(postCreditMovement).not.toHaveBeenCalled();
    });

    // Restore recovery pass (codex #3344 r5 P1): the dated loop restores
    // only covered-TODAY terms, so a refunded anchor repaid AFTER term_end
    // whose inline restore was lost would strand the clawed credit forever.
    // The pass keys on the reversal class and re-validates paid backing
    // windowlessly (decided-repaid restores are not window-gated).
    const extReversal = {
      note: 'Annual prepay refunded — reversing the WaveGuard extension credit (term term-9, estimate est-1)',
      invoice_id: 'inv-prepay',
      delta: '-4.90',
      created_by: 'system:waveguard_tier_extension_reversal',
      customer_id: 'cust-1',
    };
    const extGrantEvent = {
      id: 'lg-grant',
      note: 'WaveGuard Silver extension — prepaid-term difference (term term-9, estimate est-1)',
      invoice_id: 'inv-prepay',
      delta: '4.90',
      created_by: 'system:waveguard_tier_extension',
    };

    test('clawed credit on an EXPIRED-window term whose anchor is repaid restores through the recovery pass', async () => {
      const conn = makeConn({
        'annual_prepay_terms as t': [
          query({ rows: [] }), // dated loop: nothing covered today (window expired)
          query({ first: { id: 'term-9', customer_id: 'cust-1' } }), // windowless paid-backing recheck
        ],
        annual_prepay_terms: [query({ columnInfo: {} })], // expired marker pass column probe → skipped
        customer_credit_ledger: [
          query({ rows: [] }), // clawback pass grant scan — none outstanding
          query({ rows: [extReversal] }), // restore pass reversal scan
          query({ rows: [extReversal] }), // restore fn: reversals for the term
          query({ rows: [extGrantEvent, { ...extReversal, id: 'lg-rev' }] }), // marker events (reversal-last)
        ],
        invoices: [
          query({ first: { id: 'inv-prepay', status: 'paid' } }), // unlocked pre-check: repaid
          query({ first: { id: 'inv-prepay' } }), // in-lock anchor
        ],
        customers: [
          query({ first: { id: 'cust-1' } }), // hoisted customer lock
          query({ first: { id: 'cust-1' } }), // restore fn's own lock
        ],
      });

      const summary = await AnnualPrepayRenewals.reconcileCoveredTermsSweep({ today: '2026-07-09', conn });

      expect(summary.credited).toBe(1);
      expect(postCreditMovement).toHaveBeenCalledWith(expect.objectContaining({
        customerId: 'cust-1',
        delta: 4.9,
        createdBy: 'system:waveguard_tier_extension_restore',
      }), conn);
    });

    test('an UNANCHORED reversal resolves the term prepay invoice and still restores when repaid', async () => {
      const unanchoredReversal = { ...extReversal, invoice_id: null };
      const conn = makeConn({
        'annual_prepay_terms as t': [
          query({ rows: [] }), // dated loop
          query({ first: { id: 'term-9', customer_id: 'cust-1' } }), // windowless paid-backing recheck
        ],
        annual_prepay_terms: [
          query({ columnInfo: {} }), // marker pass probe
          query({ first: { id: 'term-9', prepay_invoice_id: 'inv-prepay' } }), // anchor resolve
        ],
        customer_credit_ledger: [
          query({ rows: [] }), // clawback pass grant scan
          query({ rows: [unanchoredReversal] }), // restore pass reversal scan
          query({ rows: [extReversal] }), // restore fn: reversals for the term
          query({ rows: [extGrantEvent, { ...extReversal, id: 'lg-rev' }] }), // marker events
        ],
        invoices: [
          query({ first: { id: 'inv-prepay', status: 'paid' } }), // pre-check on the RESOLVED anchor
          query({ first: { id: 'inv-prepay' } }), // in-lock anchor
        ],
        customers: [
          query({ first: { id: 'cust-1' } }),
          query({ first: { id: 'cust-1' } }),
        ],
      });

      const summary = await AnnualPrepayRenewals.reconcileCoveredTermsSweep({ today: '2026-07-09', conn });

      expect(summary.credited).toBe(1);
      expect(postCreditMovement).toHaveBeenCalledWith(expect.objectContaining({
        customerId: 'cust-1',
        delta: 4.9,
        createdBy: 'system:waveguard_tier_extension_restore',
      }), conn);
    });

    test('restore recovery stands down while the anchor is still refunded', async () => {
      const conn = makeConn({
        'annual_prepay_terms as t': [query({ rows: [] })],
        annual_prepay_terms: [query({ columnInfo: {} })],
        customer_credit_ledger: [
          query({ rows: [] }), // clawback pass grant scan
          query({ rows: [extReversal] }), // restore pass reversal scan
        ],
        invoices: [query({ first: { id: 'inv-prepay', status: 'refunded', paid_at: null } })],
      });

      const summary = await AnnualPrepayRenewals.reconcileCoveredTermsSweep({ today: '2026-07-09', conn });

      expect(summary.credited).toBe(0);
      expect(postCreditMovement).not.toHaveBeenCalled();
    });

    test('paid anchor whose term fails the windowless paid-backing recheck restores nothing', async () => {
      const conn = makeConn({
        'annual_prepay_terms as t': [
          query({ rows: [] }), // dated loop
          query({ first: undefined }), // coveredTermsAsOf(null): term not paid-backed
        ],
        annual_prepay_terms: [query({ columnInfo: {} })],
        customer_credit_ledger: [
          query({ rows: [] }), // clawback pass grant scan
          query({ rows: [extReversal] }), // restore pass reversal scan
        ],
        invoices: [
          query({ first: { id: 'inv-prepay', status: 'paid' } }), // pre-check
          query({ first: { id: 'inv-prepay' } }), // in-lock anchor
        ],
        customers: [query({ first: { id: 'cust-1' } })],
      });

      const summary = await AnnualPrepayRenewals.reconcileCoveredTermsSweep({ today: '2026-07-09', conn });

      expect(summary.credited).toBe(0);
      expect(postCreditMovement).not.toHaveBeenCalled();
    });

    test('sweep query failure degrades to empty summary, never throws', async () => {
      const conn = jest.fn(() => { throw new Error('boom'); });
      const summary = await AnnualPrepayRenewals.reconcileCoveredTermsSweep({ today: '2026-07-09', conn });
      expect(summary).toEqual({ terms: 0, settled: 0, credited: 0, reversed: 0, disputeRecovered: 0 });
    });

    test('dispute-marker leg (Codex round-3 P2): a covered term still carrying the marker gets mode re-stamp, dues claw-back, and marker clear', async () => {
      const markedTerm = {
        id: 'term-1', customer_id: 'cust-1', status: 'renewed',
        term_start: '2026-07-01', term_end: '2027-07-01',
        prepay_amount: '480.00', coverage_visit_count: null, coverage_service_type: null,
        dispute_suspended_at: '2026-07-05T14:00:00Z',
      };
      const paidDues = {
        id: 'pay-dues-1', status: 'paid', amount: '89.00',
        payment_date: '2026-07-06', refund_status: null, refund_amount: null,
      };
      const priorWriteQ = query();
      const stampModeQ = query();
      const markerClearQ = query();
      const conn = makeConn({
        'annual_prepay_terms as t': [query({ rows: [markedTerm] })],
        annual_prepay_terms: [priorWriteQ, markerClearQ],
        customers: [
          query({ first: { billing_mode: null } }), // stamp prior-mode read
          stampModeQ, // billing_mode re-stamp
          query({ first: { id: 'cust-1' } }), // dues credit row lock
        ],
        payments: [query({ rows: [paidDues] })],
        customer_credit_ledger: [
          query({ first: undefined }), // dues credit dedupe check
          query({ rows: [] }), // reversal-recovery grants scan
        ],
      });
      conn.schema = { hasColumn: jest.fn().mockResolvedValue(true) };
      db.mockImplementation(() => query({ columnInfo: SS_COLS }));

      const summary = await AnnualPrepayRenewals.reconcileCoveredTermsSweep({ today: '2026-07-09', conn });

      expect(summary.disputeRecovered).toBe(1);
      expect(stampModeQ.update).toHaveBeenCalledWith(expect.objectContaining({ billing_mode: 'annual_prepay' }));
      expect(postCreditMovement).toHaveBeenCalledWith(expect.objectContaining({
        customerId: 'cust-1',
        delta: 89,
        createdBy: 'system:annual_prepay_dispute_dues',
      }), conn);
      expect(markerClearQ.update).toHaveBeenCalledWith(expect.objectContaining({ dispute_suspended_at: null }));
    });
  });

  describe('dispute-window monthly dues claw-back (Codex round-3 P1)', () => {
    const MARKED_TERM = {
      id: 'term-1', customer_id: 'cust-1', status: 'active',
      term_start: '2026-07-01', term_end: '2027-07-01',
      dispute_suspended_at: '2026-07-05T14:00:00Z',
    };

    test('paid dues inside the dispute window credit back and the marker clears', async () => {
      const markerClearQ = query();
      const conn = makeConn({
        payments: [query({
          rows: [{ id: 'pay-dues-1', status: 'paid', amount: '89.00', payment_date: '2026-07-06', refund_status: null, refund_amount: null }],
        })],
        customers: [query({ first: { id: 'cust-1' } })], // row lock
        customer_credit_ledger: [query({ first: undefined })], // no dup marker
        annual_prepay_terms: [markerClearQ],
      });

      const summary = await AnnualPrepayRenewals.finishDisputeRecoveryForTerm(MARKED_TERM, conn);

      expect(summary).toEqual({ credited: 1, pending: 0 });
      expect(postCreditMovement).toHaveBeenCalledWith(expect.objectContaining({
        customerId: 'cust-1',
        delta: 89,
        createdBy: 'system:annual_prepay_dispute_dues',
        note: expect.stringContaining('(term term-1, dues payment pay-dues-1)'),
      }), conn);
      expect(markerClearQ.update).toHaveBeenCalledWith(expect.objectContaining({ dispute_suspended_at: null }));
    });

    test('processing (in-flight ACH) dues defer: no credit, marker kept for the next sync/sweep', async () => {
      const conn = makeConn({
        payments: [query({
          rows: [{ id: 'pay-dues-2', status: 'processing', amount: '89.00', payment_date: '2026-07-06', refund_status: null, refund_amount: null }],
        })],
        // NO annual_prepay_terms queue: a marker-clear attempt would throw
        // and fail this test.
      });

      const summary = await AnnualPrepayRenewals.finishDisputeRecoveryForTerm(MARKED_TERM, conn);

      expect(summary).toEqual({ credited: 0, pending: 1 });
      expect(postCreditMovement).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('deferred'));
    });

    test('refund-touched dues go to operator follow-up: no auto-credit, marker still clears', async () => {
      const markerClearQ = query();
      const conn = makeConn({
        payments: [query({
          rows: [{ id: 'pay-dues-3', status: 'paid', amount: '89.00', payment_date: '2026-07-06', refund_status: 'partial', refund_amount: '20.00' }],
        })],
        annual_prepay_terms: [markerClearQ],
      });

      const summary = await AnnualPrepayRenewals.finishDisputeRecoveryForTerm(MARKED_TERM, conn);

      expect(summary).toEqual({ credited: 0, pending: 0 });
      expect(postCreditMovement).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('refund activity'));
      expect(markerClearQ.update).toHaveBeenCalledWith(expect.objectContaining({ dispute_suspended_at: null }));
    });

    test('no marker on the term → no-op', async () => {
      const conn = makeConn({});
      const summary = await AnnualPrepayRenewals.finishDisputeRecoveryForTerm({ ...MARKED_TERM, dispute_suspended_at: null }, conn);
      expect(summary).toEqual({ credited: 0, pending: 0 });
      expect(conn).not.toHaveBeenCalled();
    });

    test('dues query is bounded to the coverage window — post-term_end collections never claw back (Codex round-4 P2)', async () => {
      const paymentsQ = query({ rows: [] });
      const markerClearQ = query();
      const conn = makeConn({
        payments: [paymentsQ],
        annual_prepay_terms: [markerClearQ], // nothing pending → marker clears
      });

      await AnnualPrepayRenewals.finishDisputeRecoveryForTerm(MARKED_TERM, conn);

      // Lower bound = dispute open; upper bound = term_end (GUARD 4 only
      // ever suppressed dues while coverage was in force, so anything
      // collected after term_end was owed regardless). The upper bound is
      // what keeps the legacy description match from clawing post-coverage
      // months.
      expect(paymentsQ.where).toHaveBeenCalledWith('payment_date', '>=', '2026-07-05');
      expect(paymentsQ.where).toHaveBeenCalledWith('payment_date', '<=', '2027-07-01');
    });

    test('an ET-evening suspension keeps same-ET-day dues in the window (Codex round-5 P2: timestamptz vs ET calendar date)', async () => {
      // 2026-07-06T01:30:00Z = 2026-07-05 9:30 PM ET (EDT): the UTC date has
      // already rolled over, so a UTC-derived lower bound would start the
      // window on 07-06 and skip dues collected that same ET evening.
      const eveningTerm = { ...MARKED_TERM, dispute_suspended_at: '2026-07-06T01:30:00Z' };
      const paymentsQ = query({ rows: [] });
      const markerClearQ = query();
      const conn = makeConn({
        payments: [paymentsQ],
        annual_prepay_terms: [markerClearQ],
      });

      await AnnualPrepayRenewals.finishDisputeRecoveryForTerm(eveningTerm, conn);

      expect(paymentsQ.where).toHaveBeenCalledWith('payment_date', '>=', '2026-07-05');
    });

    test('won-dispute reactivation runs the claw-back end to end through syncTermForInvoicePayment', async () => {
      const PENDING_MARKED = {
        id: 'term-s', customer_id: 'cust-1', status: 'payment_pending',
        prepay_amount: null, coverage_visit_count: null, coverage_service_type: null,
        term_start: '2026-07-01', term_end: '2027-07-01',
        dispute_suspended_at: '2026-07-05T14:00:00Z',
      };
      const ACTIVE_MARKED = { ...PENDING_MARKED, status: 'active' };
      const stampModeQ = query();
      const markerClearQ = query();
      const conn = makeConn({
        annual_prepay_terms: [
          query({ rows: [PENDING_MARKED] }), // terms select for the paid invoice
          query({ rows: [] }), // dispute-cancel revival lookup — none
          query({ returning: [ACTIVE_MARKED] }), // pending→active flip (marker survives)
          query({ returning: [ACTIVE_MARKED] }), // refreshTermSnapshot snapshot update
          query(), // prior_billing_mode record on the term
          markerClearQ, // marker clear after clean claw-back
          query({ rows: [] }), // decided-coverage select
        ],
        customers: [
          query({ columnInfo: {} }), // syncCustomerRenewalDate probe
          query({ first: { billing_mode: 'per_application' } }), // stamp prior-mode read
          stampModeQ, // billing_mode stamp
          query({ first: { id: 'cust-1' } }), // dues credit row lock
        ],
        scheduled_services: [
          query(), // attachScheduledServices window update (no coverage config)
          query({ first: undefined }), // findLastScheduledServiceForTerm
        ],
        payments: [query({
          rows: [{ id: 'pay-dues-1', status: 'paid', amount: '89.00', payment_date: '2026-07-06', refund_status: null, refund_amount: null }],
        })],
        customer_credit_ledger: [query({ first: undefined })], // dues dedupe check
      });
      conn.schema = { hasColumn: jest.fn().mockResolvedValue(true) };
      db.mockImplementation(() => query({ columnInfo: SS_COLS }));

      await AnnualPrepayRenewals.syncTermForInvoicePayment(
        { id: 'prepay-inv-1', status: 'paid', paid_at: '2026-07-09' },
        conn,
      );

      expect(postCreditMovement).toHaveBeenCalledWith(expect.objectContaining({
        customerId: 'cust-1',
        delta: 89,
        createdBy: 'system:annual_prepay_dispute_dues',
      }), conn);
      expect(markerClearQ.update).toHaveBeenCalledWith(expect.objectContaining({ dispute_suspended_at: null }));
    });
  });

  describe('lost-dispute revival (Codex round-4 P1)', () => {
    test('re-paying the reopened invoice revives the dispute-cancelled term through the full restore pipeline', async () => {
      const CANCELLED_MARKED = {
        id: 'term-r', customer_id: 'cust-1', status: 'cancelled', renewal_decision: null,
        prepay_amount: null, coverage_visit_count: null, coverage_service_type: null,
        term_start: '2026-07-01', term_end: '2027-07-01',
        dispute_suspended_at: '2026-07-05T14:00:00Z',
      };
      const REVIVED = { ...CANCELLED_MARKED, status: 'active' };
      const revivalSelectQ = query({ rows: [CANCELLED_MARKED] });
      const reviveQ = query({ returning: [REVIVED] });
      const stampModeQ = query();
      const markerClearQ = query();
      const conn = makeConn({
        annual_prepay_terms: [
          query({ rows: [] }), // pending/active terms on the paid invoice: none
          revivalSelectQ, // marker-gated cancelled-term lookup
          reviveQ, // cancelled→active revival update
          query({ returning: [REVIVED] }), // refreshTermSnapshot snapshot update
          query(), // prior_billing_mode record on the term
          markerClearQ, // marker clear after clean claw-back
          query({ rows: [] }), // decided-coverage select
        ],
        customers: [
          query({ first: { id: 'cust-1' } }), // extension-restore row lock (revival leg)
          query({ columnInfo: {} }), // syncCustomerRenewalDate probe
          query({ first: { billing_mode: null } }), // stamp prior-mode read
          stampModeQ, // billing_mode stamp
          query({ first: { id: 'cust-1' } }), // dues credit row lock
        ],
        scheduled_services: [
          query(), // attachScheduledServices window update (no coverage config)
          query({ first: undefined }), // findLastScheduledServiceForTerm
        ],
        payments: [query({
          rows: [{ id: 'pay-dues-1', status: 'paid', amount: '89.00', payment_date: '2026-07-06', refund_status: null, refund_amount: null }],
        })],
        customer_credit_ledger: [
          query({ rows: [] }), // extension-restore reversal lookup: none
          query({ first: undefined }), // dues dedupe check
        ],
      });
      conn.schema = { hasColumn: jest.fn().mockResolvedValue(true) };
      db.mockImplementation(() => query({ columnInfo: SS_COLS }));

      await AnnualPrepayRenewals.syncTermForInvoicePayment(
        { id: 'prepay-inv-1', status: 'paid', paid_at: '2026-07-09' },
        conn,
      );

      // Only the dispute-cancel shape revives: renewal_decision NULL +
      // dispute marker present, both on the select and the update.
      expect(revivalSelectQ.whereNull).toHaveBeenCalledWith('renewal_decision');
      expect(revivalSelectQ.whereNotNull).toHaveBeenCalledWith('dispute_suspended_at');
      expect(reviveQ.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'active' }));
      // The revived term runs the whole active pipeline: billing-mode
      // re-stamp, dues claw-back, marker clear.
      expect(stampModeQ.update).toHaveBeenCalledWith(expect.objectContaining({ billing_mode: 'annual_prepay' }));
      expect(postCreditMovement).toHaveBeenCalledWith(expect.objectContaining({
        customerId: 'cust-1',
        delta: 89,
        createdBy: 'system:annual_prepay_dispute_dues',
      }), conn);
      expect(markerClearQ.update).toHaveBeenCalledWith(expect.objectContaining({ dispute_suspended_at: null }));
    });
  });

  describe('expired-window dispute recovery (Codex round-4 P2)', () => {
    const EXPIRED_DECIDED = {
      id: 'term-x', customer_id: 'cust-1', status: 'renewed',
      prepay_invoice_id: 'prepay-inv-1',
      term_start: '2024-07-01', term_end: '2025-07-01',
      prepay_amount: '480.00', coverage_visit_count: 4, coverage_service_type: 'Pest Control',
      dispute_suspended_at: '2025-06-20T14:00:00Z',
    };
    const PAID_DUES = { id: 'pay-dues-x', status: 'paid', amount: '89.00', payment_date: '2025-06-25', refund_status: null, refund_amount: null };

    test('a decided-term dispute resolved after term_end still claws back in-window dues and clears the marker (no stamp restore)', async () => {
      const markerClearQ = query();
      const conn = makeConn({
        annual_prepay_terms: [
          query({ rows: [] }), // pending/active terms on the paid invoice: none
          query({ rows: [] }), // dispute-cancel revival lookup — none
          query({ rows: [EXPIRED_DECIDED] }), // decided-coverage select
          markerClearQ, // marker clear after clean claw-back
        ],
        'annual_prepay_terms as t': [
          query({ first: { id: 'term-x' } }), // null-window paid-backing check
        ],
        // NO stamp-restore queues: the expired window must skip
        // stampAnnualPrepayBillingMode / applyPrepaidCoverageForTerm — any
        // attempt would consume the dues row lock below and fail the credit
        // assertion.
        customers: [
          query({ first: { id: 'cust-1' } }), // extension-restore row lock (not window-gated)
          query({ first: { id: 'cust-1' } }), // dues credit row lock
        ],
        payments: [query({ rows: [PAID_DUES] })],
        customer_credit_ledger: [
          query({ rows: [] }), // extension-restore reversal lookup: none
          query({ first: undefined }), // dues dedupe check
        ],
        invoices: [query({ first: { id: 'prepay-inv-1', scheduled_service_id: null } })], // visit-hook lookup
      });
      conn.schema = { hasColumn: jest.fn().mockResolvedValue(true) };
      db.mockImplementation(() => query({ columnInfo: SS_COLS }));

      await AnnualPrepayRenewals.syncTermForInvoicePayment(
        { id: 'prepay-inv-1', status: 'paid', paid_at: '2026-07-09' },
        conn,
      );

      expect(postCreditMovement).toHaveBeenCalledWith(expect.objectContaining({
        customerId: 'cust-1',
        delta: 89,
        createdBy: 'system:annual_prepay_dispute_dues',
      }), conn);
      expect(markerClearQ.update).toHaveBeenCalledWith(expect.objectContaining({ dispute_suspended_at: null }));
    });

    test('sweep expired-window marker pass recovers a marked term the covered-today loop can no longer see', async () => {
      const staleQ = query({ rows: [EXPIRED_DECIDED] });
      const markerClearQ = query();
      const conn = makeConn({
        'annual_prepay_terms as t': [
          query({ rows: [] }), // covered-today sweep selection: none
          staleQ, // null-window marker re-selection
        ],
        annual_prepay_terms: [
          query({ columnInfo: { prior_billing_mode: {}, dispute_suspended_at: {} } }), // column guard
          markerClearQ,
        ],
        customers: [query({ first: { id: 'cust-1' } })], // dues credit row lock
        payments: [query({ rows: [PAID_DUES] })],
        customer_credit_ledger: [query({ first: undefined })],
      });
      conn.schema = { hasColumn: jest.fn().mockResolvedValue(true) };
      db.mockImplementation(() => query({ columnInfo: SS_COLS }));

      const summary = await AnnualPrepayRenewals.reconcileCoveredTermsSweep({ today: '2026-07-09', conn });

      expect(staleQ.whereNotNull).toHaveBeenCalledWith('t.dispute_suspended_at');
      expect(summary.disputeRecovered).toBe(1);
      expect(postCreditMovement).toHaveBeenCalledWith(expect.objectContaining({
        customerId: 'cust-1',
        delta: 89,
        createdBy: 'system:annual_prepay_dispute_dues',
      }), conn);
      expect(markerClearQ.update).toHaveBeenCalledWith(expect.objectContaining({ dispute_suspended_at: null }));
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
