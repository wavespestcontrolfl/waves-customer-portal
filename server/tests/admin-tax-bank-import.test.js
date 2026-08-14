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
  expenseRow: null,
  payoutRow: null,
  accountTypeRow: null,
  listRows: null,
  latestRecon: null,
  bankUpdateError: null,
  bankUpdateResult: 1,
  insertedBank: [],
  insertedExpenses: [],
  expenseUpdates: [],
  deletedExpenseIds: [],
  bankUpdates: [],
  category: null,
  // per-call overrides for the bank insert's returning(): shift one entry per
  // call; when empty, fall back to echoing every inserted row (no duplicates)
  insertReturningQueue: null,
};

function bankBuilder() {
  const wheres = [];
  const b = {
    where: jest.fn((c) => { wheres.push(c); return b; }),
    whereIn: jest.fn((c, v) => { wheres.push([c, v]); return b; }),
    whereRaw: jest.fn((sql, binds) => { wheres.push([sql, binds]); return b; }),
    first: jest.fn((...cols) => {
      // appliedRefundTotal aggregates refund credits (raw select with the
      // refundAmount sum) — resolve the staged total
      if (cols.some(c => typeof c === 'string' && c.includes('refundAmount'))) return Promise.resolve({ total: state.refundTotal || 0 });
      // the label→type binding check selects account_type; everything else
      // (row lookups, force replay check) resolves the staged bankRow
      if (cols.includes('account_type') && !cols.includes('id')) return Promise.resolve(state.accountTypeRow);
      return Promise.resolve(state.bankRow);
    }),
    update: jest.fn((patch) => {
      if (state.bankUpdateError) return Promise.reject(state.bankUpdateError);
      state.bankUpdates.push({ wheres: wheres.slice(), patch });
      return Promise.resolve(state.bankUpdateResult);
    }),
    insert: jest.fn((rows) => {
      state.insertedBank.push(...(Array.isArray(rows) ? rows : [rows]));
      return b;
    }),
    onConflict: jest.fn(() => b),
    ignore: jest.fn(() => b),
    returning: jest.fn(() => {
      if (Array.isArray(state.insertReturningQueue) && state.insertReturningQueue.length) {
        const next = state.insertReturningQueue.shift();
        if (next instanceof Error) return Promise.reject(next);
        return Promise.resolve(next);
      }
      return Promise.resolve(state.insertedBank.map((r, i) => ({ id: `bt-${i}`, row_hash: r.row_hash })));
    }),
    select: jest.fn(() => b),
    count: jest.fn(() => b),
    groupBy: jest.fn(() => Promise.resolve([])),
    orderBy: jest.fn(() => b),
    limit: jest.fn(() => b),
    offset: jest.fn(() => b),
  };
  // awaiting a bare select chain (the suggest scope query) resolves listRows
  b.then = (resolve, reject) => Promise.resolve(state.listRows || []).then(resolve, reject);
  return b;
}

function expensesBuilder() {
  const b = {
    insert: jest.fn((row) => { state.insertedExpenses.push(row); return b; }),
    returning: jest.fn(() => Promise.resolve([{ id: 'exp-new', ...state.insertedExpenses[state.insertedExpenses.length - 1] }])),
    where: jest.fn(() => b),
    forUpdate: jest.fn(() => b),
    first: jest.fn(() => Promise.resolve(state.expenseRow)),
    update: jest.fn((patch) => {
      state.expenseUpdates.push(patch);
      return { returning: jest.fn(() => Promise.resolve([{ id: state.expenseRow?.id || 'exp-9', ...patch }])) };
    }),
    del: jest.fn(() => { state.deletedExpenseIds.push('exp-new'); return Promise.resolve(1); }),
  };
  return b;
}

// raw with bindings returns both so tests can assert bound payloads;
// binding-less raw stays a plain string (the jsonb key-subtraction asserts)
const mockDb = jest.fn((table) => {
  if (table === 'bank_transactions') return bankBuilder();
  if (table === 'expenses') return expensesBuilder();
  if (table === 'expense_categories') {
    return { where: jest.fn(() => ({ first: jest.fn(() => Promise.resolve(state.category)) })) };
  }
  if (table === 'bank_reconciliation') {
    return {
      where: jest.fn(function w() { return this; }),
      orderBy: jest.fn(function o() { return this; }),
      first: jest.fn(() => Promise.resolve(state.latestRecon)),
    };
  }
  if (table === 'stripe_payouts') {
    return {
      where: jest.fn(function w() { return this; }),
      forUpdate: jest.fn(function f() { return this; }),
      first: jest.fn(() => Promise.resolve(state.payoutRow)),
    };
  }
  return bankBuilder();
});
mockDb.raw = jest.fn((sql, bindings) => (bindings ? { sql, bindings } : sql));
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
// unlink reverses a bank-import-authored reconciliation through the same
// stripe-banking mechanism — stubbed, asserted in the unlink describe
jest.mock('../services/stripe-banking', () => ({ reconcilePayout: jest.fn(() => Promise.resolve({})) }));
const { reconcilePayout } = require('../services/stripe-banking');
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
// refund apply/undo must re-derive the persisted job-cost rollups
jest.mock('../services/job-costing', () => ({ calculateJobCost: jest.fn(() => Promise.resolve()) }));
jest.mock('../services/bank-import', () => ({
  ...jest.requireActual('../services/bank-import'),
  runDeterministicMatching: jest.fn(() => Promise.resolve({ scanned: 0, payoutsLinked: 0, expensesLinked: 0, transferFlagged: 0, ambiguous: 0 })),
  ledgerCoverage: jest.fn(() => Promise.resolve([])),
  // heal passes are unit-tested in the service suite; here we assert the
  // coverage endpoint INVOKES them (coverage is a money claim)
  resetDanglingLinks: jest.fn(() => Promise.resolve(0)),
  healEditedExpenseLinks: jest.fn(() => Promise.resolve(0)),
  // list construction is unit-tested in the service suite; the route test
  // asserts the endpoint's shape and guards
  refundCandidatesForRow: jest.fn(() => Promise.resolve([])),
  surveyExpenseCandidatesForRow: jest.fn(() => Promise.resolve([])),
  surveyPayoutCandidatesForRow: jest.fn(() => Promise.resolve({ candidates: [], overflow: false })),
  healUnreconciledLinks: jest.fn(() => Promise.resolve({ reverted: 0, remarked: 0 })),
  healOrphanRefunds: jest.fn(() => Promise.resolve(0)),
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

const get = (path) => fetch(`${baseUrl}${path}`, {
  headers: { 'Content-Type': 'application/json' },
});
const post = (path, body) => fetch(`${baseUrl}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
});

// suggestionMerge writes are raws {sql, bindings:[json]} — unwrap the payload
const sugOf = (u) => {
  const s = u.patch.suggestion;
  if (!s) return null;
  if (typeof s === 'string') return null;
  if (s.bindings) return JSON.parse(s.bindings[0]);
  return s;
};

beforeEach(() => {
  state.bankRow = null;
  state.expenseRow = null;
  state.bankUpdateError = null;
  state.bankUpdateResult = 1;
  state.insertedBank = [];
  state.insertedExpenses = [];
  state.expenseUpdates = [];
  state.deletedExpenseIds = [];
  state.bankUpdates = [];
  state.category = null;
  state.payoutRow = null;
  state.accountTypeRow = null;
  state.listRows = null;
  state.latestRecon = null;
  state.insertReturningQueue = null;
  state.refundTotal = 0;
  reconcilePayout.mockReset();
  reconcilePayout.mockImplementation(async () => ({}));
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

  test('a whitespace-only account label is rejected before any write', async () => {
    const res = await post('/admin/tax/bank-import/upload', { accountLabel: '   ', accountType: 'bank', csv: 'Date,Description,Amount\n08/10/2026,X,-1.00' });
    expect(res.status).toBe(400);
    expect(state.insertedBank).toHaveLength(0);
  });

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

  test('a label already imported under the OTHER account type is refused before any write', async () => {
    state.accountTypeRow = { account_type: 'bank' };
    const csv = 'Date,Description,Amount\n08/10/2026,HD SUPPLY,-204.87';
    const res = await post('/admin/tax/bank-import/upload', { accountLabel: 'capone-checking', accountType: 'card', csv });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('already imported as a bank account');
    expect(state.insertedBank).toHaveLength(0);
  });

  test('the bulk insert runs inside ONE transaction — an error can never leave a partial import', async () => {
    const csv = 'Date,Description,Amount\n08/10/2026,HD SUPPLY,-204.87';
    const before = mockDb.transaction.mock.calls.length;
    await post('/admin/tax/bank-import/upload', { accountLabel: 'capone-checking', accountType: 'bank', csv });
    expect(mockDb.transaction.mock.calls.length).toBe(before + 1);
  });

  test('a matching-pass failure after committed inserts still reports the import as succeeded', async () => {
    const bankImportSvc = require('../services/bank-import');
    bankImportSvc.runDeterministicMatching.mockRejectedValueOnce(new Error('matcher exploded'));
    const csv = 'Date,Description,Amount\n08/10/2026,HD SUPPLY,-204.87';
    const res = await post('/admin/tax/bank-import/upload', { accountLabel: 'capone-checking', accountType: 'bank', csv });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.imported).toBe(1);
    expect(body.matching).toBeNull();
    expect(body.matchingError).toContain('Run matching');
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
    expect(body.duplicates).toBe(0);
    expect(body.duplicateSamples).toEqual([]);
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

  test('credits (any account) and non-unmatched rows are refused — refunds use apply-refund', async () => {
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

describe('link-expense (gate on)', () => {
  beforeEach(() => {
    process.env.GATE_BANK_IMPORT = 'true';
    state.bankRow = { id: 'bt-1', direction: 'debit', status: 'unmatched', amount: '58.12', txn_date: '2026-08-09' };
    state.expenseRow = { id: 'exp-9', amount: '58.12', expense_date: '2026-08-10' };
  });

  test('an expense outside the amount/date matching window is refused', async () => {
    state.expenseRow = { id: 'exp-9', amount: '999.00', expense_date: '2026-08-10' };
    expect((await post('/admin/tax/bank-import/bt-1/link-expense', { expenseId: 'exp-9' })).status).toBe(400);
    state.expenseRow = { id: 'exp-9', amount: '58.12', expense_date: '2026-07-01' };
    expect((await post('/admin/tax/bank-import/bt-1/link-expense', { expenseId: 'exp-9' })).status).toBe(400);
    expect(state.bankUpdates).toHaveLength(0);
  });

  test('a refund-reduced expense still accepts its full-price debit (GROSS plausibility)', async () => {
    // $58.12 purchase, $20 refund already applied → expense now $38.12; the
    // original statement debit still carries the gross $58.12
    state.expenseRow = { id: 'exp-9', amount: '38.12', expense_date: '2026-08-10' };
    state.refundTotal = 20;
    const res = await post('/admin/tax/bank-import/bt-1/link-expense', { expenseId: 'exp-9' });
    expect(res.status).toBe(200);
    expect(state.bankUpdates[0].patch).toMatchObject({ status: 'matched_expense', matched_expense_id: 'exp-9' });
    // without the applied refund the same net amount is still refused
    state.bankUpdates = [];
    state.refundTotal = 0;
    expect((await post('/admin/tax/bank-import/bt-1/link-expense', { expenseId: 'exp-9' })).status).toBe(400);
    expect(state.bankUpdates).toHaveLength(0);
  });

  test('links via CAS with match_method=manual', async () => {
    const res = await post('/admin/tax/bank-import/bt-1/link-expense', { expenseId: 'exp-9' });
    expect(res.status).toBe(200);
    expect(state.bankUpdates[0].wheres).toContainEqual({ id: 'bt-1', status: 'unmatched' });
    expect(state.bankUpdates[0].patch).toMatchObject({ status: 'matched_expense', matched_expense_id: 'exp-9', match_method: 'manual' });
  });

  test('validates inputs: missing expenseId, unknown expense, credit row, non-unmatched row', async () => {
    expect((await post('/admin/tax/bank-import/bt-1/link-expense', {})).status).toBe(400);
    state.expenseRow = null;
    expect((await post('/admin/tax/bank-import/bt-1/link-expense', { expenseId: 'nope' })).status).toBe(404);
    state.expenseRow = { id: 'exp-9' };
    state.bankRow.direction = 'credit';
    expect((await post('/admin/tax/bank-import/bt-1/link-expense', { expenseId: 'exp-9' })).status).toBe(400);
    state.bankRow.direction = 'debit';
    state.bankRow.status = 'ignored';
    expect((await post('/admin/tax/bank-import/bt-1/link-expense', { expenseId: 'exp-9' })).status).toBe(409);
  });

  test('a unique-index violation (expense already linked elsewhere) answers 409', async () => {
    const dup = new Error('duplicate key value violates unique constraint');
    dup.code = '23505';
    state.bankUpdateError = dup;
    const res = await post('/admin/tax/bank-import/bt-1/link-expense', { expenseId: 'exp-9' });
    expect(res.status).toBe(409);
  });

  test('losing the CAS race answers 409', async () => {
    state.bankUpdateResult = 0;
    expect((await post('/admin/tax/bank-import/bt-1/link-expense', { expenseId: 'exp-9' })).status).toBe(409);
  });
});

describe('force-duplicates upload (gate on)', () => {
  beforeEach(() => { process.env.GATE_BANK_IMPORT = 'true'; });
  const csv = 'Date,Description,Amount\n08/10/2026,HD SUPPLY,-204.87';
  const { withRowHashes } = jest.requireActual('../services/bank-import');
  const hdSupplyHash = withRowHashes('capone-checking', [
    { txn_date: '2026-08-10', description: 'HD SUPPLY', amount: 204.87, direction: 'debit' },
  ])[0].row_hash;

  test('without the flag, a conflicting row is surfaced as a duplicate with its hash, not force-inserted', async () => {
    state.insertReturningQueue = [[]]; // the bulk insert reports nothing landed
    const res = await post('/admin/tax/bank-import/upload', { accountLabel: 'capone-checking', accountType: 'bank', csv });
    const body = await res.json();
    expect(body.imported).toBe(0);
    expect(body.duplicates).toBe(1);
    expect(body.forced).toBe(0);
    expect(body.duplicateHashes).toEqual([hdSupplyHash]); // fuels a scoped force re-post
    expect(state.insertedBank).toHaveLength(1); // only the bulk attempt
  });

  test('forceDuplicates without the hash scope or token is rejected BEFORE any insert — 400 means nothing changed', async () => {
    state.insertReturningQueue = [[]];
    let res = await post('/admin/tax/bank-import/upload', { accountLabel: 'capone-checking', accountType: 'bank', csv, forceDuplicates: true });
    expect(res.status).toBe(400);
    res = await post('/admin/tax/bank-import/upload', { accountLabel: 'capone-checking', accountType: 'bank', csv, forceDuplicates: true, forceRowHashes: [hdSupplyHash] });
    expect(res.status).toBe(400); // token missing
    expect(state.insertedBank).toHaveLength(0); // validated before the bulk insert
  });

  test('a replayed force confirmation (same token) is caught by the stored record — nothing re-inserted', async () => {
    state.bankRow = { id: 'forced-earlier' }; // the forceToken+forcedFor lookup finds the prior forced row
    state.insertReturningQueue = [[]]; // bulk insert: everything conflicts (replay)
    const res = await post('/admin/tax/bank-import/upload', { accountLabel: 'capone-checking', accountType: 'bank', csv, forceDuplicates: true, forceRowHashes: [hdSupplyHash], forceToken: 'tok-replayed-1' });
    const body = await res.json();
    expect(body.forced).toBe(0);
    expect(body.forceAlreadyPresent).toBe(1);
    expect(state.insertedBank).toHaveLength(1); // bulk attempt only — no force insert at all
  });

  test('with forceDuplicates + hash + token, the skipped row re-inserts under the next free ordinal, recording the token', async () => {
    state.insertReturningQueue = [
      [], // bulk insert: everything conflicts
      [{ id: 'bt-forced' }], // first force attempt lands
    ];
    const res = await post('/admin/tax/bank-import/upload', { accountLabel: 'capone-checking', accountType: 'bank', csv, forceDuplicates: true, forceRowHashes: [hdSupplyHash], forceToken: 'tok-first-99' });
    const body = await res.json();
    expect(body.forced).toBe(1);
    expect(body.imported).toBe(1);
    expect(body.duplicates).toBe(1);
    expect(state.insertedBank).toHaveLength(2);
    // the forced copy has a DIFFERENT identity than the original attempt,
    // and carries the confirmation identity for replay detection
    expect(state.insertedBank[1].row_hash).not.toBe(state.insertedBank[0].row_hash);
    expect(state.insertedBank[1].suggestion).toEqual({ forceToken: 'tok-first-99', forcedFor: hdSupplyHash });
    expect(state.insertedBank[1]).toMatchObject({ amount: 204.87, direction: 'debit', account_label: 'capone-checking' });
  });

  test('exhausting the ordinal walk reports an explicit forceFailed — never a false already-present', async () => {
    state.insertReturningQueue = [[], ...Array.from({ length: 25 }, () => [])]; // bulk + all 25 walk attempts conflict
    const res = await post('/admin/tax/bank-import/upload', { accountLabel: 'capone-checking', accountType: 'bank', csv, forceDuplicates: true, forceRowHashes: [hdSupplyHash], forceToken: 'tok-exhaust-1' });
    const body = await res.json();
    expect(body.forced).toBe(0);
    expect(body.forceAlreadyPresent).toBe(0);
    expect(body.forceFailed).toBe(1);
  });

  test('losing the DB force-identity race (concurrent retry of the same confirmation) resolves as already present', async () => {
    const identityRace = Object.assign(new Error('duplicate key value violates unique constraint "bank_txn_force_identity_uniq"'), { code: '23505' });
    state.insertReturningQueue = [
      [], // bulk insert: everything conflicts
      identityRace, // the force insert loses to the concurrent twin at the DB
    ];
    const res = await post('/admin/tax/bank-import/upload', { accountLabel: 'capone-checking', accountType: 'bank', csv, forceDuplicates: true, forceRowHashes: [hdSupplyHash], forceToken: 'tok-raced-11' });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.forced).toBe(0);
    expect(body.forceAlreadyPresent).toBe(1);
    expect(state.insertedBank).toHaveLength(2); // walking stopped at the identity race
  });

  test('a NEW confirmation (new token) walks past prior forced copies — a third identical transaction stays importable', async () => {
    state.insertReturningQueue = [
      [], // bulk: ordinal 0 conflicts
      [], // walk: ordinal 1 conflicts (the earlier forced copy)
      [{ id: 'bt-third' }], // ordinal 2 lands
    ];
    const res = await post('/admin/tax/bank-import/upload', { accountLabel: 'capone-checking', accountType: 'bank', csv, forceDuplicates: true, forceRowHashes: [hdSupplyHash], forceToken: 'tok-second-42' });
    const body = await res.json();
    expect(body.forced).toBe(1);
    expect(state.insertedBank).toHaveLength(3); // 1 bulk + 2 walk attempts
  });

  test('a forced copy cannot collide with a row the SAME upload imported (two new identical rows, one conflicted)', async () => {
    const { hashRow } = jest.requireActual('../services/bank-import');
    const hdRow = { txn_date: '2026-08-10', description: 'HD SUPPLY', amount: 204.87, direction: 'debit' };
    const ordinal1Hash = hashRow('capone-checking', hdRow, 1);
    const twoIdenticalCsv = 'Date,Description,Amount\n08/10/2026,HD SUPPLY,-204.87\n08/10/2026,HD SUPPLY,-204.87';
    state.insertReturningQueue = [
      [{ id: 'bt-new', row_hash: ordinal1Hash }], // bulk: ordinal 0 conflicts (DB copy), ordinal 1 lands
      [{ id: 'bt-forced' }], // the force attempt lands
    ];
    const res = await post('/admin/tax/bank-import/upload', { accountLabel: 'capone-checking', accountType: 'bank', csv: twoIdenticalCsv, forceDuplicates: true, forceRowHashes: [hdSupplyHash], forceToken: 'tok-collide-7' });
    const body = await res.json();
    expect(body.forced).toBe(1);
    // target ordinal = tuple occurrences (2) + row ordinal (0) = 2 — past
    // everything this file occupies, so the just-imported ordinal-1 row is safe
    expect(state.insertedBank[2].row_hash).toBe(hashRow('capone-checking', hdRow, 2));
    expect(state.insertedBank[2].row_hash).not.toBe(ordinal1Hash);
  });

  test('forcing a HIGHER-ordinal duplicate starts at the first free ordinal — no holes for a fuller export to refill', async () => {
    const { hashRow } = jest.requireActual('../services/bank-import');
    const hdRow = { txn_date: '2026-08-10', description: 'HD SUPPLY', amount: 204.87, direction: 'debit' };
    const ordinal1Hash = hashRow('capone-checking', hdRow, 1);
    // both occurrences already stored (ordinals 0-1); the operator forces
    // only the SECOND — the copy must land at ordinal 2, not skip to 3
    const twoIdenticalCsv = 'Date,Description,Amount\n08/10/2026,HD SUPPLY,-204.87\n08/10/2026,HD SUPPLY,-204.87';
    state.insertReturningQueue = [
      [], // bulk: both conflict
      [{ id: 'bt-forced' }], // force attempt lands
    ];
    const res = await post('/admin/tax/bank-import/upload', { accountLabel: 'capone-checking', accountType: 'bank', csv: twoIdenticalCsv, forceDuplicates: true, forceRowHashes: [ordinal1Hash], forceToken: 'tok-hole-13' });
    const body = await res.json();
    expect(body.forced).toBe(1);
    expect(state.insertedBank[2].row_hash).toBe(hashRow('capone-checking', hdRow, 2));
  });

  test('force only touches the scoped hashes — a full re-post cannot duplicate the rest of the statement', async () => {
    const twoRowCsv = 'Date,Description,Amount\n08/10/2026,HD SUPPLY,-204.87\n08/11/2026,REFUND,15.00';
    state.insertReturningQueue = [
      [], // bulk insert: EVERY row conflicts on the confirming re-post
      [{ id: 'bt-forced' }], // the single scoped force attempt lands
    ];
    const res = await post('/admin/tax/bank-import/upload', { accountLabel: 'capone-checking', accountType: 'bank', csv: twoRowCsv, forceDuplicates: true, forceRowHashes: [hdSupplyHash], forceToken: 'tok-scoped-3' });
    const body = await res.json();
    expect(body.duplicates).toBe(2); // both conflicted…
    expect(body.forced).toBe(1); // …but only the scoped one was forced
    expect(state.insertedBank).toHaveLength(3); // 2 bulk attempts + 1 force
    expect(state.insertedBank[2]).toMatchObject({ description: 'HD SUPPLY' });
  });
});

describe('coverage (gate on)', () => {
  beforeEach(() => { process.env.GATE_BANK_IMPORT = 'true'; });

  test('coverage SELF-HEALS stale links before reporting — an edited expense cannot keep counting as covered', async () => {
    const { resetDanglingLinks, healEditedExpenseLinks } = require('../services/bank-import');
    resetDanglingLinks.mockClear();
    healEditedExpenseLinks.mockClear();
    const res = await get('/admin/tax/bank-import/coverage?year=2026');
    expect(res.status).toBe(200);
    expect(resetDanglingLinks).toHaveBeenCalled();
    expect(healEditedExpenseLinks).toHaveBeenCalled();
  });
});

describe('refund-candidates on demand (gate on)', () => {
  beforeEach(() => { process.env.GATE_BANK_IMPORT = 'true'; });

  test('serves the FULL plausible list for a credit — off-slice originals stay selectable', async () => {
    const { refundCandidatesForRow } = require('../services/bank-import');
    refundCandidatesForRow.mockResolvedValueOnce([
      { id: 'exp-1', amount: '21.00', vendor_name: 'Wawa', description: 'gas', expense_date: '2026-08-05' },
      { id: 'exp-2', amount: '25.00', vendor_name: 'Wawa', description: 'gas', expense_date: '2026-08-02' },
    ]);
    state.bankRow = { id: 'bt-1', amount: '20.00', txn_date: '2026-08-09', description: 'WAWA REFUND', direction: 'credit', account_type: 'card', status: 'unmatched' };
    const res = await get('/admin/tax/bank-import/bt-1/refund-candidates');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.candidates.map((c) => c.id)).toEqual(['exp-1', 'exp-2']);
    expect(body.candidates[0].amount).toBe(21);
  });

  test('a debit has no refund candidates — 400', async () => {
    state.bankRow = { id: 'bt-1', direction: 'debit', status: 'unmatched' };
    expect((await get('/admin/tax/bank-import/bt-1/refund-candidates')).status).toBe(400);
  });

  test('expense-candidates serves the FULL list for a debit (gross-aware amounts) — off-slice targets stay selectable', async () => {
    const { surveyExpenseCandidatesForRow } = require('../services/bank-import');
    surveyExpenseCandidatesForRow.mockResolvedValueOnce([
      { id: 'exp-1', amount: '38.12', gross_amount: 58.12, vendor_name: 'Wawa', description: 'gas', expense_date: '2026-08-08' },
      { id: 'exp-2', amount: '58.12', vendor_name: 'Wawa', description: 'gas 2', expense_date: '2026-08-09' },
    ]);
    state.bankRow = { id: 'bt-1', amount: '58.12', txn_date: '2026-08-09', description: 'WAWA', direction: 'debit', account_type: 'card', status: 'unmatched', suggestion: null };
    const res = await get('/admin/tax/bank-import/bt-1/expense-candidates');
    expect(res.status).toBe(200);
    // the MANUAL picker lifts unlink rejections — link-expense accepts
    // those ids, so a previously unlinked target stays restorable
    expect(surveyExpenseCandidatesForRow).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ expenseIds: [] }));
    const body = await res.json();
    expect(body.total).toBe(2);
    // newest-first deterministic order; gross reading surfaces for the
    // refund-reduced candidate
    expect(body.candidates.map((c) => c.id)).toEqual(['exp-2', 'exp-1']);
    expect(body.candidates[1].amount).toBe(58.12);
  });

  test('a credit has no expense candidates — 400', async () => {
    state.bankRow = { id: 'bt-1', direction: 'credit', status: 'unmatched' };
    expect((await get('/admin/tax/bank-import/bt-1/expense-candidates')).status).toBe(400);
  });

  test('status SELF-HEALS before counting — concurrent tab loads cannot report already-reverted matches', async () => {
    const { resetDanglingLinks, healEditedExpenseLinks, healUnreconciledLinks } = require('../services/bank-import');
    resetDanglingLinks.mockClear();
    healEditedExpenseLinks.mockClear();
    healUnreconciledLinks.mockClear();
    const res = await get('/admin/tax/bank-import/status');
    expect(res.status).toBe(200);
    expect(resetDanglingLinks).toHaveBeenCalled();
    expect(healEditedExpenseLinks).toHaveBeenCalled();
    // the payout-eligibility healer runs on page load too — a failed/
    // rescheduled linked payout cannot keep counting as matched
    expect(healUnreconciledLinks).toHaveBeenCalled();
    // and orphaned refunds (suggestion-JSON association — no FK heal can
    // see a deleted target) stop counting as completed refunds
    const { healOrphanRefunds } = require('../services/bank-import');
    expect(healOrphanRefunds).toHaveBeenCalled();
  });

  test('the transactions page SELF-HEALS too — rendered rows must not carry actions that can only 409', async () => {
    const { resetDanglingLinks, healUnreconciledLinks } = require('../services/bank-import');
    resetDanglingLinks.mockClear();
    healUnreconciledLinks.mockClear();
    const res = await get('/admin/tax/bank-import/transactions');
    expect(res.status).toBe(200);
    expect(resetDanglingLinks).toHaveBeenCalled();
    expect(healUnreconciledLinks).toHaveBeenCalled();
  });

  test('payout-candidates serves the full nearest-arrival list for a bank credit', async () => {
    const { surveyPayoutCandidatesForRow } = require('../services/bank-import');
    surveyPayoutCandidatesForRow.mockResolvedValueOnce({
      candidates: [
        { id: 'po-far', effective_amount: 500, arrival_date: '2026-08-09' },
        { id: 'po-near', effective_amount: 500, arrival_date: '2026-08-11' },
      ],
      overflow: false,
    });
    state.bankRow = { id: 'bt-1', amount: '500.00', txn_date: '2026-08-11', description: 'DEPOSIT', direction: 'credit', account_type: 'bank', status: 'unmatched', suggestion: null };
    const res = await get('/admin/tax/bank-import/bt-1/payout-candidates');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.candidates.map((c) => c.id)).toEqual(['po-near', 'po-far']);
    expect(body.total).toBe(2);
    // card credits have no payout candidates
    state.bankRow = { id: 'bt-1', direction: 'credit', account_type: 'card', status: 'unmatched' };
    expect((await get('/admin/tax/bank-import/bt-1/payout-candidates')).status).toBe(400);
  });
});

describe('apply-refund (gate on)', () => {
  beforeEach(() => {
    process.env.GATE_BANK_IMPORT = 'true';
    state.bankRow = { id: 'bt-1', amount: '20.00', txn_date: '2026-08-09', description: 'WAWA 5211 REFUND', direction: 'credit', account_type: 'card', account_label: 'capone-card-1234', status: 'unmatched', suggestion: { refundCandidates: [{ id: 'exp-9' }] } };
    state.expenseRow = { id: 'exp-9', amount: '58.12', tax_deductible_amount: '29.06', notes: '[Bank import capone-card-1234]', vendor_name: 'Wawa', description: 'gas', payment_method: 'card', expense_date: '2026-08-01' };
  });

  test('an IMPLAUSIBLE target (outside the lookback window) is refused — no arbitrary ledger reductions', async () => {
    // validation is by the matcher's plausibility RULES, not parked-list
    // membership — so a crafted/stale id still can't reduce an arbitrary
    // expense, while a valid off-slice original stays applicable
    state.expenseRow = { ...state.expenseRow, expense_date: '2026-04-01' }; // > 90 days before the credit
    const res = await post('/admin/tax/bank-import/bt-1/apply-refund', { expenseId: 'exp-9' });
    expect(res.status).toBe(409);
    expect(state.expenseUpdates).toHaveLength(0);
    expect(state.bankUpdates).toHaveLength(0);
  });

  test('a plausible original NOT in the parked slice still applies (high-frequency-vendor overflow)', async () => {
    state.bankRow.suggestion = { refundCandidates: [{ id: 'exp-other' }] }; // the real original fell off the bounded list
    const res = await post('/admin/tax/bank-import/bt-1/apply-refund', { expenseId: 'exp-9' });
    expect(res.status).toBe(200);
    expect(state.expenseUpdates[0].amount).toBe(38.12);
  });

  test('vendor/method re-verification under the lock rejects a changed expense', async () => {
    state.expenseRow = { id: 'exp-9', amount: '58.12', tax_deductible_amount: '29.06', vendor_name: 'Totally Different LLC', description: 'x', payment_method: 'ach', expense_date: '2026-08-01' };
    const res = await post('/admin/tax/bank-import/bt-1/apply-refund', { expenseId: 'exp-9' });
    expect(res.status).toBe(409);
    expect(state.bankUpdates).toHaveLength(0);
  });

  test('a CROSS-TAX-YEAR refund refuses to rewrite the filed year (tax benefit rule)', async () => {
    state.bankRow.txn_date = '2026-01-15';
    state.expenseRow = { ...state.expenseRow, expense_date: '2025-12-20' }; // inside the 90-day lookback, different tax year
    const res = await post('/admin/tax/bank-import/bt-1/apply-refund', { expenseId: 'exp-9' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('income');
    expect(state.expenseUpdates).toHaveLength(0);
    expect(state.bankUpdates).toHaveLength(0);
  });

  test('a BANK-account credit (purchase refunded into checking) applies as a refund too', async () => {
    state.bankRow.account_type = 'bank';
    state.bankRow.account_label = 'capone-checking';
    const res = await post('/admin/tax/bank-import/bt-1/apply-refund', { expenseId: 'exp-9' });
    expect(res.status).toBe(200);
    expect(state.expenseUpdates[0].amount).toBe(38.12);
  });

  test('a job expense refund re-derives the persisted job-cost rollups after commit', async () => {
    const { calculateJobCost } = require('../services/job-costing');
    calculateJobCost.mockClear();
    state.expenseRow = { ...state.expenseRow, scheduled_service_id: 'svc-1' };
    const res = await post('/admin/tax/bank-import/bt-1/apply-refund', { expenseId: 'exp-9' });
    expect(res.status).toBe(200);
    expect(calculateJobCost).toHaveBeenCalledWith('svc-1');
  });

  test('REDUCES the original expense (proportional deductible, floor 0) and claims the credit row', async () => {
    const res = await post('/admin/tax/bank-import/bt-1/apply-refund', { expenseId: 'exp-9' });
    expect(res.status).toBe(200);
    const upd = state.expenseUpdates[0];
    expect(upd.amount).toBe(38.12); // 58.12 - 20.00 — never a negative ledger row
    expect(upd.tax_deductible_amount).toBe(19.06); // 29.06 × (38.12 / 58.12)
    expect(upd.notes).toContain('[Refund $20.00 applied');
    const claim = state.bankUpdates[0];
    expect(claim.wheres).toContainEqual({ id: 'bt-1', status: 'unmatched' });
    expect(claim.patch).toMatchObject({ status: 'refund_applied', match_method: 'refund' });
    expect(sugOf(claim)).toMatchObject({ refundAppliedTo: 'exp-9', refundAmount: 20 });
  });

  test('a refund larger than the remaining expense is refused', async () => {
    state.bankRow.amount = '99.99';
    const res = await post('/admin/tax/bank-import/bt-1/apply-refund', { expenseId: 'exp-9' });
    expect(res.status).toBe(400);
    expect(state.bankUpdates).toHaveLength(0);
  });

  test('validates inputs: missing expenseId, debit row, non-unmatched, unknown expense', async () => {
    expect((await post('/admin/tax/bank-import/bt-1/apply-refund', {})).status).toBe(400);
    state.bankRow.direction = 'debit';
    expect((await post('/admin/tax/bank-import/bt-1/apply-refund', { expenseId: 'exp-9' })).status).toBe(400);
    state.bankRow.direction = 'credit';
    state.bankRow.status = 'ignored';
    expect((await post('/admin/tax/bank-import/bt-1/apply-refund', { expenseId: 'exp-9' })).status).toBe(409);
    state.bankRow.status = 'unmatched';
    state.expenseRow = null; // parked candidate whose expense row is gone
    expect((await post('/admin/tax/bank-import/bt-1/apply-refund', { expenseId: 'exp-9' })).status).toBe(404);
  });

  test('losing the claim CAS rolls the expense adjustment back and answers 409', async () => {
    state.bankUpdateResult = 0;
    const res = await post('/admin/tax/bank-import/bt-1/apply-refund', { expenseId: 'exp-9' });
    expect(res.status).toBe(409);
    expect(mockDb.transaction).toHaveBeenCalled(); // real DB rolls the update back with the throw
  });

  test('the refund claim stores a refundRestore snapshot for exact undo', async () => {
    await post('/admin/tax/bank-import/bt-1/apply-refund', { expenseId: 'exp-9' });
    expect(sugOf(state.bankUpdates[0]).refundRestore).toEqual({ prevAmount: 58.12, prevDeductible: 29.06, appliedDeductible: 19.06 });
  });

  test('undo (unlink) RESTORES the expense from the snapshot and returns the credit to review', async () => {
    state.bankRow = {
      id: 'bt-1', amount: '20.00', direction: 'credit', account_type: 'card', status: 'refund_applied',
      suggestion: { refundAppliedTo: 'exp-9', refundAmount: 20, refundRestore: { prevAmount: 58.12, prevDeductible: 29.06, appliedDeductible: 19.06 } },
    };
    state.expenseRow = { id: 'exp-9', amount: '38.12', tax_deductible_amount: '19.06', notes: 'n' };
    const res = await post('/admin/tax/bank-import/bt-1/unlink', {});
    expect(res.status).toBe(200);
    const upd = state.expenseUpdates[0];
    expect(upd.amount).toBe(58.12);
    expect(upd.tax_deductible_amount).toBe(29.06);
    expect(upd.notes).toContain('UNDONE');
    const claim = state.bankUpdates[0];
    expect(claim.wheres).toContainEqual({ id: 'bt-1', status: 'refund_applied' });
    expect(claim.patch.status).toBe('unmatched');
    expect(sugOf(claim).refundUndone.expenseId).toBe('exp-9');
  });

  test('undoing a job expense refund re-derives the job-cost rollups too', async () => {
    const { calculateJobCost } = require('../services/job-costing');
    calculateJobCost.mockClear();
    state.bankRow = {
      id: 'bt-1', amount: '20.00', direction: 'credit', account_type: 'card', status: 'refund_applied',
      suggestion: { refundAppliedTo: 'exp-9', refundAmount: 20, refundRestore: { prevAmount: 58.12, prevDeductible: 29.06, appliedDeductible: 19.06 } },
    };
    state.expenseRow = { id: 'exp-9', amount: '38.12', tax_deductible_amount: '19.06', notes: 'n', scheduled_service_id: 'svc-1' };
    const res = await post('/admin/tax/bank-import/bt-1/unlink', {});
    expect(res.status).toBe(200);
    expect(calculateJobCost).toHaveBeenCalledWith('svc-1');
  });

  test('undo refuses when the DEDUCTIBLE changed since the refund — later tax edits are never destroyed', async () => {
    state.bankRow = {
      id: 'bt-1', amount: '20.00', direction: 'credit', account_type: 'card', status: 'refund_applied',
      suggestion: { refundAppliedTo: 'exp-9', refundAmount: 20, refundRestore: { prevAmount: 58.12, prevDeductible: 29.06, appliedDeductible: 19.06 } },
    };
    // amount untouched, but the operator re-categorized → deductible differs
    state.expenseRow = { id: 'exp-9', amount: '38.12', tax_deductible_amount: '38.12', notes: 'n' };
    const res = await post('/admin/tax/bank-import/bt-1/unlink', {});
    expect(res.status).toBe(409);
    expect(state.expenseUpdates).toHaveLength(0);
  });

  test('undo refuses when the expense changed since the refund (manual fix territory)', async () => {
    state.bankRow = {
      id: 'bt-1', amount: '20.00', direction: 'credit', account_type: 'card', status: 'refund_applied',
      suggestion: { refundAppliedTo: 'exp-9', refundAmount: 20, refundRestore: { prevAmount: 58.12, prevDeductible: 29.06, appliedDeductible: 19.06 } },
    };
    state.expenseRow = { id: 'exp-9', amount: '10.00', tax_deductible_amount: '5.00', notes: 'n' }; // drifted
    const res = await post('/admin/tax/bank-import/bt-1/unlink', {});
    expect(res.status).toBe(409);
    expect(state.expenseUpdates).toHaveLength(0);
  });

  test('undo with the expense deleted just releases the credit row', async () => {
    state.bankRow = {
      id: 'bt-1', amount: '20.00', direction: 'credit', account_type: 'card', status: 'refund_applied',
      suggestion: { refundAppliedTo: 'exp-9', refundAmount: 20, refundRestore: { prevAmount: 58.12, prevDeductible: 29.06, appliedDeductible: 19.06 } },
    };
    state.expenseRow = null;
    const res = await post('/admin/tax/bank-import/bt-1/unlink', {});
    expect(res.status).toBe(200);
    expect(state.expenseUpdates).toHaveLength(0);
    expect(state.bankUpdates[0].patch.status).toBe('unmatched');
  });
});

describe('link-payout (gate on)', () => {
  beforeEach(() => {
    process.env.GATE_BANK_IMPORT = 'true';
    state.bankRow = { id: 'bt-1', amount: '2418.66', txn_date: '2026-08-11', direction: 'credit', account_type: 'bank', status: 'unmatched', suggestion: { payoutCandidates: [{ id: 'po-9' }] } };
    state.payoutRow = { id: 'po-9', status: 'paid', amount: '2418.66', arrival_date: '2026-08-10' };
  });

  test('a payout outside the amount/arrival matching window is refused', async () => {
    state.payoutRow = { id: 'po-9', status: 'paid', amount: '100.00', arrival_date: '2026-08-10' };
    expect((await post('/admin/tax/bank-import/bt-1/link-payout', { payoutId: 'po-9' })).status).toBe(400);
    state.payoutRow = { id: 'po-9', status: 'paid', amount: '2418.66', arrival_date: '2026-07-01' };
    expect((await post('/admin/tax/bank-import/bt-1/link-payout', { payoutId: 'po-9' })).status).toBe(400);
    expect(state.bankUpdates).toHaveLength(0);
  });

  test('claims via CAS with match_method=manual and echoes reconciliation (pending flag in the claim)', async () => {
    const res = await post('/admin/tax/bank-import/bt-1/link-payout', { payoutId: 'po-9' });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.reconciliation).toBe('confirmed');
    const claim = state.bankUpdates[0];
    expect(claim.wheres).toContainEqual({ id: 'bt-1', status: 'unmatched' });
    expect(claim.patch).toMatchObject({ status: 'matched_payout', matched_payout_id: 'po-9', match_method: 'manual' });
    expect(sugOf(claim).reconcilePending).toBe(true);
    expect(reconcilePayout).toHaveBeenCalledWith('po-9', 2418.66, expect.stringContaining('bt-1'), 'bank-import:bt-1', 'confirmed',
      expect.objectContaining({ onlyIfUnreconciled: true, precondition: expect.any(Function) }));
    // the flag clears (jsonb key-subtraction, scoped to this link)
    expect(state.bankUpdates[1].wheres).toContainEqual({ id: 'bt-1', status: 'matched_payout', matched_payout_id: 'po-9' });
    expect(state.bankUpdates[1].patch.suggestion).toContain("- 'reconcilePending'");
  });

  test('an already-reconciled payout (guard skip) resolves as already_reconciled — flag still claimed and cleared', async () => {
    reconcilePayout.mockResolvedValueOnce({ payout_id: 'po-9', skipped: true });
    const res = await post('/admin/tax/bank-import/bt-1/link-payout', { payoutId: 'po-9' });
    const body = await res.json();
    expect(body.reconciliation).toBe('already_reconciled');
    // the flag always rides in the claim; a guard skip clears it too
    expect(sugOf(state.bankUpdates[0]).reconcilePending).toBe(true);
    expect(state.bankUpdates[1].patch.suggestion).toContain("- 'reconcilePending'");
  });

  test('a human-rejected reconciliation answers 409 — the helper reverted the link, never a silent success', async () => {
    reconcilePayout.mockResolvedValueOnce({ payout_id: 'po-9', skipped: true, reason: 'human_rejected' });
    state.latestRecon = { status: 'rejected', reconciled_by: 'adam' }; // locked re-check confirms the ruling
    const res = await post('/admin/tax/bank-import/bt-1/link-payout', { payoutId: 'po-9' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain('rejected');
  });

  test('a precondition skip (row changed mid-flight) answers 409', async () => {
    reconcilePayout.mockResolvedValueOnce({ payout_id: 'po-9', skipped: true, reason: 'precondition' });
    const res = await post('/admin/tax/bank-import/bt-1/link-payout', { payoutId: 'po-9' });
    expect(res.status).toBe(409);
  });

  test('a non-paid payout is refused server-side — pending/failed money cannot explain a bank credit', async () => {
    state.payoutRow = { id: 'po-9', status: 'in_transit' };
    const res = await post('/admin/tax/bank-import/bt-1/link-payout', { payoutId: 'po-9' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('not paid');
    expect(state.bankUpdates).toHaveLength(0);
  });

  test('an echo failure answers pending — the claim stands and the sweep retries', async () => {
    reconcilePayout.mockRejectedValueOnce(new Error('db down'));
    const res = await post('/admin/tax/bank-import/bt-1/link-payout', { payoutId: 'po-9' });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.reconciliation).toBe('pending');
    expect(state.bankUpdates).toHaveLength(1); // no clearing update
    expect(sugOf(state.bankUpdates[0]).reconcilePending).toBe(true);
  });

  test('validates inputs: missing payoutId, debit row, card credit, non-unmatched, unknown payout', async () => {
    expect((await post('/admin/tax/bank-import/bt-1/link-payout', {})).status).toBe(400);
    state.bankRow.direction = 'debit';
    expect((await post('/admin/tax/bank-import/bt-1/link-payout', { payoutId: 'po-9' })).status).toBe(400);
    state.bankRow.direction = 'credit';
    state.bankRow.account_type = 'card';
    expect((await post('/admin/tax/bank-import/bt-1/link-payout', { payoutId: 'po-9' })).status).toBe(400);
    state.bankRow.account_type = 'bank';
    state.bankRow.status = 'ignored';
    expect((await post('/admin/tax/bank-import/bt-1/link-payout', { payoutId: 'po-9' })).status).toBe(409);
    state.bankRow.status = 'unmatched';
    state.payoutRow = null;
    expect((await post('/admin/tax/bank-import/bt-1/link-payout', { payoutId: 'po-9' })).status).toBe(404);
  });

  test('a unique-index violation (payout already linked elsewhere) answers 409', async () => {
    const dup = Object.assign(new Error('duplicate key'), { code: '23505' });
    state.bankUpdateError = dup;
    expect((await post('/admin/tax/bank-import/bt-1/link-payout', { payoutId: 'po-9' })).status).toBe(409);
  });
});

describe('suggest scoped to visible rows (gate on)', () => {
  beforeEach(() => { process.env.GATE_BANK_IMPORT = 'true'; });

  test('processes the passed ids and writes only suggestion jsonb', async () => {
    const { autoCategorizeExpense } = require('../services/expense-categorizer');
    autoCategorizeExpense.mockResolvedValueOnce({ categoryId: 'cat-1', categoryName: 'Supplies', reasoning: 'r' });
    state.listRows = [{ id: 'bt-7', description: 'HD SUPPLY', amount: '204.87', suggestion: null }];
    const res = await post('/admin/tax/bank-import/suggest', { limit: 20, ids: ['bt-7'] });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.processed).toBe(1);
    // atomic jsonb merge — never a rebuild that could erase keys the
    // matcher wrote during the model call
    const sug = state.bankUpdates[0].patch.suggestion;
    expect(sug.sql).toContain("coalesce(suggestion, '{}'::jsonb) ||");
    expect(JSON.parse(sug.bindings[0])).toMatchObject({ categoryId: 'cat-1', categoryName: 'Supplies' });
  });
});

describe('unlink (gate on)', () => {
  beforeEach(() => {
    process.env.GATE_BANK_IMPORT = 'true';
    state.bankRow = {
      id: 'bt-1', amount: '2418.66', direction: 'credit', status: 'matched_payout',
      matched_payout_id: 'po-1', matched_expense_id: null, match_method: 'payout_amount_date', suggestion: null,
    };
  });

  test('unlinks a matched expense row back to unmatched with an audit stamp; no reconciliation involved', async () => {
    state.bankRow = {
      id: 'bt-1', amount: '58.12', direction: 'debit', status: 'matched_expense',
      matched_expense_id: 'exp-9', matched_payout_id: null, match_method: 'manual', suggestion: { categoryName: 'Fuel' },
    };
    const res = await post('/admin/tax/bank-import/bt-1/unlink', {});
    expect(res.status).toBe(200);
    const upd = state.bankUpdates[0];
    // CAS on the CURRENT status AND the exact expense id — a stale unlink
    // read against expense A must 409 instead of clearing a newer link to B
    expect(upd.wheres).toContainEqual({ id: 'bt-1', status: 'matched_expense', matched_expense_id: 'exp-9' });
    expect(upd.patch).toMatchObject({ status: 'unmatched', matched_expense_id: null, matched_payout_id: null, match_method: null, matched_at: null });
    expect(sugOf(upd).lastUnlink).toMatchObject({ was: 'matched_expense', method: 'manual', expenseId: 'exp-9' });
    // merge semantics: prior suggestion keys (e.g. categoryName) survive at the DB
    expect(reconcilePayout).not.toHaveBeenCalled();
  });

  test('unlinking a payout row reverses OUR reconciliation inside one transaction', async () => {
    state.payoutRow = { id: 'po-1', reconciled: true, reconciled_by: 'bank-import:bt-1' };
    const res = await post('/admin/tax/bank-import/bt-1/unlink', {});
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.reconciliation).toBe('reversed');
    // ownership was checked under the payout row lock; the reversal joins
    // the SAME transaction via opts.trx so both commit or neither does
    expect(reconcilePayout).toHaveBeenCalledWith('po-1', 2418.66, expect.stringContaining('bt-1'), 'bank-import:bt-1', 'rejected',
      expect.objectContaining({ trx: expect.anything() }));
    // exactly one update: the in-transaction unlink CAS, scoped to the exact payout
    expect(state.bankUpdates).toHaveLength(1);
    const upd = state.bankUpdates[0];
    expect(upd.wheres).toContainEqual({ id: 'bt-1', status: 'matched_payout', matched_payout_id: 'po-1' });
    expect(upd.patch).toMatchObject({ status: 'unmatched', matched_payout_id: null });
    expect(sugOf(upd).lastUnlink.payoutId).toBe('po-1');
    // rejections accumulate — a later unlink of a different target keeps this one excluded
    expect(sugOf(upd).rejectedPayoutIds).toEqual(['po-1']);
  });

  test("someone else's reconciliation is kept — unlink proceeds, banking side untouched", async () => {
    state.payoutRow = { id: 'po-1', reconciled: true, reconciled_by: 'adam' };
    const res = await post('/admin/tax/bank-import/bt-1/unlink', {});
    const body = await res.json();
    expect(body.reconciliation).toBe('kept');
    expect(reconcilePayout).not.toHaveBeenCalled();
    expect(state.bankUpdates).toHaveLength(1);
    expect(state.bankUpdates[0].patch.status).toBe('unmatched');
  });

  test('an unreconciled payout unlinks with nothing to reverse', async () => {
    state.payoutRow = { id: 'po-1', reconciled: false, reconciled_by: null };
    const res = await post('/admin/tax/bank-import/bt-1/unlink', {});
    const body = await res.json();
    expect(body.reconciliation).toBeNull();
    expect(reconcilePayout).not.toHaveBeenCalled();
    expect(state.bankUpdates[0].patch.status).toBe('unmatched');
  });

  test('a reversal failure rolls the unlink back — the row stays linked and the operator retries', async () => {
    state.payoutRow = { id: 'po-1', reconciled: true, reconciled_by: 'bank-import:bt-1' };
    reconcilePayout.mockRejectedValueOnce(new Error('db down'));
    const res = await post('/admin/tax/bank-import/bt-1/unlink', {});
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toContain('still linked');
  });

  test('only matched rows can be unlinked — unmatched and created_expense answer 409', async () => {
    state.bankRow.status = 'unmatched';
    expect((await post('/admin/tax/bank-import/bt-1/unlink', {})).status).toBe(409);
    state.bankRow.status = 'created_expense';
    expect((await post('/admin/tax/bank-import/bt-1/unlink', {})).status).toBe(409);
  });

  test('a concurrent status change loses the CAS and answers 409', async () => {
    state.bankUpdateResult = 0;
    expect((await post('/admin/tax/bank-import/bt-1/unlink', {})).status).toBe(409);
  });
});
