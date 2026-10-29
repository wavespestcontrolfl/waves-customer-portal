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

    it('an EFTPS debit equal to a paycheck net links the tax row, not the paycheck', async () => {
      await trx('tax_filing_calendar').where({ id: filingId }).update({ amount_due: '812.63' });
      const irs = await line('IRS USATAXPYMT 270012345', '812.63', '2026-11-13');
      const summary = await bankImport.runDeterministicMatching();
      expect(summary).toMatchObject({ payrollChecksLinked: 0, payrollTaxLinked: 1 });
      expect(await row(irs)).toMatchObject({ status: 'created_expense', match_method: 'payroll_tax', matched_tax_filing_id: filingId, matched_payroll_check_id: null });
      expect(await trx('payroll_checks as pc').leftJoin('bank_transactions as bt', 'bt.matched_payroll_check_id', 'pc.id').whereNotNull('bt.id').count('* as n').first()).toMatchObject({ n: '0' });
    });

    it('a paycheck one cent off does not suppress an exact EFTPS tax match', async () => {
      const irs = await line('EFTPS PAYMENT', '350.00', '2026-11-13');
      await insertCheck({ name: 'Sample Delta', net: 35001 });
      await bankImport.runDeterministicMatching();
      const r = await row(irs);
      expect(r).toMatchObject({ status: 'created_expense', match_method: 'payroll_tax', matched_tax_filing_id: filingId });
      expect(JSON.stringify(r.suggestion)).not.toMatch(/Delta/);
    });

    it('two bank lines printing the same check number are suggested, never linked', async () => {
      await trx('payroll_checks').where({ id: checkA }).update({ check_number: '1042' });
      const one = await line('CHECK 1042', '812.63', '2026-10-28');
      const two = await line('CHECK 1042', '812.63', '2026-10-29');
      await bankImport.runDeterministicMatching();
      for (const id of [one, two]) {
        const r = await row(id);
        expect(r.status).toBe('unmatched');
        expect(r.suggestion.payrollCandidates).toEqual([expect.objectContaining({ id: checkA })]);
      }
    });

    it('CHECK 1099 REF 1042 is not evidence for check 1042', async () => {
      await trx('payroll_checks').where({ id: checkA }).update({ check_number: '1042' });
      const id = await line('CHECK 1099 REF 1042', '812.63', '2026-10-28');
      await bankImport.runDeterministicMatching();
      expect((await row(id)).status).toBe('unmatched');
    });

    describe('an expense the owner already entered', () => {
      const manual = async (patch = {}) => {
        const id = randomUUID();
        await trx('expenses').insert({
          id, description: 'Sample Alpha paycheck', vendor_name: 'CHECK 1042 sample', amount: '812.63',
          expense_date: '2026-10-28', tax_year: '2026', ...patch,
        });
        return id;
      };
      const payrollCategory = async () => (await trx('expense_categories').where({ name: CATEGORY }).first('id')).id;

      it('parks the line beside the payroll candidate and the expense; creates and links nothing', async () => {
        const expenseId = await manual();
        const id = await line('CHECK 1042', '812.63', '2026-10-28');
        const summary = await bankImport.runDeterministicMatching();
        expect(summary.payrollChecksLinked).toBe(0);
        const r = await row(id);
        expect(r.status).toBe('unmatched');
        expect(r.matched_payroll_check_id).toBeNull();
        expect(r.matched_expense_id).toBeNull();
        expect(r.suggestion.payrollCandidates).toEqual([expect.objectContaining({
          id: checkA, existingExpenses: [expect.objectContaining({ id: expenseId, amount: 812.63 })],
        })]);
        // the ordinary matcher lists the expense but, held, does not link it (vendor evidence would have)
        expect(r.suggestion.candidates.map((c) => c.id)).toEqual([expenseId]);
        const cat = await payrollCategory();
        expect(await trx('expenses').where({ category_id: cat }).count('* as n').first()).toMatchObject({ n: '0' });
        expect(await trx('expenses').count('* as n').first()).toMatchObject({ n: '1' });
      });

      it('the owner may link the paycheck to that expense: same id, moved into the payroll category, restored on void', async () => {
        const expenseId = await manual({ tax_deductible_amount: '812.63' });
        const id = await line('CHECK 1042', '812.63', '2026-10-28');
        await bankImport.runDeterministicMatching();
        const refused = await bankImport.claimPayrollLink({ row: await row(id), check: { id: checkA }, by: 'owner' });
        expect(refused).toMatchObject({ ok: false, reason: 'existing_expense' });
        const ok = await bankImport.claimPayrollLink({ row: await row(id), check: { id: checkA }, by: 'owner', expenseId });
        expect(ok).toMatchObject({ ok: true, reused: true });
        const e = await trx('expenses').where({ id: expenseId }).first();
        expect(e).toMatchObject({ category_id: await payrollCategory(), tax_deductible_amount: '0.00' });
        expect(await row(id)).toMatchObject({ status: 'matched_expense', matched_expense_id: expenseId, matched_payroll_check_id: checkA });
        expect(await trx('expenses').count('* as n').first()).toMatchObject({ n: '1' });

        await trx('payroll_checks').where({ run_id: runId }).update({ status: 'voided' });
        await trx('payroll_runs').where({ id: runId }).update({ status: 'voided', voided_at: trx.fn.now(), void_reason: 'redo' });
        expect(await bankImport.releaseVoidedPayrollLinks()).toBe(1);
        // the owner's own expense survives, back in its first category
        expect(await trx('expenses').where({ id: expenseId }).first()).toMatchObject({ category_id: null, tax_deductible_amount: '812.63' });
        expect(await row(id)).toMatchObject({ status: 'unmatched', matched_expense_id: null });
      });

      it('finds an expense entered on payday when the check clears two weeks later, and the owner may reuse it', async () => {
        const expenseId = await manual({ expense_date: '2026-10-23' });
        const id = await line('CHECK 1042', '812.63', '2026-11-09');
        await bankImport.runDeterministicMatching();
        const r = await row(id);
        expect(r.status).toBe('unmatched');
        expect(r.suggestion.payrollCandidates[0].existingExpenses).toEqual([expect.objectContaining({ id: expenseId })]);
        const ok = await bankImport.claimPayrollLink({ row: r, check: { id: checkA }, by: 'owner', expenseId });
        expect(ok).toMatchObject({ ok: true, reused: true });
        expect(await trx('expenses').count('* as n').first()).toMatchObject({ n: '1' });
        // a Bank Import refresh (the edit heal) and a later matching pass keep the late-clearing link
        expect(await bankImport.healEditedExpenseLinks()).toBe(0);
        await bankImport.runDeterministicMatching();
        expect(await row(id)).toMatchObject({ status: 'matched_expense', matched_expense_id: expenseId, matched_payroll_check_id: checkA });
        expect((await trx('expenses').where({ id: expenseId }).first()).category_id).toBe(await payrollCategory());
      });

      it('the owner\'s Unlink gives the reused expense its category and deduction back and keeps the evidence', async () => {
        const expenseId = await manual({ tax_deductible_amount: '812.63' });
        const id = await line('CHECK 1042', '812.63', '2026-10-28');
        await bankImport.runDeterministicMatching();
        await bankImport.claimPayrollLink({ row: await row(id), check: { id: checkA }, by: 'owner', expenseId });
        expect(await bankImport.unlinkPayrollMatched(await row(id))).toBe(true);
        expect(await trx('expenses').where({ id: expenseId }).first()).toMatchObject({ category_id: null, tax_deductible_amount: '812.63' });
        const r = await row(id);
        expect(r).toMatchObject({ status: 'unmatched', matched_expense_id: null, matched_payroll_check_id: null });
        expect(r.suggestion.payrollMatch).toBeUndefined();
        expect(r.suggestion.payrollUnlinked).toMatchObject({ reason: 'owner_unlinked', checkId: checkA });
        expect(r.suggestion.payrollUnlinked.was).toMatchObject({ reusedExpense: true, prevDeductible: '812.63' });
        expect(r.suggestion.rejectedExpenseIds).toEqual([expenseId]);
      });

      it('another path that unlinks a reused expense (an edit heal) still restores it', async () => {
        const expenseId = await manual({ tax_deductible_amount: '812.63' });
        const id = await line('CHECK 1042', '812.63', '2026-10-28');
        await bankImport.runDeterministicMatching();
        await bankImport.claimPayrollLink({ row: await row(id), check: { id: checkA }, by: 'owner', expenseId });
        // the edit heal clears the expense link and leaves the payroll links behind
        await trx('bank_transactions').where({ id }).update({ status: 'unmatched', matched_expense_id: null, match_method: null });
        await bankImport.runDeterministicMatching();
        expect(await trx('expenses').where({ id: expenseId }).first()).toMatchObject({ category_id: null, tax_deductible_amount: '812.63' });
        expect((await row(id)).suggestion.rejectedPayrollCheckIds).toEqual([checkA]);
      });

      it('an edit heal that releases a reused expense clears the payroll links in the same pass, before another claim', async () => {
        const expenseId = await manual({ tax_deductible_amount: '812.63' });
        const id = await line('CHECK 1042', '812.63', '2026-10-28');
        await bankImport.runDeterministicMatching();
        await bankImport.claimPayrollLink({ row: await row(id), check: { id: checkA }, by: 'owner', expenseId });
        // the owner edits the expense out of the line's window: the edit heal releases the link
        await trx('expenses').where({ id: expenseId }).update({ expense_date: '2026-09-01' });
        expect(await bankImport.healEditedExpenseLinks()).toBe(1);
        const r = await row(id);
        expect(r).toMatchObject({ status: 'unmatched', matched_expense_id: null, matched_payroll_check_id: null });
        expect(r.suggestion.payrollMatch).toBeUndefined();
        expect(r.suggestion.rejectedPayrollCheckIds).toEqual([checkA]);
        expect(await trx('expenses').where({ id: expenseId }).first()).toMatchObject({ category_id: null, tax_deductible_amount: '812.63' });
      });

      it('a line whose filing row was deleted and whose reused expense was generically unlinked is still cleaned', async () => {
        const expenseId = await manual({ tax_deductible_amount: '350.00', amount: '350.00', vendor_name: 'IRS sample' });
        const id = await line('IRS USATAXPYMT 270012345', '350.00', '2026-11-13');
        await bankImport.runDeterministicMatching();
        await bankImport.claimPayrollLink({ row: await row(id), filing: { id: filingId }, by: 'owner', expenseId });
        await trx('tax_filing_calendar').where({ id: filingId }).del();
        // generic unlink path: status back, expense link cleared, payrollMatch left behind, both FKs already null
        await trx('bank_transactions').where({ id }).update({ status: 'unmatched', matched_expense_id: null, match_method: null });
        await bankImport.runDeterministicMatching();
        expect((await row(id)).suggestion.payrollMatch).toBeUndefined();
        expect(await trx('expenses').where({ id: expenseId }).first()).toMatchObject({ category_id: null, tax_deductible_amount: '350.00' });
      });

      it('names the existing expense beside a suggested paycheck too (a tie, a one-cent miss)', async () => {
        const expenseId = await manual({ vendor_name: 'Sample Beta pay', amount: '770.11' });
        const near = await line('ONLINE TRANSFER', '770.11', '2026-10-29');
        await bankImport.runDeterministicMatching();
        const r = await row(near);
        expect(r.status).toBe('unmatched');
        expect(r.suggestion.payrollCandidates).toEqual([expect.objectContaining({
          id: checkB, nearMiss: true, existingExpenses: [expect.objectContaining({ id: expenseId })],
        })]);
        // and the owner can act on it: link the paycheck to that expense
        const ok = await bankImport.claimPayrollLink({ row: await row(near), check: { id: checkB }, by: 'owner', expenseId });
        expect(ok).toMatchObject({ ok: true, reused: true });
      });

      it('restores the deduction in proportion to the expense\'s amount now, and keeps a deduction the owner typed since', async () => {
        const expenseId = await manual({ amount: '812.63', tax_deductible_amount: '406.32' });
        const id = await line('CHECK 1042', '812.63', '2026-10-28');
        await bankImport.runDeterministicMatching();
        await bankImport.claimPayrollLink({ row: await row(id), check: { id: checkA }, by: 'owner', expenseId });
        // a refund later cut the expense to half
        await trx('expenses').where({ id: expenseId }).update({ amount: '406.32' });
        expect(await bankImport.unlinkPayrollMatched(await row(id))).toBe(true);
        expect(await trx('expenses').where({ id: expenseId }).first()).toMatchObject({ category_id: null, tax_deductible_amount: '203.16' });

        const typed = await manual({ amount: '812.63', tax_deductible_amount: '100.00', vendor_name: 'Typed sample' });
        const second = await line('CHECK 1042 B', '812.63', '2026-10-29');
        await bankImport.claimPayrollLink({ row: await row(second), check: { id: checkA }, by: 'owner', expenseId: typed, createNew: false });
        await trx('expenses').where({ id: typed }).update({ tax_deductible_amount: '50.00' });
        await bankImport.unlinkPayrollMatched(await row(second));
        expect(await trx('expenses').where({ id: typed }).first()).toMatchObject({ tax_deductible_amount: '50.00' });
      });

      it('the owner may book as new beside it', async () => {
        await manual();
        const id = await line('CHECK 1042', '812.63', '2026-10-28');
        const ok = await bankImport.claimPayrollLink({ row: await row(id), check: { id: checkA }, by: 'owner', createNew: true });
        expect(ok).toMatchObject({ ok: true, reused: false });
        expect(await trx('expenses').count('* as n').first()).toMatchObject({ n: '2' });
      });
    });

    describe('a linked tax payment whose calendar row changes', () => {
      const linkedTax = async () => {
        const id = await line('IRS USATAXPYMT 270012345', '350.00', '2026-11-13');
        await bankImport.runDeterministicMatching();
        const r = await row(id);
        expect(r).toMatchObject({ status: 'created_expense', matched_tax_filing_id: filingId });
        return { id, expenseId: r.matched_expense_id };
      };

      it('goes back to review when the row amount changes: expense removed, evidence kept, seen-in-bank gone', async () => {
        const { id, expenseId } = await linkedTax();
        expect((await row(id)).suggestion.payrollMatch.amountCents).toBe(35000);
        await trx('tax_filing_calendar').where({ id: filingId }).update({ amount_due: '700.00' });
        await bankImport.runDeterministicMatching();
        const r = await row(id);
        expect(r).toMatchObject({ status: 'unmatched', matched_tax_filing_id: null, matched_expense_id: null, match_method: null });
        expect(r.suggestion.payrollMatch).toBeUndefined();
        expect(r.suggestion.payrollUnlinked).toMatchObject({ reason: 'calendar_changed', filingId, bankCents: 35000, calendarCents: 70000, matchedCents: 35000 });
        expect(r.suggestion.payrollUnlinked.was).toMatchObject({ expenseId, filingId });
        // an automatic release is not a rejection
        expect(r.suggestion.rejectedTaxFilingIds).toBeUndefined();
        expect(await trx('expenses').where({ id: expenseId }).first()).toBeUndefined();
        expect(await trx('bank_transactions').where({ matched_tax_filing_id: filingId }).count('* as n').first()).toMatchObject({ n: '0' });
        // it does not re-link to the row that no longer says its amount ...
        await bankImport.runDeterministicMatching();
        expect((await row(id)).status).toBe('unmatched');
        // ... and matches again when a correction brings the amount back
        await trx('tax_filing_calendar').where({ id: filingId }).update({ amount_due: '350.00' });
        await bankImport.runDeterministicMatching();
        expect(await row(id)).toMatchObject({ status: 'created_expense', matched_tax_filing_id: filingId });
      });

      it('goes back to review when the row is deleted, with the evidence', async () => {
        const { id, expenseId } = await linkedTax();
        await trx('tax_filing_calendar').where({ id: filingId }).del();
        await bankImport.runDeterministicMatching();
        const r = await row(id);
        expect(r).toMatchObject({ status: 'unmatched', matched_tax_filing_id: null, matched_expense_id: null });
        expect(r.suggestion.payrollUnlinked).toMatchObject({ reason: 'calendar_deleted', filingId, bankCents: 35000, calendarCents: null });
        expect(r.suggestion.rejectedTaxFilingIds).toBeUndefined();
        expect(await trx('expenses').where({ id: expenseId }).first()).toBeUndefined();
      });

      it('keeps an owner-approved one-cent link while the calendar row is unchanged, and releases it when the row changes', async () => {
        const id = await line('IRS USATAXPYMT 270012345', '350.01', '2026-11-13');
        await bankImport.runDeterministicMatching();
        expect((await row(id)).suggestion.payrollCandidates).toEqual([expect.objectContaining({ id: filingId, nearMiss: true })]);
        const ok = await bankImport.claimPayrollLink({ row: await row(id), filing: { id: filingId }, by: 'owner' });
        expect(ok.ok).toBe(true);
        expect((await row(id)).suggestion.payrollMatch.amountCents).toBe(35000);
        await bankImport.runDeterministicMatching();
        expect(await row(id)).toMatchObject({ status: 'created_expense', matched_tax_filing_id: filingId });
        await trx('tax_filing_calendar').where({ id: filingId }).update({ amount_due: '700.00' });
        await bankImport.runDeterministicMatching();
        expect((await row(id)).suggestion.payrollUnlinked).toMatchObject({ reason: 'calendar_changed', matchedCents: 35000, calendarCents: 70000, bankCents: 35001 });
      });

      it('keeps a link whose row still says the same amount (amount_paid wins over amount_due)', async () => {
        const { id } = await linkedTax();
        await trx('tax_filing_calendar').where({ id: filingId }).update({ amount_due: '999.00', amount_paid: '350.00', status: 'paid' });
        await bankImport.runDeterministicMatching();
        expect(await row(id)).toMatchObject({ status: 'created_expense', matched_tax_filing_id: filingId });
      });
    });

    it('an exact tax amount inside the pay period still open is a suggestion, not a link', async () => {
      const id = await line('IRS USATAXPYMT 270012345', '350.00', '2026-10-20');
      await bankImport.runDeterministicMatching();
      const r = await row(id);
      expect(r.status).toBe('unmatched');
      expect(r.suggestion.payrollCandidates).toEqual([expect.objectContaining({ kind: 'tax', id: filingId })]);
    });

    it('a payroll suggestion keeps the line out of the ledger inbox, and a stale one is cleared when the gate is off', async () => {
      const taxLedgerRules = require('../services/tax-ledger-rules');
      const near = await line('ONLINE TRANSFER', '770.11', '2026-10-29');
      await bankImport.runDeterministicMatching();
      expect(taxLedgerRules.hasLiveCandidates(await row(near))).toBe(true);
      expect(taxLedgerRules.inboxBlock(await row(near))).toMatch(/Bank Import/);
      delete process.env[GATE];
      await bankImport.runDeterministicMatching();
      expect((await row(near)).suggestion.payrollCandidates).toBeUndefined();
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
