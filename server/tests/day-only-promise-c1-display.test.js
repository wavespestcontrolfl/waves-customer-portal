/**
 * GATE_DAY_ONLY_PROMISE part C1: the shared piece every customer screen uses (services/time-display.js).
 * One bulk loadTimeDisplay call per payload; a failure shows the hour; the confirm echo for a day-only page.
 */

const mockLoadTimeDisplay = jest.fn();
jest.mock('../services/time-promise', () => ({ loadTimeDisplay: (...args) => mockLoadTimeDisplay(...args) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const logger = require('../services/logger');
const {
  ARRIVAL_NOTE, dayOnlyIds, dayOnlyFields, shownSlotFor,
} = require('../services/time-display');

const conn = Symbol('conn');
const row = (id, window_start = '09:00:00') => ({ id, scheduled_date: '2099-01-12', window_start });

function verdicts(map) {
  return new Map(Object.entries(map).map(([id, showHour]) => [id, { showHour, level: 'none', eligible: !showHour }]));
}

describe('time-display', () => {
  beforeEach(() => jest.clearAllMocks());

  test('the one shared wording', () => {
    expect(ARRIVAL_NOTE).toBe('Arrival window texted the day before');
    expect(dayOnlyFields(true)).toEqual({ day_only: true, arrival_note: 'Arrival window texted the day before' });
    // A shown hour adds NO key, so a gate-off payload is byte-for-byte today's.
    expect(dayOnlyFields(false)).toEqual({});
  });

  test('dayOnlyIds asks loadTimeDisplay ONCE for all rows and returns the hidden ids', async () => {
    mockLoadTimeDisplay.mockResolvedValue(verdicts({ a: false, b: true, c: false }));
    const rows = [row('a'), row('b'), row('c')];
    const hidden = await dayOnlyIds(conn, rows);
    expect(mockLoadTimeDisplay).toHaveBeenCalledTimes(1);
    expect(mockLoadTimeDisplay).toHaveBeenCalledWith(conn, rows, expect.any(Date));
    expect([...hidden].sort()).toEqual(['a', 'c']);
  });

  test('a row with no hour to hide is not asked about, and no rows means no read', async () => {
    mockLoadTimeDisplay.mockResolvedValue(verdicts({ a: false }));
    await dayOnlyIds(conn, [row('a'), row('w', null)]);
    expect(mockLoadTimeDisplay.mock.calls[0][1].map((r) => r.id)).toEqual(['a']);
    mockLoadTimeDisplay.mockClear();
    expect((await dayOnlyIds(conn, [row('w', null)])).size).toBe(0);
    expect((await dayOnlyIds(conn, [])).size).toBe(0);
    expect((await dayOnlyIds(conn, null)).size).toBe(0);
    expect(mockLoadTimeDisplay).not.toHaveBeenCalled();
  });

  test('a loadTimeDisplay failure shows the hour (nothing hidden) and logs once', async () => {
    mockLoadTimeDisplay.mockRejectedValue(new Error('db down'));
    expect((await dayOnlyIds(conn, [row('a')])).size).toBe(0);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  test('ids compare as strings (numeric ids from the database)', async () => {
    mockLoadTimeDisplay.mockResolvedValue(new Map([[7, { showHour: false }]]));
    expect((await dayOnlyIds(conn, [row(7)])).has('7')).toBe(true);
  });

  describe('shownSlotFor (the confirm echo of a day-only page)', () => {
    const svc = row('a', '09:00:00');

    test('a blank echo for a day-only visit stands in with the row\'s current start', async () => {
      mockLoadTimeDisplay.mockResolvedValue(verdicts({ a: false }));
      for (const blank of [{ date: '2099-01-12' }, { date: '2099-01-12', windowStart: null }, { date: '2099-01-12', windowStart: '' }]) {
        expect(await shownSlotFor(conn, svc, blank)).toEqual({ ...blank, windowStart: '09:00' });
      }
    });

    test('an echoed hour is compared as it came (no read)', async () => {
      const body = { date: '2099-01-12', windowStart: '10:00' };
      expect(await shownSlotFor(conn, svc, body)).toBe(body);
      expect(mockLoadTimeDisplay).not.toHaveBeenCalled();
    });

    test('a blank echo for a visit that shows its hour stays blank, so the match fails and the customer reloads', async () => {
      mockLoadTimeDisplay.mockResolvedValue(verdicts({ a: true }));
      const body = { date: '2099-01-12', windowStart: null };
      expect(await shownSlotFor(conn, svc, body)).toBe(body);
    });

    test('a windowless row, a missing row, a failure: the body is untouched', async () => {
      const body = { date: '2099-01-12' };
      expect(await shownSlotFor(conn, row('w', null), body)).toBe(body);
      expect(await shownSlotFor(conn, null, body)).toBe(body);
      mockLoadTimeDisplay.mockRejectedValue(new Error('db down'));
      expect(await shownSlotFor(conn, svc, body)).toBe(body);
      expect(await shownSlotFor(conn, svc, undefined)).toEqual({});
    });
  });
});
