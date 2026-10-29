/**
 * POST /admin/tax/bank-import/:id/link-payroll and the filing calendar's "seen in the bank" date
 * (GATE_PAYROLL_BANK_MATCH). Gate off: the route answers 404 and the calendar gains no key. Gate on:
 * the route hands the owner's pick to bank-import's claim, and maps each refusal to a plain answer.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const state = { bankRow: null, filings: [], seen: [] };
const builder = (table) => {
  const b = {
    where: jest.fn(() => b),
    orderBy: jest.fn(() => b),
    limit: jest.fn(() => b),
    offset: jest.fn(() => b),
    count: jest.fn(() => b),
    whereIn: jest.fn(() => b),
    whereRaw: jest.fn(() => b),
    select: jest.fn(() => (table === 'bank_transactions' ? Promise.resolve(state.seen) : b)),
    first: jest.fn(() => Promise.resolve(state.bankRow)),
  };
  b.then = (resolve, reject) => Promise.resolve(table === 'tax_filing_calendar' ? state.filings : []).then(resolve, reject);
  return b;
};
const mockDb = jest.fn((table) => builder(table));
mockDb.raw = jest.fn((sql) => sql);
jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/pnl-report', () => ({
  buildPnlReport: jest.fn(), getPeriodRange: jest.fn(), paidRevenueForWindow: jest.fn(),
  rateAsOf: jest.fn(), prorateAssetDepreciation: jest.fn(), annotateMidQuarter: jest.fn(),
  outflowTransactionsQuery: jest.fn(),
  dateCellStr: jest.requireActual('../services/pnl-report').dateCellStr,
}));
jest.mock('../services/invoice-helpers', () => ({ invoiceAmountDue: jest.fn(), invoiceWithdrawnFromCustomer: () => false }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.techRole = 'admin'; next(); },
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/bank-import', () => ({
  ...jest.requireActual('../services/bank-import'),
  claimPayrollLink: jest.fn(),
  unlinkPayrollMatched: jest.fn(),
  // the snapshot heals have their own suites; the list routes here only shape the response
  resetDanglingLinks: jest.fn(() => Promise.resolve(0)),
  healEditedExpenseLinks: jest.fn(() => Promise.resolve(0)),
  healUnreconciledLinks: jest.fn(() => Promise.resolve({ reverted: 0, remarked: 0 })),
  healOrphanRefunds: jest.fn(() => Promise.resolve(0)),
  verifyPendingExpenseClaims: jest.fn(() => Promise.resolve({ cleared: 0, reverted: 0, more: false })),
  verifyPendingPayoutClaims: jest.fn(() => Promise.resolve({ cleared: 0, reverted: 0, more: false })),
  retryPendingEchoes: jest.fn(() => Promise.resolve({ pending: 0, morePending: false, retried: 0, humanRejected: 0 })),
}));
const bankImport = require('../services/bank-import');

const express = require('express');
const taxRouter = require('../routes/admin-tax');

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/admin/tax', taxRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });

const post = (path, body) => fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

beforeEach(() => {
  process.env.GATE_BANK_IMPORT = 'true';
  process.env.GATE_PAYROLL_BANK_MATCH = 'true';
  state.bankRow = { id: UUID_A, direction: 'debit', status: 'unmatched', suggestion: null };
  state.filings = [];
  state.seen = [];
  bankImport.claimPayrollLink.mockReset();
  mockDb.mockClear();
});
afterEach(() => {
  delete process.env.GATE_BANK_IMPORT;
  delete process.env.GATE_PAYROLL_BANK_MATCH;
});

describe('link-payroll', () => {
  test('gate off answers 404 and claims nothing', async () => {
    delete process.env.GATE_PAYROLL_BANK_MATCH;
    const res = await post(`/admin/tax/bank-import/${UUID_A}/link-payroll`, { checkId: UUID_B });
    expect(res.status).toBe(404);
    expect(bankImport.claimPayrollLink).not.toHaveBeenCalled();
  });

  test('needs exactly one well-formed id', async () => {
    expect((await post(`/admin/tax/bank-import/${UUID_A}/link-payroll`, {})).status).toBe(400);
    expect((await post(`/admin/tax/bank-import/${UUID_A}/link-payroll`, { checkId: UUID_B, filingId: UUID_B })).status).toBe(400);
    expect((await post(`/admin/tax/bank-import/${UUID_A}/link-payroll`, { checkId: 'not-an-id' })).status).toBe(400);
  });

  test('refuses a credit and a row that is no longer unmatched', async () => {
    state.bankRow = { id: UUID_A, direction: 'credit', status: 'unmatched', suggestion: null };
    expect((await post(`/admin/tax/bank-import/${UUID_A}/link-payroll`, { checkId: UUID_B })).status).toBe(400);
    state.bankRow = { id: UUID_A, direction: 'debit', status: 'created_expense', suggestion: null };
    expect((await post(`/admin/tax/bank-import/${UUID_A}/link-payroll`, { checkId: UUID_B })).status).toBe(409);
    expect(bankImport.claimPayrollLink).not.toHaveBeenCalled();
  });

  test('hands the pick to the claim as the owner and returns the new expense', async () => {
    bankImport.claimPayrollLink.mockResolvedValue({ ok: true, expense: { id: 'exp-1' } });
    const res = await post(`/admin/tax/bank-import/${UUID_A}/link-payroll`, { checkId: UUID_B });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, expenseId: 'exp-1', reusedExpense: false });
    expect(bankImport.claimPayrollLink).toHaveBeenCalledWith(expect.objectContaining({ check: { id: UUID_B }, filing: null, by: 'owner' }));
  });

  test('passes the owner\'s existing-expense pick and book-as-new through, and refuses a duplicate by default', async () => {
    const UUID_C = '33333333-3333-4333-8333-333333333333';
    bankImport.claimPayrollLink.mockResolvedValue({ ok: true, expense: { id: UUID_C }, reused: true });
    const res = await post(`/admin/tax/bank-import/${UUID_A}/link-payroll`, { checkId: UUID_B, expenseId: UUID_C });
    expect(await res.json()).toEqual({ success: true, expenseId: UUID_C, reusedExpense: true });
    expect(bankImport.claimPayrollLink).toHaveBeenLastCalledWith(expect.objectContaining({ expenseId: UUID_C, createNew: false }));
    await post(`/admin/tax/bank-import/${UUID_A}/link-payroll`, { checkId: UUID_B, createNew: true });
    expect(bankImport.claimPayrollLink).toHaveBeenLastCalledWith(expect.objectContaining({ expenseId: null, createNew: true }));
    expect((await post(`/admin/tax/bank-import/${UUID_A}/link-payroll`, { checkId: UUID_B, expenseId: 'nope' })).status).toBe(400);
    bankImport.claimPayrollLink.mockResolvedValue({ ok: false, reason: 'existing_expense', existing: [] });
    const dup = await post(`/admin/tax/bank-import/${UUID_A}/link-payroll`, { checkId: UUID_B });
    expect(dup.status).toBe(409);
    expect((await dup.json()).error).toMatch(/already be entered/);
  });

  test('maps a refusal to a plain answer', async () => {
    bankImport.claimPayrollLink.mockResolvedValue({ ok: false, reason: 'implausible' });
    expect((await post(`/admin/tax/bank-import/${UUID_A}/link-payroll`, { filingId: UUID_B })).status).toBe(400);
    bankImport.claimPayrollLink.mockResolvedValue({ ok: false, reason: 'taken' });
    expect((await post(`/admin/tax/bank-import/${UUID_A}/link-payroll`, { checkId: UUID_B })).status).toBe(409);
  });
});

describe('unlink', () => {
  test('a payroll-matched line goes through the payroll unlink, not the generic one', async () => {
    state.bankRow = { id: UUID_A, direction: 'debit', status: 'matched_expense', matched_expense_id: UUID_B, matched_payroll_check_id: UUID_B, matched_tax_filing_id: null, suggestion: {} };
    bankImport.unlinkPayrollMatched.mockResolvedValue(true);
    const res = await post(`/admin/tax/bank-import/${UUID_A}/unlink`, {});
    expect(res.status).toBe(200);
    expect(bankImport.unlinkPayrollMatched).toHaveBeenCalledWith(expect.objectContaining({ id: UUID_A }));
    bankImport.unlinkPayrollMatched.mockResolvedValue(false);
    expect((await post(`/admin/tax/bank-import/${UUID_A}/unlink`, {})).status).toBe(409);
  });
});

describe('bank lines with the gate off', () => {
  const stored = () => ({
    id: UUID_A, status: 'unmatched', direction: 'debit', description: 'CHECK 1042', amount: '812.63',
    matched_payroll_check_id: null, matched_tax_filing_id: null,
    suggestion: {
      noMatch: true,
      payrollCandidates: [{ kind: 'check', id: UUID_B, name: 'Sample Alpha' }], payrollCandidatesTotal: 1,
      payrollMatch: { by: 'auto', checkId: UUID_B }, payrollUnlinked: { checkId: UUID_B }, rejectedPayrollCheckIds: [UUID_B],
    },
  });
  const listed = async (path) => (await (await fetch(`${baseUrl}/admin/tax${path}`)).json());

  test('the transactions list drops every payroll suggestion key and the two link columns', async () => {
    delete process.env.GATE_PAYROLL_BANK_MATCH;
    const row = stored();
    state.seen = [row];
    const body = await listed('/bank-import/transactions');
    expect(body.transactions[0].suggestion).toEqual({ noMatch: true });
    expect(body.transactions[0]).not.toHaveProperty('matched_payroll_check_id');
    // the stored row is not rewritten
    expect(Object.keys(row.suggestion)).toContain('payrollCandidates');
  });

  test('the ledger inbox drops them too', async () => {
    delete process.env.GATE_PAYROLL_BANK_MATCH;
    process.env.GATE_TAX_LEDGER = 'true';
    try {
      state.seen = [stored()];
      const body = await listed('/bank-import/ledger/inbox');
      expect(body.rows[0].suggestion).toEqual({ noMatch: true });
    } finally { delete process.env.GATE_TAX_LEDGER; }
  });

  test('with the gate on the payroll keys reach the client', async () => {
    state.seen = [stored()];
    const body = await listed('/bank-import/transactions');
    expect(body.transactions[0].suggestion.payrollCandidates).toHaveLength(1);
    expect(body.transactions[0].suggestion.payrollMatch).toBeDefined();
  });
});

describe('filing calendar', () => {
  const filing = { id: UUID_B, filing_type: 'payroll_941_deposit', title: 'Deposit', due_date: '2026-11-16', status: 'upcoming', amount_due: '350.00' };

  test('gate on adds the date a payment was seen in the bank', async () => {
    state.filings = [filing];
    state.seen = [{ matched_tax_filing_id: UUID_B, txn_date: '2026-11-13' }];
    const body = await (await fetch(`${baseUrl}/admin/tax/filings`)).json();
    expect(body.filings[0].bankSeenOn).toBe('2026-11-13');
  });

  test('gate off adds no key and reads no bank line', async () => {
    delete process.env.GATE_PAYROLL_BANK_MATCH;
    state.filings = [filing];
    const body = await (await fetch(`${baseUrl}/admin/tax/filings`)).json();
    expect(body.filings[0]).not.toHaveProperty('bankSeenOn');
    expect(mockDb).not.toHaveBeenCalledWith('bank_transactions');
  });
});
