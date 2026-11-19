/**
 * GET /billing-v2/balance — portal "Pay now" open-invoice links
 * (GATE_PORTAL_PAY_NOW, customer-portal audit 2026-07-22 S2-1).
 *
 * Contract:
 *   - gate ON → response carries `openInvoices`: the customer's own open
 *     (sent/viewed/overdue), non-payer, non-statement invoices as
 *     { payUrl: '/pay/<token>', amountDue, invoiceNumber, dueDate },
 *     oldest first, capped at 5, amounts via the cents-safe
 *     invoiceAmountDue helper (total − credit_applied, clamped ≥ 0)
 *   - fully-credited rows (amountDue 0) are dropped — no $0 pay buttons
 *   - gate OFF → the field is ABSENT and the rest of the payload is
 *     byte-identical to the pre-change response (dark-ship contract)
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
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));

const { isEnabled } = require('../config/feature-gates');

// Programmable table results, set per test.
const tableResults = {
  payerInvoices: [],
  failedRows: [],
  upcomingRows: [],
  unpaidTotal: '0',
  recentAttempts: [],
  linkedNonDraftInvoices: [],
  linkedInvoiceLookupError: null,
  // Rows the open-invoice (Pay now) query returns. That query is the only
  // invoices read that combines whereNull with a list terminal (no .first()),
  // which is how the mock below routes to it.
  openInvoiceRows: [],
  lastOpenInvoicesCalls: null,
};

jest.mock('../models/db', () => {
  const mkChain = (resolveFn) => {
    const q = {};
    const passthrough = ['where', 'whereIn', 'whereNot', 'whereNull', 'whereNotNull', 'whereRaw', 'orWhere', 'orWhereIn', 'orWhereNot', 'orWhereNull', 'orWhereNotNull', 'orderBy', 'limit', 'offset'];
    for (const m of passthrough) {
      q[m] = (...args) => {
        q._calls = q._calls || [];
        q._calls.push([m, args]);
        // Grouped clauses (`where(function () { this… })`) record their nested
        // calls too, the way knex applies them — the payer-owned filter is one
        // of these now that it matches payer_id OR the withdrawal stamp.
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
    if (table === 'customers') return { id: 'cust-1', payer_id: null };
    if (table === 'invoices') {
      if (calls.some(([m]) => m === 'whereNotNull')) return tableResults.payerInvoices;
      if (q._selected?.includes('scheduled_service_id')) return [];
      // unpaidInvoices SUM terminates with .first() (checked before whereNull:
      // it also filters whereNull('payer_id')).
      if (wantFirst) return { total: tableResults.unpaidTotal };
      // Pay-now open-invoice list: whereNull filters, list terminal.
      if (calls.some(([m]) => m === 'whereNull')) {
        tableResults.lastOpenInvoicesCalls = calls;
        const failedDraftIds = new Set(calls
          .filter(([m, args]) => m === 'whereIn' && args[0] === 'id')
          .flatMap(([, args]) => args[1]).map(String));
        return tableResults.openInvoiceRows.filter((row) => (
          row.status == null
          || ['sent', 'viewed', 'overdue'].includes(row.status)
          || (row.status === 'draft' && failedDraftIds.has(String(row.id)))
        ));
      }
      // failed-row status lookup (whereIn('id', …) + whereNot draft)
      if (calls.some(([m]) => m === 'whereIn')) {
        if (tableResults.linkedInvoiceLookupError) throw tableResults.linkedInvoiceLookupError;
        return tableResults.linkedNonDraftInvoices;
      }
      return tableResults.unpaidTotal;
    }
    if (table === 'payments') {
      if (whereArg.status === 'failed') return tableResults.failedRows;
      if (whereArg.status === 'upcoming') return tableResults.upcomingRows;
      if (wantFirst) return tableResults.recentAttempts[0] || null;
      return tableResults.recentAttempts;
    }
    throw new Error(`Unexpected table ${table}`);
  }));
  dbFn.raw = (sql) => sql;
  const trxFn = jest.fn((table) => dbFn(table));
  trxFn.raw = dbFn.raw;
  dbFn.__balanceTrx = trxFn;
  dbFn.transaction = jest.fn((callback) => callback(trxFn));
  return dbFn;
});

const billingRouter = require('../routes/billing-v2');

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

describe('GET /balance — Pay-now open-invoice links (GATE_PORTAL_PAY_NOW)', () => {
  beforeEach(() => {
    tableResults.payerInvoices = [];
    tableResults.failedRows = [];
    tableResults.upcomingRows = [];
    tableResults.unpaidTotal = '0';
    tableResults.recentAttempts = [];
    tableResults.linkedNonDraftInvoices = [];
    tableResults.linkedInvoiceLookupError = null;
    tableResults.openInvoiceRows = [];
    tableResults.lastOpenInvoicesCalls = null;
    isEnabled.mockImplementation(() => true);
  });

  test('gate on: open invoices map to tokenized /pay links with cents-safe amounts', async () => {
    tableResults.unpaidTotal = '162.10';
    tableResults.openInvoiceRows = [
      { token: 'tok-old', invoice_number: 'INV-101', due_date: '2026-07-30', total: '107.10', credit_applied: '7.10' },
      { token: 'tok-new', invoice_number: 'INV-102', due_date: '2026-08-15', total: '62.10', credit_applied: null },
    ];

    const body = await getBalance();
    expect(body.openInvoices).toEqual([
      // 107.10 − 7.10 in integer cents → exactly 100, no float drift.
      { payUrl: '/pay/tok-old', amountDue: 100, invoiceNumber: 'INV-101', dueDate: '2026-07-30' },
      { payUrl: '/pay/tok-new', amountDue: 62.1, invoiceNumber: 'INV-102', dueDate: '2026-08-15' },
    ]);
    // Oldest-first + bounded: the query itself orders by created_at asc and
    // caps at 5 (contract lives in SQL; the chain calls prove it was issued).
    expect(tableResults.lastOpenInvoicesCalls).toEqual(expect.arrayContaining([
      ['orderBy', ['created_at', 'asc']],
      ['limit', [5]],
    ]));
    // Statement-accrued rows are excluded (their /pay tokens 404 by design),
    // and the positive-balance predicate runs in SQL BEFORE the cap, so
    // fully-credited old invoices can't crowd payable ones out of the five.
    expect(tableResults.lastOpenInvoicesCalls).toEqual(expect.arrayContaining([
      ['whereNull', ['payer_id']],
      ['whereNull', ['payer_statement_id']],
      ['whereRaw', ['GREATEST(total - COALESCE(credit_applied, 0) - COALESCE(amount_paid, 0), 0) > 0']],
    ]));
  });

  test('gate on: a fully-credited row that slips past the SQL predicate is still dropped in JS', async () => {
    tableResults.openInvoiceRows = [
      { token: 'tok-credited', invoice_number: 'INV-103', due_date: '2026-08-01', total: '49.00', credit_applied: '49.00' },
    ];

    const body = await getBalance();
    expect(body.openInvoices).toEqual([]);
  });

  test('gate on: a failed DRAFT invoice still gets its pay link — the exact failure Pay now repairs', async () => {
    // Failed completion autopay: obligation lives on a draft invoice, so it
    // rides failedTotal (not unpaidInvoices) — the pay-link query must pick
    // the draft up by id or the CTA is absent in the one scenario it's for.
    const draftId = 'ab36f51e-4441-4cc8-bbf7-c41ffad50152';
    tableResults.failedRows = [{ amount: '89.00', metadata: JSON.stringify({ invoice_id: draftId }) }];
    tableResults.linkedNonDraftInvoices = []; // draft → not balance-carrying
    tableResults.recentAttempts = [{ status: 'failed', metadata: null }];
    tableResults.openInvoiceRows = [
      { id: draftId, status: 'draft', token: 'tok-draft', invoice_number: 'INV-DRAFT-1', due_date: null, total: '89.00', credit_applied: null },
    ];

    const body = await getBalance();
    expect(body.currentBalance).toBe(89);
    expect(tableResults.lastOpenInvoicesCalls).toEqual(expect.arrayContaining([
      ['where', [{ status: 'draft' }]],
      ['whereIn', ['id', [draftId]]],
    ]));
    expect(body.lastPaymentFailed).toBe(true);
    expect(body.openInvoices).toEqual([
      { payUrl: '/pay/tok-draft', amountDue: 89, invoiceNumber: 'INV-DRAFT-1', dueDate: null },
    ]);
  });

  test('the failed-id shortcut rechecks draft status before returning a bearer token', async () => {
    const retiredId = 'de27b36a-3054-4c64-93e4-0d15b785bb34';
    tableResults.failedRows = [{ amount: '31.00', metadata: { invoice_id: retiredId } }];
    tableResults.openInvoiceRows = [
      { id: retiredId, status: 'void', token: 'retired-token', invoice_number: 'INV-VOID', total: '31.00' },
    ];

    const body = await getBalance();

    expect(tableResults.lastOpenInvoicesCalls).toEqual(expect.arrayContaining([
      ['where', [{ status: 'draft' }]],
      ['whereIn', ['id', [retiredId]]],
    ]));
    expect(body.openInvoices).toEqual([]);
  });

  test('an unresolved failed-invoice status cannot mint a shortcut for a retired invoice; ordinary open rows remain', async () => {
    const failedId = 'ab36f51e-4441-4cc8-bbf7-c41ffad50152';
    tableResults.failedRows = [{ amount: '89.00', metadata: { invoice_id: failedId.toUpperCase() } }];
    tableResults.linkedInvoiceLookupError = new Error('status lookup unavailable');
    tableResults.openInvoiceRows = [
      { id: failedId, status: 'paid', token: 'retired-token', invoice_number: 'INV-PAID', total: '89.00' },
      { id: 'de27b36a-3054-4c64-93e4-0d15b785bb34', status: 'sent', token: 'open-token', invoice_number: 'INV-OPEN', total: '31.00' },
    ];

    const body = await getBalance();

    expect(body.currentBalance).toBe(0);
    expect(tableResults.lastOpenInvoicesCalls).not.toEqual(expect.arrayContaining([
      ['whereIn', ['id', [failedId.toUpperCase()]]],
    ]));
    expect(body.openInvoices).toEqual([
      { payUrl: '/pay/open-token', amountDue: 31, invoiceNumber: 'INV-OPEN', dueDate: undefined },
    ]);
  });

  test('gate off: field absent, rest of the payload unchanged (dark-ship contract)', async () => {
    isEnabled.mockImplementation((name) => name !== 'portalPayNow');
    tableResults.unpaidTotal = '107.00';
    tableResults.recentAttempts = [{ status: 'failed', metadata: null }];

    const body = await getBalance();
    expect(body).not.toHaveProperty('openInvoices');
    expect(body.currentBalance).toBe(107);
    expect(body.lastPaymentFailed).toBe(true);
    // The gated query never ran.
    expect(tableResults.lastOpenInvoicesCalls).toBeNull();
  });
});
