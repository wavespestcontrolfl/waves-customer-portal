/**
 * services/tax-years (GATE_TAX_RETURN_ENGINE): the strict validation on the
 * year record, the carry-in resolution, and the filed / unfiled guards
 * (database mocked).
 *
 * Locked-down behaviors:
 *  1. A PUT takes only the editable fields, each a strict number (no "50junk",
 *     no blank, no negative) or a known filing status; an unknown field is a 400.
 *  2. A filed year cannot be edited: 409, before and at the write.
 *  3. A carry-in left at 0 takes the prior year's FILED snapshot; a number the
 *     owner typed wins; a prior year that is only a draft gives nothing.
 *  4. filed_on is a real day from the start of the year to today.
 *  5. Marking filed is draft to filed only (409 otherwise); unmarking a year
 *     that was never filed is a 409, a year with no record a 404.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const state = { existing: null, upserted: [], upsertReturns: undefined, updateRows: [], inserted: [], rows: {} };
function mockTable() {
  const b = {
    where: jest.fn(() => b),
    orderBy: jest.fn(() => b),
    select: jest.fn(() => Promise.resolve(state.rows.list || [])),
    first: jest.fn(() => Promise.resolve(state.existing)),
    insert: jest.fn((row) => { state.inserted.push(row); return b; }),
    onConflict: jest.fn(() => b),
    merge: jest.fn((patch) => { state.upserted.push(patch); return b; }),
    ignore: jest.fn(() => Promise.resolve()),
    update: jest.fn(() => b),
    returning: jest.fn(() => Promise.resolve(state.upsertReturns !== undefined ? state.upsertReturns : state.updateRows)),
  };
  return b;
}
jest.mock('../models/db', () => jest.fn(() => mockTable()));

const ty = require('../services/tax-years');
const { etParts, etDateString } = require('../utils/datetime-et');

const httpErr = (status) => expect.objectContaining({ status });
const year = etParts().year - 1;

beforeEach(() => {
  Object.assign(state, { existing: null, upserted: [], upsertReturns: undefined, updateRows: [], inserted: [], rows: {} });
});

describe('upsertYear validation', () => {
  beforeEach(() => { state.upsertReturns = [{ tax_year: year, filing_status: 'single', status: 'draft', other_income: '10.50', estimates_paid: '0', nol_in: '0', qbi_loss_in: '0', sec179_carry_in: '0', home_office_carry_in: '0', filed_on: null }]; });
  test('saves strict numbers rounded to cents and a known filing status', async () => {
    const row = await ty.upsertYear(String(year), { filing_status: 'mfj', other_income: '10.505', estimates_paid: 200, notes: '  hi  ' });
    expect(state.upserted[0]).toMatchObject({ filing_status: 'mfj', other_income: 10.51, estimates_paid: 200, notes: 'hi' });
    expect(row.other_income).toBe(10.5);
  });
  test.each([['50junk'], [''], [null], [-1], [true], [[]], ['1e12'], [NaN]])('refuses an amount of %p', async (v) => {
    await expect(ty.upsertYear(year, { other_income: v })).rejects.toEqual(httpErr(400));
    await expect(ty.upsertYear(year, { nol_in: v })).rejects.toEqual(httpErr(400));
  });
  test('refuses an unknown filing status, an unknown field and an empty body', async () => {
    await expect(ty.upsertYear(year, { filing_status: 'mfs' })).rejects.toEqual(httpErr(400));
    await expect(ty.upsertYear(year, { status: 'filed' })).rejects.toThrow('unknown field: status');
    await expect(ty.upsertYear(year, { filed_on: '2026-01-01' })).rejects.toThrow('unknown field: filed_on');
    await expect(ty.upsertYear(year, {})).rejects.toThrow('nothing to update');
    expect(state.upserted).toEqual([]);
  });
  test('refuses notes over 500 characters and a bad year', async () => {
    await expect(ty.upsertYear(year, { notes: 'x'.repeat(501) })).rejects.toEqual(httpErr(400));
    await expect(ty.upsertYear(2019, { other_income: 1 })).rejects.toEqual(httpErr(400));
    await expect(ty.upsertYear('abc', { other_income: 1 })).rejects.toEqual(httpErr(400));
  });
  test('a filed year is a 409 before the write, and at the write when it was filed meanwhile', async () => {
    state.existing = { status: 'filed' };
    await expect(ty.upsertYear(year, { other_income: 1 })).rejects.toEqual(httpErr(409));
    expect(state.upserted).toEqual([]);
    state.existing = { status: 'draft' };
    state.upsertReturns = []; // the status guard in the upsert matched nothing
    await expect(ty.upsertYear(year, { other_income: 1 })).rejects.toEqual(httpErr(409));
  });
});

describe('resolveCarryIn', () => {
  const filedPrior = (carry) => ({ exists: true, row: { tax_year: 2024, status: 'filed', filed_snapshot: { result: { carry_out: carry } } } });
  const row = { nol_in: 0, qbi_loss_in: 0, sec179_carry_in: 0, home_office_carry_in: 0 };
  test('a zero takes the prior year filed carry-out, with where it came from', () => {
    const c = ty.resolveCarryIn(row, filedPrior({ nol: 26000, qbi_loss: 0, sec179: 700, home_office: 12.5 }));
    expect(c.nol).toEqual({ value: 26000, source: 'prior_year', from_year: 2024 });
    expect(c.qbi_loss).toEqual({ value: 0, source: 'prior_year', from_year: 2024 });
    expect(c.sec179.value).toBe(700);
    expect(c.home_office.value).toBe(12.5);
  });
  test('a number typed on the year wins', () => {
    const c = ty.resolveCarryIn({ ...row, nol_in: 5 }, filedPrior({ nol: 26000 }));
    expect(c.nol).toEqual({ value: 5, source: 'entered', from_year: null });
    expect(c.sec179.source).toBe('prior_year');
  });
  test('a prior year that is only a draft, or missing, gives none', () => {
    const draft = { exists: true, row: { tax_year: 2024, status: 'draft', filed_snapshot: null } };
    expect(ty.resolveCarryIn(row, draft).nol).toEqual({ value: 0, source: 'none', from_year: null });
    expect(ty.resolveCarryIn(row, null).nol.source).toBe('none');
  });
});

describe('getYearRow', () => {
  test('a year with no record reads as the defaults', async () => {
    const r = await ty.getYearRow(year);
    expect(r.exists).toBe(false);
    expect(r.row).toMatchObject({ tax_year: year, filing_status: 'single', status: 'draft', nol_in: 0, filed_snapshot: null });
  });
});

describe('parseFiledOn', () => {
  const today = '2026-10-24';
  test('defaults to today and takes a real day from the start of the year to today', () => {
    expect(ty.parseFiledOn(undefined, 2025, today)).toBe(today);
    expect(ty.parseFiledOn('2026-04-15', 2025, today)).toBe('2026-04-15');
    expect(ty.parseFiledOn('2025-01-01', 2025, today)).toBe('2025-01-01');
  });
  test.each([['2026-02-30'], ['2026-4-15'], ['04/15/2026'], ['2024-12-31'], ['2026-10-25'], [20260415], ['2026-13-01']])('refuses %p', (v) => {
    expect(() => ty.parseFiledOn(v, 2025, today)).toThrow(expect.objectContaining({ status: 400 }));
  });
  test('uses the ET day by default', () => {
    expect(ty.parseFiledOn(undefined, 2020)).toBe(etDateString());
  });
});

describe('markFiled and unmarkFiled', () => {
  test('mark filed freezes the snapshot as JSON and returns the row', async () => {
    state.updateRows = [{ tax_year: 2025, status: 'filed', filed_on: '2026-04-15', other_income: '0', estimates_paid: '0', nol_in: '0', qbi_loss_in: '0', sec179_carry_in: '0', home_office_carry_in: '0' }];
    const row = await ty.markFiled(2025, '2026-04-15', { result: { total_tax: 1 } });
    expect(row.status).toBe('filed');
    expect(state.inserted[0]).toEqual({ tax_year: 2025 }); // the draft row is made when there is none
  });
  test('a year that is not a draft is a 409', async () => {
    state.updateRows = [];
    await expect(ty.markFiled(2025, '2026-04-15', {})).rejects.toEqual(httpErr(409));
  });
  test('unmark: 409 for a year that is not filed, 404 for no record', async () => {
    state.updateRows = [];
    state.existing = { tax_year: 2025 };
    await expect(ty.unmarkFiled(2025)).rejects.toEqual(httpErr(409));
    state.existing = null;
    await expect(ty.unmarkFiled(2025)).rejects.toEqual(httpErr(404));
  });
  test('unmark clears the filing back to a draft', async () => {
    state.updateRows = [{ tax_year: 2025, status: 'draft', filed_on: null, other_income: '0', estimates_paid: '0', nol_in: '0', qbi_loss_in: '0', sec179_carry_in: '0', home_office_carry_in: '0' }];
    expect((await ty.unmarkFiled(2025)).status).toBe('draft');
  });
});
