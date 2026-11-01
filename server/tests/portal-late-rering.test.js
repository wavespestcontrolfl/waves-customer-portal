// The one late re-ring for portal items (GATE_PORTAL_LATE_RERING): the due time and the gate. The SQL, the
// witnesses and the single-ring fence run against Postgres in portal-item-close-postgres.test.js.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockDb = jest.fn(() => { throw new Error('the gate is off: nothing should be read'); });
jest.mock('../models/db', () => mockDb);

const { dueAtFor, runPortalLateRering } = require('../services/portal-late-rering');

// Eastern wall-clock times in November 2026 (EST, UTC-5): 8 AM-8 PM is 13:00-01:00 UTC.
const est = (day, hhmm) => new Date(`2026-11-${day}T${hhmm}:00-05:00`);

describe('the due time: one business hour counted only between 8 AM and 8 PM ET (owner 2026-09-26)', () => {
  test.each([
    ['10:00 AM -> 11:00 AM the same day', est('03', '10:00'), est('03', '11:00')],
    ['7:10 AM (before opening) -> 9:00 AM', est('03', '07:10'), est('03', '09:00')],
    ['7:30 PM -> 8:30 AM the next day', est('03', '19:30'), est('04', '08:30')],
    ['8:00 PM sharp -> 9:00 AM the next day', est('03', '20:00'), est('04', '09:00')],
    ['11:30 PM -> 9:00 AM the next day', est('03', '23:30'), est('04', '09:00')],
    ['a Saturday 10:00 AM -> 11:00 AM (weekends count)', est('07', '10:00'), est('07', '11:00')],
    ['a Saturday 7:45 PM -> Sunday 8:45 AM', est('07', '19:45'), est('08', '08:45')],
  ])('%s', (_label, asked, due) => {
    expect(dueAtFor(asked).getTime()).toBe(due.getTime());
  });

  test('a bad time has no due time', () => {
    expect(dueAtFor(new Date('not a date'))).toBeNull();
  });
});

describe('the gate', () => {
  afterEach(() => { delete process.env.GATE_PORTAL_LATE_RERING; });
  test.each([[undefined], [''], ['1'], ['on'], ['TRUE'], ['shadow']])('GATE_PORTAL_LATE_RERING = %j reads and writes nothing', async (value) => {
    if (value === undefined) delete process.env.GATE_PORTAL_LATE_RERING; else process.env.GATE_PORTAL_LATE_RERING = value;
    expect(await runPortalLateRering({ now: new Date() })).toEqual({ skipped: true, reason: 'gate_off' });
    expect(mockDb).not.toHaveBeenCalled();
  });
});
