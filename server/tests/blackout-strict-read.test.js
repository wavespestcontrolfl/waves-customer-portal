/**
 * Owner 2026-10-09: the closed-day readers fail open for every customer
 * surface, but the nightly auto-dispatch path must BLOCK when the list cannot
 * be read. `{ strict: true }` is the one switch; the default is unchanged.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const db = require('../models/db');
const blackout = require('../services/scheduling/blackout-dates');

// A conn whose every table read rejects.
const failingConn = () => jest.fn(() => {
  const c = {};
  ['where', 'whereBetween'].forEach((m) => { c[m] = () => c; });
  c.first = async () => { throw new Error('db down'); };
  c.select = async () => { throw new Error('db down'); };
  return c;
});

describe('blackout-dates: strict option', () => {
  test('default: an unreadable list fails open (empty set / false / not closed)', async () => {
    const conn = failingConn();
    expect((await blackout.getWeeklyDaysOff(conn)).size).toBe(0);
    expect((await blackout.getBlackoutDates('2026-12-01', '2026-12-07', conn)).size).toBe(0);
    expect(await blackout.isBlackoutDate('2026-12-03', conn)).toBe(false);
  });

  test('strict: every reader throws instead', async () => {
    const conn = failingConn();
    await expect(blackout.getWeeklyDaysOff(conn, { strict: true })).rejects.toThrow('db down');
    await expect(blackout.getBlackoutDates('2026-12-01', '2026-12-07', conn, { strict: true })).rejects.toThrow('db down');
    await expect(blackout.isBlackoutDate('2026-12-03', conn, { strict: true })).rejects.toThrow('db down');
  });

  test('strict does not change a good read', async () => {
    const conn = jest.fn((table) => {
      const c = {};
      ['where', 'whereBetween'].forEach((m) => { c[m] = () => c; });
      c.first = async () => (table === 'system_settings' ? { value: '[0]' } : null);
      c.select = async () => [{ date: '2026-12-02' }];
      return c;
    });
    expect(await blackout.isBlackoutDate('2026-12-06', conn, { strict: true })).toBe(true); // a Sunday
    expect(await blackout.isBlackoutDate('2026-12-02', conn, { strict: true })).toBe(false); // weekly read says only Sunday; one-off read is a first() miss
    const dates = await blackout.getBlackoutDates('2026-12-01', '2026-12-07', conn, { strict: true });
    expect([...dates].sort()).toEqual(['2026-12-02', '2026-12-06']);
  });
});

describe('find-time: strictBlackout reaches the destination-day filter', () => {
  const chain = (rows) => {
    const c = new Proxy({}, {
      get: (_t, prop) => {
        if (prop === 'then') return (resolve) => resolve(rows);
        return () => c;
      },
    });
    return c;
  };

  test('the search throws when the strict closed-day read fails, and passes the option through', async () => {
    const spy = jest.spyOn(blackout, 'getBlackoutDates').mockRejectedValue(new Error('blackout list unreadable'));
    db.raw = jest.fn((sql) => ({ sql }));
    db.mockImplementation((table) => chain(table === 'technicians' ? [{ id: 't1', name: 'A' }] : []));
    const { findAvailableSlots } = require('../services/scheduling/find-time');
    const opts = {
      lat: 27.4, lng: -82.5, durationMinutes: 60, dateFrom: '2026-12-01', dateTo: '2026-12-07', includeWeekends: true,
    };
    await expect(findAvailableSlots({ ...opts, strictBlackout: true })).rejects.toThrow('blackout list unreadable');
    expect(spy).toHaveBeenLastCalledWith('2026-12-01', '2026-12-07', undefined, { strict: true });
    // Without the option the call is the old fail-open one.
    spy.mockResolvedValue(new Set());
    await findAvailableSlots(opts).catch(() => {});
    expect(spy).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), undefined, { strict: false });
    spy.mockRestore();
  });
});
