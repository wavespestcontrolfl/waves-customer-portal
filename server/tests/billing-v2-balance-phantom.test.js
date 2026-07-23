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
jest.mock('../services/payment-router', () => ({}));
jest.mock('../services/stripe', () => ({}));
jest.mock('../config/stripe-config', () => ({}));
jest.mock('../services/payment-lifecycle-email', () => ({}));
jest.mock('../services/autopay-log', () => ({ logAutopay: jest.fn() }));

// Programmable table results, set per test.
const tableResults = {
  payerInvoices: [],
  failedRows: [],
  upcomingRows: [],
  unpaidTotal: '0',
  recentAttempts: [],
  // Invoices referenced by failed rows that are NOT draft (the whereIn +
  // whereNot('draft') status lookup) — i.e. invoices that carry their own
  // balance, so their failed rows are excluded from failedTotal.
  linkedNonDraftInvoices: [],
};

jest.mock('../models/db', () => {
  const mkChain = (resolveFn) => {
    const q = {};
    const passthrough = ['where', 'whereIn', 'whereNot', 'whereNull', 'whereNotNull', 'whereRaw', 'orderBy', 'limit', 'offset'];
    for (const m of passthrough) q[m] = (...args) => { q._calls = q._calls || []; q._calls.push([m, args]); return q; };
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
      if (calls.some(([m]) => m === 'whereNotNull')) return tableResults.payerInvoices;
      // unpaidInvoices uses whereIn('status', …) but terminates with .first();
      // the failed-row status lookup uses whereIn('id', …) with no .first().
      if (wantFirst) return { total: tableResults.unpaidTotal };
      if (calls.some(([m]) => m === 'whereIn')) return tableResults.linkedNonDraftInvoices;
      // Pay-now open-invoice list (status filter lives in a where-group, so
      // no top-level whereIn; keyed off its whereNull payer filters). Not
      // under test in this suite — return no rows.
      if (calls.some(([m]) => m === 'whereNull')) return [];
      return tableResults.unpaidTotal;
    }
    if (table === 'payments') {
      if (whereArg.status === 'failed') return tableResults.failedRows;
      if (whereArg.status === 'upcoming') return tableResults.upcomingRows;
      // recent-attempts scan (whereIn statuses)
      if (wantFirst) return tableResults.recentAttempts[0] || null;
      return tableResults.recentAttempts;
    }
    throw new Error(`Unexpected table ${table}`);
  }));
  dbFn.raw = (sql) => sql;
  return dbFn;
});

const billingRouter = require('../routes/billing-v2');

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
  const res = { json: (payload) => { body = payload; } };
  let error = null;
  await handler(req, res, (err) => { error = err; });
  if (error) throw error;
  return body;
}

describe('GET /balance — phantom failed-row exclusion', () => {
  beforeEach(() => {
    tableResults.payerInvoices = [];
    tableResults.failedRows = [];
    tableResults.upcomingRows = [];
    tableResults.unpaidTotal = '0';
    tableResults.recentAttempts = [];
    tableResults.linkedNonDraftInvoices = [];
  });

  test('invoice-linked failed row does not double-count the open invoice', async () => {
    tableResults.unpaidTotal = '107.00';
    tableResults.failedRows = [{
      amount: '110.11',
      metadata: JSON.stringify({ invoice_id: 'inv-1', source: 'card_on_file_failed_attempt' }),
    }];
    tableResults.linkedNonDraftInvoices = [{ id: 'inv-1' }];
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
      metadata: JSON.stringify({ invoice_id: 'inv-1' }),
    }];
    tableResults.linkedNonDraftInvoices = [{ id: 'inv-1' }]; // settled = paid, still non-draft
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
