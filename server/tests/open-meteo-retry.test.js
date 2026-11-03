/**
 * Open-Meteo second try for the Monday watering sweep (owner 2026-11-03).
 *
 * Pins the budget contract: a retryable miss gets ONE more try at the longer
 * limit after the pause, a final miss or a caller without a budget gets none,
 * and the run's time budget stops second tries once it is spent.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  createOpenMeteoRetry, withOpenMeteoRetry, retryableStatus, RETRY_DELAY_MS, RETRY_TIMEOUT_MS,
} = require('../services/open-meteo-retry');

const miss = (retryable) => ({ value: null, ok: false, retryable });
const hit = (value) => ({ value, ok: true, retryable: false });

describe('withOpenMeteoRetry', () => {
  test('a retryable miss gets one second try at the longer limit, after the pause', async () => {
    const sleep = jest.fn(async () => {});
    const retry = createOpenMeteoRetry({ sleep });
    const attempt = jest.fn().mockResolvedValueOnce(miss(true)).mockResolvedValueOnce(hit({ rainInches: 0.4 }));
    await expect(withOpenMeteoRetry(attempt, { firstTimeoutMs: 3500, retry, label: 'forecast' })).resolves.toEqual({ rainInches: 0.4 });
    expect(attempt.mock.calls.map(([ms]) => ms)).toEqual([3500, RETRY_TIMEOUT_MS]);
    expect(sleep).toHaveBeenCalledWith(RETRY_DELAY_MS);
    expect(retry.stats).toMatchObject({ used: 1, recovered: 1 });
  });

  test('a hit, a final miss, or a caller with no budget makes exactly one request', async () => {
    const retry = createOpenMeteoRetry({ sleep: async () => {} });
    for (const [first, budget] of [[hit(1), retry], [miss(false), retry], [miss(true), undefined]]) {
      const attempt = jest.fn().mockResolvedValue(first);
      await withOpenMeteoRetry(attempt, { firstTimeoutMs: 3500, retry: budget, label: 'service-week forecast' });
      expect(attempt).toHaveBeenCalledTimes(1);
    }
    expect(retry.stats.used).toBe(0);
  });

  test('the run stops second tries once its time budget is spent; misses then fail soft at once', async () => {
    // Each second try costs 15 s on this clock; a 20 s budget allows two.
    let clockMs = 0;
    const retry = createOpenMeteoRetry({ budgetMs: 20000, sleep: async () => { clockMs += 15000; }, now: () => clockMs });
    const attempt = jest.fn().mockResolvedValue(miss(true));
    for (let i = 0; i < 3; i += 1) {
      await expect(withOpenMeteoRetry(attempt, { firstTimeoutMs: 3500, retry, label: 'forecast' })).resolves.toBeNull();
    }
    // 2 misses x 2 tries + 1 miss x 1 try.
    expect(attempt).toHaveBeenCalledTimes(5);
    expect(retry.stats).toMatchObject({ used: 2, recovered: 0, spentMs: 30000 });
  });
});

test('retryableStatus: 429 and 5xx can pass on a second try, other answers cannot', () => {
  expect([429, 500, 502, 503].map(retryableStatus)).toEqual([true, true, true, true]);
  expect([400, 401, 404, undefined].map(retryableStatus)).toEqual([false, false, false, false]);
});
