/**
 * isOfficeOpenAt — the pure office-open predicate the estimate-promise wording
 * is decided from (hook P1 on #3569). Unknown is never open.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const { isOfficeOpenAt } = require('../services/voice-agent/relay-context');

const HOURS = { startMin: 8 * 60, endMin: 17 * 60, closedToday: false, closedTomorrow: false };
const ET_10AM = new Date('2026-08-28T14:00:00Z'); // 10:00 ET (EDT)
const ET_7AM = new Date('2026-08-28T11:00:00Z');
const ET_5PM = new Date('2026-08-28T21:00:00Z');
const ET_459PM = new Date('2026-08-28T20:59:00Z');

test('inside the window ⇒ true; before/at end ⇒ false', () => {
  expect(isOfficeOpenAt(HOURS, ET_10AM)).toBe(true);
  expect(isOfficeOpenAt(HOURS, ET_459PM)).toBe(true);
  expect(isOfficeOpenAt(HOURS, ET_7AM)).toBe(false);
  expect(isOfficeOpenAt(HOURS, ET_5PM)).toBe(false);
});

test('a scheduled day off ⇒ false even inside the window', () => {
  expect(isOfficeOpenAt({ ...HOURS, closedToday: true }, ET_10AM)).toBe(false);
});

test('closure flags loaded for a different ET date (midnight rollover) ⇒ unknown, never reused', () => {
  const loadedYesterday = { ...HOURS, closedToday: false, closedForDate: '2026-08-27' };
  expect(isOfficeOpenAt(loadedYesterday, ET_10AM)).toBeNull(); // 2026-08-28 in ET
  expect(isOfficeOpenAt({ ...HOURS, closedForDate: '2026-08-28' }, ET_10AM)).toBe(true);
  expect(isOfficeOpenAt({ ...HOURS, closedToday: true, closedForDate: '2026-08-28' }, ET_10AM)).toBe(false);
});

test('unknown is NEVER open: no hours, bad hours, or closedUnknown ⇒ null', () => {
  expect(isOfficeOpenAt(null, ET_10AM)).toBeNull();
  expect(isOfficeOpenAt({}, ET_10AM)).toBeNull();
  expect(isOfficeOpenAt({ startMin: NaN, endMin: 17 * 60 }, ET_10AM)).toBeNull();
  expect(isOfficeOpenAt({ startMin: 8 * 60, endMin: 17 * 60, closedUnknown: true }, ET_10AM)).toBeNull();
});
