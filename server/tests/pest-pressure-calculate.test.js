const { DEFAULT_CONFIG } = require('../services/pest-pressure/config');
const { calculatePestPressureScore } = require('../services/pest-pressure/calculate');

function withWeights(overrides = {}) {
  return {
    ...DEFAULT_CONFIG,
    weights: { ...DEFAULT_CONFIG.weights, ...overrides },
  };
}

describe('calculatePestPressureScore', () => {
  test('all components zero returns 0.0 / Very Low', () => {
    const result = calculatePestPressureScore({
      clientRating: 0,
      technicianRating: 0,
      reServiceImpact: 0,
      recurringIssueRating: 0,
      riskFactorRating: 0,
      previousScore: null,
    }, DEFAULT_CONFIG);

    expect(result.score).toBe(0);
    expect(result.label.key).toBe('very_low');
    expect(result.label.name).toBe('Very Low');
    expect(result.dataCompleteness).toBe('complete');
    expect(result.trend).toBe('first_marker');
    expect(result.trendDelta).toBeNull();
  });

  test('mixed low values return expected rounded score', () => {
    // 1*0.25 + 2*0.30 + 0*0.20 + 1*0.15 + 0*0.10 = 0.25 + 0.60 + 0 + 0.15 + 0 = 1.00
    const result = calculatePestPressureScore({
      clientRating: 1,
      technicianRating: 2,
      reServiceImpact: 0,
      recurringIssueRating: 1,
      riskFactorRating: 0,
      previousScore: null,
    }, DEFAULT_CONFIG);

    expect(result.score).toBe(1.0);
    expect(result.label.key).toBe('low');
    expect(result.dataCompleteness).toBe('complete');
  });

  test('high values clamp to 5.0', () => {
    const result = calculatePestPressureScore({
      clientRating: 5,
      technicianRating: 5,
      reServiceImpact: 5,
      recurringIssueRating: 5,
      riskFactorRating: 5,
      previousScore: null,
    }, DEFAULT_CONFIG);

    expect(result.score).toBe(5);
    expect(result.label.key).toBe('high');
  });

  test('missing client rating with available technician data recalculates using available components', () => {
    // Available weights renormalized over technician(30) + reService(20) + recurring(15) + risk(10) = 75
    // tech 4*(30/75) + reService 2*(20/75) + recurring 0 + risk 1*(10/75)
    // = 1.6 + 0.5333 + 0 + 0.1333 = 2.2667 → 2.3
    const result = calculatePestPressureScore({
      clientRating: null,
      technicianRating: 4,
      reServiceImpact: 2,
      recurringIssueRating: 0,
      riskFactorRating: 1,
      previousScore: null,
    }, DEFAULT_CONFIG);

    expect(result.score).toBe(2.3);
    expect(result.dataCompleteness).toBe('partial');
    expect(result.missingComponents).toEqual(['clientRating']);
    expect(result.label.key).toBe('moderate');
  });

  test('insufficient data returns no score and insufficient_data trend', () => {
    const result = calculatePestPressureScore({
      clientRating: null,
      technicianRating: null,
      reServiceImpact: null,
      recurringIssueRating: null,
      riskFactorRating: null,
      previousScore: null,
    }, DEFAULT_CONFIG);

    expect(result.score).toBeNull();
    expect(result.displayedScore).toBeNull();
    expect(result.trend).toBe('insufficient_data');
    expect(result.dataCompleteness).toBe('insufficient');
    expect(result.summary).toMatch(/once enough service data is available/);
  });

  test('previous score unavailable returns first_marker', () => {
    const result = calculatePestPressureScore({
      clientRating: 2,
      technicianRating: 2,
      reServiceImpact: 0,
      recurringIssueRating: 0,
      riskFactorRating: 0,
      previousScore: null,
    }, DEFAULT_CONFIG);

    expect(result.trend).toBe('first_marker');
    expect(result.summary).toMatch(/first Pest Pressure score/);
  });

  test('score decrease of at least 0.5 returns improving', () => {
    const result = calculatePestPressureScore({
      clientRating: 1,
      technicianRating: 1,
      reServiceImpact: 0,
      recurringIssueRating: 0,
      riskFactorRating: 0,
      previousScore: 1.5,
    }, DEFAULT_CONFIG);

    expect(result.score).toBe(0.6);
    expect(result.trendDelta).toBe(-0.9);
    expect(result.trend).toBe('improving');
  });

  test('score change within +/-0.4 returns stable', () => {
    const result = calculatePestPressureScore({
      clientRating: 1,
      technicianRating: 2,
      reServiceImpact: 0,
      recurringIssueRating: 0,
      riskFactorRating: 0,
      previousScore: 0.9,
    }, DEFAULT_CONFIG);

    // 1*0.25 + 2*0.30 = 0.85, delta = -0.05 → stable
    expect(result.score).toBe(0.9);
    expect(result.trend).toBe('stable');
  });

  test('score increase of 0.5 to 0.9 returns increasing', () => {
    const result = calculatePestPressureScore({
      clientRating: 2,
      technicianRating: 3,
      reServiceImpact: 0,
      recurringIssueRating: 0,
      riskFactorRating: 0,
      previousScore: 0.8,
    }, DEFAULT_CONFIG);

    // 2*0.25 + 3*0.30 = 1.4, delta = +0.6 → increasing
    expect(result.score).toBe(1.4);
    expect(result.trendDelta).toBe(0.6);
    expect(result.trend).toBe('increasing');
  });

  test('score increase of 1.0+ returns significant_increase', () => {
    const result = calculatePestPressureScore({
      clientRating: 3,
      technicianRating: 4,
      reServiceImpact: 2,
      recurringIssueRating: 1,
      riskFactorRating: 1,
      previousScore: 1.0,
    }, DEFAULT_CONFIG);

    // 3*0.25 + 4*0.30 + 2*0.20 + 1*0.15 + 1*0.10 = 0.75 + 1.20 + 0.40 + 0.15 + 0.10 = 2.6
    expect(result.score).toBe(2.6);
    expect(result.trendDelta).toBe(1.6);
    expect(result.trend).toBe('significant_increase');
  });

  test('label thresholds resolve correctly across all bands', () => {
    const bands = [
      { value: 0.0, key: 'very_low' },
      { value: 0.9, key: 'very_low' },
      { value: 1.0, key: 'low' },
      { value: 1.9, key: 'low' },
      { value: 2.0, key: 'moderate' },
      { value: 2.9, key: 'moderate' },
      { value: 3.0, key: 'elevated' },
      { value: 3.9, key: 'elevated' },
      { value: 4.0, key: 'high' },
      { value: 5.0, key: 'high' },
    ];

    for (const band of bands) {
      const result = calculatePestPressureScore({
        clientRating: band.value,
        technicianRating: band.value,
        reServiceImpact: band.value,
        recurringIssueRating: band.value,
        riskFactorRating: band.value,
        previousScore: null,
      }, DEFAULT_CONFIG);
      expect(result.score).toBeCloseTo(band.value, 1);
      expect(result.label.key).toBe(band.key);
    }
  });

  test('historical score stores config snapshot (deep clone, not reference)', () => {
    const config = { ...DEFAULT_CONFIG };
    const result = calculatePestPressureScore({
      clientRating: 1,
      technicianRating: 1,
      reServiceImpact: 1,
      recurringIssueRating: 1,
      riskFactorRating: 1,
      previousScore: null,
    }, config);

    expect(result.configSnapshot).toEqual(JSON.parse(JSON.stringify(config)));
    expect(result.configSnapshot).not.toBe(config);
    expect(result.calculationVersion).toBe(config.calculationVersion);
    expect(result.componentScores.clientRating).toEqual({ value: 1, weight: 25, present: true });
  });

  test('treat_missing_as_zero substitutes 0 for null inputs', () => {
    const config = { ...DEFAULT_CONFIG, missingDataBehavior: 'treat_missing_as_zero' };
    const result = calculatePestPressureScore({
      clientRating: null,
      technicianRating: 4,
      reServiceImpact: null,
      recurringIssueRating: null,
      riskFactorRating: null,
      previousScore: null,
    }, config);

    // Only technician contributes: 4 * 0.30 = 1.2
    expect(result.score).toBe(1.2);
    expect(result.dataCompleteness).toBe('partial');
  });

  test('require_minimum returns insufficient when minimum unmet', () => {
    const config = { ...DEFAULT_CONFIG, missingDataBehavior: 'require_minimum' };
    const result = calculatePestPressureScore({
      clientRating: null,
      technicianRating: null,
      reServiceImpact: null,
      recurringIssueRating: null,
      riskFactorRating: 3,
      previousScore: null,
    }, config);

    // riskFactorRating alone doesn't satisfy requireOneOf: ['technicianRating','clientRating','history']
    expect(result.score).toBeNull();
    expect(result.dataCompleteness).toBe('insufficient');
  });

  test('require_minimum accepts history when reServiceImpact or recurringIssue present', () => {
    const config = { ...DEFAULT_CONFIG, missingDataBehavior: 'require_minimum' };
    const result = calculatePestPressureScore({
      clientRating: null,
      technicianRating: null,
      reServiceImpact: 3,
      recurringIssueRating: null,
      riskFactorRating: 2,
      previousScore: null,
    }, config);

    // reService 3*(20/30) + risk 2*(10/30) = 2 + 0.6667 = 2.6667 → 2.7
    expect(result.score).toBe(2.7);
    expect(result.dataCompleteness).toBe('partial');
  });

  test('rejects out-of-range component values', () => {
    expect(() => calculatePestPressureScore({
      clientRating: 6,
      technicianRating: 1,
      reServiceImpact: 1,
      recurringIssueRating: 1,
      riskFactorRating: 1,
      previousScore: null,
    }, DEFAULT_CONFIG)).toThrow(RangeError);

    expect(() => calculatePestPressureScore({
      clientRating: -1,
      technicianRating: 1,
      reServiceImpact: 1,
      recurringIssueRating: 1,
      riskFactorRating: 1,
      previousScore: null,
    }, DEFAULT_CONFIG)).toThrow(RangeError);
  });

  test('explanation copy matches trend state', () => {
    const lowStable = calculatePestPressureScore({
      clientRating: 0,
      technicianRating: 1,
      reServiceImpact: 0,
      recurringIssueRating: 0,
      riskFactorRating: 0,
      previousScore: 0.3,
    }, DEFAULT_CONFIG);
    // 1*0.30 = 0.3, delta 0 → stable, label very_low → stable_low copy
    expect(lowStable.summary).toMatch(/remains low/);

    const moderateStable = calculatePestPressureScore({
      clientRating: 3,
      technicianRating: 3,
      reServiceImpact: 1,
      recurringIssueRating: 1,
      riskFactorRating: 1,
      previousScore: 2.2,
    }, DEFAULT_CONFIG);
    // 3*0.25 + 3*0.30 + 1*0.20 + 1*0.15 + 1*0.10 = 0.75 + 0.90 + 0.20 + 0.15 + 0.10 = 2.1
    // delta -0.1 → stable, label moderate → stable_other
    expect(moderateStable.score).toBe(2.1);
    expect(moderateStable.label.key).toBe('moderate');
    expect(moderateStable.trend).toBe('stable');
    expect(moderateStable.summary).toMatch(/stable compared/);
  });
});
