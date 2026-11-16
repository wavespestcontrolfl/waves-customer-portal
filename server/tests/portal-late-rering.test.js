// The one late re-ring for portal items: the due time. The SQL, the
// witnesses and the single-ring fence run against Postgres in portal-item-close-postgres.test.js.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockDb = jest.fn(() => { throw new Error('the due time reads nothing'); });
jest.mock('../models/db', () => mockDb);

const { dueAtFor, estimateDueAtFor } = require('../services/portal-late-rering');

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

describe('the owed-estimate due time: 24 business hours on the 8 AM-8 PM ET clock (owner 2026-11-02)', () => {
  test.each([
    ['10:00 AM Mon -> 10:00 AM Wed', est('02', '10:00'), est('04', '10:00')],
    ['7:30 PM Mon -> 7:30 PM Wed (half an hour left Mon, all of Tue, the rest Wed)', est('02', '19:30'), est('04', '19:30')],
    ['7:00 AM Mon (before opening) -> 8:00 PM Tue (the clock starts at 8:00 AM Mon)', est('02', '07:00'), est('03', '20:00')],
    ['8:00 PM Mon sharp -> 8:00 PM Wed', est('02', '20:00'), est('04', '20:00')],
    ['a Friday 10:00 AM -> Sunday 10:00 AM (weekends count)', est('06', '10:00'), est('08', '10:00')],
  ])('%s', (_label, asked, due) => {
    expect(estimateDueAtFor(asked).getTime()).toBe(due.getTime());
  });

  test('a bad time has no due time', () => {
    expect(estimateDueAtFor(new Date('not a date'))).toBeNull();
  });
});
