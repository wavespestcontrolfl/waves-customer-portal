/**
 * services/tax-shared-bills (GATE_TAX_SHARED_BILLS): the pure text and money
 * rules, plus the CRUD validation (db mocked).
 *
 * Locked-down behaviors:
 *  1. normalize: upper case, letters and digits, one space per run, 300 cap.
 *  2. matching is whole-word plain text: "VERIZON" finds "VERIZON WIRELESS",
 *     not "VERIZONWRLS"; a glued name ("SPECTRUM855 707 7328MO") needs its
 *     glued pattern. The longest pattern wins, a tie goes to the lowest id.
 *  3. shareOf rounds half up to cents and never leaves [0, amount].
 *  4. homeOfficeDeduction is $5 x sq ft (300 max) x months / 12.
 *  5. a business percent is a strict number from 0 to 100; a pattern is 3 to
 *     60 characters after normalizing; a year is 2020 to next year (ET).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const state = { category: { id: 'x' }, inserted: [], updated: [], insertError: null, updateRows: null, delCount: 1, home: null, upserted: [] };
function table(name) {
  const b = {
    where: jest.fn(() => b),
    first: jest.fn(() => Promise.resolve(name === 'expense_categories' ? state.category : state.home)),
    insert: jest.fn((row) => {
      state.inserted.push(row);
      if (name === 'tax_home_office') state.upserted.push(row);
      return b;
    }),
    onConflict: jest.fn(() => b),
    merge: jest.fn(() => b),
    returning: jest.fn(() => (state.insertError ? Promise.reject(state.insertError) : Promise.resolve([{ id: 'new-id', business_pct: '50.00', ...state.inserted[state.inserted.length - 1] }]))),
    update: jest.fn((patch) => { state.updated.push(patch); return { returning: jest.fn(() => Promise.resolve(state.updateRows || [{ id: 'u', ...patch }])) }; }),
    del: jest.fn(() => Promise.resolve(state.delCount)),
  };
  return b;
}
const mockDb = jest.fn((name) => table(name));
jest.mock('../models/db', () => mockDb);

const svc = require('../services/tax-shared-bills');
const { etParts } = require('../utils/datetime-et');

const ID = '11111111-1111-4111-8111-111111111111';
const CAT = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  Object.assign(state, { category: { id: CAT }, inserted: [], updated: [], insertError: null, updateRows: null, delCount: 1, home: null, upserted: [] });
  mockDb.mockClear();
});

describe('normalize', () => {
  test('upper-cases, collapses every non-alphanumeric run to one space and trims', () => {
    expect(svc.normalize('  Verizon-Wireless*  pay_ment!! ')).toBe('VERIZON WIRELESS PAY MENT');
    expect(svc.normalize(null)).toBe('');
  });
  test('caps at 300 characters and never ends on a space', () => {
    const out = svc.normalize(`${'a'.repeat(299)} bbb`);
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out.endsWith(' ')).toBe(false);
  });
});

describe('matching', () => {
  const bills = [
    { id: 'b-2', pattern: 'VERIZON', label: 'Phone', business_pct: 50, enabled: true },
    { id: 'b-1', pattern: 'VERIZON WIRELESS', label: 'Phone long', business_pct: 40, enabled: true },
    { id: 'b-3', pattern: 'SPECTRUM', label: 'Internet', business_pct: 60, enabled: true },
  ];
  test('matches on word boundaries inside a longer description', () => {
    expect(svc.matchBill('Withdrawal from VERIZON PAYMENT', [bills[0]]).id).toBe('b-2');
    expect(svc.matchBill('verizon.', [bills[0]]).id).toBe('b-2');
  });
  test('a name glued to other letters is not a word match', () => {
    expect(svc.matchBill('VERIZONWRLS PMT', [bills[0]])).toBeNull();
    // the bank prints the name glued to digits: normalize gives "SPECTRUM855 707 7328MO",
    // so SPECTRUM alone is NOT a word there; the owner stores SPECTRUM855 instead
    expect(svc.normalize('Spectrum855-707-7328MO')).toBe('SPECTRUM855 707 7328MO');
    expect(svc.matchBill('Spectrum855-707-7328MO', [bills[2]])).toBeNull();
    expect(svc.matchBill('Spectrum855-707-7328MO', [{ id: 'g', pattern: 'spectrum855', enabled: true }]).id).toBe('g');
  });
  test('the longest pattern wins, a tie goes to the lowest id, disabled bills are skipped', () => {
    expect(svc.matchBill('VERIZON WIRELESS PAYMENT', bills).id).toBe('b-1');
    const tie = [{ id: 'z', pattern: 'ACME', enabled: true }, { id: 'a', pattern: 'ACME', enabled: true }];
    expect(svc.matchBill('ACME CO', tie).id).toBe('a');
    expect(svc.matchBill('VERIZON WIRELESS', [{ ...bills[1], enabled: false }])).toBeNull();
  });
  test('an empty description or no bills matches nothing', () => {
    expect(svc.matchBill('', bills)).toBeNull();
    expect(svc.matchBill('VERIZON', [])).toBeNull();
  });
  test('a pattern full of regex characters is plain text', () => {
    expect(svc.matchBill('A+B(.*)', [{ id: 'r', pattern: '(.*)+', enabled: true }])).toBeNull();
  });
});

describe('shareOf', () => {
  test('rounds half up to cents', () => {
    expect(svc.shareOf(10.05, 50)).toBe(5.03);
    expect(svc.shareOf(100, 50)).toBe(50);
    expect(svc.shareOf(33.33, 33.33)).toBe(11.11);
    expect(svc.shareOf(0.01, 50)).toBe(0.01);
  });
  test('never above the amount or below zero', () => {
    expect(svc.shareOf(80, 150)).toBe(80);
    expect(svc.shareOf(80, -5)).toBe(0);
    expect(svc.shareOf(-10, 50)).toBe(0);
    expect(svc.shareOf('junk', 50)).toBe(0);
    expect(svc.shareOf(80, 100)).toBe(80);
  });
});

describe('homeOfficeDeduction', () => {
  test('$5 per sq ft per year, prorated by months, 300 sq ft at most', () => {
    expect(svc.homeOfficeDeduction({ sq_ft: 300, months: 12 })).toBe(1500);
    expect(svc.homeOfficeDeduction({ sq_ft: 300, months: 5 })).toBe(625);
    expect(svc.homeOfficeDeduction({ sq_ft: 400, months: 12 })).toBe(1500);
    expect(svc.homeOfficeDeduction({ sq_ft: 100, months: 7 })).toBe(291.67);
    expect(svc.homeOfficeDeduction({})).toBe(0);
  });
});

describe('bill validation', () => {
  const ok = { pattern: 'Verizon', label: ' Phone plan ', business_pct: '50' };
  test('creates with a normalized pattern, trimmed label and numeric percent', async () => {
    const bill = await svc.createBill({ ...ok, category_id: CAT });
    expect(state.inserted[0]).toMatchObject({ pattern: 'VERIZON', label: 'Phone plan', business_pct: 50, category_id: CAT, enabled: true });
    expect(bill.business_pct).toBe(50);
  });
  test.each([['50junk'], [''], [null], [true], [[]], [101], [-1], [NaN], ['1e999']])('refuses percent %p', async (pct) => {
    await expect(svc.createBill({ ...ok, business_pct: pct })).rejects.toMatchObject({ status: 400 });
  });
  test('accepts 0 and 100', async () => {
    await expect(svc.createBill({ ...ok, business_pct: 0 })).resolves.toBeTruthy();
    await expect(svc.createBill({ ...ok, pattern: 'Spectrum', business_pct: '100' })).resolves.toBeTruthy();
  });
  test('a pattern is 3 to 60 characters after normalizing', async () => {
    await expect(svc.createBill({ ...ok, pattern: 'VZ' })).rejects.toMatchObject({ status: 400 });
    await expect(svc.createBill({ ...ok, pattern: ' -- ' })).rejects.toMatchObject({ status: 400 });
    await expect(svc.createBill({ ...ok, pattern: 'A'.repeat(61) })).rejects.toMatchObject({ status: 400 });
    await expect(svc.createBill({ ...ok, pattern: 'A'.repeat(60) })).resolves.toBeTruthy();
  });
  test('a label is required; a category must exist', async () => {
    await expect(svc.createBill({ ...ok, label: '  ' })).rejects.toMatchObject({ status: 400 });
    state.category = undefined;
    await expect(svc.createBill({ ...ok, category_id: CAT })).rejects.toMatchObject({ status: 400, message: 'unknown category_id' });
    await expect(svc.createBill({ ...ok, category_id: 'not-a-uuid' })).rejects.toMatchObject({ status: 400 });
  });
  test('a duplicate pattern answers 409', async () => {
    state.insertError = Object.assign(new Error('dup'), { code: '23505' });
    await expect(svc.createBill(ok)).rejects.toMatchObject({ status: 409 });
  });
  test('update takes only the fields sent, validates them, and 404s an unknown row', async () => {
    await svc.updateBill(ID, { enabled: false });
    expect(Object.keys(state.updated[0]).sort()).toEqual(['enabled', 'updated_at']);
    await expect(svc.updateBill(ID, { enabled: 'no' })).rejects.toMatchObject({ status: 400 });
    await expect(svc.updateBill(ID, {})).rejects.toMatchObject({ status: 400 });
    await expect(svc.updateBill(ID, { business_pct: '50junk' })).rejects.toMatchObject({ status: 400 });
    state.updateRows = [];
    await expect(svc.updateBill(ID, { label: 'x' })).rejects.toMatchObject({ status: 404 });
    await expect(svc.updateBill('nope', { label: 'x' })).rejects.toMatchObject({ status: 404 });
  });
  test('delete 404s a missing row', async () => {
    await expect(svc.deleteBill(ID)).resolves.toBe(true);
    state.delCount = 0;
    await expect(svc.deleteBill(ID)).rejects.toMatchObject({ status: 404 });
  });
});

describe('home office validation', () => {
  const year = etParts().year;
  test('saves the simplified method for a valid year', async () => {
    const row = await svc.upsertHomeOffice(String(year), { sq_ft: '300', months: 12, notes: ' spare room ' });
    expect(state.upserted[0]).toMatchObject({ tax_year: year, method: 'simplified', sq_ft: 300, months: 12, notes: 'spare room' });
    expect(row.tax_year).toBe(year);
  });
  test('months default to 12', async () => {
    await svc.upsertHomeOffice(year, { sq_ft: 120 });
    expect(state.upserted[0].months).toBe(12);
  });
  test.each([[0], [301], [1.5], ['300sq'], [''], [null]])('refuses sq_ft %p', async (sq) => {
    await expect(svc.upsertHomeOffice(year, { sq_ft: sq })).rejects.toMatchObject({ status: 400 });
  });
  test.each([[0], [13], [2.5], ['x']])('refuses months %p', async (m) => {
    await expect(svc.upsertHomeOffice(year, { sq_ft: 100, months: m })).rejects.toMatchObject({ status: 400 });
  });
  test('the year runs from 2020 to next year', async () => {
    await expect(svc.upsertHomeOffice(2019, { sq_ft: 100 })).rejects.toMatchObject({ status: 400 });
    await expect(svc.upsertHomeOffice(year + 2, { sq_ft: 100 })).rejects.toMatchObject({ status: 400 });
    await expect(svc.upsertHomeOffice('abc', { sq_ft: 100 })).rejects.toMatchObject({ status: 400 });
    await expect(svc.upsertHomeOffice(year + 1, { sq_ft: 100 })).resolves.toBeTruthy();
    await expect(svc.getHomeOffice(2019)).rejects.toMatchObject({ status: 400 });
  });
});

describe('isOn', () => {
  afterEach(() => { delete process.env.GATE_TAX_SHARED_BILLS; delete process.env.GATE_BANK_IMPORT; });
  test('needs both GATE_BANK_IMPORT and GATE_TAX_SHARED_BILLS, read at call time', () => {
    expect(svc.isOn()).toBe(false);
    process.env.GATE_TAX_SHARED_BILLS = 'true';
    expect(svc.isOn()).toBe(false);
    process.env.GATE_BANK_IMPORT = 'true';
    expect(svc.isOn()).toBe(true);
    delete process.env.GATE_TAX_SHARED_BILLS;
    expect(svc.isOn()).toBe(false);
  });
});

describe('expenses.csv carries the booked deduction', () => {
  const csv = require('../services/csv-generators');
  test('a shared-bill expense exports its stored deductible amount and note, not a recomputation', () => {
    const out = csv.expensesToCSV([
      { expense_date: '2026-03-04', irs_line: '25', category_name: 'Utilities', vendor_name: 'PHONE CO', description: 'PHONE CO PAYMENT', amount: '120.00', payment_method: 'ach', has_receipt: false, tax_deductible_amount: '60.00', notes: '[Bank import x] [Shared bill: Phone plan 50%]' },
      { expense_date: '2026-03-05', amount: '10.00', tax_deductible_amount: null, notes: null },
    ]).split('\n');
    expect(out[0]).toMatch(/,Deductible Amount,Notes$/);
    expect(out[1]).toContain(',120.00,');
    expect(out[1]).toContain(',60.00,');
    expect(out[1]).toContain('Shared bill: Phone plan 50%');
    expect(out[2].endsWith(',,')).toBe(true);
  });
});

describe('the booked-share note', () => {
  const svc = require('../services/tax-shared-bills');
  test('round-trips the percent, strips brackets from the label, and reads the last marker', () => {
    const note = svc.sharedNote({ label: 'Phone [x] plan', business_pct: '50.00' });
    expect(note).toBe(' [Shared bill: Phone x plan 50%]');
    expect(svc.bookedSharePct(`[Bank import a]${note}`)).toBe(50);
    expect(svc.bookedSharePct('[Shared bill: A 60%] [Shared bill: B 12.5%]')).toBe(12.5);
    expect(svc.bookedSharePct('[Bank import a] [AI-categorized — verify]')).toBeNull();
    expect(svc.bookedSharePct(null)).toBeNull();
  });
});
