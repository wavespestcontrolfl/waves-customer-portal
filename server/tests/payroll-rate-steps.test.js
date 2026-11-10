// Unit tests for pay rate steps that need no database: the pure week-rate rule, the day-90 suggestion,
// input validation (a refused input never reaches the connection) and the duplicate-date answer.
// The database side (apply, cancel, pay runs, the migration) is payroll-rate-steps-postgres.test.js.
// Names are synthetic.
jest.mock('../models/db', () => ({}));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn() }));

const { rateForWeek, suggestedDay90Monday, createStep, cancelStep } = require('../services/payroll-rate-steps');
const { etDateString, addETDays } = require('../utils/datetime-et');
const { floridaMinimumWageCentsFor } = require('../services/payroll-calc');
const { staffWeekStartForWorkDate, addStaffWorkDays } = require('../utils/staff-time-work-date');

const TECH_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '22222222-2222-4222-8222-222222222222';
const untouched = Object.assign(() => { throw new Error('connection used'); }, {
  transaction: () => { throw new Error('connection used'); },
});
const step = (effectiveOn, hourlyRate, previousRate = null, applied = false) => ({
  effective_on: effectiveOn, hourly_rate: hourlyRate, previous_rate: previousRate, applied_at: applied ? '2026-12-01T05:00:00Z' : null,
});

describe('rateForWeek', () => {
  const applied = step('2027-03-01', '25.00', '23.00', true);

  it('returns the current rate when there are no steps', () => {
    expect(rateForWeek('23.00', [], '2027-02-22')).toBe('23.00');
    expect(rateForWeek('23.00', undefined, '2027-02-22')).toBe('23.00');
  });

  it('pays a week before an applied step the rate stored from before it, and the step week the new rate', () => {
    expect(rateForWeek('25.00', [applied], '2027-02-22')).toBe('23.00');
    expect(rateForWeek('25.00', [applied], '2027-03-01')).toBe('25.00');
    expect(rateForWeek('25.00', [applied], '2027-03-08')).toBe('25.00');
  });

  it('lets a later manual edit win for weeks after the last applied step, never for earlier weeks', () => {
    expect(rateForWeek('26.00', [applied], '2027-03-15')).toBe('26.00');
    expect(rateForWeek('26.00', [applied], '2027-02-22')).toBe('23.00');
  });

  it('reads the earliest applied step after the week when two are applied', () => {
    const second = step('2027-06-07', '27.00', '25.00', true);
    expect(rateForWeek('27.00', [second, applied], '2027-02-22')).toBe('23.00');
    expect(rateForWeek('27.00', [second, applied], '2027-03-08')).toBe('25.00');
    expect(rateForWeek('27.00', [second, applied], '2027-06-07')).toBe('27.00');
  });

  it('prices a week with a step that is due but not applied yet, and ignores one that is not due', () => {
    const due = step('2027-03-01', '25.00');
    expect(rateForWeek('23.00', [due], '2027-03-01')).toBe('25.00');
    expect(rateForWeek('23.00', [due], '2027-03-08')).toBe('25.00');
    expect(rateForWeek('23.00', [due], '2027-02-22')).toBe('23.00');
  });

  it('uses the latest due step when several are waiting', () => {
    expect(rateForWeek('23.00', [step('2027-03-01', '25.00'), step('2027-04-05', '26.00')], '2027-04-12')).toBe('26.00');
  });
});

describe('suggestedDay90Monday', () => {
  it('gives the first Monday after day 90, where day 1 is the hire date', () => {
    expect(suggestedDay90Monday('2027-01-04')).toBe('2027-04-05');
  });

  it('gives the FOLLOWING Monday when day 90 is itself a Monday', () => {
    const day90 = '2027-04-12';
    expect(staffWeekStartForWorkDate(day90)).toBe(day90);
    expect(suggestedDay90Monday(addStaffWorkDays(day90, -89))).toBe('2027-04-19');
  });

  it('is null without a hire date', () => {
    expect(suggestedDay90Monday(null)).toBeNull();
  });
});

describe('createStep validation', () => {
  const nextMonday = () => {
    const tomorrow = etDateString(addETDays(new Date(), 1));
    const monday = staffWeekStartForWorkDate(tomorrow);
    return monday > etDateString() ? monday : addStaffWorkDays(monday, 7);
  };
  const valid = () => ({ effectiveOn: nextMonday(), hourlyRate: '25' });
  const reject = (patch, message, status = 400, actor = ACTOR_ID) => expect(createStep(TECH_ID, { ...valid(), ...patch }, actor, untouched))
    .rejects.toMatchObject({ status, message: expect.stringMatching(message) });

  it.each([
    ['a bad date', { effectiveOn: '2027-02-30' }, /real date/],
    ['no date', { effectiveOn: undefined }, /Start date is required/],
    ['today', { effectiveOn: () => staffWeekStartForWorkDate(etDateString()) }, /after today/],
    ['a day that is not Monday', { effectiveOn: () => addStaffWorkDays(nextMonday(), 1) }, /Monday/],
    ['no rate', { hourlyRate: undefined }, /Hourly rate is required/],
    ['zero', { hourlyRate: '0' }, /above 0/],
    ['three decimals', { hourlyRate: '25.123' }, /2 decimal/],
    ['exponent notation', { hourlyRate: '1e2' }, /2 decimal/],
    ['negative', { hourlyRate: '-5' }, /above 0/],
    ['too large', { hourlyRate: '1000000' }, /above 0/],
    // One cent under the floor in force that Monday, read from the wage table, so a new yearly rate does not break this.
    ['below the Florida minimum', { hourlyRate: () => ((Number(floridaMinimumWageCentsFor(nextMonday())) - 1) / 100).toFixed(2) }, /cannot be below the Florida minimum wage of \$\d+\.\d{2}/],
    ['a long note', { note: 'x'.repeat(501) }, /at most 500/],
  ])('refuses %s before the connection is used', async (_label, patch, message) => {
    const resolved = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, typeof v === 'function' ? v() : v]));
    await reject(resolved, message);
  });

  it('refuses a bad technician id with a 404 and a missing actor with a 403', async () => {
    await expect(createStep('nope', valid(), ACTOR_ID, untouched)).rejects.toMatchObject({ status: 404 });
    await reject({}, /admin is needed/, 403, null);
  });

  it('accepts "25" and "25.50" and answers a second open step for the same date with a plain 409', async () => {
    const conn = { transaction: jest.fn().mockRejectedValue(Object.assign(new Error('duplicate'), { code: '23505' })) };
    await expect(createStep(TECH_ID, valid(), ACTOR_ID, conn)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/already has a pay rate change on that date/) });
    await expect(createStep(TECH_ID, { ...valid(), hourlyRate: '25.50' }, ACTOR_ID, conn)).rejects.toMatchObject({ status: 409 });
    expect(conn.transaction).toHaveBeenCalledTimes(2);
  });
});

describe('cancelStep', () => {
  it('answers 404 for an id that is not a uuid and 403 without an actor', async () => {
    await expect(cancelStep('nope', ACTOR_ID, untouched)).rejects.toMatchObject({ status: 404 });
    await expect(cancelStep(TECH_ID, null, untouched)).rejects.toMatchObject({ status: 403 });
  });
});
