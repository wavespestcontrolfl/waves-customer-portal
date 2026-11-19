/**
 * GET /billing-v2/balance — invoice-linked failed rows must not double-count
 * (money-path audit 2026-07-06 P1).
 *
 * A declined saved-card charge on a sent invoice inserts a failed payments
 * row while the invoice stays 'sent' — the same obligation then counted
 * TWICE in currentBalance (invoice + failed attempt), and nothing ever
 * superseded the row (no next_retry_at for the retry sweep, no PI for
 * /confirm to match), so the phantom persisted after the customer paid.
 * Contract:
 *   - failed rows stamped with metadata.invoice_id are EXCLUDED from
 *     failedTotal (the obligation lives on the invoice row)
 *   - unstamped failed rows (monthly autopay ladder) still count
 *   - lastPaymentFailed banner still reflects the attempt history
 */
jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.customerId = 'cust-1';
    req.customer = { id: 'cust-1', monthly_rate: '55.00', waveguard_tier: 'silver' };
    next();
  },
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../services/stripe', () => ({}));
jest.mock('../config/stripe-config', () => ({}));
jest.mock('../services/payment-lifecycle-email', () => ({}));
jest.mock('../services/autopay-log', () => ({ logAutopay: jest.fn() }));
const mockLoadLivePayerLinkage = jest.fn();
let mockPortalPayNow = false;
jest.mock('../services/payer-linkage', () => ({
  ...jest.requireActual('../services/payer-linkage'),
  loadLivePayerLinkage: (...args) => mockLoadLivePayerLinkage(...args),
}));
jest.mock('../config/feature-gates', () => ({
  isEnabled: (gate) => gate === 'portalPayNow' && mockPortalPayNow,
}));

// Programmable table results, set per test.
const tableResults = {
  payerInvoices: [],
  failedRows: [],
  upcomingRows: [],
  unpaidTotal: '0',
  recentAttempts: [],
  openInvoices: [],
  liveOwnedInvoices: [],
  // Invoices referenced by failed rows that are NOT draft (the whereIn +
  // whereNot('draft') status lookup) — i.e. invoices that carry their own
  // balance, so their failed rows are excluded from failedTotal.
  linkedNonDraftInvoices: [],
};
const invoiceQueryCalls = [];

jest.mock('../models/db', () => {
  const mkChain = (resolveFn) => {
    const q = {};
    const passthrough = ['where', 'whereIn', 'whereNotIn', 'whereNot', 'whereNull', 'whereNotNull', 'whereRaw', 'orWhere', 'orWhereIn', 'orWhereNot', 'orWhereNull', 'orWhereNotNull', 'orderBy', 'limit', 'offset'];
    for (const m of passthrough) {
      q[m] = (...args) => {
        q._calls = q._calls || [];
        q._calls.push([m, args]);
        // Grouped clauses record their nested calls, as knex applies them:
        // the payer-owned filter matches payer_id OR the withdrawal stamp.
        if (typeof args[0] === 'function') args[0].call(q);
        return q;
      };
    }
    q.select = (...args) => { q._selected = args; return q; };
    q.first = async () => resolveFn(q, true);
    q.then = (onOk, onErr) => Promise.resolve().then(() => resolveFn(q, false)).then(onOk, onErr);
    q.catch = (fn) => Promise.resolve().then(() => resolveFn(q, false)).catch(fn);
    return q;
  };
  const dbFn = jest.fn((table) => mkChain((q, wantFirst) => {
    const calls = q._calls || [];
    const whereArg = (calls.find(([m]) => m === 'where') || [null, [{}]])[1][0] || {};
    if (table === 'invoices') {
      invoiceQueryCalls.push(calls);
      if (calls.some(([m]) => m === 'whereNotNull')) {
        if (tableResults.payerInvoices instanceof Error) throw tableResults.payerInvoices;
        return tableResults.payerInvoices;
      }
      // unpaidInvoices uses whereIn('status', …) but terminates with .first();
      // the failed-row status lookup uses whereIn('id', …) with no .first().
      if (wantFirst) return { total: tableResults.unpaidTotal };
      // Pay-now open-invoice list (status filter lives in a where-group, so
      // it is keyed off its whereNull payer filters). Check this before the
      // status lookup: the failed-draft rescue now has its own whereIn('id').
      if (calls.some(([m]) => m === 'whereNull')) {
        const excluded = new Set(calls
          .filter(([m, args]) => m === 'whereNotIn' && args[0] === 'id')
          .flatMap(([, args]) => args[1]).map(String));
        return tableResults.openInvoices.filter((row) => !excluded.has(String(row.id)));
      }
      if (calls.some(([m, args]) => m === 'whereIn' && args[0] === 'id')) return tableResults.linkedNonDraftInvoices;
      return tableResults.unpaidTotal;
    }
    if (table === 'payments') {
      const project = (rows) => rows.map((row) => Object.fromEntries(q._selected.map((key) => [key, row[key]])));
      if (whereArg.status === 'failed') return project(tableResults.failedRows);
      if (whereArg.status === 'upcoming') return project(tableResults.upcomingRows);
      // recent-attempts scan (whereIn statuses)
      if (wantFirst) return tableResults.recentAttempts[0] || null;
      return project(tableResults.recentAttempts);
    }
    throw new Error(`Unexpected table ${table}`);
  }));
  dbFn.raw = (sql) => sql;
  const trxFn = jest.fn((table) => dbFn(table));
  trxFn.raw = dbFn.raw;
  dbFn.__balanceTrx = trxFn;
  dbFn.__snapshotActive = false;
  dbFn.transaction = jest.fn(async (callback, options) => {
    dbFn.__snapshotActive = true;
    try {
      return await callback(trxFn);
    } finally {
      dbFn.__snapshotActive = false;
    }
  });
  return dbFn;
});

const billingRouter = require('../routes/billing-v2');
const LINKED_INVOICE_ID = '44444444-4444-4444-8444-444444444444';

// Invoke the GET /balance handler directly (no supertest at the repo root):
// the authenticate middleware is mocked above, so the handler only needs
// req.customerId / req.customer and a res.json spy.
async function getBalance() {
  const layer = billingRouter.stack.find((l) => l.route?.path === '/balance');
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const req = {
    customerId: 'cust-1',
    customer: { id: 'cust-1', monthly_rate: '55.00', waveguard_tier: 'silver' },
  };
  let body = null;
  const database = require('../models/db');
  const res = { json: (payload) => { body = payload; getBalance.publishedDuringSnapshot = database.__snapshotActive; } };
  let error = null;
  await handler(req, res, (err) => { error = err; });
  if (error) throw error;
  return body;
}

describe('GET /balance — phantom failed-row exclusion', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPortalPayNow = false;
    invoiceQueryCalls.length = 0;
    tableResults.payerInvoices = [];
    tableResults.failedRows = [];
    tableResults.upcomingRows = [];
    tableResults.unpaidTotal = '0';
    tableResults.recentAttempts = [];
    tableResults.openInvoices = [];
    tableResults.liveOwnedInvoices = [];
    tableResults.linkedNonDraftInvoices = [];
    getBalance.publishedDuringSnapshot = null;
    mockLoadLivePayerLinkage.mockImplementation(async () => {
      if (tableResults.payerInvoices instanceof Error) {
        return { failed: true, payerInvoiceIds: new Set(), liveOwnedIds: new Set(), liveOwnedRows: [], isPayerLinked: () => false };
      }
      const { buildPayerLinkage } = jest.requireActual('../services/payer-linkage');
      const linkage = buildPayerLinkage([...tableResults.payerInvoices, ...tableResults.liveOwnedInvoices]);
      return {
        ...linkage,
        liveOwnedIds: new Set(tableResults.liveOwnedInvoices.map((row) => String(row.id))),
        liveOwnedRows: tableResults.liveOwnedInvoices,
      };
    });
  });

  test('every ownership, amount, status and token read shares one repeatable-read snapshot, committed before publish', async () => {
    mockPortalPayNow = true;
    await getBalance();

    const database = require('../models/db');
    expect(database.transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: 'repeatable read', readOnly: true },
    );
    expect(mockLoadLivePayerLinkage).toHaveBeenCalledWith('cust-1', database.__balanceTrx);
    expect(database.__balanceTrx.mock.calls.map(([table]) => table)).toEqual([
      'payments', // failed facts
      'payments', // upcoming amount
      'invoices', // unpaid sum
      'payments', // latest-attempt banner
      'invoices', // Pay-now tokens
    ]);
    expect(getBalance.publishedDuringSnapshot).toBe(false);
  });

  test('the latest attempt excludes direct and invoice-linked payer rows before choosing the homeowner’s payment', async () => {
    const payerInvoiceId = 'ab36f51e-4441-4cc8-bbf7-c41ffad50152';
    const homeownerInvoiceId = 'de27b36a-3054-4c64-93e4-0d15b785bb34';
    tableResults.payerInvoices = [{ id: payerInvoiceId, stripe_charge_id: 'ch_payer' }];
    tableResults.recentAttempts = [
      { id: 'direct', status: 'failed', payer_id: 'third-party' },
      { id: 'stamped', status: 'failed', metadata: JSON.stringify({ payer_id: 'third-party' }) },
      { id: 'linked', status: 'failed', stripe_charge_id: 'ch_payer' },
      {
        id: 'alias',
        status: 'failed',
        metadata: { invoice_id: homeownerInvoiceId, waves_invoice_id: payerInvoiceId.toUpperCase() },
      },
    ];
    const payerRows = tableResults.recentAttempts.map((row) => ({ ...row, amount: '99.00' }));
    tableResults.failedRows = [...payerRows, { amount: '12.00' }];
    tableResults.upcomingRows = [...payerRows, { amount: '17.00', payment_date: '2026-12-01' }];
    expect(await getBalance()).toMatchObject({
      lastPaymentFailed: false, lastPaymentAttemptId: null, currentBalance: 12,
      upcomingCharges: 17, nextCharge: { amount: 17, date: '2026-12-01' },
    });
    tableResults.recentAttempts.push({ id: 'own', status: 'failed' });
    expect(await getBalance()).toMatchObject({ lastPaymentFailed: true, lastPaymentAttemptId: 'own' });
  });

  test('live default/visit payer ownership is excluded from failed, upcoming, balance, next-charge, and Pay now surfaces', async () => {
    const visitPayerInvoiceId = '11111111-1111-4111-8111-111111111111';
    const defaultPayerInvoiceId = '22222222-2222-4222-8222-222222222222';
    const ownInvoiceId = '33333333-3333-4333-8333-333333333333';
    tableResults.liveOwnedInvoices = [
      {
        id: visitPayerInvoiceId,
        scheduled_service_id: 'visit-with-payer',
        stripe_payment_intent_id: 'pi_visit_payer',
        invoice_number: 'WPC-2026-1001',
      },
      {
        id: defaultPayerInvoiceId,
        scheduled_service_id: 'visit-using-default-payer',
        stripe_charge_id: 'ch_default_payer',
        invoice_number: 'WPC-2026-1002',
      },
    ];
    tableResults.failedRows = [
      { amount: '70.00', metadata: { invoice_id: visitPayerInvoiceId } },
      { amount: '80.00', stripe_charge_id: 'ch_default_payer' },
      { amount: '12.00', metadata: null },
    ];
    tableResults.upcomingRows = [
      { amount: '70.00', metadata: { invoice_id: visitPayerInvoiceId }, payment_date: '2026-12-01' },
      { amount: '80.00', stripe_charge_id: 'ch_default_payer', payment_date: '2026-12-02' },
      { amount: '17.00', payment_date: '2026-12-03', description: 'Homeowner renewal' },
    ];
    tableResults.recentAttempts = [
      { id: 'payer-failure', status: 'failed', stripe_payment_intent_id: 'pi_visit_payer' },
      { id: 'own-paid', status: 'paid' },
    ];
    // The fake aggregate represents only the homeowner invoice after SQL
    // applies the live-owned exclusion.
    tableResults.unpaidTotal = '31.00';
    tableResults.openInvoices = [
      { id: visitPayerInvoiceId, token: 'payer-token', invoice_number: 'WPC-2026-1001', total: '70.00', credit_applied: 0, amount_paid: 0 },
      { id: defaultPayerInvoiceId, token: 'default-payer-token', invoice_number: 'WPC-2026-1002', total: '80.00', credit_applied: 0, amount_paid: 0 },
      { id: ownInvoiceId, token: 'own-token', invoice_number: 'WPC-2026-1003', total: '31.00', credit_applied: 0, amount_paid: 0 },
    ];
    mockPortalPayNow = true;

    const body = await getBalance();

    expect(body).toMatchObject({
      currentBalance: 43,
      upcomingCharges: 17,
      nextCharge: { amount: 17, date: '2026-12-03', description: 'Homeowner renewal' },
      lastPaymentFailed: false,
      openInvoices: [{ payUrl: '/pay/own-token', amountDue: 31, invoiceNumber: 'WPC-2026-1003' }],
    });
    const liveExclusions = invoiceQueryCalls
      .flatMap((calls) => calls.filter(([method, args]) => method === 'whereNotIn' && args[0] === 'id'));
    expect(liveExclusions).toEqual([
      ['whereNotIn', ['id', [visitPayerInvoiceId, defaultPayerInvoiceId]]],
      ['whereNotIn', ['id', [visitPayerInvoiceId, defaultPayerInvoiceId]]],
    ]);
    const statementExclusions = invoiceQueryCalls
      .flatMap((calls) => calls.filter(([method, args]) => method === 'whereNull' && args[0] === 'payer_statement_id'));
    expect(statementExclusions).toHaveLength(2);
  });

  test('the unpaid invoice aggregate excludes statement-accrued children even when payer_id is null', async () => {
    tableResults.unpaidTotal = '25.00';

    expect((await getBalance()).currentBalance).toBe(25);

    const unpaidRead = invoiceQueryCalls.find((calls) => calls.some(
      ([method, args]) => method === 'whereIn' && args[0] === 'status',
    ));
    expect(unpaidRead).toEqual(expect.arrayContaining([
      ['whereNull', ['payer_id']],
      ['whereNull', ['payer_statement_id']],
    ]));
  });

  test('unverifiable payer ownership uses the existing Billing unavailable path instead of returning a wrong amount or zero', async () => {
    tableResults.payerInvoices = new Error('payer lookup unavailable');
    tableResults.recentAttempts = [{ id: 'unknown', status: 'failed' }];
    tableResults.failedRows = [{ amount: 44 }];
    tableResults.upcomingRows = [{ amount: 55 }];
    tableResults.unpaidTotal = '25.00';
    await expect(getBalance()).rejects.toMatchObject({
      isOperational: true,
      statusCode: 503,
      code: 'BILLING_OWNERSHIP_UNAVAILABLE',
    });
  });

  test('invoice-linked failed row does not double-count the open invoice', async () => {
    tableResults.unpaidTotal = '107.00';
    tableResults.failedRows = [{
      amount: '110.11',
      metadata: JSON.stringify({ invoice_id: LINKED_INVOICE_ID, source: 'card_on_file_failed_attempt' }),
    }];
    tableResults.linkedNonDraftInvoices = [{ id: LINKED_INVOICE_ID }];
    tableResults.recentAttempts = [{ status: 'failed', metadata: null }];

    const body = await getBalance();
    // Only the invoice — not invoice + failed surcharged gross (217.11).
    expect(body.currentBalance).toBe(107);
    // The banner still reflects the failed attempt.
    expect(body.lastPaymentFailed).toBe(true);
  });

  test('invoice-linked failed row leaves no phantom after the invoice settles', async () => {
    tableResults.unpaidTotal = '0';
    tableResults.failedRows = [{
      amount: '110.11',
      metadata: JSON.stringify({ invoice_id: LINKED_INVOICE_ID }),
    }];
    tableResults.linkedNonDraftInvoices = [{ id: LINKED_INVOICE_ID }]; // settled = paid, still non-draft
    tableResults.recentAttempts = [{ status: 'paid', metadata: null }];

    const body = await getBalance();
    expect(body.currentBalance).toBe(0);
    expect(body.lastPaymentFailed).toBe(false);
  });

  test('unstamped failed rows (monthly autopay ladder) still count as balance owed', async () => {
    tableResults.failedRows = [{ amount: '55.00', metadata: null }];

    const body = await getBalance();
    expect(body.currentBalance).toBe(55);
  });

  // Codex #4682 r3 P1: the monthly cron's lock-contention deferral is a
  // 'failed' row with next_retry_at armed but NO attempt behind it — the
  // competing collector may be landing this very month. It must not be
  // shown (or payable) as balance, and must not raise the failed banner.
  test('a never-attempted lock-contention deferral is neither balance nor a failed attempt', async () => {
    const deferral = {
      amount: '55.00', stripe_payment_intent_id: null, retry_count: 0, next_retry_at: '2026-09-24T14:00:00Z',
      metadata: JSON.stringify({ type: 'monthly_autopay', billed_month: '2026-09', deferred_reason: 'lock_contention' }),
    };
    tableResults.failedRows = [deferral];
    tableResults.recentAttempts = [{ status: 'failed', ...deferral }, { status: 'paid', metadata: null }];

    const body = await getBalance();
    expect(body.currentBalance).toBe(0);
    expect(body.lastPaymentFailed).toBe(false);
  });

  test('a deferral the sweep DISARMED without superseding (Auto Pay off / off the monthly lane) counts again — no collector is coming for it', async () => {
    const disarmed = {
      amount: '55.00', stripe_payment_intent_id: null, retry_count: 0, next_retry_at: null,
      metadata: JSON.stringify({ type: 'monthly_autopay', billed_month: '2026-09', deferred_reason: 'lock_contention' }),
    };
    tableResults.failedRows = [disarmed];
    tableResults.recentAttempts = [{ status: 'failed', ...disarmed }];

    const body = await getBalance();
    expect(body.currentBalance).toBe(55);
    expect(body.lastPaymentFailed).toBe(true);
  });

  test('once the retry sweep has actually attempted the deferral (retry_count > 0) it counts like any failed rung', async () => {
    const attempted = {
      amount: '55.00', stripe_payment_intent_id: null, retry_count: 1, next_retry_at: '2026-09-26T14:00:00Z',
      metadata: JSON.stringify({ type: 'monthly_autopay', billed_month: '2026-09', deferred_reason: 'lock_contention' }),
    };
    tableResults.failedRows = [attempted];
    tableResults.recentAttempts = [{ status: 'failed', ...attempted }];

    const body = await getBalance();
    expect(body.currentBalance).toBe(55);
    expect(body.lastPaymentFailed).toBe(true);
  });

  test('a failure linked to a DRAFT invoice still counts — drafts are not in unpaidInvoices', async () => {
    // Per-application completion path: createFromService mints a draft, the
    // auto-charge fails. unpaidInvoices only sums sent/viewed/overdue, so
    // excluding this failed row too would show $0 owed while the draft
    // invoice/pay-link is still collectible (Codex P2).
    tableResults.unpaidTotal = '0';
    tableResults.failedRows = [{
      amount: '89.00',
      metadata: JSON.stringify({ invoice_id: 'inv-draft', source: 'card_on_file_failed_attempt' }),
    }];
    tableResults.linkedNonDraftInvoices = []; // inv-draft is draft → not returned

    const body = await getBalance();
    expect(body.currentBalance).toBe(89);
  });
});
