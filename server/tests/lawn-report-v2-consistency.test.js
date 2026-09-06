// Golden-fixture consistency tests for the Lawn Report V2 synthesis layer.
// Renders the report from representative payloads and asserts the report can never
// (a) emit banned/over-claiming customer copy, or (b) contradict itself — the trust
// failures the report-consistency layer exists to prevent. Synthetic payloads only
// (no customer PII). If a future copy/LLM/logic change reintroduces a contradiction,
// one of these fails.

const { buildLawnReportV2 } = require('../services/service-report/lawn-report-v2');
const { reconcileLawnReport } = require('../services/service-report/report-consistency');
const { findBannedCustomerCopy } = require('../services/service-report/activity-indicators');
const { buildServiceReportV1SmsVars } = require('../services/service-report/delivery');
const { frozenSmsSummary } = require('../services/service-report/lawn-report-write-gate');

const APPLICATIONS = [
  { product: { name: 'SedgeHammer Plus', active_ingredient: 'halosulfuron-methyl', category: 'herbicide', reentry_summary: 'Follow the product label before re-entering treated areas.' }, targets: ['weeds'] },
];
const DYNAMIC_CONTEXT_READY = { reentry: { targets: [{ statusAtGeneratedAt: 'ready' }], petAdvisory: 'Keep pets off treated turf until dry.' } };

function baseAssessment(overrides = {}) {
  return {
    scores: { turfDensity: 73, weedSuppression: 81, colorHealth: 77, stressDamage: 35, fungusControl: 95, overallScore: 68, season: 'peak' },
    overwateringSignal: false,
    turfProfile: { grassType: 'st_augustine' },
    observations: 'This lawn shows mild drought stress or slightly uneven irrigation coverage in the mid-lawn zone.',
    aiSummary: 'Good overall condition with a few light-tan mid-lawn areas suggesting uneven irrigation coverage.',
    recommendations: { nextVisitFocus: 'Recheck the mid-lawn zones and confirm irrigation uniformity next visit.' },
    waterContext: {
      rainfallInches7d: 0.9, irrigationInchesPerWeek: 0.7, effectiveInches7d: 1.6, targetInchesPerWeek: 1.25,
      irrigationAdvice: { status: 'balanced', rainKnown: true, profileMissing: false, recommendedInchesPerWeek: 1.25 },
    },
    trend: [
      { date: '2026-04-15', overallScore: 60, turfDensity: 60, weedSuppression: 70, colorHealth: 65, stressDamage: 40 },
      { date: '2026-06-18', overallScore: 68, turfDensity: 73, weedSuppression: 81, colorHealth: 77, stressDamage: 35 },
    ],
    beforeAfter: {
      before: { date: '2026-04-15', photoUrl: 'https://example/b.jpg', overallScore: 60 },
      after: { date: '2026-06-18', photoUrl: 'https://example/a.jpg', overallScore: 68 },
      improvement: 8,
    },
    photos: [{ url: 'https://example/a.jpg', isBest: true, zone: 'front' }],
    ...overrides,
  };
}

const CASES = {
  balancedDryCoverage: baseAssessment(),
  overWatered: baseAssessment({
    overwateringSignal: true,
    observations: 'Mushrooms and damp patches indicate too much water.',
    scores: { turfDensity: 58, weedSuppression: 44, colorHealth: 49, stressDamage: 35, fungusControl: 40, overallScore: 54, season: 'peak' },
    waterContext: { rainfallInches7d: 1.6, irrigationInchesPerWeek: 1.2, effectiveInches7d: 2.8, targetInchesPerWeek: 1.25, irrigationAdvice: { status: 'surplus', rainKnown: true, profileMissing: false, recommendedInchesPerWeek: 1.25 } },
  }),
  deficit: baseAssessment({
    observations: 'Turf looks dry and is showing drought stress across the lawn.',
    waterContext: { rainfallInches7d: 0.1, irrigationInchesPerWeek: 0.3, effectiveInches7d: 0.4, targetInchesPerWeek: 1.25, irrigationAdvice: { status: 'deficit', rainKnown: true, profileMissing: false, recommendedInchesPerWeek: 1.25 } },
  }),
  healthy: baseAssessment({
    observations: 'Thick, healthy, even turf with strong color and no visible stress.',
    aiSummary: 'Lawn is in excellent shape with strong density and color.',
    scores: { turfDensity: 88, weedSuppression: 92, colorHealth: 86, stressDamage: 90, fungusControl: 95, overallScore: 89, season: 'peak' },
    recommendations: {},
  }),
};

function collectStrings(value, acc = []) {
  if (typeof value === 'string') { acc.push(value); return acc; }
  if (Array.isArray(value)) { value.forEach((v) => collectStrings(v, acc)); return acc; }
  if (value && typeof value === 'object') { Object.values(value).forEach((v) => collectStrings(v, acc)); return acc; }
  return acc;
}

describe('Lawn Report V2 — consistency golden fixtures', () => {
  for (const [name, lawnAssessment] of Object.entries(CASES)) {
    describe(name, () => {
      const reportV2 = buildLawnReportV2({ lawnAssessment, applications: APPLICATIONS, actions: ['Exterior perimeter band'] });
      const fix = reconcileLawnReport({ data: { lawnAssessment, dynamicContext: DYNAMIC_CONTEXT_READY }, reportV2 });
      const merged = { ...reportV2, ...(fix || {}) };

      test('emits no banned / over-claiming customer copy', () => {
        const banned = collectStrings(merged).flatMap((s) => findBannedCustomerCopy(s));
        expect(banned).toEqual([]);
      });

      test('raises no blocker-severity consistency warnings', () => {
        const blockers = (fix?.warnings || []).filter((w) => w.severity === 'blocker');
        expect(blockers).toEqual([]);
      });

      test('Water/Coverage is not shown as a diagnosis card (redundant with Water This Week)', () => {
        // The Water/Coverage card was removed from the customer-facing diagnosis —
        // its score was fungus/over-water derived, not a real moisture reading, and
        // the "Water This Week" card owns watering with real rain + irrigation data.
        const water = reportV2.diagnosis.find((c) => c.key === 'water_moisture_stress');
        expect(water).toBeUndefined();
      });

      test('customer action is never a Waves-owned next-visit task', () => {
        const wavesPlans = (reportV2.insights || []).map((i) => i.nextVisitPlan).filter(Boolean);
        if (reportV2.snapshot.customerAction) {
          expect(wavesPlans).not.toContain(reportV2.snapshot.customerAction);
        }
      });

      test('re-entry never reads "ready now" alongside "until dry"', () => {
        if (fix?.reentry) {
          expect(/until\s+dry/i.test(fix.reentry.petAdvisory)).toBe(false);
        }
      });

      test('every trend series has 2+ points or is absent', () => {
        for (const [key, series] of Object.entries(reportV2.trends || {})) {
          if (key === 'mowingBand' || !Array.isArray(series)) continue;
          expect(series.length).toBeGreaterThanOrEqual(2);
        }
      });
    });
  }

  // Owner ruling 2026-08-01: lawn reads like pest. The frozen synthesis (score
  // band + watering action) is still written to the record — the REPORT is its
  // consumer — but nothing about it reaches the completion text any more. The
  // text renders from the DB template, and these vars are everything it gets,
  // so a synthesis line could only appear if one were added HERE.
  test('SMS vars carry nothing lawn-specific — lawn reads like pest', () => {
    const lawn = buildServiceReportV1SmsVars({
      customerFirstName: 'Tony', reportUrl: 'https://x/r/abc', serviceType: 'Lawn Care',
    });
    const pest = buildServiceReportV1SmsVars({
      customerFirstName: 'Tony', reportUrl: 'https://x/r/abc', serviceType: 'Pest Control',
    });

    // Identical shape; the service name is the only difference.
    expect(Object.keys(lawn).sort()).toEqual(Object.keys(pest).sort());
    expect({ ...lawn, service_type: null }).toEqual({ ...pest, service_type: null });

    // No score, watering advice, or opt-out wording can ride along.
    expect(Object.values(lawn).join(' ')).not.toMatch(/watering|sprinkler|stable|score|\/100|STOP/i);
  });

  test('frozenSmsSummary reads the persisted write-gate line (object or JSON string)', () => {
    const line = 'Your St. Augustine lawn report is ready: looking healthy.';
    expect(frozenSmsSummary({ structured_notes: { lawnReportV2: { smsSummary: line } } })).toBe(line);
    expect(frozenSmsSummary({ structured_notes: JSON.stringify({ lawnReportV2: { smsSummary: line } }) })).toBe(line);
    expect(frozenSmsSummary({ structured_notes: {} })).toBeNull();
    expect(frozenSmsSummary({})).toBeNull();
  });

  test('single-visit history yields no fabricated trend or before/after', () => {
    const oneVisit = baseAssessment({
      trend: [{ date: '2026-06-18', overallScore: 68, turfDensity: 73, weedSuppression: 81, colorHealth: 77, stressDamage: 35 }],
      beforeAfter: { before: { date: '2026-06-18', photoUrl: 'https://example/x.jpg', overallScore: 67 }, after: { date: '2026-06-18', photoUrl: 'https://example/y.jpg', overallScore: 68 }, improvement: 1 },
    });
    const v2 = buildLawnReportV2({ lawnAssessment: oneVisit, applications: APPLICATIONS });
    expect(v2.trends.overall).toBeUndefined();
    expect(v2.beforeAfter).toBeNull();
  });
});

describe('Lawn Report V2 — property rainfall is authoritative over the area snapshot', () => {
  // When the property's own Open-Meteo rainfall is known, mapWater returns
  // property-level water totals and ignores the regional area snapshot. The
  // diagnosis / insights / overwatering signal must ignore it too — otherwise the
  // water CARD (property source) shows one thing while the Water/Coverage diagnosis
  // (area source) says another. Regression for the usingSnapshot gate.
  const deficitAssessment = () => baseAssessment({
    observations: 'Turf looks dry and is showing drought stress across the lawn.',
    aiSummary: 'Dry, under-watered turf with tan patches.',
    overwateringSignal: false,
    waterContext: {
      rainfallInches7d: 0.1, irrigationInchesPerWeek: 0.3, effectiveInches7d: 0.4, targetInchesPerWeek: 1.25,
      irrigationAdvice: { status: 'deficit', rainKnown: true, profileMissing: false, recommendedInchesPerWeek: 1.25 },
    },
  });
  // Area snapshot says the OPPOSITE — wet / overwatered.
  const WET_SNAPSHOT = {
    status: 'high', interpretation: 'wet_condition_watch',
    adjusted_rain_7day_inches: 3.4, rain_7day_inches: 3.4, irrigation_inches_per_week: 1.5,
    total_water_7day_inches: 4.9, target_water_inches_per_week: 1.25, confidence: 'high',
  };

  test('a conflicting area snapshot is ignored end-to-end when property rainfall is known', () => {
    const assessment = deficitAssessment();
    const baseline = buildLawnReportV2({ lawnAssessment: assessment, applications: APPLICATIONS });
    const withConflict = buildLawnReportV2({ lawnAssessment: assessment, applications: APPLICATIONS, waterSnapshot: WET_SNAPSHOT });

    // Water card uses the property irrigation-advice path, not the snapshot.
    expect(withConflict.water.source).toBe('irrigation_advice');
    // The snapshot must not change the diagnosis-layer outputs at all — same root
    // cause and same Water/Coverage category as with no snapshot.
    expect(withConflict.snapshot.rootCause).toEqual(baseline.snapshot.rootCause);
    const waterCat = (r) => r.diagnosis.find((c) => c.key === 'water_moisture_stress');
    expect(waterCat(withConflict)).toEqual(waterCat(baseline));
    // And nothing in the report claims a water surplus / overwatering.
    const txt = collectStrings(withConflict).join(' ').toLowerCase();
    expect(txt).not.toMatch(/too much water|overwater/);
  });

  test('with NO property rainfall, a usable area snapshot still drives the diagnosis', () => {
    // Strip property rainfall so clientRainKnown is false → snapshot is authoritative.
    const assessment = baseAssessment({
      overwateringSignal: false,
      observations: 'Damp, spongy turf with a few mushrooms.',
      aiSummary: 'Soil reads wet; some fungal pressure.',
      waterContext: {
        rainfallInches7d: null, irrigationInchesPerWeek: 1.4, effectiveInches7d: null, targetInchesPerWeek: 1.25,
        irrigationAdvice: { status: null, rainKnown: false, profileMissing: false, recommendedInchesPerWeek: 1.25 },
      },
    });
    const withSnap = buildLawnReportV2({ lawnAssessment: assessment, applications: APPLICATIONS, waterSnapshot: WET_SNAPSHOT });
    const noSnap = buildLawnReportV2({ lawnAssessment: assessment, applications: APPLICATIONS });
    // The snapshot is the only water signal here, so it must change the report.
    expect(withSnap.snapshot.rootCause).not.toEqual(noSnap.snapshot.rootCause);
  });
});


describe('Tan edge wear does not establish a watering problem', () => {
  const renderObservation = observations => buildLawnReportV2({
    lawnAssessment: baseAssessment({
      ...CASES.healthy,
      observations,
      aiSummary: 'Dense green turf with ordinary edge wear.',
    }),
  });

  test('does not invent sprinkler advice from normal tan edge wear', () => {
    const report = renderObservation('Minor tan patches near pavement are normal wear. No signs of weeds, disease, insect damage, or watering problems are visible.');
    expect(report.water.coverageWatch).toBe(false);
    expect(report.insights.some(card => card.category === 'water')).toBe(false);
    expect(report.smsSummary).not.toMatch(/sprinkler|watching watering/i);
  });

  test.each([
    'No signs of underwatering are visible.',
    'The lawn is not under-watered.',
    'No current signs of under watering are visible.',
    'The turf is without signs of underwatering.',
    'The lawn isn’t under-watered.',
    'Underwatering was not observed.',
    'Underwatering is absent.',
    'No evidence of overwatering or underwatering.',
    'No signs of over-watering or under-watering are visible.',
    'Underwatering is not a concern.',
    'Underwatering isn’t the problem.',
    'No signs of overwatering, underwatering, or disease are visible.',
    'No disease, weed pressure, or underwatering is visible.',
    'Underwatering has not been observed.',
    'Underwatering hasn’t been observed.',
    'Underwatering was ruled out.',
    'Underwatering has been ruled out.',
    'Underwatering is not indicated.',
    'Underwatering was not detected.',
    'No clear visual evidence of underwatering.',
    'Underwatering is not likely.',
    'No signs of overwatering and underwatering are visible.',
    'Underwatering was not seen and no disease was present.',
    'Underwatering was not observed, no disease was present.',
    'Underwatering is not present and the lawn looks healthy.',
    'Underwatering is not currently evident.',
    'Underwatering and disease were not observed.',
    'Underwatering is not an active concern.',
    'Underwatering is currently not evident.',
    'Underwatering symptoms are not visible.',
    'The lawn doesn’t show signs of underwatering.',
    'Underwatering couldn’t be confirmed.',
    'Underwatering is no longer evident.',
    'The lawn does not yet show signs of underwatering.',
    'The lawn doesn’t yet show signs of underwatering.',
    'Neither disease nor underwatering is evident.',
    'Underwatering is neither visible nor evident.',
    'Underwatering was excluded based on the even turf color.',
    'The photo is inconsistent with underwatering.',
    'Underwatering was considered but excluded after reviewing the even turf color.',
    'Underwatering was considered, but it was ruled out after reviewing the turf.',
    'No signs of sprinklers not reaching the pavement are visible.',
    'Underwatering was considered but not observed.',
    'Underwatering was considered, but not currently evident.',
    'Underwatering was considered, but it hasn’t been observed.',
    'No visible moisture stress. Continue monitoring for underwatering during hot weather.',
    'Monitor for under-watering during hot weather.',
    'Watch for signs of underwatering next week.',
    'Check for underwatering if hot weather continues.',
    'Maintain watering to prevent underwatering.',
    'There is a risk of underwatering during hot weather.',
    'If underwatering develops, check the sprinklers.',
    'The lawn could become under-watered next week.',
    'The lawn may be under-watered if hot weather continues.',
    'Underwatering could develop during hot weather.',
    'Underwatering may become visible next week.',
    'Underwatering will occur if watering stops.',
    'Underwatering is possible during hot weather.',
    'Underwatering would explain future curling.',
    'Monitor for sprinklers not reaching the pavement edge.',
    'Underwatering, disease, and insect damage were not observed.',
    'Underwatering symptoms, such as curling, were not observed.',
    'Previously under-watered turf has recovered.',
    'Formerly under-watered turf is now healthy.',
    'Underwatering has resolved.',
    'Underwatering symptoms have cleared.',
    'Underwatering was corrected after the last visit.',
    'It is unclear whether underwatering is present.',
    'There is insufficient evidence to conclude the lawn is under-watered.',
    'It is uncertain whether the lawn is under-watered.',
    'Underwatering cannot be confirmed.',
    'Underwatering is unconfirmed.',
    'Evidence for underwatering is inconclusive.',
    'Underwatering was considered but was not confirmed.',
    'Underwatering was considered, but it has not been verified.',
    'Underwatering was considered but not proven.',
    'No evidence that the sprinkler heads are not reaching the edge.',
    'Monitor for sprinkler heads not reaching the pavement edge.',
  ])('does not invent sprinkler advice from %s', observation => {
    const report = renderObservation(observation);
    expect(report.water.coverageWatch).toBe(false);
    expect(report.insights.some(card => card.category === 'water')).toBe(false);
    expect(report.smsSummary).not.toMatch(/sprinkler|watching watering/i);
  });

  test.each([
    'Tan patches near the pavement look dry.',
    'Tan blades and curling point to under-watering.',
    'Tan blades and curling point to underwatering.',
    'Tan blades and curling point to under watering.',
    'The tan turf looks under-watered.',
    'Tan patches suggest uneven irrigation coverage.',
    'No weeds were seen and uneven irrigation coverage is visible near the driveway.',
    'No signs of underwatering in the center, but the edges are under-watered.',
    'The edges are under-watered. No weeds were seen.',
    'No weeds were seen and the edges look under-watered.',
    'No underwatering in the center; dry patches remain near the pavement.',
    'No weeds were seen, the edges are under-watered.',
    'No disease or weeds are present, but underwatering is visible near the pavement.',
    'No weeds were seen and underwatering is visible near the pavement.',
    'No weeds were seen, underwatering is visible near the pavement.',
    'Underwatering is not caused by the sprinkler schedule; a blocked head is responsible.',
    'The lawn is under-watered and weeds were not observed.',
    'The lawn is not only under-watered, it also shows wear near the pavement.',
    'No weeds were seen, yet the edges are under-watered.',
    'No weed activity is evident and mild underwatering is visible along the pavement.',
    'No weeds are apparent and underwatering symptoms are visible near the pavement.',
    'No weeds are evident and tan blades point to under-watering near the pavement.',
    'No weeds are evident and the edges look under-watered.',
    'Underwatering is inconsistent across the lawn.',
    'Tan blades and curling at the pavement edge suggest the sprinkler is not reaching that zone.',
    'Tan blades suggest sprinklers aren’t reaching that zone.',
    'Tan blades suggest the sprinkler does not reach that zone.',
    'We observed underwatering but excluded disease.',
    'We observed underwatering but not disease.',
    'Monitor for underwatering in the center; underwatering is visible along the pavement.',
    'Underwatering is visible along the pavement. Monitor for additional symptoms.',
    'Visible underwatering may require a sprinkler adjustment.',
    'Tan blades and curling suggest the sprinkler heads aren’t reaching that zone.',
    'Tan blades suggest the sprinkler head is not reaching that zone.',
    'Tan blades suggest the irrigation heads do not cover that zone.',
    'Previously under-watered turf has recovered, but underwatering is visible along the pavement.',
    'Underwatering has resolved in the center; the edges remain under-watered.',
    'It is unclear whether disease is present, but the turf is under-watered.',
    'Underwatering is visible. There is insufficient evidence of disease.',
  ])('preserves moisture evidence in %s', observation => {
    const report = renderObservation(observation);
    expect(report.water.coverageWatch).toBe(true);
    expect(report.insights.some(card => card.category === 'water')).toBe(true);
  });

  test('keeps an affirmative summary independent of a negated observation', () => {
    const report = buildLawnReportV2({
      lawnAssessment: baseAssessment({
        ...CASES.healthy,
        observations: 'No weeds',
        aiSummary: 'Underwatering is visible near the pavement.',
      }),
    });
    expect(report.water.coverageWatch).toBe(true);
    expect(report.insights.some(card => card.category === 'water')).toBe(true);
  });
});
