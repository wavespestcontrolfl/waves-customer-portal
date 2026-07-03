// Golden-fixture consistency tests for the Lawn Report V2 synthesis layer.
// Renders the report from representative payloads and asserts the report can never
// (a) emit banned/over-claiming customer copy, or (b) contradict itself — the trust
// failures the report-consistency layer exists to prevent. Synthetic payloads only
// (no customer PII). If a future copy/LLM/logic change reintroduces a contradiction,
// one of these fails.

const { buildLawnReportV2 } = require('../services/service-report/lawn-report-v2');
const { reconcileLawnReport } = require('../services/service-report/report-consistency');
const { findBannedCustomerCopy } = require('../services/service-report/activity-indicators');
const { buildServiceReportV1Sms } = require('../services/service-report/delivery');
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

  test('SMS leads with the frozen synthesis line (single source of truth)', () => {
    const summaryLine = 'Your St. Augustine lawn report is ready: stable — watching watering. Check sprinkler coverage there.';
    const withSummary = buildServiceReportV1Sms({ customerFirstName: 'Tony', reportUrl: 'https://x/r/abc', summaryLine });
    expect(withSummary).toContain('Hi Tony, your St. Augustine lawn report is ready');
    expect(withSummary).toContain('https://x/r/abc');
    expect(withSummary).toContain('Reply STOP');

    const generic = buildServiceReportV1Sms({ customerFirstName: 'Tony', reportUrl: 'https://x/r/abc' });
    expect(generic).toContain('your Waves service report is ready');
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
