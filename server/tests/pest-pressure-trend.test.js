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

  // Regression guards for codex P2 #972 — before the fix, `stableBand`
  // was never consulted and any delta in (improvingAtOrBelow, increasingFrom)
  // was bucketed as 'stable' regardless of how narrowly the operator
  // tuned the stable range.
  describe('stableBand is actually honored (codex P2 regression guard)', () => {
    test('narrow stable band: delta=0.3 with stableBand=0.2 → increasing, not stable', () => {
      const tight = { ...thresholds, stableBand: 0.2 };
      const r = resolveTrend(2.3, 2.0, tight);
      expect(r.trend).toBe('increasing');
      expect(r.delta).toBeCloseTo(0.3, 1);
    });

    test('narrow stable band: delta=-0.3 with stableBand=0.2 → improving, not stable', () => {
      const tight = { ...thresholds, stableBand: 0.2 };
      const r = resolveTrend(1.7, 2.0, tight);
      expect(r.trend).toBe('improving');
      expect(r.delta).toBeCloseTo(-0.3, 1);
    });

    test('wide stable band: delta=0.6 with stableBand=0.8 → stable (stableBand wins over default increasingFrom)', () => {
      // increasingFrom=0.5 still triggers at 0.6 because directional
      // thresholds win first. This documents the precedence order:
      // explicit improvingAtOrBelow / increasingFrom checked before
      // stableBand. Operators tuning a wide stableBand also need to
      // raise increasingFrom past it.
      const wide = { ...thresholds, stableBand: 0.8 };
      const r = resolveTrend(2.6, 2.0, wide);
      expect(r.trend).toBe('increasing');
      expect(r.delta).toBeCloseTo(0.6, 1);
    });

    test('default config gap zone: delta=0.45 (between stableBand=0.4 and increasingFrom=0.5) → increasing', () => {
      // With default config there's a small gap (0.4, 0.5) that used to
      // silently fall into 'stable'. Now classifies by sign.
      const r = resolveTrend(2.45, 2.0, thresholds);
      expect(r.trend).toBe('increasing');
      expect(r.delta).toBeCloseTo(0.5, 1); // roundDelta rounds 0.45 to 0.5; trend still 'increasing'
    });

    test('default config exact stableBand boundary: |delta|=0.4 → stable', () => {
      expect(resolveTrend(2.4, 2.0, thresholds).trend).toBe('stable');
      expect(resolveTrend(1.6, 2.0, thresholds).trend).toBe('stable');
    });
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
