// The MAXIMAL normal lawn payload for the new-sod mode tests: everything the engine can print about
// watering or mowing at once (a water-in product with creditableWaterIn, height-of-cut with a gauge
// photo, a forecast line, an observed-rain note, a run/hold plan, advice scattered through the cards).
// Shared by server/tests/lawn-new-sod-payload.test.js and the client render test
// client/src/pages/ServiceReportDocument.newSod.test.jsx. Synthetic data only.

const maximalLawnPayload = () => ({
  serviceRecordId: '00000000-0000-4000-8000-000000000042',
  serviceDate: '2026-10-02T00:00:00.000Z',
  serviceDisplayName: 'Lawn Care Treatment Program',
  serviceLine: 'lawn',
  technicianName: 'Test Tech',
  customerName: 'Test Customer',
  serviceAddress: '100 Example Court, Bradenton, FL 34201',
  mowingHeight: { heightIn: 2.5, bandLabel: '3.5-4 in', status: 'too_short', photoUrl: 'https://img.example.test/gauge.jpg', trend: [{ heightIn: 2.5, measuredAt: '2026-09-30' }] },
  photos: [{ id: 'p1', url: 'https://img.example.test/p1.jpg' }],
  dynamicContext: { reentry: { customerSummary: 'Treated areas are ready for normal use.', irrigationReadyAt: '2026-10-03T19:00:00.000Z', petAdvisory: 'Keep pets off treated zones until dry.' } },
  applications: [{
    id: 'app-1',
    product: { name: 'Test Fertilizer', epa_reg: '1-2', active_ingredient: 'Urea 20%', irrigation_notes: 'Water in with 1/4 inch after application.', irrigation_required: true, reentry_summary: 'Keep pets off until dry.' },
    methodLabel: 'Broadcast', rate: '1', rateUnit: 'lb', totalAmount: '2', amountUnit: 'lb', targets: ['Color'],
  }],
  lawnAssessment: {
    overwateringSignal: true,
    droughtStress: 'moderate',
    waterContext: {
      rainfallInches7d: 3.2, irrigationInchesPerWeek: 1.5, targetInchesPerWeek: 1,
      irrigationAdvice: { status: 'surplus', message: 'Ease back on irrigation.' },
      weekPlan: { title: 'Skip this week’s runs', detail: 'Rain covers it.', action: 'hold', afterHold: { title: 'Not before Thu', detail: 'x' }, afterTreatment: { title: 'One run', detail: 'y' }, prescribesRun: false, visitInPlanWeek: true, depthInches: 0.5 },
    },
  },
  reportV2: {
    banner: { state: 'water_in', lines: ['Water in today’s treatment by Fri 3 PM.'], expiresAt: '2099-01-01T00:00:00Z', forecastLine: 'About 0.4 inch of rain is forecast by Thu 8 AM.', observedRain: { line: 'Radar measured about 0.5 inch of rain near your address.' }, mowHold: { line: 'Mowing: hold off until Fri 4 PM.' } },
    water: {
      rainInches: 3.2, irrigationInches: 1.5, totalInches: 4.7, targetInches: 1, status: 'high', confidence: 'high',
      explanation: 'Easing back on irrigation should help.', coverageWatch: true, droughtSignal: true, scheduleOnFile: false, scheduleUnconfirmed: true,
      // visitInPlanWeek + prescribesRun:false reads as a HOLD plan to the credit path: "no extra runs".
      weekPlan: { title: 'Skip this week’s runs', detail: 'Rain covers it.', action: 'hold', visitInPlanWeek: true, prescribesRun: false, afterTreatment: { title: 'One run', detail: 'y' }, afterHold: { title: 'Not before Thu', detail: 'x' } },
    },
    aftercare: {
      watering: 'Water in today’s treatment by Fri 3 PM.', reentry: 'Keep pets off until dry.', waterInRequired: true, creditableWaterIn: true,
      wateringHold: false, needsReview: false, evidenceSource: 'product_instruction', waterInTask: 'Water in today’s treatment by Fri 3 PM.',
    },
    mowing: { status: 'too_short', heightIn: 2.5, targetMin: 3.5, targetMax: 4, recommendation: 'Raise the mower one setting.' },
    trends: { overall: [{ label: 'Aug', value: 60 }, { label: 'Sep', value: 70 }], waterGap: [{ label: 'Aug', value: 1 }, { label: 'Sep', value: 2 }], mowing: [{ label: 'Aug', value: 3 }, { label: 'Sep', value: 4 }], mowingBand: [3, 4] },
    insights: [
      { category: 'water', status: 'needs_attention', priority: 1, headline: 'The lawn is likely getting too much water', whatWeSaw: 'The weekly water total is above target.', customerAction: 'Ease back on irrigation.' },
      { category: 'mowing', status: 'watch', priority: 2, headline: 'Lawn is being mowed a bit short', whatWeSaw: 'Measured height of cut is 2.5 in.', customerAction: 'Raise the mower one setting.' },
      { category: 'weeds', status: 'watch', priority: 3, headline: 'A little weed activity to keep ahead of', whatWeSaw: 'Weeds competing with the turf in places.', whyItMatters: 'Weeds spread fastest when the turf is thin.', wavesAction: 'Spot-treated where appropriate.', customerAction: 'Water the treated area daily.', nextVisitPlan: 'Reassess weed pressure next visit.' },
    ],
    snapshot: {
      overallScore: 70, status: 'healthy', statusHeadline: 'Stable — watching weed pressure', scoreExplanation: null,
      customerAction: 'Water in today’s application as directed.', wavesNext: 'Recheck moisture next visit.', rootCause: 'The main driver looks like too much water.',
      treatmentSummary: 'We applied a fertilizer to feed the lawn.', seasonalNote: 'Peak-season lawns run a little thinner.', todaysFocus: ['Color'], watching: ['Weed activity'], noActionNeeded: false,
    },
    followUp: { scheduled: true, headline: 'Follow-up already planned', reason: 'Recheck the moisture balance.', customerAction: 'Run the sprinklers.' },
    smsSummary: 'Your lawn report is ready: stable. Skip watering today.',
    photos: [{ url: 'https://img.example.test/p1.jpg', label: 'Front yard' }],
  },
});

module.exports = { maximalLawnPayload };
