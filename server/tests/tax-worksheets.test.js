/**
 * services/tax-worksheets (GATE_TAX_WORKSHEETS): the Florida DR-15 lines and
 * the 1099-NEC list.
 *
 * Locked-down behaviors:
 *  1. Periods and due dates: month, quarter, half year and year windows; the
 *     DR-15 is due on the 20th of the next month and a weekend moves it to
 *     Monday; a 1099-NEC is due Jan 31 (next weekday); the 1099 threshold is
 *     $600 through 2025 and $2,000 from 2026.
 *  2. DR-15 lines: exempt = gross - taxable; the collection allowance is 2.5%
 *     of the first $1,200 of tax ($30 at most) and only on time; a late
 *     return owes 10% of the tax, at least $50 even with no tax.
 *  3. 1099 list: contract labor and legal payments grouped by payee from the
 *     bank text; card, debit card and platform payments are left out.
 *  4. The sheet reads the P&L revenue and the P&L's own tax legs, maps the
 *     filing calendar row, warns for a period in progress and refuses a
 *     future period.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

function chain(result) {
  const b = new Proxy(function chainable() {}, {
    get(_t, prop) {
      if (prop === 'then') return (res, rej) => Promise.resolve(result('then')).then(res, rej);
      if (prop === 'first') return () => Promise.resolve(result('first'));
      return () => b;
    },
    apply() { return b; },
  });
  return b;
}
const tables = {};
const mockDb = jest.fn((table) => chain((kind) => (tables[table] ? tables[table](kind) : (kind === 'first' ? undefined : []))));
mockDb.raw = jest.fn((sql) => sql);
jest.mock('../models/db', () => mockDb);
jest.mock('../services/pnl-report', () => ({
  buildPnlReport: jest.fn(),
  salesTaxLegsForWindow: jest.fn(),
  dateCellStr: jest.requireActual('../services/pnl-report').dateCellStr,
}));
jest.mock('../utils/datetime-et', () => ({
  ...jest.requireActual('../utils/datetime-et'),
  etDateString: jest.fn(() => '2026-10-25'),
}));

const pnl = require('../services/pnl-report');
const ws = require('../services/tax-worksheets');

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  pnl.buildPnlReport.mockReset();
  pnl.salesTaxLegsForWindow.mockReset();
});

describe('periods and due dates', () => {
  test.each([
    ['month', 10, { label: 'Oct 2026', start: '2026-10-01', end: '2026-10-31' }],
    ['quarter', 4, { label: 'Q4 2026', start: '2026-10-01', end: '2026-12-31' }],
    ['half', 1, { label: 'H1 2026', start: '2026-01-01', end: '2026-06-30' }],
    ['year', undefined, { label: '2026', start: '2026-01-01', end: '2026-12-31', index: null }],
  ])('%s %s', (kind, index, expected) => {
    expect(ws.periodFor(kind, 2026, index)).toMatchObject({ kind, year: 2026, ...expected });
  });

  test('February in a leap year ends on the 29th', () => {
    expect(ws.periodFor('month', 2024, 2).end).toBe('2024-02-29');
  });

  test('a bad kind or index is a 400', () => {
    expect(() => ws.periodFor('week', 2026, 1)).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => ws.periodFor('quarter', 2026, 5)).toThrow(expect.objectContaining({ status: 400, message: expect.stringContaining('1 to 4') }));
    expect(() => ws.periodFor('month', 2099, 1)).toThrow(expect.objectContaining({ status: 400 }));
  });

  test.each([
    ['2026-09-30', '2026-10-20'], // Tuesday
    ['2026-08-31', '2026-09-21'], // the 20th is a Sunday
    ['2026-05-31', '2026-06-22'], // the 20th is a Saturday
    ['2026-12-31', '2027-01-20'], // into the next year
    ['2024-12-31', '2025-01-21'], // Jan 20, 2025 is Martin Luther King Jr. Day
    ['2023-01-31', '2023-02-21'], // Feb 20, 2023 is Washington's Birthday
    ['2022-05-31', '2022-06-21'], // Juneteenth (a Sunday) observed Monday June 20
  ])('DR-15 for a period ending %s is due %s', (end, due) => {
    expect(ws.dr15DueDate(end)).toBe(due);
  });

  test('1099-NEC threshold and due date by year', () => {
    expect([ws.necThreshold(2024), ws.necThreshold(2025), ws.necThreshold(2026)]).toEqual([600, 600, 2000]);
    expect([ws.necDueDate(2024), ws.necDueDate(2025), ws.necDueDate(2026)]).toEqual(['2025-01-31', '2026-02-02', '2027-02-01']);
  });
});

describe('DR-15 lines', () => {
  const NONE = { tax: 0, taxable: 0, surtax: 0 };
  const legs = (tax, taxable, surtax) => ({ tax, taxable, surtax });
  const base = { revenue: 8929.31, collected: legs(13.37, 191, 1.91), reversed: NONE, dueDate: '2026-11-20' };

  test('on time: allowance 2.5% of the tax, no penalty', () => {
    const r = ws.dr15Lines({ ...base, today: '2026-11-02' });
    expect(r.late).toBe(false);
    expect(r.lines).toEqual({
      gross_sales: 8929.31, exempt_sales: 8738.31, taxable_amount: 191, tax_collected: 13.37, lawful_deductions: 0,
      tax_due: 13.37, surtax_collected: 1.91, collection_allowance: 0.33, penalty: 0, amount_due: 13.04,
    });
    expect(r.allowance_note).toContain('2026-11-20');
  });

  test('late: no allowance, penalty 10% of the tax but at least $50, even with almost no tax', () => {
    const r = ws.dr15Lines({ revenue: 2131.1, collected: legs(0.36, 5.1, 0.05), reversed: NONE, dueDate: '2026-05-20', today: '2026-10-25' });
    expect(r.late).toBe(true);
    expect(r.lines).toMatchObject({ collection_allowance: 0, penalty: 50, amount_due: 50.36 });
    expect(r.penalty_note).toContain('at least $50');
    const big = ws.dr15Lines({ revenue: 20000, collected: legs(700, 10000, 100), reversed: NONE, dueDate: '2026-05-20', today: '2026-10-25' });
    expect(big.lines.penalty).toBe(70);
    const bigger = ws.dr15Lines({ revenue: 20000, collected: legs(1000, 10000, 100), reversed: NONE, dueDate: '2026-05-20', today: '2026-10-25' });
    expect(bigger.lines.penalty).toBe(100);
  });

  test('the allowance stops at $30 (2.5% of the first $1,200)', () => {
    const r = ws.dr15Lines({ revenue: 40000, collected: legs(2100, 30000, 300), reversed: NONE, dueDate: '2026-11-20', today: '2026-11-02' });
    expect(r.lines.collection_allowance).toBe(30);
    expect(r.lines.amount_due).toBe(2070);
  });

  test('refunded tax is line 6; refunds beyond the tax collected are an excess for the next return, never a negative amount due', () => {
    const r = ws.dr15Lines({ revenue: 5000, collected: legs(30, 428.57, 4.29), reversed: legs(100, 1428.57, 14.29), dueDate: '2026-12-21', today: '2026-12-01' });
    // line 6 stops at the tax collected; the rest is the excess
    expect(r.lines).toMatchObject({ gross_sales: 6428.57, taxable_amount: 428.57, tax_collected: 30, lawful_deductions: 30, tax_due: 0, collection_allowance: 0, amount_due: 0 });
    expect(r.excess_deduction).toBe(70);
    const part = ws.dr15Lines({ revenue: 5000, collected: legs(100, 1428.57, 14.29), reversed: legs(13.37, 191, 1.91), dueDate: '2026-12-21', today: '2026-12-01' });
    expect(part.lines).toMatchObject({ lawful_deductions: 13.37, tax_due: 86.63, collection_allowance: 2.17, amount_due: 84.46 });
    expect(part.excess_deduction).toBe(0);
  });

  test('a return filed and paid on time stays on time after the due date passes', () => {
    const r = ws.dr15Lines({ ...base, today: '2026-12-15', filedOn: '2026-11-18', paidOn: '2026-11-18' });
    expect(r.late).toBe(false);
    expect(r.lines.penalty).toBe(0);
  });

  test('filed on time but paid late, or still unpaid after the due date, is late', () => {
    expect(ws.dr15Lines({ ...base, today: '2026-12-15', filedOn: '2026-11-18', paidOn: '2026-11-25' }).late).toBe(true);
    expect(ws.dr15Lines({ ...base, today: '2026-12-15', filedOn: '2026-11-18' }).lines).toMatchObject({ collection_allowance: 0, penalty: 50 });
  });

  test('a zero-tax return filed on time needs no payment', () => {
    expect(ws.dr15Lines({ ...base, collected: NONE, today: '2026-12-15', filedOn: '2026-11-18' }).late).toBe(false);
  });

  test('exempt sales never go below zero', () => {
    expect(ws.dr15Lines({ ...base, revenue: 100, today: '2026-11-02' }).lines.exempt_sales).toBe(0);
  });
});

describe('payment channel and payee', () => {
  test.each([
    ['card', 'anything', 'card'],
    ['cash', '', 'cash'],
    ['check', '', 'check'],
    ['ach', 'Zelle money sent to Pat Example', 'zelle'],
    ['ach', 'Debit Card Purchase - FIVERR NEW YORK NY', 'platform'],
    ['ach', 'Debit Card Purchase - HARDWARE STORE BRADENTON FL', 'debit_card'],
    ['ach', 'Debit Card Purchase - Cash App*Pat Example', 'debit_card'],
    ['ach', 'Withdrawal from WISE US INC WISE', 'wise'],
    ['ach', 'VENMO PAYMENT 1234567', 'venmo'],
    ['ach', 'Cash App*Lee Sample', 'cash_app'],
    ['ach', 'Check 1042', 'check'],
    ['ach', 'Online Transfer to savings', 'bank_transfer'],
    ['ach', 'Something else', 'unknown'],
    [null, 'Zelle money sent to Pat Example', 'zelle'],
  ])('%s + "%s" -> %s', (method, text, expected) => {
    expect(ws.paymentChannel(method, text)).toBe(expected);
  });

  test.each([
    ['Zelle money sent to Pat Example Conf# AB12CD', 'Pat Example', true],
    ['Zelle money sent to Lee Sample-Smith', 'Lee Sample-Smith', true],
    ['PAYPAL *LEESAMPLE', 'LEESAMPLE', true],
    ['Pat Example', 'Pat Example', true],
    ['Withdrawal from WISE US INC WISE', 'Withdrawal from WISE US INC WISE (payee not in the bank text)', false],
    ['Check 1042', 'Check 1042 (payee not in the bank text)', false],
    ['VENMO PAYMENT', 'VENMO PAYMENT (payee not in the bank text)', false],
    ['Venmo', 'Venmo (payee not in the bank text)', false],
    ['Online Transfer', 'Online Transfer (payee not in the bank text)', false],
    ['', 'Unknown payee', false],
  ])('"%s" -> %s', (text, name, identified) => {
    expect(ws.payeeOf(text)).toEqual({ name, identified });
  });
});

describe('1099 list', () => {
  const row = (over) => ({ expense_id: 'e1', date: '2026-03-04', amount: 100, payment_method: 'ach', vendor_name: '', description: '', bank_text: '', line: '11', category: 'Contract Labor', ...over });

  test('groups by payee across spellings, marks who needs a form, leaves card and platform payments out', () => {
    const rows = [
      row({ expense_id: 'a', amount: 1200, vendor_name: 'Zelle money sent to Pat Example', bank_text: 'Zelle money sent to Pat Example' }),
      row({ expense_id: 'b', amount: 900, vendor_name: 'Zelle money sent to PAT EXAMPLE', bank_text: 'Zelle money sent to PAT EXAMPLE' }),
      row({ expense_id: 'c', amount: 900, vendor_name: 'Zelle money sent to Lee Sample', bank_text: 'Zelle money sent to Lee Sample', line: '17', category: 'Legal & Professional' }),
      row({ expense_id: 'd', amount: 50, payment_method: 'card', vendor_name: 'FIVERR' }),
      row({ expense_id: 'e', amount: 75, vendor_name: 'Debit Card Purchase - UPWORK', bank_text: 'Debit Card Purchase - UPWORK' }),
      row({ expense_id: 'f', amount: 300, vendor_name: 'Odd text' }),
    ];
    const r = ws.build1099List(2026, rows);
    expect(r).toMatchObject({ year: 2026, threshold: 2000, due_date: '2027-02-01' });
    expect(r.payees.map((p) => [p.name, p.total, p.count, p.needs_1099])).toEqual([
      ['Pat Example', 2100, 2, true],
      ['Lee Sample', 900, 1, false],
      ['Odd text', 300, 1, false],
    ]);
    expect(r.payees[0].channels).toEqual(['zelle']);
    expect(r.payees[1].lines).toEqual(['17']);
    expect(r.payees[2].unclear_method).toBe(true);
    expect(r.left_out).toEqual({ count: 2, total: 125, by_channel: { card: { count: 1, total: 50 }, platform: { count: 1, total: 75 } } });
  });

  test('payments that name no person are never added together', () => {
    const r = ws.build1099List(2026, [
      row({ expense_id: 'k1', amount: 1100, payment_method: 'check', vendor_name: 'Check 1042', bank_text: 'Check 1042' }),
      row({ expense_id: 'k2', amount: 1100, payment_method: 'check', vendor_name: 'Check 1043', bank_text: 'Check 1043' }),
      row({ expense_id: 'k3', amount: 1100, payment_method: 'check', vendor_name: 'Check 1043', bank_text: 'Check 1043' }),
    ]);
    expect(r.payees.map((p) => [p.key, p.total, p.unresolved, p.needs_1099])).toEqual([
      ['unresolved:k1', 1100, true, false],
      ['unresolved:k2', 1100, true, false],
      ['unresolved:k3', 1100, true, false],
    ]);
  });

  test('2025 payments use the $600 threshold', () => {
    const r = ws.build1099List(2025, [row({ amount: 900, vendor_name: 'Zelle money sent to Lee Sample', bank_text: 'Zelle money sent to Lee Sample' })]);
    expect(r.threshold).toBe(600);
    expect(r.payees[0].needs_1099).toBe(true);
  });
});

describe('salesTaxSheet', () => {
  test('reads the P&L revenue and tax legs, maps the calendar row, warns for a period in progress', async () => {
    pnl.buildPnlReport.mockResolvedValue({ revenue: { total: 8929.31 }, coverage: { complete: true } });
    pnl.salesTaxLegsForWindow.mockResolvedValue({ tax: 13.37, taxable: 191, surtax: 1.91, collected: { tax: 13.37, taxable: 191, surtax: 1.91 }, reversed: { tax: 0, taxable: 0, surtax: 0 } });
    tables.tax_filing_calendar = () => ({ id: 'f-10', status: 'upcoming', period_label: 'Oct 2026', due_date: '2026-11-20', filed_date: null, paid_date: null, amount_paid: null, confirmation_number: null });
    const r = await ws.salesTaxSheet({ kind: 'month', year: '2026', index: '10' });
    expect(pnl.buildPnlReport).toHaveBeenCalledWith(mockDb, '2026-10-01', '2026-10-31');
    expect(pnl.salesTaxLegsForWindow).toHaveBeenCalledWith(mockDb, '2026-10-01', '2026-10-31');
    expect(r.period).toMatchObject({ label: 'Oct 2026', in_progress: true });
    expect(r.due_date).toBe('2026-11-20');
    expect(r.lines).toMatchObject({ gross_sales: 8929.31, exempt_sales: 8738.31, tax_collected: 13.37, amount_due: 13.04 });
    expect(r.filing).toEqual({ id: 'f-10', status: 'upcoming', period_label: 'Oct 2026', due_date: '2026-11-20', filed_date: null, paid_date: null, amount_paid: null, confirmation_number: null });
    expect(r.warnings.map((w) => w.code)).toEqual(['in_progress']);
  });

  test('a filed return is judged by its filing date; incomplete P&L coverage is a warning', async () => {
    pnl.buildPnlReport.mockResolvedValue({ revenue: { total: 2131.1 }, coverage: { complete: false, note: 'sync needed' } });
    pnl.salesTaxLegsForWindow.mockResolvedValue({ tax: 0.36, taxable: 5.1, surtax: 0.05, collected: { tax: 0.36, taxable: 5.1, surtax: 0.05 }, reversed: { tax: 0, taxable: 0, surtax: 0 } });
    tables.tax_filing_calendar = () => ({ id: 'f-4', status: 'paid', period_label: 'Apr 2026', due_date: '2026-05-20', filed_date: '2026-05-19', paid_date: '2026-05-19', amount_paid: '0.35', confirmation_number: 'C-1' });
    const r = await ws.salesTaxSheet({ kind: 'month', year: 2026, index: 4 });
    expect(r.late).toBe(false);
    expect(r.filing).toMatchObject({ status: 'paid', amount_paid: 0.35, confirmation_number: 'C-1' });
    expect(r.warnings).toEqual([{ code: 'pnl_coverage', text: 'Sales may be incomplete: sync needed' }]);
  });

  test('refunds beyond the tax collected warn to carry the excess to the next return', async () => {
    pnl.buildPnlReport.mockResolvedValue({ revenue: { total: 5000 }, coverage: { complete: true } });
    pnl.salesTaxLegsForWindow.mockResolvedValue({ tax: -70, taxable: -1000, surtax: -10, collected: { tax: 30, taxable: 428.57, surtax: 4.29 }, reversed: { tax: 100, taxable: 1428.57, surtax: 14.29 } });
    const r = await ws.salesTaxSheet({ kind: 'month', year: 2026, index: 9 });
    expect(r.lines).toMatchObject({ tax_due: 0, lawful_deductions: 30, amount_due: 50 });
    expect(r.warnings).toContainEqual({ code: 'excess_deduction', text: "Tax refunded ($100.00) is more than the tax collected. Carry the $70.00 excess to the next return's line 6." });
  });

  test('a period with no calendar row has no filing; a future period is a 400', async () => {
    pnl.buildPnlReport.mockResolvedValue({ revenue: { total: 0 } });
    pnl.salesTaxLegsForWindow.mockResolvedValue({ tax: 0, taxable: 0, surtax: 0, collected: { tax: 0, taxable: 0, surtax: 0 }, reversed: { tax: 0, taxable: 0, surtax: 0 } });
    const q = await ws.salesTaxSheet({ kind: 'quarter', year: 2026, index: 2 });
    expect(q.filing).toBeNull();
    await expect(ws.salesTaxSheet({ kind: 'month', year: 2026, index: 11 })).rejects.toMatchObject({ status: 400, message: 'Nov 2026 has not started' });
  });
});

describe('form1099List', () => {
  test('lists the year, counts payment-app debits still in the Inbox, adds the notes', async () => {
    tables['expenses as e'] = () => [
      { expense_id: 'a', expense_date: '2026-02-03', amount: '2500.00', payment_method: 'ach', vendor_name: 'Zelle money sent to Pat Example', description: 'x', line: '11', category: 'Contract Labor', bank_text: 'Zelle money sent to Pat Example' },
    ];
    tables.bank_transactions = () => ({ count: 3, total: '410.50' });
    const r = await ws.form1099List('2026');
    expect(r.payees).toEqual([expect.objectContaining({ name: 'Pat Example', total: 2500, needs_1099: true })]);
    expect(r.payees[0].payments[0]).toMatchObject({ date: '2026-02-03', channel: 'zelle', line: '11' });
    expect(r.inbox_pending).toEqual({ count: 3, total: 410.5 });
    expect(r.notes.some((n) => n.includes('1099-MISC'))).toBe(true);
    // the Inbox count never puts a "?" in raw SQL (knex would read it as a binding)
    expect(mockDb.raw.mock.calls.every(([sql]) => !String(sql).includes('?') || /\(\?, \?\)/.test(String(sql)))).toBe(true);
  });
});
