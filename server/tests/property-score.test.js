// Property Score composite rules. The overall number averages ONLY condition
// components that actually carry a score (lawn / pest / tree & shrub) with
// equal weights; protection components (termite, mosquito) and irrigation
// status never enter the number. Delta pairs only components with BOTH a
// current and previous value so movement always reflects real data.

const { _test } = require('../services/property-score');
const { lawnOverall, lawnStressDamage } = require('../services/lawn-health-shared');

const { composeOverall, pressureToHealth, movementReason } = _test;

describe('composeOverall', () => {
  it('averages only scored components with equal weights', () => {
    const result = composeOverall([
      { key: 'lawn', status: 'scored', score: 90, previousScore: null },
      { key: 'tree_shrub', status: 'scored', score: 70, previousScore: null },
      { key: 'termite', status: 'active' },
      { key: 'mosquito', status: 'not_monitored' },
      { key: 'irrigation', status: 'status', waterStatus: 'high' },
    ]);
    expect(result.score).toBe(80);
    expect(result.componentCount).toBe(2);
    expect(result.delta).toBeNull();
  });

  it('returns null score when nothing is scored', () => {
    const result = composeOverall([
      { key: 'termite', status: 'active' },
      { key: 'lawn', status: 'pending' },
    ]);
    expect(result).toEqual({ score: null, delta: null, componentCount: 0 });
  });

  it('computes delta only over components with both current and previous values', () => {
    const result = composeOverall([
      { key: 'lawn', status: 'scored', score: 88, previousScore: 80 },
      // no previous — must not drag delta toward zero
      { key: 'tree_shrub', status: 'scored', score: 40, previousScore: null },
    ]);
    expect(result.score).toBe(64);
    expect(result.delta).toBe(8);
  });

  it('ignores a scored status with a null score', () => {
    const result = composeOverall([
      { key: 'lawn', status: 'scored', score: null, previousScore: null },
    ]);
    expect(result.score).toBeNull();
  });
});

describe('pressureToHealth', () => {
  it('rescales the 0-5 pressure scale linearly (lower pressure = higher health)', () => {
    expect(pressureToHealth(0)).toBe(100);
    expect(pressureToHealth(5)).toBe(0);
    expect(pressureToHealth(2.5)).toBe(50);
    expect(pressureToHealth(1.2)).toBe(76);
  });

  it('clamps out-of-range values and rejects non-numbers', () => {
    expect(pressureToHealth(-1)).toBe(100);
    expect(pressureToHealth(9)).toBe(0);
    expect(pressureToHealth(null)).toBeNull();
    expect(pressureToHealth('n/a')).toBeNull();
  });
});

describe('movementReason', () => {
  it('describes movement in plain sentences', () => {
    expect(movementReason(4)).toBe('Up 4 points since your last assessment.');
    expect(movementReason(-1)).toBe('Down 1 point since your last assessment.');
    expect(movementReason(0)).toBe('Holding steady since your last assessment.');
    expect(movementReason(null)).toBeNull();
  });
});

// The shared lawn math must keep the exact route behavior it was extracted
// from (four-category weighting, legacy-row recompute).
describe('lawn-health-shared extraction', () => {
  it('recomputes legacy rows without stress_damage under the four-category model', () => {
    const legacy = { turf_density: 80, weed_suppression: 60, color_health: 70, fungus_control: 90, thatch_level: 50, overall_score: 42 };
    // stored overall ignored because stress_damage is absent
    expect(lawnStressDamage(legacy)).toBe(50);
    expect(lawnOverall(legacy)).toBe(Math.round(80 * 0.30 + 60 * 0.25 + 70 * 0.25 + 50 * 0.20));
  });

  it('trusts the stored overall for four-category rows', () => {
    expect(lawnOverall({ overall_score: 87, stress_damage: 70 })).toBe(87);
  });
});
