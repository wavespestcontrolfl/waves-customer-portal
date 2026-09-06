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
  ])('affirmative severity %s / technician %j grounds %s water advice in the report status', async (severity, flag, adviceStatus, reportStatus, instruction) => {
    const lawnAssessment = assessment(severity, flag, adviceStatus);
    const v2 = buildLawnReportV2({ lawnAssessment });
    const wording = `Based on rain this week, the lawn needs ${instruction}.`;
    const callModel = jest.fn(async () => ({ ok: true, json: { water: wording } }));
    const out = await applyLawnReportNarrative(v2, { observations: `${lawnAssessment.observations} ${severity}` }, { callModel });
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(callModel.mock.calls[0][0].text).toContain('"droughtSignal": true');
    expect(callModel.mock.calls[0][0].text).toContain(`"status": "${reportStatus}"`);
    expect(callModel.mock.calls[0][0].system).toContain(`"${reportStatus}" supports ${instruction}`);
    expect(out.water.explanation).toBe(wording);
    expect(out.water.status).toBe(reportStatus);
    expect(out.water.droughtSignal).toBe(true);
    expect(out.water.totalInches).toBe(v2.water.totalInches);
  });
});
