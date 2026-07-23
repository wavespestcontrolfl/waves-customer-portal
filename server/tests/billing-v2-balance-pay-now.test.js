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
jest.mock('../services/payment-router', () => ({}));
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
  // Rows the open-invoice (Pay now) query returns. That query is the only
  // invoices read that combines whereNull with a list terminal (no .first()),
  // which is how the mock below routes to it.
  openInvoiceRows: [],
  lastOpenInvoicesCalls: null,
};

jest.mock('../models/db', () => {
  const mkChain = (resolveFn) => {
    const q = {};
    const passthrough = ['where', 'whereIn', 'whereNot', 'whereNull', 'whereNotNull', 'orderBy', 'limit', 'offset'];
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
      // unpaidInvoices SUM terminates with .first() (checked before whereNull:
      // it also filters whereNull('payer_id')).
      if (wantFirst) return { total: tableResults.unpaidTotal };
      // Pay-now open-invoice list: whereNull filters, list terminal.
      if (calls.some(([m]) => m === 'whereNull')) {
        tableResults.lastOpenInvoicesCalls = calls;
        return tableResults.openInvoiceRows;
      }
      // failed-row status lookup (whereIn('id', …) + whereNot draft)
      if (calls.some(([m]) => m === 'whereIn')) return tableResults.linkedNonDraftInvoices;
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
    // Statement-accrued rows are excluded (their /pay tokens 404 by design).
    expect(tableResults.lastOpenInvoicesCalls).toEqual(expect.arrayContaining([
      ['whereNull', ['payer_id']],
      ['whereNull', ['payer_statement_id']],
    ]));
  });

  test('gate on: fully-credited invoices are dropped — never a $0 pay button', async () => {
    tableResults.openInvoiceRows = [
      { token: 'tok-credited', invoice_number: 'INV-103', due_date: '2026-08-01', total: '49.00', credit_applied: '49.00' },
    ];

    const body = await getBalance();
    expect(body.openInvoices).toEqual([]);
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
