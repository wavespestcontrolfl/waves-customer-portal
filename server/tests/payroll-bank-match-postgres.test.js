// Real PostgreSQL transaction (rolled back): the bank import's match pass with GATE_PAYROLL_BANK_MATCH
// off and on, on the migrated schema. A finalized run with two paychecks, bank lines (one exact, one
// off by a cent, one EFTPS deposit, one unrelated), the books (pay-run-books) leaving the matched
// lines out, a voided run, an undo, the owner's pick, and a tie. All names are synthetic.
// DATABASE_URL-gated like the other *-postgres suites.
// CI runs a DB suite only when it carries this exact line (tests.yml greps for it).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
let mockConnection;
jest.mock('../models/db', () => new Proxy((...args) => mockConnection(...args), {
  get(_target, key) {
    const value = mockConnection?.[key];
    return typeof value === 'function' ? value.bind(mockConnection) : value;
  },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { randomUUID } = require('node:crypto');
const bankImport = require('../services/bank-import');
const payrollRuns = require('../services/payroll-runs');
const migration = require('../models/migrations/20261029130000_bank_txn_payroll_match');
const { bankLinesLeftOut, leaveOutPayRunCategory, payRunTotals } = require('../services/pay-run-books');

jest.setTimeout(60000);
const GATE = 'GATE_PAYROLL_BANK_MATCH';
const CATEGORY = 'Payroll (counted from pay runs)';

postgres('payroll bank match in the bank import', () => {
  let database;
  let trx;
  let runId;
  let checkA;
  let checkB;
  let filingId;
  const OLD_GATE = process.env[GATE];

  const insertCheck = async (patch) => {
    const w4 = randomUUID();
    const tech = randomUUID();
    await trx('technicians').insert({ id: tech, name: patch.name, employment_type: 'w2', employment_status: 'active' });
    await trx('payroll_w4_elections').insert({
      id: w4, technician_id: tech, form_year: 2026, filing_status: 'single', signed_on: '2026-01-02', effective_on: '2026-01-02',
    });
    const id = randomUUID();
    await trx('payroll_checks').insert({
      id, run_id: runId, technician_id: tech, employee_name: patch.name, week_start: '2026-10-12', pay_date: '2026-10-23',
      hourly_rate: '25.00', regular_minutes: '2400.00', overtime_minutes: '0.00',
      gross_cents: 100000, regular_pay_cents: 100000, overtime_pay_cents: 0, overtime_premium_cents: 0,
      federal_income_tax_cents: 9000, social_security_cents: 6200, medicare_cents: 1450, additional_medicare_cents: 0,
      net_cents: patch.net, employer_social_security_cents: 6200, employer_medicare_cents: 1450, futa_cents: 600,
      fl_reemployment_cents: 270, ytd_gross_before_cents: 0, w4_election_id: w4, calc_snapshot: JSON.stringify({}),
      pay_method: 'check', check_number: patch.checkNumber || null, status: 'finalized',
    });
    return id;
  };
  const line = async (description, amount, date, extra = {}) => {
    const id = randomUUID();
    await trx('bank_transactions').insert({
      id, account_label: 'sample-checking', account_type: 'bank', txn_date: date, description, amount, direction: 'debit',
      row_hash: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''), ...extra,
    });
    return id;
  };
  const row = (id) => trx('bank_transactions').where({ id }).first();

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = process.env.WAVES_DATABASE_ENVIRONMENT === 'test'
      && /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) && !privateQa) {
      throw new Error('Use an isolated local/CI database or labeled private QA database');
    }
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
  });
  beforeEach(async () => {
    trx = await database.transaction();
    mockConnection = trx;
    delete process.env[GATE];
    runId = randomUUID();
    await trx('payroll_runs').insert({ id: runId, week_start: '2026-10-12', pay_date: '2026-10-23', status: 'finalized' });
    checkA = await insertCheck({ name: 'Sample Alpha', net: 81263 });
    checkB = await insertCheck({ name: 'Sample Beta', net: 77010, checkNumber: '1043' });
    filingId = randomUUID();
    await trx('tax_filing_calendar').insert({
      id: filingId, filing_type: 'payroll_941_deposit', title: 'Federal payroll tax deposit - Oct 2026', period_label: 'Oct 2026',
      due_date: '2026-11-16', status: 'upcoming', amount_due: '350.00', source_key: 'payroll:941_deposit:2026-10',
    });
  });
  afterEach(async () => {
    await trx.rollback();
    if (OLD_GATE === undefined) delete process.env[GATE]; else process.env[GATE] = OLD_GATE;
  });
  afterAll(async () => { if (database) await database.destroy(); });

  const seedLines = async () => ({
    exact: await line('CHECK 1042', '812.63', '2026-10-28'),
    cent: await line('CHECK 1043', '770.11', '2026-10-29'),
    irs: await line('IRS USATAXPYMT 270012345', '350.00', '2026-11-13'),
    other: await line('SAMPLE HARDWARE STORE', '50.00', '2026-10-28'),
  });

  it('gate off: nothing links, no payroll key or column appears, no expense is created', async () => {
    const ids = await seedLines();
    const summary = await bankImport.runDeterministicMatching();
    expect(summary).not.toHaveProperty('payrollChecksLinked');
    for (const id of Object.values(ids)) {
      const r = await row(id);
      expect(r.status).toBe('unmatched');
      expect(r.matched_payroll_check_id).toBeNull();
      expect(r.matched_tax_filing_id).toBeNull();
      expect(JSON.stringify(r.suggestion || {})).not.toMatch(/payroll/i);
    }
    const cat = await trx('expense_categories').where({ name: CATEGORY }).first('id');
    expect(await trx('expenses').where({ category_id: cat.id }).count('* as n').first()).toMatchObject({ n: '0' });
  });

  describe('gate on', () => {
    beforeEach(() => { process.env[GATE] = 'true'; });

    it('links the exact net pay and the EFTPS deposit, suggests the one-cent line, and leaves the rest alone', async () => {
      const ids = await seedLines();
      const summary = await bankImport.runDeterministicMatching();
      expect(summary).toMatchObject({ payrollChecksLinked: 1, payrollTaxLinked: 1 });

      const exact = await row(ids.exact);
      expect(exact).toMatchObject({ status: 'created_expense', match_method: 'payroll_check', matched_payroll_check_id: checkA, matched_tax_filing_id: null });
      expect(exact.suggestion.payrollMatch).toMatchObject({ by: 'auto', checkId: checkA });

      const irs = await row(ids.irs);
      expect(irs).toMatchObject({ status: 'created_expense', match_method: 'payroll_tax', matched_tax_filing_id: filingId, matched_payroll_check_id: null });

      // the calendar row is never marked paid by the match
      expect(await trx('tax_filing_calendar').where({ id: filingId }).first('status', 'amount_paid', 'paid_date'))
        .toMatchObject({ status: 'upcoming', amount_paid: null, paid_date: null });

      const cent = await row(ids.cent);
      expect(cent.status).toBe('unmatched');
      expect(cent.matched_payroll_check_id).toBeNull();
      expect(cent.suggestion.payrollCandidates).toEqual([expect.objectContaining({ id: checkB, name: 'Sample Beta', nearMiss: true })]);

      const other = await row(ids.other);
      expect(other).toMatchObject({ status: 'unmatched', matched_payroll_check_id: null });
      expect(JSON.stringify(other.suggestion || {})).not.toMatch(/payroll/i);
    });

    it('books each matched line in the pay-run category, which the books leave out', async () => {
      const ids = await seedLines();
      await bankImport.runDeterministicMatching();
      const cat = await trx('expense_categories').where({ name: CATEGORY }).first('id');
      const expenses = await trx('expenses').where({ category_id: cat.id }).orderBy('amount');
      expect(expenses.map((e) => e.amount)).toEqual(['350.00', '812.63']);
      expect(expenses.every((e) => Number(e.tax_deductible_amount) === 0 && e.notes.includes('[Payroll bank match]'))).toBe(true);
      expect((await row(ids.exact)).matched_expense_id).toBe(expenses.find((e) => e.amount === '812.63').id);

      expect(await bankLinesLeftOut(trx, '2026-10-01', '2026-11-30')).toEqual({ count: 2, amount: 1162.63 });
      // an ordinary expense still counts; the matched payroll lines do not
      await trx('expenses').insert({ description: 'Sample hardware', amount: '50.00', expense_date: '2026-10-28', tax_year: '2026' });
      const counted = await leaveOutPayRunCategory(trx('expenses').whereBetween('expense_date', ['2026-10-01', '2026-11-30'])).sum({ total: 'amount' }).first();
      expect(Number(counted.total)).toBe(50);
      // wages and employer taxes come from the finalized checks, untouched by the bank lines
      expect((await payRunTotals(trx, '2026-10-01', '2026-10-31')).checks).toBe(2);
    });

    it('is idempotent: a second pass links nothing new', async () => {
      await seedLines();
      await bankImport.runDeterministicMatching();
      const again = await bankImport.runDeterministicMatching();
      expect(again).toMatchObject({ payrollChecksLinked: 0, payrollTaxLinked: 0 });
      const cat = await trx('expense_categories').where({ name: CATEGORY }).first('id');
      expect(await trx('expenses').where({ category_id: cat.id }).count('* as n').first()).toMatchObject({ n: '2' });
    });

    it('parks a tie as a suggestion naming both paychecks and links neither', async () => {
      // a finalized check cannot be edited, so the tie is a third check with the same net pay
      const twin = await insertCheck({ name: 'Sample Gamma', net: 81263 });
      const id = await line('ONLINE TRANSFER', '812.63', '2026-10-28');
      await bankImport.runDeterministicMatching();
      const r = await row(id);
      expect(r.status).toBe('unmatched');
      expect(r.suggestion.payrollCandidates.map((c) => c.id).sort()).toEqual([checkA, twin].sort());
    });

    it('does not auto-link a line the owner held for their own link', async () => {
      const id = await line('CHECK 1042', '812.63', '2026-10-28', { suggestion: JSON.stringify({ manualLink: true }) });
      await bankImport.runDeterministicMatching();
      const r = await row(id);
      expect(r.status).toBe('unmatched');
      expect(r.suggestion.payrollCandidates).toEqual([expect.objectContaining({ id: checkA })]);
    });

    it('lets the owner pick a suggested paycheck', async () => {
      const ids = await seedLines();
      await bankImport.runDeterministicMatching();
      const bad = await bankImport.claimPayrollLink({ row: await row(ids.other), check: { id: checkB }, by: 'owner' });
      expect(bad).toEqual({ ok: false, reason: 'implausible' });
      const ok = await bankImport.claimPayrollLink({ row: await row(ids.cent), check: { id: checkB }, by: 'owner' });
      expect(ok.ok).toBe(true);
      expect(await row(ids.cent)).toMatchObject({ status: 'created_expense', matched_payroll_check_id: checkB, match_method: 'payroll_check' });
      expect((await row(ids.cent)).suggestion.payrollMatch.by).toBe('owner');
      expect((await row(ids.cent)).suggestion.payrollCandidates).toBeUndefined();
      // the same check cannot be taken twice
      const second = await line('CHECK 1043 AGAIN', '770.10', '2026-10-30');
      expect(await bankImport.claimPayrollLink({ row: await row(second), check: { id: checkB }, by: 'owner' })).toEqual({ ok: false, reason: 'taken' });
    });

    it('releases a line when its pay run is voided, keeps the trail, and does not re-link it', async () => {
      const ids = await seedLines();
      await bankImport.runDeterministicMatching();
      await trx('payroll_checks').where({ run_id: runId }).update({ status: 'voided' });
      await trx('payroll_runs').where({ id: runId }).update({ status: 'voided', voided_at: trx.fn.now(), void_reason: 'redo the week' });
      expect(await bankImport.releaseVoidedPayrollLinks()).toBe(1);
      const r = await row(ids.exact);
      expect(r).toMatchObject({ status: 'unmatched', matched_payroll_check_id: null, matched_expense_id: null, match_method: null });
      expect(r.suggestion.payrollUnlinked).toMatchObject({ checkId: checkA, reason: 'the pay run was voided' });
      expect(r.suggestion.rejectedPayrollCheckIds).toEqual([checkA]);
      expect(r.suggestion.payrollMatch).toBeUndefined();
      const cat = await trx('expense_categories').where({ name: CATEGORY }).first('id');
      expect(await trx('expenses').where({ category_id: cat.id }).count('* as n').first()).toMatchObject({ n: '1' });
      await bankImport.runDeterministicMatching();
      expect((await row(ids.exact)).status).toBe('unmatched');
    });

    it('shows each final check its bank status: matched with a date, needs your pick, or not seen yet', async () => {
      const ids = await seedLines();
      await bankImport.runDeterministicMatching();
      const byName = Object.fromEntries((await payrollRuns.getRun(runId)).checks.map((c) => [c.name, c.bank]));
      expect(byName['Sample Alpha']).toEqual({ state: 'matched', date: '2026-10-28' });
      expect(byName['Sample Beta']).toEqual({ state: 'needs_pick' });
      await trx('bank_transactions').where({ id: ids.cent }).update({ suggestion: null });
      expect((await payrollRuns.getRun(runId)).checks.find((c) => c.name === 'Sample Beta').bank).toEqual({ state: 'not_seen' });
      delete process.env[GATE];
      expect((await payrollRuns.getRun(runId)).checks.every((c) => !('bank' in c))).toBe(true);
    });

    it('voiding the pay run through the service releases its bank lines', async () => {
      const ids = await seedLines();
      await bankImport.runDeterministicMatching();
      const run = await payrollRuns.voidRun(runId, { reason: 'redo the week' }, null);
      expect(run.status).toBe('voided');
      expect(await row(ids.exact)).toMatchObject({ status: 'unmatched', matched_payroll_check_id: null });
      expect((await row(ids.irs)).status).toBe('created_expense');
    });

    it('keeps an undo: deleting the created expense frees the line and the matcher does not re-book it', async () => {
      const ids = await seedLines();
      await bankImport.runDeterministicMatching();
      const { matched_expense_id: expenseId } = await row(ids.exact);
      await trx('expenses').where({ id: expenseId }).del();
      const again = await bankImport.runDeterministicMatching();
      expect(again.payrollChecksLinked).toBe(0);
      const r = await row(ids.exact);
      expect(r).toMatchObject({ status: 'unmatched', matched_payroll_check_id: null });
      expect(r.suggestion.rejectedPayrollCheckIds).toEqual([checkA]);
    });
  });

  describe('the migration', () => {
    it('is idempotent, and down refuses while a bank line is linked', async () => {
      await migration.up(trx);
      process.env[GATE] = 'true';
      await seedLines();
      await bankImport.runDeterministicMatching();
      await expect(migration.down(trx)).rejects.toThrow(/cannot roll back/);
      await trx('bank_transactions').update({ status: 'unmatched', matched_payroll_check_id: null, matched_tax_filing_id: null });
      await migration.down(trx);
      expect(await trx.schema.hasColumn('bank_transactions', 'matched_payroll_check_id')).toBe(false);
      await migration.up(trx);
      expect(await trx.schema.hasColumn('bank_transactions', 'matched_tax_filing_id')).toBe(true);
    });

    it('holds one bank line per paycheck and at most one link per line', async () => {
      const a = await line('CHECK 1042', '812.63', '2026-10-28');
      const b = await line('CHECK 1042 B', '812.63', '2026-10-29');
      await trx.raw('SAVEPOINT s1');
      await trx('bank_transactions').where({ id: a }).update({ matched_payroll_check_id: checkA });
      await expect(trx('bank_transactions').where({ id: b }).update({ matched_payroll_check_id: checkA })).rejects.toMatchObject({ code: '23505' });
      await trx.raw('ROLLBACK TO SAVEPOINT s1');
      await trx.raw('SAVEPOINT s2');
      await expect(trx('bank_transactions').where({ id: a }).update({ matched_payroll_check_id: checkA, matched_tax_filing_id: filingId })).rejects.toMatchObject({ code: '23514' });
      await trx.raw('ROLLBACK TO SAVEPOINT s2');
    });
  });
});
