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

function allText(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => allText(item, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => allText(item, out));
  return out.join(' ');
}

describe('lawn insight evidence boundaries', () => {
  test('weed severity does not invent a trend or spot work', () => {
    const categories = [{ key: 'weed_pressure', status: 'needs_attention' }];
    const withoutApplication = buildLawnInsightCards({ categories })[0];
    expect(withoutApplication.headline).toBe('Weed pressure needs attention');
    expect(withoutApplication.wavesAction).toBe('');
    expect(withoutApplication.customerAction).toBe('');
    expect(withoutApplication.nextVisitPlan).toBe('');
    expect(allText(withoutApplication)).not.toMatch(/climbing|spot-treated|built it into the plan/i);

    const broadcast = buildLawnInsightCards({
      categories,
      treatmentKinds: ['herbicide'],
      treatmentProducts: [{ kind: 'herbicide', method: 'broadcast_spray' }],
    })[0];
    expect(broadcast.wavesAction).toMatch(/recorded broadcast method/i);
    expect(broadcast.wavesAction).not.toMatch(/spot/i);
    expect(broadcast.provenance).toEqual({
      findingSource: 'photo_signal',
      actionSource: 'recorded_application',
      planSource: null,
    });
  });

  test('a customer concern remains attributed and does not become an inspection', () => {
    const card = buildLawnInsightCards({ customerConcern: 'New browning after the prior visit.' })
      .find((item) => item.category === 'customer_concern');
    expect(card.confidence).toBe('customer_reported');
    expect(card.whatWeSaw).toMatch(/^You mentioned:/);
    expect(allText(card)).not.toMatch(/checked|inspected|looked into|follow up on it/i);
    expect(card.provenance).toEqual({ findingSource: 'customer', actionSource: null, planSource: null });
  });

  test('photo stress stays a signal without fabricated completed or future work', () => {
    const cards = buildLawnInsightCards({
      categories: [
        { key: 'damage_disease_signals', status: 'needs_attention' },
        { key: 'coverage', label: 'Coverage', status: 'watch' },
      ],
    });

    expect(cards.map((card) => card.category)).toEqual(['damage', 'coverage']);
    for (const card of cards) {
      expect(card.wavesAction).toBe('');
      expect(card.nextVisitPlan).toBe('');
      expect(card.provenance.findingSource).toBe('photo_signal');
    }
    expect(cards[1]).toMatchObject({ status: 'watch' });
    expect(cards[1].whatWeSaw).toMatch(/coverage is below the healthy range/i);
    const overlaid = mergeNarrative({ insights: cards }, { insights: cards.map(() => ({ wavesAction: 'We inspected and treated the affected area.' })) });
    expect(overlaid.insights.map((card) => card.wavesAction)).toEqual(['', '']);
    expect(groundingFacts({ insights: cards }, {}).insights[0]).toMatchObject({ wavesAction: '', provenance: { actionSource: null } });
  });

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

  test('an overall all-clear requires assessed healthy categories', () => {
    const unassessed = buildLawnInsightCards({})[0];
    expect(unassessed).toMatchObject({ category: 'overall', status: 'tracking' });
    expect(allText(unassessed)).not.toMatch(/good shape|responding well|completed/i);

    const healthy = buildLawnInsightCards({
      categories: [
        { key: 'coverage', status: 'healthy' },
        { key: 'color_vigor', status: 'strong' },
        { key: 'weed_pressure', status: 'healthy' },
      ],
      treatmentKinds: ['fertilizer'],
      treatmentProducts: [{ kind: 'fertilizer' }],
    })[0];
    expect(healthy).toMatchObject({ status: 'healthy', headline: 'Your lawn is in good shape' });
    expect(healthy.wavesAction).toMatch(/fertilizer application was recorded/i);
    expect(healthy.nextVisitPlan).toBe('');
    expect(healthy.provenance.actionSource).toBe('recorded_application');
  });

  test('the real report carries recorded method and scope provenance into insights', () => {
    const report = buildLawnReportV2({
      lawnAssessment: assessment(),
      applications: [{
        product: {
          name: 'Synthetic Weed Control', category: 'herbicide',
          service_report_summary: 'Reviewed weed-control role.', facts_approved: true,
        },
        method: 'broadcast_spray', methodInferred: false,
        applicationArea: 'Front lawn', areaValue: 4200, areaUnit: 'sqft',
      }],
    });

    expect(report.treatment.products[0]).toMatchObject({
      method: 'broadcast_spray', methodSource: 'recorded_application',
      applicationArea: 'Front lawn', applicationAreaSource: 'recorded_application',
      area: '4200 sqft', purposeSource: 'approved_product_fact',
    });
    const weed = report.insights.find((card) => card.category === 'weeds');
    expect(weed.wavesAction).toMatch(/recorded broadcast method/i);
    expect(weed.provenance.actionSource).toBe('recorded_application');

    const inferred = buildLawnReportV2({
      lawnAssessment: assessment(),
      applications: [{
        product: {
          name: 'Synthetic Weed Control', category: 'herbicide',
          service_report_summary: 'Unapproved diagnostic claim.', facts_approved: false,
        },
        method: 'spot_treatment', methodInferred: true,
      }],
    });
    expect(inferred.treatment.products[0]).toMatchObject({
      method: null, inferredMethod: 'spot_treatment',
      methodSource: 'category_inference', purposeSource: 'category_heuristic',
    });
    expect(inferred.treatment.products[0].whatItDoes).not.toMatch(/diagnostic claim/i);
    expect(inferred.insights.find((card) => card.category === 'weeds').wavesAction)
      .not.toMatch(/spot/i);
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
    ])).toMatchObject({ watering: expect.stringMatching(/Confirm the directions/), evidenceSource: 'conflicting_product_instructions', needsReview: true });
    expect(buildAftercare([
      { product: { irrigation_required: true, reentry_text: 'Keep people and pets away until dry.' } },
      { product: { irrigation_notes: 'Do not water after service.' } },
    ])).toMatchObject({ watering: expect.stringMatching(/Confirm the directions/), reentry: 'Keep people and pets away until dry.', evidenceSource: 'incomplete_product_instructions', needsReview: true });

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
