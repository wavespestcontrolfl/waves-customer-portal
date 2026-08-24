/**
 * /admin/tax/revenue/quarterly-estimate + /revenue/reconcile — the 1040-ES
 * estimate and the reconcile card must share the P&L's revenue basis.
 *
 * Locked-down behaviors:
 *  1. Revenue = paidRevenueForWindow MINUS sales tax collected (sum of
 *     invoices.tax_amount for invoices paid in the window) — the SAME two
 *     figures buildPnlReport nets, so the estimate, the reconcile card, and
 *     the P&L cannot disagree on the window's income.
 *  2. Expenses use the DEDUCTIBLE amount (COALESCE(tax_deductible_amount,
 *     amount), clamped), not raw amount — meals at 50% etc.
 *  3. The YTD net is ANNUALIZED before the liability is computed (Q1 is no
 *     longer ~4× low) and prior filed/paid 1040-ES rows on the filing
 *     calendar are credited against the required cumulative.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

// ── Generic queue-backed knex mock ──────────────────────────────────────────
// Each db('<table>') call builds a chainable stub; resolving it (via .first()
// or awaiting the builder) shifts the next staged result for that table.
// Staging order therefore mirrors the code's construction order per table.
const queues = {};
const rawCalls = [];
function stage(table, ...results) { (queues[table] = queues[table] || []).push(...results); }
function nextFor(table) {
  const q = queues[table] || [];
  const v = q.length ? q.shift() : null;
  if (v instanceof Error) throw v;
  return v;
}
function makeBuilder(rawTable) {
  // knex accepts aliased sources ('invoices as i') — queue by the base table.
  const table = String(rawTable).split(' ')[0];
  const b = {};
  [
    'where', 'whereIn', 'whereNot', 'whereNull', 'whereNotNull', 'whereRaw',
    'whereBetween', 'whereExists', 'whereNotExists', 'leftJoin', 'join',
    'groupBy', 'orderBy', 'select', 'sum', 'count', 'limit',
  ].forEach((m) => { b[m] = jest.fn(() => b); });
  b.first = jest.fn(() => new Promise((res) => res(nextFor(table))));
  // Awaiting the builder directly (list queries) resolves the staged value too.
  b.then = (res, rej) => Promise.resolve(nextFor(table)).then(res, rej);
  b.catch = (fn) => Promise.resolve(nextFor(table)).catch(fn);
  return b;
}
const mockDb = jest.fn((table) => makeBuilder(table));
mockDb.raw = jest.fn((sql) => { rawCalls.push(String(sql)); return sql; });
mockDb.fn = { now: jest.fn(() => 'now()'), uuid: jest.fn(() => 'uuid()') };

jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.techRole = 'admin'; next(); },
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/invoice-helpers', () => ({ invoiceAmountDue: jest.fn() }));
jest.mock('../services/expense-categorizer', () => ({
  autoCategorizeExpense: jest.fn(),
  categoryDeductibleAmount: jest.fn((_c, a) => a),
}));
jest.mock('../services/bouncie-mileage', () => ({ getIrsRate: jest.fn(() => 0.7) }));
jest.mock('../services/bank-import', () => ({}));
jest.mock('../services/stripe-banking', () => ({ reconcilePayout: jest.fn() }));
jest.mock('../services/job-costing', () => ({ calculateJobCost: jest.fn() }));

const express = require('express');
const { buildPnlReport } = require('../services/pnl-report');
const taxRouter = require('../routes/admin-tax');

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/admin/tax', taxRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll((done) => { server.close(done); });

const get = async (path) => {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json() };
};

// paidRevenueForWindow construction order per table:
//   payments: ledger receipts, then full-refund gap markers
//   invoices: paid-Stripe gap rows, then (from salesTaxCollectedForWindow) tax
function stageRevenueWindow({ ledger = '30700', salesTax = '700' } = {}) {
  stage('payments', { total: ledger }, { total: '0' });
  stage('invoices', { total: '0' }, { total: salesTax });
  stage('estimate_deposits', { total: '0' });
  stage('stripe_payout_transactions', { total: '0' });
}

beforeEach(() => {
  for (const k of Object.keys(queues)) delete queues[k];
  rawCalls.length = 0;
});

describe('GET /admin/tax/revenue/quarterly-estimate', () => {
  test('Q1: revenue is refund-netted paid cash minus sales tax; net income is annualized ×4', async () => {
    stageRevenueWindow(); // paid 30700, sales tax 700 → revenue 30000
    stage('expenses', { total: '5000' }); // deductible sum
    const res = await get('/admin/tax/revenue/quarterly-estimate?quarter=Q1&year=2026');
    expect(res.status).toBe(200);
    expect(res.body.startDate).toBe('2026-01-01');
    expect(res.body.endDate).toBe('2026-03-31');
    expect(res.body.salesTaxCollected).toBe(700);
    expect(res.body.ytdRevenue).toBe(30000); // 30700 paid − 700 pass-through tax
    expect(res.body.ytdExpenses).toBe(5000);
    expect(res.body.estimatedNetIncome).toBe(25000);
    expect(res.body.annualizedNet).toBe(100000); // 25000 / 3 months × 12
    expect(res.body.seTax).toBeCloseTo(14129.55, 2);
    expect(res.body.incomeTax).toBeCloseTo(20445.75, 2);
    expect(res.body.requiredCumulative).toBeCloseTo(res.body.annualLiability / 4, 2);
    expect(res.body.priorPaymentsCredited).toBe(0);
    expect(res.body.quarterlyPayment).toBe(res.body.requiredCumulative);
    // The expenses query summed the DEDUCTIBLE amount, clamped to [0, amount].
    expect(rawCalls.some((sql) => sql.includes('tax_deductible_amount') && sql.includes('LEAST'))).toBe(true);
    // Q1 never reads the filing calendar (no prior quarters to credit).
    expect(queues.tax_filing_calendar).toBeUndefined();
  });

  test('Q2 credits prior filed/paid 1040-ES payments against the required cumulative', async () => {
    stageRevenueWindow();
    stage('expenses', { total: '5000' });
    stage('tax_filing_calendar', { total: '2000' });
    const res = await get('/admin/tax/revenue/quarterly-estimate?quarter=Q2&year=2026');
    expect(res.status).toBe(200);
    expect(res.body.annualizedNet).toBe(50000); // 25000 / 6 months × 12
    expect(res.body.priorPaymentsCredited).toBe(2000);
    expect(res.body.requiredCumulative).toBeCloseTo(res.body.annualLiability / 2, 2);
    expect(res.body.quarterlyPayment).toBeCloseTo(
      Math.max(0, res.body.requiredCumulative - 2000), 2,
    );
  });

  test('a real expenses DB failure is a 500, never a silent $0 that inflates the estimate', async () => {
    stageRevenueWindow();
    stage('expenses', new Error('connection reset'));
    const res = await get('/admin/tax/revenue/quarterly-estimate?quarter=Q1&year=2026');
    expect(res.status).toBe(500);
  });

  test('a filing-calendar failure is a 500 — a zeroed credit would re-bill a paid installment', async () => {
    stageRevenueWindow();
    stage('expenses', { total: '5000' });
    stage('tax_filing_calendar', new Error('connection reset'));
    const res = await get('/admin/tax/revenue/quarterly-estimate?quarter=Q2&year=2026');
    expect(res.status).toBe(500);
  });

  test('rejects a bad quarter', async () => {
    const res = await get('/admin/tax/revenue/quarterly-estimate?quarter=Q5');
    expect(res.status).toBe(400);
  });
});

describe('revenue basis agreement across surfaces', () => {
  test('reconcile card reports the same net-of-sales-tax revenue and discloses taxCollected', async () => {
    stageRevenueWindow();
    const res = await get('/admin/tax/revenue/reconcile?month=2026-03');
    expect(res.status).toBe(200);
    expect(res.body.totalRevenue).toBe(30000);
    expect(res.body.taxCollected).toBe(700); // no longer a hard-coded null
    expect(res.body.taxOwed).toBeNull(); // still not computable from portal data
  });

  test('buildPnlReport nets the same sales tax out of service revenue and discloses it', async () => {
    stageRevenueWindow();
    stage('expenses', { total: '0', non_deductible: '0' }, []); // COGS row, then opex rows
    stage('stripe_payout_transactions', { total: '0' }); // fees (outflows staged above)
    stage('mileage_log', { total: '0' });
    stage('equipment_register', [], []); // assets, barred vehicles
    stage('company_financials', null);
    stage('stripe_sync_state', null);
    const report = await buildPnlReport(mockDb, '2026-01-01', '2026-03-31');
    expect(report.revenue.serviceRevenue).toBe(30000); // equals the estimate's ytdRevenue
    expect(report.revenue.salesTaxCollected).toBe(700);
    expect(report.revenue.total).toBe(30000);
  });
});
