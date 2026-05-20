const { DEFAULT_CONFIG } = require('../services/pest-pressure/config');
const { resolveTrend } = require('../services/pest-pressure/trend');
const { resolveLabel } = require('../services/pest-pressure/label');

const thresholds = DEFAULT_CONFIG.trendThresholds;

describe('resolveTrend', () => {
  test('null score → insufficient_data', () => {
    expect(resolveTrend(null, 1.0, thresholds)).toEqual({ trend: 'insufficient_data', delta: null });
  });

  test('null previousScore → first_marker', () => {
    expect(resolveTrend(2.3, null, thresholds)).toEqual({ trend: 'first_marker', delta: null });
  });

  test.each([
    [2.0, 2.5, 'improving', -0.5],
    [1.0, 2.0, 'improving', -1.0],
    [2.0, 2.4, 'stable', -0.4],
    [2.4, 2.0, 'stable', 0.4],
    [2.5, 2.0, 'increasing', 0.5],
    [2.9, 2.0, 'increasing', 0.9],
    [3.0, 2.0, 'significant_increase', 1.0],
    [4.5, 2.0, 'significant_increase', 2.5],
  ])('score %f vs previous %f → %s (delta %f)', (score, previous, expected, delta) => {
    const r = resolveTrend(score, previous, thresholds);
    expect(r.trend).toBe(expected);
    expect(r.delta).toBeCloseTo(delta, 1);
  });
});

describe('resolveLabel', () => {
  test('returns null for null score', () => {
    expect(resolveLabel(null, DEFAULT_CONFIG.labels)).toBeNull();
  });

  test('returns the band that contains the score', () => {
    expect(resolveLabel(0.5, DEFAULT_CONFIG.labels).key).toBe('very_low');
    expect(resolveLabel(1.5, DEFAULT_CONFIG.labels).key).toBe('low');
    expect(resolveLabel(2.5, DEFAULT_CONFIG.labels).key).toBe('moderate');
    expect(resolveLabel(3.5, DEFAULT_CONFIG.labels).key).toBe('elevated');
    expect(resolveLabel(4.5, DEFAULT_CONFIG.labels).key).toBe('high');
  });

  test('boundary scores resolve to their stated band', () => {
    expect(resolveLabel(0.9, DEFAULT_CONFIG.labels).key).toBe('very_low');
    expect(resolveLabel(1.0, DEFAULT_CONFIG.labels).key).toBe('low');
    expect(resolveLabel(5.0, DEFAULT_CONFIG.labels).key).toBe('high');
  });

  test('out-of-range scores clamp to nearest band rather than crashing', () => {
    expect(resolveLabel(-1, DEFAULT_CONFIG.labels).key).toBe('very_low');
    expect(resolveLabel(7, DEFAULT_CONFIG.labels).key).toBe('high');
  });
});
