/**
 * services/tax-years (GATE_TAX_RETURN_ENGINE): the strict validation on the
 * year record, the carry-in resolution, and the filed / unfiled guards
 * (database mocked).
 *
 * Locked-down behaviors:
 *  1. A PUT takes only the editable fields, each a strict number (no "50junk",
 *     no blank, no negative) or a known filing status; an unknown field is a 400.
 *  2. A filed year cannot be edited: the upsert merges only into a draft row,
 *     so a filed row updates nothing and that is the 409.
 *  3. A NULL carry-in takes the prior year's FILED snapshot (or 0); any number
 *     the owner entered, 0 included, wins; a PUT of null clears it back to the
 *     default; a prior year that is only a draft gives nothing.
 *  4. filed_on is a real day from the start of the year to today.
 *  5. Marking filed is draft to filed only (409 otherwise); unmarking a year
 *     that was never filed is a 409, a year with no record a 404.
 *  6. Filing only matches the versions the return was computed from, the
 *     year's row and the prior year's row (its filed snapshot feeds NULL
 *     carry-ins), under a table lock: a write that landed since on either (a
 *     PUT, a filing, an unfiling) is a 409 and the snapshot is never written.
 *  7. A failed read of the prior year is an error, never a zero carryover.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const state = {
  existing: null, upserted: [], upsertReturns: undefined, updateRows: [], inserted: [], rows: {},
  firstResults: [], firstCalls: 0, wheres: [], store: null, raws: [], transactions: 0,
};
// state.store (optional) is a one-row fake of tax_years: the filing UPDATE
// matches it only while it is a draft AND its version equals the whereRaw
// binding, exactly like the SQL; a match applies the patch.
function mockTable() {
  let rawVersion = null;
  let patch = null;
  const b = {
    where: jest.fn((...args) => { state.wheres.push(args); return b; }),
    whereRaw: jest.fn((_sql, bindings) => { rawVersion = bindings[0]; return b; }),
    orderBy: jest.fn(() => b),
    select: jest.fn(() => Promise.resolve(state.rows.list || [])),
    first: jest.fn(() => {
      state.firstCalls += 1;
      if (state.firstResults.length) {
        const next = state.firstResults.shift();
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
      }
      return Promise.resolve(state.store ? { status: state.store.status } : state.existing);
    }),
    insert: jest.fn((row) => { state.inserted.push(row); return b; }),
    onConflict: jest.fn(() => b),
    merge: jest.fn((p) => { state.upserted.push(p); return b; }),
    ignore: jest.fn(() => Promise.resolve()),
    update: jest.fn((p) => { patch = p; return b; }),
    returning: jest.fn(() => {
      if (state.store && patch) {
        if (state.store.status !== 'draft' || state.store.version !== rawVersion) return Promise.resolve([]);
        Object.assign(state.store, { status: 'filed', snapshot: patch.filed_snapshot });
        return Promise.resolve([{ tax_year: 2025, status: 'filed', filed_on: patch.filed_on, other_income: '0', estimates_paid: '0', nol_in: null, qbi_loss_in: null, sec179_carry_in: null, home_office_carry_in: null }]);
      }
      return Promise.resolve(state.upsertReturns !== undefined ? state.upsertReturns : state.updateRows);
    }),
  };
  return b;
}
// db.transaction(cb): the trx builds the same fake table; trx.raw records its SQL
function mockTransaction(cb) {
  state.transactions += 1;
  const trx = jest.fn(() => mockTable());
  trx.raw = jest.fn((sql) => { state.raws.push(sql); return Promise.resolve(); });
  return cb(trx);
}
jest.mock('../models/db', () => {
  const d = jest.fn(() => mockTable());
  d.raw = jest.fn((sql) => sql);
  d.fn = { now: jest.fn(() => 'db-now') };
  d.transaction = jest.fn((cb) => mockTransaction(cb));
  return d;
});

const ty = require('../services/tax-years');
const { etParts, etDateString } = require('../utils/datetime-et');

const httpErr = (status) => expect.objectContaining({ status });
const year = etParts().year - 1;

beforeEach(() => {
  Object.assign(state, { existing: null, upserted: [], upsertReturns: undefined, updateRows: [], inserted: [], rows: {}, firstResults: [], firstCalls: 0, wheres: [], store: null, raws: [], transactions: 0 });
});

describe('upsertYear validation', () => {
  beforeEach(() => { state.upsertReturns = [{ tax_year: year, filing_status: 'single', status: 'draft', other_income: '10.50', estimates_paid: '0', nol_in: null, qbi_loss_in: '0.00', sec179_carry_in: null, home_office_carry_in: null, filed_on: null }]; });
  test('saves strict numbers rounded to cents and a known filing status', async () => {
    const row = await ty.upsertYear(String(year), { filing_status: 'mfj', other_income: '10.505', estimates_paid: 200, notes: '  hi  ' });
    expect(state.upserted[0]).toMatchObject({ filing_status: 'mfj', other_income: 10.51, estimates_paid: 200, notes: 'hi', updated_at: 'db-now' });
    expect(state.wheres).toContainEqual(['tax_years.status', 'draft']); // a filing that lands first makes this write match nothing
    expect(row.other_income).toBe(10.5);
    expect(row).toMatchObject({ nol_in: null, qbi_loss_in: 0, sec179_carry_in: null }); // NULL stays NULL, a stored 0 stays 0
  });
  test.each([['50junk'], [''], [null], [-1], [true], [[]], ['1e12'], [NaN]])('refuses an amount of %p', async (v) => {
    await expect(ty.upsertYear(year, { other_income: v })).rejects.toEqual(httpErr(400));
    await expect(ty.upsertYear(year, { estimates_paid: v })).rejects.toEqual(httpErr(400));
  });
  test.each([['50junk'], [''], [-1], [true], [[]], ['1e12'], [NaN]])('refuses a carry-in of %p (only a number or null)', async (v) => {
    for (const k of ['nol_in', 'qbi_loss_in', 'sec179_carry_in', 'home_office_carry_in']) {
      await expect(ty.upsertYear(year, { [k]: v })).rejects.toEqual(httpErr(400));
    }
    expect(state.upserted).toEqual([]);
  });
  test('a carry-in of 0 is saved as 0 and null clears it back to the default', async () => {
    await ty.upsertYear(year, { nol_in: 0, sec179_carry_in: '0' });
    expect(state.upserted[0]).toEqual(expect.objectContaining({ nol_in: 0, sec179_carry_in: 0 }));
    await ty.upsertYear(year, { nol_in: null, qbi_loss_in: null, home_office_carry_in: 12.5 });
    expect(state.upserted[1]).toEqual(expect.objectContaining({ nol_in: null, qbi_loss_in: null, home_office_carry_in: 12.5 }));
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
  test('a filed year is a 409 from the write itself: the merge only matches a draft row', async () => {
    state.upsertReturns = []; // the row is filed, so the status guard in the upsert matched nothing
    await expect(ty.upsertYear(year, { other_income: 1 })).rejects.toMatchObject({ status: 409, message: `${year} is marked filed: unmark it before changing it` });
    expect(state.wheres).toContainEqual(['tax_years.status', 'draft']);
    expect(state.firstCalls).toBe(0); // no separate read first: the guarded write is the check
  });
  test('notes: null and blank clear them, text is trimmed, anything else is a 400', async () => {
    await ty.upsertYear(year, { notes: null });
    await ty.upsertYear(year, { notes: '   ' });
    await ty.upsertYear(year, { notes: '  call the CPA  ' });
    expect(state.upserted.map((p) => p.notes)).toEqual([null, null, 'call the CPA']);
    await expect(ty.upsertYear(year, { notes: 5 })).rejects.toEqual(httpErr(400));
    await expect(ty.upsertYear(year, { notes: ['x'] })).rejects.toEqual(httpErr(400));
  });
});

describe('resolveCarryIn', () => {
  const filedPrior = (carry) => ({ exists: true, row: { tax_year: 2024, status: 'filed', filed_snapshot: { result: { carry_out: carry } } } });
  const nulls = { nol_in: null, qbi_loss_in: null, sec179_carry_in: null, home_office_carry_in: null };
  test('NULL takes the prior year filed carry-out, with where it came from', () => {
    const c = ty.resolveCarryIn(nulls, filedPrior({ nol: 26000, qbi_loss: 0, sec179: 700, home_office: 12.5 }));
    expect(c.nol).toMatchObject({ value: 26000, source: 'prior_year', from_year: 2024, default_value: 26000 });
    expect(c.qbi_loss).toMatchObject({ value: 0, source: 'prior_year', from_year: 2024 });
    expect(c.sec179.value).toBe(700);
    expect(c.home_office.value).toBe(12.5);
  });
  test('a number entered on the year wins, and the default stays visible', () => {
    const c = ty.resolveCarryIn({ ...nulls, nol_in: 5 }, filedPrior({ nol: 26000 }));
    expect(c.nol).toMatchObject({ value: 5, source: 'entered', from_year: null, default_value: 26000, default_source: 'prior_year', default_from_year: 2024 });
    expect(c.sec179.source).toBe('prior_year');
  });
  test('an explicit 0 overrides a non-zero prior snapshot', () => {
    const c = ty.resolveCarryIn({ ...nulls, nol_in: 0 }, filedPrior({ nol: 26000 }));
    expect(c.nol).toMatchObject({ value: 0, source: 'entered', default_value: 26000 });
  });
  test('a prior year that is only a draft, or missing, gives none', () => {
    const draft = { exists: true, row: { tax_year: 2024, status: 'draft', filed_snapshot: null } };
    expect(ty.resolveCarryIn(nulls, draft).nol).toMatchObject({ value: 0, source: 'none', from_year: null });
    expect(ty.resolveCarryIn(nulls, null).nol.source).toBe('none');
    expect(ty.resolveCarryIn({ ...nulls, nol_in: 0 }, null).nol).toMatchObject({ value: 0, source: 'entered', default_source: 'none' });
  });
});

describe('getYearDetail: the prior year read', () => {
  test('a failed read of the prior year is an error, never a zero carryover', async () => {
    state.firstResults = [null, new Error('db down')]; // this year reads, the prior year fails
    await expect(ty.getYearDetail(year)).rejects.toThrow('db down');
  });
  test('a failed read of this year is an error too', async () => {
    state.firstResults = [new Error('db down'), null];
    await expect(ty.getYearDetail(year)).rejects.toThrow('db down');
  });
  test('a prior year with no row is a normal none', async () => {
    state.firstResults = [null, null];
    const d = await ty.getYearDetail(year);
    expect(d.carry_in.nol).toMatchObject({ value: 0, source: 'none' });
  });
  test('the first year the module knows has no prior year to read', async () => {
    const d = await ty.getYearDetail(2020);
    expect(state.firstCalls).toBe(1);
    expect(d.carry_in.nol.source).toBe('none');
    expect(d.prior_version).toBeNull();
  });
  test('the prior row version as read comes back for the filing check, null when it has no row', async () => {
    state.firstResults = [null, { tax_year: year - 1, status: 'draft', version: 'p1', other_income: '0', estimates_paid: '0' }];
    expect((await ty.getYearDetail(year)).prior_version).toBe('p1');
    state.firstResults = [null, null];
    expect((await ty.getYearDetail(year)).prior_version).toBeNull();
  });
});

describe('getYearRow', () => {
  test('a year with no record reads as the defaults', async () => {
    const r = await ty.getYearRow(year);
    expect(r.exists).toBe(false);
    expect(r.row).toMatchObject({ tax_year: year, filing_status: 'single', status: 'draft', nol_in: null, qbi_loss_in: null, filed_snapshot: null });
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
  const draft = () => ({ status: 'draft', version: 'v1', snapshot: null });
  // the prior year's row as the filing reads it under the lock (null: no row)
  const priorNow = (version) => { state.firstResults = [version == null ? null : { version }]; };
  test('mark filed freezes the snapshot as JSON when both versions still match, under the table lock', async () => {
    state.store = draft();
    priorNow('p1');
    const row = await ty.markFiled(2025, '2026-04-15', { result: { total_tax: 1 } }, 'v1', 'p1');
    expect(row.status).toBe('filed');
    expect(state.store.snapshot).toBe(JSON.stringify({ result: { total_tax: 1 } }));
    expect(state.transactions).toBe(1);
    expect(state.raws).toEqual(['LOCK TABLE tax_years IN SHARE ROW EXCLUSIVE MODE']);
    expect(state.wheres).toContainEqual([{ tax_year: 2024 }]);
  });
  test('a prior year with no row, then and now, files', async () => {
    state.store = draft();
    priorNow(null);
    expect((await ty.markFiled(2025, '2026-04-15', { result: {} }, 'v1', null)).status).toBe('filed');
  });
  test('the prior year changed after the carry-ins were read (filed, unfiled or edited): 409, no snapshot', async () => {
    state.store = draft();
    priorNow('p2'); // an unfiling of 2024 committed after the return read it at p1
    await expect(ty.markFiled(2025, '2026-04-15', { result: {} }, 'v1', 'p1')).rejects.toMatchObject({
      status: 409, message: '2024 changed while 2025 was being filed; reload and try again',
    });
    expect(state.store).toEqual(draft());
  });
  test('a prior year row that appeared since is a change too', async () => {
    state.store = draft();
    priorNow('p1');
    await expect(ty.markFiled(2025, '2026-04-15', { result: {} }, 'v1', null)).rejects.toMatchObject({ status: 409 });
    expect(state.store).toEqual(draft());
  });
  test('the first year has no prior year to check', async () => {
    state.store = draft();
    expect((await ty.markFiled(2020, '2021-04-15', { result: {} }, 'v1')).status).toBe('filed');
    expect(state.wheres).not.toContainEqual([{ tax_year: 2019 }]);
  });
  test('ensureRow makes the draft row first, without touching an existing one', async () => {
    await ty.ensureRow(2025);
    expect(state.inserted[0]).toEqual({ tax_year: 2025 });
  });
  test('a PUT landing between the read and the filing is a 409 and writes no snapshot', async () => {
    state.store = draft(); // the row as read: version v1, the return is computed from it
    state.store.version = 'v2'; // a PUT commits now
    priorNow('p1');
    await expect(ty.markFiled(2025, '2026-04-15', { result: {} }, 'v1', 'p1')).rejects.toMatchObject({
      status: 409, message: 'the year changed while it was being filed; reload and try again',
    });
    expect(state.store).toEqual({ status: 'draft', version: 'v2', snapshot: null });
  });
  test('a year already filed is a 409 that says so', async () => {
    state.store = { status: 'filed', version: 'v1', snapshot: '{}' };
    priorNow('p1');
    await expect(ty.markFiled(2025, '2026-04-15', {}, 'v1', 'p1')).rejects.toMatchObject({ status: 409, message: '2025 is already marked filed' });
  });
  test('a version is required, and the prior year version for a year that has a prior year', async () => {
    await expect(ty.markFiled(2025, '2026-04-15', {})).rejects.toThrow(/version/);
    await expect(ty.markFiled(2025, '2026-04-15', {}, 'v1')).rejects.toThrow(/prior year row/);
    expect(state.transactions).toBe(0);
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
