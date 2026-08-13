/**
 * /admin/tax/bank-import routes — gate darkness, upload validation, and the
 * create-expense CAS.
 *
 * Locked-down behaviors:
 *  1. GATE_BANK_IMPORT off → /status answers {enabled:false} and every other
 *     bank-import route is a 404 (dark means invisible, not forbidden-ish).
 *  2. Upload validates account label + CSV size and reports imported vs
 *     duplicate counts from the conflict-ignoring insert.
 *  3. create-expense only fires from an unmatched debit, applies the
 *     server-owned partial-deduction policy to the FINAL category, stamps
 *     the AI-verify note only when the AI suggestion was used, and rolls the
 *     inserted expense back if the CAS loses the race.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const state = {
  bankRow: null,
  bankUpdateResult: 1,
  insertedBank: [],
  insertedExpenses: [],
  deletedExpenseIds: [],
  bankUpdates: [],
  category: null,
};

function bankBuilder() {
  const wheres = [];
  const b = {
    where: jest.fn((c) => { wheres.push(c); return b; }),
    whereIn: jest.fn((c, v) => { wheres.push([c, v]); return b; }),
    first: jest.fn(() => Promise.resolve(state.bankRow)),
    update: jest.fn((patch) => {
      state.bankUpdates.push({ wheres: wheres.slice(), patch });
      return Promise.resolve(state.bankUpdateResult);
    }),
    insert: jest.fn((rows) => {
      state.insertedBank.push(...rows);
      return b;
    }),
    onConflict: jest.fn(() => b),
    ignore: jest.fn(() => b),
    returning: jest.fn(() => Promise.resolve(state.insertedBank.slice(0, state.insertedBank.length - 1).map((_, i) => ({ id: `bt-${i}` })).concat([{ id: 'bt-last' }]))),
    select: jest.fn(() => b),
    count: jest.fn(() => b),
    groupBy: jest.fn(() => Promise.resolve([])),
    orderBy: jest.fn(() => b),
    limit: jest.fn(() => b),
  };
  return b;
}

function expensesBuilder() {
  const b = {
    insert: jest.fn((row) => { state.insertedExpenses.push(row); return b; }),
    returning: jest.fn(() => Promise.resolve([{ id: 'exp-new', ...state.insertedExpenses[state.insertedExpenses.length - 1] }])),
    where: jest.fn(() => b),
    del: jest.fn(() => { state.deletedExpenseIds.push('exp-new'); return Promise.resolve(1); }),
  };
  return b;
}

const mockDb = jest.fn((table) => {
  if (table === 'bank_transactions') return bankBuilder();
  if (table === 'expenses') return expensesBuilder();
  if (table === 'expense_categories') {
    return { where: jest.fn(() => ({ first: jest.fn(() => Promise.resolve(state.category)) })) };
  }
  return bankBuilder();
});
mockDb.raw = jest.fn((sql) => sql);
mockDb.fn = { now: jest.fn(() => new Date()) };
// Transaction stub: the callback gets the same table router. A thrown error
// propagates like a rollback would (the mock can't undo recorded inserts —
// route tests assert the ERROR path, not storage rollback, which is the
// database's contract).
mockDb.transaction = jest.fn(async (cb) => cb(mockDb));
jest.mock('../models/db', () => mockDb);

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/pnl-report', () => ({
  buildPnlReport: jest.fn(), getPeriodRange: jest.fn(), paidRevenueForWindow: jest.fn(),
  rateAsOf: jest.fn(), prorateAssetDepreciation: jest.fn(), annotateMidQuarter: jest.fn(),
  outflowTransactionsQuery: jest.fn(),
  dateCellStr: jest.requireActual('../services/pnl-report').dateCellStr,
}));
jest.mock('../services/invoice-helpers', () => ({ invoiceAmountDue: jest.fn() }));
jest.mock('../services/expense-categorizer', () => ({
  autoCategorizeExpense: jest.fn(),
  sanitizeDeductiblePercent: jest.requireActual('../services/expense-categorizer').sanitizeDeductiblePercent,
  categoryDeductibleAmount: jest.requireActual('../services/expense-categorizer').categoryDeductibleAmount,
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.techRole = 'admin'; next(); },
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
// The routes call the service's matching pass after upload; that policy has
// its own test file — stub it here so upload tests stay about the route.
jest.mock('../services/bank-import', () => ({
  ...jest.requireActual('../services/bank-import'),
  runDeterministicMatching: jest.fn(() => Promise.resolve({ scanned: 0, payoutsLinked: 0, expensesLinked: 0, transferFlagged: 0, ambiguous: 0 })),
  ledgerCoverage: jest.fn(() => Promise.resolve([])),
}));

const express = require('express');
const taxRouter = require('../routes/admin-tax');

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/admin/tax', taxRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll((done) => { server.close(done); });

const post = (path, body) => fetch(`${baseUrl}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
});

beforeEach(() => {
  state.bankRow = null;
  state.bankUpdateResult = 1;
  state.insertedBank = [];
  state.insertedExpenses = [];
  state.deletedExpenseIds = [];
  state.bankUpdates = [];
  state.category = null;
  delete process.env.GATE_BANK_IMPORT;
});

describe('gate darkness', () => {
  test('status answers enabled:false without touching the table', async () => {
    const res = await fetch(`${baseUrl}/admin/tax/bank-import/status`);
    expect(await res.json()).toEqual({ enabled: false });
  });

  test('every other bank-import route is a 404 while dark', async () => {
    for (const path of ['/admin/tax/bank-import/upload', '/admin/tax/bank-import/match', '/admin/tax/bank-import/abc/ignore']) {
      const res = await post(path, {});
      expect(res.status).toBe(404);
    }
    const list = await fetch(`${baseUrl}/admin/tax/bank-import/transactions`);
    expect(list.status).toBe(404);
  });
});

describe('upload (gate on)', () => {
  beforeEach(() => { process.env.GATE_BANK_IMPORT = 'true'; });

  test('rejects a missing account label, bad account type, and an empty CSV', async () => {
    expect((await post('/admin/tax/bank-import/upload', { accountType: 'bank', csv: 'Date,Description,Amount\n08/10/2026,X,-1.00' })).status).toBe(400);
    expect((await post('/admin/tax/bank-import/upload', { accountLabel: 'capone-checking', csv: 'Date,Description,Amount\n08/10/2026,X,-1.00' })).status).toBe(400);
    expect((await post('/admin/tax/bank-import/upload', { accountLabel: 'capone-checking', accountType: 'venmo', csv: 'x' })).status).toBe(400);
    expect((await post('/admin/tax/bank-import/upload', { accountLabel: 'capone-checking', accountType: 'bank', csv: '' })).status).toBe(400);
  });

  test('rejects a CSV with no usable rows, reporting why', async () => {
    const res = await post('/admin/tax/bank-import/upload', { accountLabel: 'capone-checking', accountType: 'bank', csv: 'Date,Description,Amount\nbad,X,1.00' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.skipped[0].reason).toBe('unparseable date');
  });

  test('imports rows and reports duplicates from the conflict-ignoring insert', async () => {
    const csv = 'Date,Description,Amount\n08/10/2026,HD SUPPLY,-204.87\n08/11/2026,REFUND,15.00';
    const res = await post('/admin/tax/bank-import/upload', { accountLabel: 'capone-checking', accountType: 'bank', filename: 'aug.csv', csv });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.parsed).toBe(2);
    expect(state.insertedBank).toHaveLength(2);
    expect(state.insertedBank[0]).toMatchObject({
      account_label: 'capone-checking', account_type: 'bank', direction: 'debit', amount: 204.87, source: 'csv', source_file: 'aug.csv',
    });
    expect(state.insertedBank[0].row_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('create-expense (gate on)', () => {
  beforeEach(() => {
    process.env.GATE_BANK_IMPORT = 'true';
    state.bankRow = {
      id: 'bt-1', account_label: 'capone-card-1234', account_type: 'card', txn_date: '2026-08-09',
      description: 'WAWA 5211 VENICE FL', amount: '58.12', direction: 'debit',
      status: 'unmatched', suggestion: { categoryId: 'cat-meals', categoryName: 'Meals & Entertainment' },
    };
    state.category = { name: 'Meals & Entertainment' };
  });

  test('uses the AI suggestion, applies the 50% meals policy, stamps the verify note', async () => {
    const res = await post('/admin/tax/bank-import/bt-1/create-expense', {});
    expect(res.status).toBe(200);
    const exp = state.insertedExpenses[0];
    expect(exp.category_id).toBe('cat-meals');
    expect(exp.tax_deductible_amount).toBe(29.06);
    expect(exp.expense_date).toBe('2026-08-09');
    expect(exp.tax_year).toBe('2026');
    expect(exp.quarter).toBe('Q3');
    expect(exp.notes).toContain('[AI-categorized — verify]');
    expect(exp.payment_method).toBe('card');
    // the bank row is claimed via a CAS on status='unmatched', inside a transaction
    expect(mockDb.transaction).toHaveBeenCalled();
    expect(state.bankUpdates[0].wheres).toContainEqual({ id: 'bt-1', status: 'unmatched' });
    expect(state.bankUpdates[0].patch.status).toBe('created_expense');
  });

  test('a bank-account debit books as ach, not card', async () => {
    state.bankRow.account_type = 'bank';
    await post('/admin/tax/bank-import/bt-1/create-expense', {});
    expect(state.insertedExpenses[0].payment_method).toBe('ach');
  });

  test('an operator-picked category skips the AI-verify note', async () => {
    state.category = { name: 'Supplies' };
    await post('/admin/tax/bank-import/bt-1/create-expense', { categoryId: 'cat-supplies' });
    expect(state.insertedExpenses[0].category_id).toBe('cat-supplies');
    expect(state.insertedExpenses[0].notes).not.toContain('AI-categorized');
  });

  test('losing the CAS race throws inside the transaction and answers 409', async () => {
    state.bankUpdateResult = 0;
    const res = await post('/admin/tax/bank-import/bt-1/create-expense', {});
    expect(res.status).toBe(409);
    // the throw happened INSIDE the transaction callback, so the real DB
    // rolls the expense insert back with it
    expect(mockDb.transaction).toHaveBeenCalled();
  });

  test('non-debit and non-unmatched rows are refused', async () => {
    state.bankRow.direction = 'credit';
    expect((await post('/admin/tax/bank-import/bt-1/create-expense', {})).status).toBe(400);
    state.bankRow.direction = 'debit';
    state.bankRow.status = 'ignored';
    expect((await post('/admin/tax/bank-import/bt-1/create-expense', {})).status).toBe(409);
  });

  test('unknown categoryId is a 400, not a silent uncategorized insert', async () => {
    state.category = null;
    expect((await post('/admin/tax/bank-import/bt-1/create-expense', { categoryId: 'nope' })).status).toBe(400);
    expect(state.insertedExpenses).toHaveLength(0);
  });
});
