const { buildLawnInsightCards } = require('../services/service-report/lawn-report-insights');
const { buildLawnReportV2, buildAftercare } = require('../services/service-report/lawn-report-v2');
const { _test: { groundingFacts, mergeNarrative } } = require('../services/service-report/lawn-report-narrative');

function assessment(overrides = {}) {
  return {
    assessmentDate: '2026-09-25',
    scores: {
      turfDensity: 88, weedSuppression: 35, colorHealth: 86,
      stressDamage: 90, fungusControl: 92, overallScore: 75, season: 'peak',
    },
    droughtStress: 'none',
    turfProfile: { grassType: 'st_augustine' },
    waterContext: {
      rainfallInches7d: 0.8, irrigationInchesPerWeek: 0.5,
      effectiveInches7d: 1.3, targetInchesPerWeek: 1.25,
      irrigationAdvice: { status: 'balanced', rainKnown: true, profileMissing: false },
    },
    ...overrides,
  };
}

describe('lawn water evidence boundaries', () => {
  test('water cards separate historical estimates, photo signals, and approved plans', () => {
    const noPlan = buildLawnInsightCards({ water: { status: 'deficit' } })[0];
    expect(noPlan.customerAction).toMatch(/No upcoming watering plan is recorded/i);
    expect(noPlan.customerAction).not.toMatch(/add.*irrigation|more water/i);
    expect(noPlan.provenance).toEqual({
      findingSource: 'calculated_estimate',
      actionSource: null,
      planSource: null,
    });

    const withPlan = buildLawnInsightCards({
      water: { status: 'surplus', overwatering: true, weekPlan: { title: 'Approved plan' } },
      waterInRequired: true,
    })[0];
    expect(withPlan.customerAction).toMatch(/exact amount and timing are not recorded/i);
    expect(withPlan.provenance).toEqual({
      findingSource: 'photo_signal',
      actionSource: null,
      planSource: 'approved_watering_plan',
    });
  });

  test('the narrative overlay cannot invent completed work for a water estimate', () => {
    const cards = buildLawnInsightCards({ water: { status: 'deficit' } });
    const overlaid = mergeNarrative(
      { insights: cards },
      { insights: [{ wavesAction: 'We inspected and adjusted the irrigation today.' }] },
    );
    expect(overlaid.insights[0].wavesAction).toBe('');
    expect(groundingFacts({ insights: cards }, {}).insights[0]).toMatchObject({
      wavesAction: '',
      provenance: { findingSource: 'calculated_estimate', actionSource: null },
    });
  });

  test('aftercare distinguishes recorded, missing, conflicting, and incomplete evidence', () => {
    const requirementOnly = buildAftercare([{ product: { irrigation_required: true } }]);
    expect(requirementOnly).toMatchObject({
      waterInRequired: true,
      evidenceSource: 'irrigation_requirement',
      needsReview: true,
    });
    expect(requirementOnly.watering).not.toMatch(/24 hours|normal watering|inch|minute/i);

    expect(buildAftercare([
      { product: { irrigation_notes: 'Water after service.' } },
      { product: { irrigation_notes: 'Do not water after service.' } },
    ])).toMatchObject({
      watering: expect.stringMatching(/Confirm the directions/),
      evidenceSource: 'conflicting_product_instructions',
      needsReview: true,
    });
    expect(buildAftercare([
      { product: { irrigation_required: true, reentry_text: 'Keep people and pets away until dry.' } },
      { product: { irrigation_notes: 'Do not water after service.' } },
    ])).toMatchObject({
      watering: expect.stringMatching(/Confirm the directions/),
      reentry: 'Keep people and pets away until dry.',
      evidenceSource: 'incomplete_product_instructions',
      needsReview: true,
    });

    const surplusAssessment = assessment({
      waterContext: {
        rainfallInches7d: 2, irrigationInchesPerWeek: 1,
        effectiveInches7d: 3, targetInchesPerWeek: 1.25,
        irrigationAdvice: { status: 'surplus', rainKnown: true, profileMissing: false },
      },
    });
    const missing = buildLawnReportV2({
      lawnAssessment: surplusAssessment,
      applications: [{ product: { name: 'Synthetic Fertilizer', category: 'fertilizer', irrigation_required: true } }],
    });
    expect(missing.insights.find((card) => card.category === 'water').customerAction)
      .toMatch(/exact amount and timing are not recorded/i);

    const recorded = buildLawnReportV2({
      lawnAssessment: surplusAssessment,
      applications: [{ product: {
        name: 'Synthetic Fertilizer', category: 'fertilizer', irrigation_required: true,
        irrigation_notes: 'Apply the recorded water-in amount.',
      } }],
    });
    expect(recorded.aftercare).toMatchObject({ evidenceSource: 'product_instruction', needsReview: false });
    expect(recorded.insights.find((card) => card.category === 'water').customerAction)
      .toMatch(/use the recorded product directions/i);
  });
});
