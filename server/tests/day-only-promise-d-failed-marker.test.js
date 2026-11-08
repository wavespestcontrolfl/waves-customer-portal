/**
 * GATE_DAY_ONLY_PROMISE part D: loadDayOnlyCheck against the REAL loadTimeDisplay (time-promise.js, B1) with a forced
 * read failure. B1 marks each row of a failed eligibility read with failed: true; a screen ignores it (and keeps the hour),
 * an AI context treats it as day-only. No mocks of the promise reader, no database.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { loadTimeDisplay } = require('../services/time-promise');
const { loadDayOnlyCheck } = require('../services/day-only-ai-context');

const NOW = new Date('2026-11-10T09:00:00Z');
const ROWS = [
  { id: 's1', scheduled_date: '2026-11-20', window_start: '09:00:00' },
  { id: 's2', scheduled_date: '2026-11-21', window_start: '13:00:00' },
];

/** A knex-shaped fake: every read of `failTable` throws, any other read answers with no rows. */
function conn(failTable = null) {
  const make = (table) => {
    const chain = {};
    for (const m of ['join', 'leftJoin', 'whereRaw', 'whereBetween', 'whereNull', 'whereNotNull', 'distinct', 'orWhere', 'orderBy', 'where', 'whereIn', 'whereNotIn']) chain[m] = () => chain;
    chain.select = async () => {
      if (failTable === table) throw new Error(`read failed: ${table}`);
      return [];
    };
    return chain;
  };
  const c = (table) => make(table);
  c.raw = (sql, bindings) => ({ sql, bindings });
  c.isTransaction = true;
  return c;
}

const OLD = process.env.GATE_DAY_ONLY_PROMISE;
beforeEach(() => { process.env.GATE_DAY_ONLY_PROMISE = 'true'; });
afterEach(() => { if (OLD === undefined) delete process.env.GATE_DAY_ONLY_PROMISE; else process.env.GATE_DAY_ONLY_PROMISE = OLD; });

describe('a forced read failure through the real loadTimeDisplay', () => {
  test('every row is marked failed, and a screen still shows the hour', async () => {
    const out = await loadTimeDisplay(conn('scheduled_services'), ROWS, NOW);
    expect(out.get('s1')).toEqual({ showHour: true, level: 'hour', eligible: false, failed: true });
    expect(out.get('s2').failed).toBe(true);
  });

  test('the AI check says only the day for every row (never the hour)', async () => {
    const isDayOnly = await loadDayOnlyCheck(conn('scheduled_services'), ROWS, NOW);
    expect(ROWS.map(isDayOnly)).toEqual([true, true]);
  });

  test('a good read of a visit that is not day-only carries no marker and keeps the hour', async () => {
    // No reminder rows: the first visit has no office booking source, so it is not eligible (a real verdict, not a failure).
    const out = await loadTimeDisplay(conn(), ROWS, NOW);
    expect('failed' in out.get('s1')).toBe(false);
    const isDayOnly = await loadDayOnlyCheck(conn(), ROWS, NOW);
    expect(ROWS.map(isDayOnly)).toEqual([false, false]);
  });
});
