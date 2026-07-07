// Trends wiring for the Lawn Report V2 grid (Lawn Health Trend / Water Gap /
// Mowing Height / Weed Cleanliness). Regression coverage for the two series
// that used to never render on real reports: waterGap (was never emitted) and
// the mowing history on a visit with no gauge reading (fallback context).

const { buildLawnReportV2 } = require('../services/service-report/lawn-report-v2');

function assessment(overrides = {}) {
  return {
    scores: { turfDensity: 73, weedSuppression: 81, colorHealth: 77, stressDamage: 35, fungusControl: 95, overallScore: 68, season: 'peak' },
    overwateringSignal: false,
    turfProfile: { grassType: 'st_augustine' },
    observations: 'Mild drought stress in the mid-lawn zone.',
    waterContext: {
      rainfallInches7d: 0.9, irrigationInchesPerWeek: 0.7, effectiveInches7d: 1.6, targetInchesPerWeek: 1.25,
      irrigationAdvice: { status: 'balanced', rainKnown: true, profileMissing: false, recommendedInchesPerWeek: 1.25 },
    },
    trend: [
      { date: '2026-04-15', overallScore: 60, turfDensity: 60, weedSuppression: 70, colorHealth: 65, stressDamage: 40 },
      { date: '2026-06-18', overallScore: 68, turfDensity: 73, weedSuppression: 81, colorHealth: 77, stressDamage: 35 },
    ],
    ...overrides,
  };
}

describe('Lawn Report V2 — trends grid wiring', () => {
  test('assessment history drives overall + weed cleanliness series', () => {
    const { trends } = buildLawnReportV2({ lawnAssessment: assessment() });
    expect(trends.overall).toHaveLength(2);
    expect(trends.overall.map((p) => p.value)).toEqual([60, 68]);
    expect(trends.weed.map((p) => p.value)).toEqual([70, 81]);
  });

  test('waterGap series comes from the per-visit snapshot history, sign preserved', () => {
    const { trends } = buildLawnReportV2({
      lawnAssessment: assessment(),
      waterGapHistory: [
        { serviceDate: '2026-04-15', waterGapInches: -0.4 },
        { serviceDate: '2026-05-20', waterGapInches: '0.10' },
        { serviceDate: '2026-06-18', waterGapInches: 0.35 },
      ],
    });
    expect(trends.waterGap.map((p) => p.value)).toEqual([-0.4, 0.1, 0.35]);
  });

  test('waterGap needs 2+ visits — a single snapshot fabricates no trend', () => {
    const { trends } = buildLawnReportV2({
      lawnAssessment: assessment(),
      waterGapHistory: [{ serviceDate: '2026-06-18', waterGapInches: 0.2 }],
    });
    expect(trends.waterGap).toBeUndefined();
  });

  test('no waterGapHistory (snapshots table absent) leaves other series intact', () => {
    const { trends } = buildLawnReportV2({ lawnAssessment: assessment() });
    expect(trends.waterGap).toBeUndefined();
    expect(trends.overall).toBeDefined();
  });

  test('mowing series renders from the fallback history when THIS visit has no gauge reading', () => {
    const { trends } = buildLawnReportV2({
      lawnAssessment: assessment(),
      mowingHeight: null,
      mowingTrendFallback: {
        band: { min: 3.5, max: 4.0 },
        // Newest-first, as getTurfHeightTrend returns — must chart oldest-first.
        trend: [
          { heightIn: 3.75, measuredAt: '2026-06-18T14:00:00Z' },
          { heightIn: 3.25, measuredAt: '2026-04-15T14:00:00Z' },
        ],
      },
    });
    expect(trends.mowing.map((p) => p.value)).toEqual([3.25, 3.75]);
    expect(trends.mowingBand).toEqual([3.5, 4.0]);
  });

  test('current-visit reading still wins over the fallback and charts chronologically', () => {
    const { trends } = buildLawnReportV2({
      lawnAssessment: assessment(),
      mowingHeight: {
        heightIn: 4.0,
        band: { min: 3.5, max: 4.0 },
        trend: [
          { heightIn: 4.0, measuredAt: '2026-06-18T14:00:00Z' },
          { heightIn: 3.5, measuredAt: '2026-04-15T14:00:00Z' },
        ],
      },
      mowingTrendFallback: { band: { min: 1.0, max: 2.0 }, trend: [] },
    });
    expect(trends.mowing.map((p) => p.value)).toEqual([3.5, 4.0]);
    expect(trends.mowingBand).toEqual([3.5, 4.0]);
  });
});
