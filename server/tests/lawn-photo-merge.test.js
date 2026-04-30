/**
 * Pure-function tests for the multi-photo merge helpers used by
 * /assess. These are intentionally DB-free so they run on any
 * developer box without DATABASE_URL.
 */

const { withConcurrency, majorityVote } = require('../services/lawn-photo-merge');

describe('withConcurrency', () => {
  test('preserves input order even when fn resolves out of order', async () => {
    const items = [10, 30, 5, 20, 0];
    const out = await withConcurrency(items, 2, async (n) => {
      // Smaller delays resolve first, but the result array MUST stay in input order.
      await new Promise((r) => setTimeout(r, n));
      return n * 2;
    });
    expect(out).toEqual([20, 60, 10, 40, 0]);
  });

  test('actually parallelises within a batch', async () => {
    const start = Date.now();
    // 4 items × 50ms each, cap=2 → ~2 batches × 50ms = ~100ms.
    // If sequential, we'd see ~200ms.
    await withConcurrency([1, 2, 3, 4], 2, () => new Promise((r) => setTimeout(r, 50)));
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(180);
    expect(elapsed).toBeGreaterThanOrEqual(95);
  });

  test('cap of 1 is effectively sequential', async () => {
    const order = [];
    await withConcurrency([10, 20, 30], 1, async (n) => {
      order.push(`start:${n}`);
      await new Promise((r) => setTimeout(r, 1));
      order.push(`end:${n}`);
    });
    // With cap=1, each item finishes before the next starts.
    expect(order).toEqual(['start:10', 'end:10', 'start:20', 'end:20', 'start:30', 'end:30']);
  });

  test('passes the original index to fn', async () => {
    const seen = [];
    await withConcurrency(['a', 'b', 'c'], 3, (item, i) => {
      seen.push([item, i]);
      return null;
    });
    expect(seen.sort()).toEqual([['a', 0], ['b', 1], ['c', 2]]);
  });

  test('empty input returns empty array', async () => {
    const out = await withConcurrency([], 3, () => 'x');
    expect(out).toEqual([]);
  });

  test('non-positive cap is clamped to 1 (does not divide-by-zero)', async () => {
    const out = await withConcurrency([1, 2], 0, (n) => n * 10);
    expect(out).toEqual([10, 20]);
  });

  test('throws on bad inputs', async () => {
    await expect(withConcurrency('not-an-array', 2, () => 1)).rejects.toThrow(/items must be an array/);
    await expect(withConcurrency([1], 2, 'not-a-fn')).rejects.toThrow(/fn must be a function/);
  });
});

describe('majorityVote', () => {
  test('1-photo case returns that photo\'s value (back-compat with first-valid)', () => {
    expect(majorityVote(['present'])).toBe('present');
    expect(majorityVote(['absent'])).toBe('absent');
  });

  test('2-of-3 wins over 1', () => {
    expect(majorityVote(['present', 'absent', 'present'])).toBe('present');
    expect(majorityVote(['absent', 'absent', 'present'])).toBe('absent');
  });

  test('skips null/undefined', () => {
    expect(majorityVote([null, 'present', 'present'])).toBe('present');
    expect(majorityVote([undefined, undefined, 'absent'])).toBe('absent');
  });

  test('all-null returns fallback', () => {
    expect(majorityVote([null, null], 'fallback-value')).toBe('fallback-value');
    expect(majorityVote([], 'fallback-value')).toBe('fallback-value');
  });

  test('default fallback is null', () => {
    expect(majorityVote([])).toBeNull();
  });

  test('tie resolves to first-seen value', () => {
    // 1 vote each; first non-null seen is 'present'.
    expect(majorityVote(['present', 'absent'])).toBe('present');
    expect(majorityVote(['absent', 'present'])).toBe('absent');
    // 2-2 tie also goes to first-seen.
    expect(majorityVote(['absent', 'absent', 'present', 'present'])).toBe('absent');
  });

  test('non-array input returns fallback', () => {
    expect(majorityVote(null, 'fb')).toBe('fb');
    expect(majorityVote('string', 'fb')).toBe('fb');
  });
});
