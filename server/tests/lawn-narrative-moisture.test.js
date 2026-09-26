jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn(() => { throw new Error('Unexpected provider call'); }) }));

const { buildLawnReportV2 } = require('../services/service-report/lawn-report-v2');
const { applyLawnReportNarrative } = require('../services/service-report/lawn-report-narrative');
const { applyLawnReportReconciliation } = require('../services/service-report/report-consistency');

function assessment(droughtStress, flag, status = 'balanced') {
  const rain = { balanced: 0.9, deficit: 0.1, surplus: 2.96 }[status];
  return {
    droughtStress,
    scores: {
      turfDensity: 88, weedSuppression: 45, colorHealth: 86, stressDamage: 90,
      fungusControl: 95, overallScore: 79, season: 'peak', stressFlags: { drought_stress: flag },
    },
    observations: 'Drought stress may be contributing to thinning near the pavement.',
    turfProfile: { grassType: 'st_augustine' },
    recommendations: {},
    waterContext: {
      rainfallInches7d: rain, irrigationInchesPerWeek: 0.3,
      effectiveInches7d: rain + 0.3, targetInchesPerWeek: 1.25,
      irrigationAdvice: { status, rainKnown: true, profileMissing: false, recommendedInchesPerWeek: 1.25 },
    },
  };
}

describe('structured moisture governs the optional whole-report narrative', () => {
  test.each([
    ['none', undefined, 'balanced'],
    [null, undefined, 'balanced'],
    [undefined, undefined, 'balanced'],
    ['severe', false, 'balanced'],
    [null, undefined, 'deficit'],
    ['none', undefined, 'surplus'],
  ])('severity %j / technician %j preserves deterministic %s advice through narrative and reconciliation', async (severity, flag, status) => {
    const lawnAssessment = assessment(severity, flag, status);
    const v2 = buildLawnReportV2({ lawnAssessment });
    const before = JSON.parse(JSON.stringify(v2));
    const invented = 'Check sprinkler coverage along the pavement.';
    const callModel = jest.fn(async () => ({ ok: true, json: {
      statusHeadline: invented, mainWatch: invented, customerAction: invented,
      categories: Object.fromEntries(v2.diagnosis.map(d => [d.key, invented])),
      water: `Rain this week met the target. ${invented}`, mowing: invented,
      treatmentSummary: invented,
      insights: v2.insights.map(() => ({ headline: invented, whatWeSaw: invented, customerAction: invented })),
    } }));
    const overlaid = await applyLawnReportNarrative(v2, { observations: lawnAssessment.observations }, { callModel });
    expect(overlaid).toBe(v2);
    expect(callModel).not.toHaveBeenCalled();
    const data = { serviceLine: 'lawn', lawnAssessment, reportV2: overlaid, summary: lawnAssessment.observations };
    applyLawnReportReconciliation(data, null);
    expect(data.reportV2.water).toEqual(before.water);
    expect(data.reportV2.insights).toEqual(before.insights);
    expect(data.reportV2.snapshot).toEqual(before.snapshot);
    expect(data.reportV2.diagnosis).toEqual(before.diagnosis);
  });

  test.each([
    ['minor', undefined, 'balanced', 'balanced', 'checking the flagged area\'s coverage'],
    ['none', true, 'balanced', 'balanced', 'checking the flagged area\'s coverage'],
    ['minor', undefined, 'deficit', 'low', 'more water'],
    ['minor', undefined, 'surplus', 'high', 'easing back'],
  ])('affirmative severity %s / technician %j preserves deterministic %s water advice without a plan', async (severity, flag, adviceStatus, reportStatus, instruction) => {
    const lawnAssessment = assessment(severity, flag, adviceStatus);
    const v2 = buildLawnReportV2({ lawnAssessment });
    const deterministicExplanation = v2.water.explanation;
    const wording = `Based on rain this week, the lawn needs ${instruction}.`;
    const callModel = jest.fn(async () => ({ ok: true, json: { water: wording } }));
    const out = await applyLawnReportNarrative(v2, { observations: `${lawnAssessment.observations} ${severity}` }, { callModel });
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(callModel.mock.calls[0][0].text).toContain('"droughtSignal": true');
    expect(callModel.mock.calls[0][0].text).toContain(`"status": "${reportStatus}"`);
    expect(callModel.mock.calls[0][0].system).toContain(`"${reportStatus}" supports ${instruction}`);
    expect(out.water.explanation).toBe(deterministicExplanation);
    expect(out.water.explanation).not.toBe(wording);
    expect(out.water.status).toBe(reportStatus);
    expect(out.water.droughtSignal).toBe(true);
    expect(out.water.totalInches).toBe(v2.water.totalInches);
  });

  test('a no-plan narrative overlay cannot replace evidence-bound customer actions', async () => {
    const lawnAssessment = assessment('minor', undefined, 'surplus');
    const v2 = buildLawnReportV2({ lawnAssessment });
    const originalSnapshotAction = v2.snapshot.customerAction;
    const originalInsightActions = v2.insights.map((insight) => insight.customerAction);
    const originalWaterExplanation = v2.water.explanation;
    const inventedAction = 'Ease back to one irrigation cycle this week.';
    const callModel = jest.fn(async () => ({ ok: true, json: {
      customerAction: inventedAction,
      water: 'Based on rain this week, the lawn needs easing back.',
      insights: v2.insights.map(() => ({ customerAction: inventedAction })),
    } }));

    const out = await applyLawnReportNarrative(v2, { observations: lawnAssessment.observations }, { callModel });

    expect(callModel).toHaveBeenCalledTimes(1);
    expect(callModel.mock.calls[0][0].text).toContain(JSON.stringify(originalSnapshotAction));
    expect(v2.snapshot.rootCause).toMatch(/No upcoming watering plan is recorded/);
    expect(v2.snapshot.rootCause).not.toMatch(/ease back|reduce.*irrigation|skip.*water/i);
    expect(out.snapshot.customerAction).toBe(originalSnapshotAction);
    expect(out.insights.map((insight) => insight.customerAction)).toEqual(originalInsightActions);
    expect(out.water.explanation).toBe(originalWaterExplanation);
    expect(out.snapshot.customerAction).toMatch(/No upcoming watering plan is recorded/);
    expect(out.snapshot.customerAction).not.toContain(inventedAction);
  });

  test('a narrative cache hit reuses generated prose without leaking the prior report object', async () => {
    const lawnAssessment = assessment('minor', true, 'balanced');
    const first = buildLawnReportV2({ lawnAssessment });
    first.photos = [{ url: 'https://signed.example/customer-a.jpg' }];
    first.heroPhoto = 'https://signed.example/customer-a-hero.jpg';
    first.progression = [{ url: 'https://signed.example/customer-a-before.jpg' }];
    first.snapshot.nextVisit = { label: 'Oct 2', source: 'scheduled' };
    const second = JSON.parse(JSON.stringify(first));
    second.photos = [{ url: 'https://signed.example/customer-b.jpg' }];
    second.heroPhoto = 'https://signed.example/customer-b-hero.jpg';
    second.progression = [{ url: 'https://signed.example/customer-b-before.jpg' }];
    second.snapshot.nextVisit = { label: 'Oct 9', source: 'scheduled' };

    const generated = 'Watching the dry-looking edge this visit';
    const firstModel = jest.fn(async () => ({ ok: true, json: { statusHeadline: generated } }));
    const secondModel = jest.fn(() => { throw new Error('cache miss'); });
    const ctx = { observations: 'cache-isolation-fixture-4111037964' };
    const firstOut = await applyLawnReportNarrative(first, ctx, { callModel: firstModel });
    const secondOut = await applyLawnReportNarrative(second, ctx, { callModel: secondModel });

    expect(firstModel).toHaveBeenCalledTimes(1);
    expect(secondModel).not.toHaveBeenCalled();
    expect(firstOut.snapshot.statusHeadline).toBe(generated);
    expect(secondOut.snapshot.statusHeadline).toBe(firstOut.snapshot.statusHeadline);
    expect(secondOut.photos).toEqual(second.photos);
    expect(secondOut.heroPhoto).toBe(second.heroPhoto);
    expect(secondOut.progression).toEqual(second.progression);
    expect(secondOut.snapshot.nextVisit).toEqual(second.snapshot.nextVisit);
  });

  test('the overlay cannot turn unverified overall health into an all-clear headline', async () => {
    const v2 = {
      snapshot: {
        overallScore: 92,
        status: 'strong',
        statusHeadline: 'Lawn health tracked',
        mainWatch: null,
      },
      water: { droughtSignal: true, status: 'balanced' },
      diagnosis: [{ key: 'coverage', status: 'tracking' }],
      insights: [{ category: 'overall', status: 'tracking', priority: 1 }],
    };
    const deterministicHeadline = v2.snapshot.statusHeadline;
    const callModel = jest.fn(async () => ({ ok: true, json: { statusHeadline: 'Looking great' } }));

    const out = await applyLawnReportNarrative(v2, { observations: 'unverified-health-fixture-4111037967' }, { callModel });

    expect(deterministicHeadline).toBe('Lawn health tracked');
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(callModel.mock.calls[0][0].text).toContain('"overallHealthVerified": false');
    expect(out.snapshot.statusHeadline).toBe(deterministicHeadline);
    expect(out.snapshot.statusHeadline).not.toMatch(/great|healthy/i);
  });
});
