/**
 * Weekly days off (owner ask 2026-07-23): recurring weekday closures layered
 * into the shared blackout-dates helpers, so every consumer — find-time
 * enumeration, estimate ASAP fallback, rebooker, reschedule-sms, the
 * signed-offer redemption + commit re-checks, and the recurring seeder —
 * inherits them without call-site changes. Seeded to Sat+Sun (0 and 6) by
 * migration 20260723400001 at the owner's direction.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const {
  getBlackoutDates,
  isBlackoutDate,
  getWeeklyDaysOff,
  expandWeeklyDaysOff,
} = require('../services/scheduling/blackout-dates');

// 2026-07-24 is a Friday; 07-25 Sat, 07-26 Sun, 07-27 Mon.
function mockTables({ weeklyValue, blackoutDates = [], down = false } = {}) {
  db.mockImplementation((table) => {
    if (down) throw new Error('db down');
    if (table === 'system_settings') {
      return {
        where: () => ({
          first: async () => (weeklyValue === undefined ? null : { value: weeklyValue }),
        }),
      };
    }
    if (table === 'schedule_blackout_dates') {
      return {
        whereBetween: () => ({
          select: async () => blackoutDates.map((d) => ({ date: d })),
        }),
        where: (col, dateStr) => ({
          first: async () => (blackoutDates.includes(dateStr) ? { id: 'row' } : null),
        }),
      };
    }
    throw new Error(`unexpected table ${table}`);
  });
}

beforeEach(() => db.mockReset());

describe('expandWeeklyDaysOff (pure)', () => {
  test('emits every Sat/Sun in range, inclusive of both ends', () => {
    expect(expandWeeklyDaysOff('2026-07-24', '2026-07-27', new Set([0, 6])))
      .toEqual(['2026-07-25', '2026-07-26']);
  });

  test('empty set → no dates', () => {
    expect(expandWeeklyDaysOff('2026-07-24', '2026-07-27', new Set())).toEqual([]);
  });
});

describe('getWeeklyDaysOff', () => {
  test('parses the seeded JSON array', async () => {
    mockTables({ weeklyValue: '[0,6]' });
    expect([...(await getWeeklyDaysOff())].sort()).toEqual([0, 6]);
  });

  test('malformed / non-array / out-of-range values fail open', async () => {
    mockTables({ weeklyValue: 'not json' });
    expect((await getWeeklyDaysOff()).size).toBe(0);
    mockTables({ weeklyValue: '{"a":1}' });
    expect((await getWeeklyDaysOff()).size).toBe(0);
    mockTables({ weeklyValue: '[7,-1,"x",6]' });
    expect([...(await getWeeklyDaysOff())]).toEqual([6]);
  });

  test('missing row → empty set', async () => {
    mockTables({});
    expect((await getWeeklyDaysOff()).size).toBe(0);
  });
});

describe('getBlackoutDates merges one-off dates with weekly closures', () => {
  test('range set contains explicit rows AND every weekly occurrence', async () => {
    mockTables({ weeklyValue: '[0,6]', blackoutDates: ['2026-07-29'] });
    const set = await getBlackoutDates('2026-07-24', '2026-07-31');
    expect([...set].sort()).toEqual(['2026-07-25', '2026-07-26', '2026-07-29']);
  });

  test('table outage still applies weekly closures (per-layer fail-open)', async () => {
    db.mockImplementation((table) => {
      if (table === 'system_settings') {
        return { where: () => ({ first: async () => ({ value: '[0,6]' }) }) };
      }
      throw new Error('db down');
    });
    const set = await getBlackoutDates('2026-07-24', '2026-07-27');
    expect([...set].sort()).toEqual(['2026-07-25', '2026-07-26']);
  });
});

describe('isBlackoutDate honors weekly closures', () => {
  test('a Saturday is blacked out with no table row', async () => {
    mockTables({ weeklyValue: '[0,6]' });
    expect(await isBlackoutDate('2026-07-25')).toBe(true);
    expect(await isBlackoutDate(new Date('2026-07-26T12:00:00Z'))).toBe(true);
  });

  test('a weekday without a table row stays open', async () => {
    mockTables({ weeklyValue: '[0,6]' });
    expect(await isBlackoutDate('2026-07-27')).toBe(false);
  });

  test('one-off table rows still match', async () => {
    mockTables({ weeklyValue: '[]', blackoutDates: ['2026-07-29'] });
    expect(await isBlackoutDate('2026-07-29')).toBe(true);
  });

  test('total db outage fails open', async () => {
    mockTables({ down: true });
    expect((await getBlackoutDates('2026-07-24', '2026-07-27')).size).toBe(0);
    expect(await isBlackoutDate('2026-07-25')).toBe(false);
  });
});
