/**
 * GATE_DAY_ONLY_PROMISE part D: services/day-only-ai-context.js, the one question every AI context builder asks
 * ("which of these visits is day-only?"). No database, no model call: the promise reader is mocked.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/time-promise', () => ({ dayOnlyPromiseOn: jest.fn(), loadTimeDisplay: jest.fn() }));

const timePromise = require('../services/time-promise');
const { DAY_ONLY_ARRIVAL_NOTE, loadDayOnlyCheck } = require('../services/day-only-ai-context');

const ROWS = [{ id: 'v1' }, { id: 'v2' }, { id: 'v3' }];
const CONN = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  timePromise.dayOnlyPromiseOn.mockReturnValue(true);
});

describe('the note', () => {
  test('tells the model not to state or guess an hour and where to send the customer', () => {
    expect(DAY_ONLY_ARRIVAL_NOTE).toBe('texted the day before (do not state or guess an hour; if the customer needs a set time, offer the reschedule link or the office)');
    expect(DAY_ONLY_ARRIVAL_NOTE).not.toMatch(/\d{1,2}(:\d{2})? ?(AM|PM)/i);
  });
});

describe('loadDayOnlyCheck', () => {
  test('gate off: nothing is day-only and the promise reader is never called', async () => {
    timePromise.dayOnlyPromiseOn.mockReturnValue(false);
    const isDayOnly = await loadDayOnlyCheck(CONN, ROWS);
    expect(ROWS.map(isDayOnly)).toEqual([false, false, false]);
    expect(timePromise.loadTimeDisplay).not.toHaveBeenCalled();
  });

  test('gate on: ONE bulk read for all rows; showHour false = day-only, showHour true = keep the hour', async () => {
    timePromise.loadTimeDisplay.mockResolvedValue(new Map([
      ['v1', { showHour: false, level: 'none', eligible: true }],
      ['v2', { showHour: true, level: 'hour', eligible: false }],
      ['v3', { showHour: true, level: 'none', eligible: true }],
    ]));
    const isDayOnly = await loadDayOnlyCheck(CONN, ROWS);
    expect(timePromise.loadTimeDisplay).toHaveBeenCalledTimes(1);
    expect(timePromise.loadTimeDisplay.mock.calls[0][1]).toEqual(ROWS);
    expect(ROWS.map(isDayOnly)).toEqual([true, false, false]);
  });

  test('gate on: a thrown read says only the day for every visit (never leaks an hour)', async () => {
    timePromise.loadTimeDisplay.mockRejectedValue(new Error('db down'));
    const isDayOnly = await loadDayOnlyCheck(CONN, ROWS);
    expect(ROWS.map(isDayOnly)).toEqual([true, true, true]);
  });

  test('gate on: a visit the read did not judge, or one with no id, says only the day', async () => {
    timePromise.loadTimeDisplay.mockResolvedValue(new Map([['v1', { showHour: true }]]));
    const isDayOnly = await loadDayOnlyCheck(CONN, [{ id: 'v1' }, { id: 'v9' }, { id: null }]);
    expect([{ id: 'v1' }, { id: 'v9' }, { id: null }].map(isDayOnly)).toEqual([false, true, true]);
  });

  test('no rows: nothing to read', async () => {
    const isDayOnly = await loadDayOnlyCheck(CONN, []);
    expect(isDayOnly({ id: 'v1' })).toBe(false);
    expect(timePromise.loadTimeDisplay).not.toHaveBeenCalled();
  });
});
