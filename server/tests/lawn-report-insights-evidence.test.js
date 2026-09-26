const { buildLawnInsightCards } = require('../services/service-report/lawn-report-insights');
const { _test: { groundingFacts, mergeNarrative } } = require('../services/service-report/lawn-report-narrative');

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
});
