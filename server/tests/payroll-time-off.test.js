// Unit tests for the payroll time-off service that need no database: the hours
// and date rules, the refusals that stop before the connection is used, the lock
// order, and the duplicate-date answer. Names are synthetic. The database cases
// (lock after finalize, audit rows, balance) are in payroll-time-off-postgres.test.js.
jest.mock('../models/db', () => ({}));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn() }));

const {
  hoursToHundredths, minutesText, checkWorkDate,
  createTimeOff, updateTimeOff, deleteTimeOff, setPtoAllowance, listTimeOff, balance,
} = require('../services/payroll-time-off');
const { PAYROLL_LOCK_NS, PAYROLL_LOCK_KEY } = require('../services/payroll-runs');

const TECH_ID = '11111111-1111-4111-8111-111111111111';
const ENTRY_ID = '22222222-2222-4222-8222-222222222222';
const untouched = Object.assign(() => { throw new Error('connection used'); }, {
  transaction: () => { throw new Error('connection used'); },
  raw: () => { throw new Error('connection used'); },
});
const tomorrow = () => {
  const { etDateString } = require('../utils/datetime-et');
  const { addStaffWorkDays } = require('../utils/staff-time-work-date');
  return addStaffWorkDays(etDateString(), 1);
};
const good = (patch = {}) => ({ technicianId: TECH_ID, workDate: tomorrow(), kind: 'pto', hours: 8, note: 'Vacation', ...patch });

describe('hours', () => {
  it.each([
    [8, 800], ['8', 800], ['8.5', 850], ['0.01', 1], ['24', 2400], [' 1.25 ', 125], [7.75, 775],
  ])('reads %p as %p hundredths of an hour', (value, hundredths) => {
    expect(hoursToHundredths(value)).toBe(hundredths);
  });

  it.each([
    [0, /more than 0/], ['0.00', /more than 0/], [24.01, /24 or fewer/], [25, /24 or fewer/],
    ['1.234', /2 decimal/], ['-1', /2 decimal/], ['1e1', /2 decimal/], ['abc', /2 decimal/], [NaN, /2 decimal/], [null, /2 decimal/],
  ])('refuses %p', (value, message) => {
    expect(() => hoursToHundredths(value)).toThrow(expect.objectContaining({ status: 400, message: expect.stringMatching(message) }));
  });

  it('stores the paid length as minutes with two decimals, without float drift', () => {
    expect(minutesText(800)).toBe('480.00');
    expect(minutesText(1)).toBe('0.60');
    expect(minutesText(125)).toBe('75.00');
    expect(minutesText(2400)).toBe('1440.00');
    expect(minutesText(33)).toBe('19.80');
  });
});

describe('dates', () => {
  it('takes a real date within 400 days of today either way', () => {
    expect(checkWorkDate('2026-10-26', '2026-10-26')).toBe('2026-10-26');
    expect(checkWorkDate('2027-11-30', '2026-10-26')).toBe('2027-11-30');
    expect(checkWorkDate('2025-09-21', '2026-10-26')).toBe('2025-09-21');
  });
  it.each([
    ['an impossible date', '2026-02-31', /real date/],
    ['text', 'next week', /real date/],
    ['401 days ahead', '2027-12-01', /within 400 days/],
    ['401 days back', '2025-09-20', /within 400 days/],
  ])('refuses %s', (_name, date, message) => {
    expect(() => checkWorkDate(date, '2026-10-26')).toThrow(expect.objectContaining({ status: 400, message: expect.stringMatching(message) }));
  });
});

describe('input checks stop before the connection is used', () => {
  it.each([
    ['no technician', { technicianId: undefined }, /Pick a technician/],
    ['a technician id that is not a UUID', { technicianId: 'nope' }, /Technician not found/],
    ['no date', { workDate: undefined }, /Pick a date/],
    ['a bad kind', { kind: 'sick' }, /Pick paid time off or holiday/],
    ['no kind', { kind: undefined }, /Pick paid time off or holiday/],
    ['no hours', { hours: undefined }, /Enter the hours/],
    ['zero hours', { hours: 0 }, /more than 0/],
    ['25 hours', { hours: 25 }, /24 or fewer/],
    ['three decimals', { hours: '1.005' }, /2 decimal/],
    ['a long note', { note: 'x'.repeat(501) }, /at most 500/],
    ['an impossible date', { workDate: '2026-02-30' }, /real date/],
    ['a date 2 years out', { workDate: '2028-10-26' }, /within 400 days/],
  ])('create refuses %s', async (_name, patch, message) => {
    await expect(createTimeOff(good(patch), TECH_ID, untouched)).rejects.toMatchObject({ message: expect.stringMatching(message) });
  });

  it('create refuses an unknown field', async () => {
    await expect(createTimeOff({ ...good(), extra: 1 }, TECH_ID, untouched)).rejects.toMatchObject({ status: 400 });
  });

  it('update and delete refuse an id that is not a UUID, and update refuses a bad body', async () => {
    await expect(updateTimeOff('nope', { kind: 'pto', hours: 1 }, TECH_ID, untouched)).rejects.toMatchObject({ status: 404 });
    await expect(deleteTimeOff('nope', TECH_ID, untouched)).rejects.toMatchObject({ status: 404 });
    await expect(updateTimeOff(ENTRY_ID, { kind: 'pto', hours: 30 }, TECH_ID, untouched)).rejects.toMatchObject({ status: 400 });
    await expect(updateTimeOff(ENTRY_ID, { kind: 'pto', hours: 1, workDate: '2026-10-27' }, TECH_ID, untouched)).rejects.toMatchObject({ status: 400 });
  });

  it('the allowance is 0 to 400 hours with two decimals, or null to clear', async () => {
    await expect(setPtoAllowance(TECH_ID, { hoursPerYear: 401 }, TECH_ID, untouched)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/400 or fewer/) });
    await expect(setPtoAllowance(TECH_ID, { hoursPerYear: '-1' }, TECH_ID, untouched)).rejects.toMatchObject({ status: 400 });
    await expect(setPtoAllowance(TECH_ID, { hoursPerYear: '80.123' }, TECH_ID, untouched)).rejects.toMatchObject({ status: 400 });
    await expect(setPtoAllowance(TECH_ID, {}, TECH_ID, untouched)).rejects.toMatchObject({ status: 400 });
    await expect(setPtoAllowance('nope', { hoursPerYear: 80 }, TECH_ID, untouched)).rejects.toMatchObject({ status: 404 });
  });

  it('the list needs a real range of at most 400 days; the balance needs a technician and a year', async () => {
    await expect(listTimeOff({}, untouched)).rejects.toMatchObject({ status: 400 });
    await expect(listTimeOff({ from: '2026-10-26', to: '2026-10-25' }, untouched)).rejects.toMatchObject({ status: 400 });
    await expect(listTimeOff({ from: '2026-01-01', to: '2027-02-06' }, untouched)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/400 days/) });
    await expect(balance({ technicianId: 'nope' }, untouched)).rejects.toMatchObject({ status: 404 });
    await expect(balance({ technicianId: TECH_ID, year: '27' }, untouched)).rejects.toMatchObject({ status: 400 });
  });
});

describe('writes', () => {
  // A fake connection that records the order of calls and stops at the first read.
  const fakeConnection = () => {
    const events = [];
    const stop = new Error('stopped at first read');
    const chain = () => new Proxy(() => {}, {
      get: (_t, key) => (key === 'then' ? undefined : (...args) => {
        if (key === 'first' || key === 'select' || key === 'del' || key === 'update' || key === 'insert') { events.push(`read:${key}`); return Promise.reject(stop); }
        return chain();
      }),
    });
    const trx = (table) => { events.push(`table:${table}`); return chain(); };
    trx.raw = jest.fn(async (sql, bindings) => {
      if (/pg_advisory_xact_lock/.test(sql)) { events.push('lock'); trx.lockArgs = [sql, bindings]; return { rows: [] }; }
      return sql;
    });
    trx.fn = { now: () => 'now' };
    return { events, stop, trx, conn: { transaction: (callback) => callback(trx) } };
  };

  it.each([
    ['create', (conn) => createTimeOff(good(), TECH_ID, conn)],
    ['update', (conn) => updateTimeOff(ENTRY_ID, { kind: 'pto', hours: 1 }, TECH_ID, conn)],
    ['delete', (conn) => deleteTimeOff(ENTRY_ID, TECH_ID, conn)],
  ])('%s takes the same lock finalizeRun takes before any table is read', async (_name, call) => {
    const { events, stop, trx, conn } = fakeConnection();
    await expect(call(conn)).rejects.toBe(stop);
    expect(events[0]).toBe('lock');
    expect(events.filter((event) => event === 'lock')).toHaveLength(1);
    expect(trx.lockArgs[0]).toBe('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))');
    expect(trx.lockArgs[1]).toEqual([PAYROLL_LOCK_NS, PAYROLL_LOCK_KEY]);
  });

  it('answers a second entry for the same technician and date with 409 and a plain message', async () => {
    const conn = { transaction: () => Promise.reject(Object.assign(new Error('duplicate key'), { code: '23505' })) };
    await expect(createTimeOff(good(), TECH_ID, conn)).rejects.toMatchObject({
      status: 409, message: expect.stringMatching(/already has time off recorded for that date/),
    });
  });
});
