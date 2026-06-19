const {
  calculateLawnOverallScore, lawnScoreDelta, lawnScoreValue,
} = require('../services/service-report/report-data');
const { answerServiceReportQuestion } = require('../services/service-report/report-assistant');

describe('lawn score — null categories are excluded, not coerced to 0', () => {
  test('lawnScoreValue treats DB NULL / empty as missing, not 0 (Number(null) === 0 trap)', () => {
    expect(lawnScoreValue(null)).toBeNull();
    expect(lawnScoreValue(undefined)).toBeNull();
    expect(lawnScoreValue('')).toBeNull();
    expect(lawnScoreValue(0)).toBe(0);   // a real zero is still a score
    expect(lawnScoreValue('80')).toBe(80);
    expect(lawnScoreValue(82.4)).toBe(82);
  });

  test('with all four categories present it is the plain 30/25/25/20 average (#1898 guard)', () => {
    expect(calculateLawnOverallScore({
      turf_density: 80, weed_suppression: 90, color_health: 82, stress_damage: 70,
    })).toBe(81);
  });

  test('a not-yet-scored category is excluded and weights renormalize (not counted as 0)', () => {
    // turf .30 + weed .25 + stress .20 over present weight .75; all 80 -> 80.
    // Cover BOTH a missing key (undefined) and an explicit DB NULL / '' — the
    // bug only reproduces with real NULL rows, where Number(null) === 0.
    expect(calculateLawnOverallScore({ turf_density: 80, weed_suppression: 80, stress_damage: 80 })).toBe(80);
    expect(calculateLawnOverallScore({ turf_density: 80, weed_suppression: 80, color_health: null, stress_damage: 80 })).toBe(80);
    expect(calculateLawnOverallScore({ turf_density: 80, weed_suppression: 80, color_health: '', stress_damage: 80 })).toBe(80);
    // The old `Number(x) || 0` path treated the missing color as 0 -> round(60) = 60.
    expect(calculateLawnOverallScore({ turf_density: 80, weed_suppression: 80, color_health: null, stress_damage: 80 })).not.toBe(60);
  });

  test('overall is null only when no category was scored at all', () => {
    expect(calculateLawnOverallScore({})).toBeNull();
    expect(calculateLawnOverallScore({ turf_density: 50 })).toBe(50);
  });

  test('a stored four-category overall_score is trusted as-is', () => {
    expect(calculateLawnOverallScore({ overall_score: 88, stress_damage: 70, turf_density: 10 })).toBe(88);
  });

  test('a delta is null unless BOTH visits scored that category (no fabricated improvement)', () => {
    expect(lawnScoreDelta(85, 60)).toBe(25);
    expect(lawnScoreDelta(60, 85)).toBe(-25);
    expect(lawnScoreDelta(85, null)).toBeNull(); // would have been a fake +85
    expect(lawnScoreDelta(null, 60)).toBeNull();
    expect(lawnScoreDelta(null, null)).toBeNull();
  });

  test('end-to-end: a DB NULL initial category yields a null delta, not a fabricated +85', () => {
    // The real before/after path is lawnScoreDelta(lawnScoreValue(after), lawnScoreValue(before)).
    expect(lawnScoreDelta(lawnScoreValue(85), lawnScoreValue(null))).toBeNull();
    expect(lawnScoreDelta(lawnScoreValue(85), lawnScoreValue(''))).toBeNull();
    expect(lawnScoreDelta(lawnScoreValue(85), lawnScoreValue(60))).toBe(25);
  });
});

describe('report assistant never leaks null scores into its answer', () => {
  test('omits unscored categories and the overall instead of saying "null%"', () => {
    const answer = answerServiceReportQuestion({
      question: 'How is my lawn health doing?',
      data: {
        lawnAssessment: {
          scores: {
            overallScore: null, turfDensity: 80, weedSuppression: null, colorHealth: 82, stressDamage: null,
          },
        },
      },
    });
    expect(answer).not.toMatch(/null/i);
    expect(answer).toContain('density/coverage 80%');
    expect(answer).toContain('color/nutrients 82%');
    expect(answer).not.toContain('% overall');
    expect(answer).not.toContain('weed cleanliness');
  });

  test('keeps the full overall + breakdown when every category is scored', () => {
    const answer = answerServiceReportQuestion({
      question: 'whats my lawn score?',
      data: {
        lawnAssessment: {
          scores: {
            overallScore: 81, turfDensity: 80, weedSuppression: 90, colorHealth: 82, stressDamage: 70,
          },
        },
      },
    });
    expect(answer).toContain('Current lawn health is 81% overall.');
    expect(answer).toContain('Breakdown: density/coverage 80%, weed cleanliness 90%, color/nutrients 82%, stress/damage 70%.');
  });
});
