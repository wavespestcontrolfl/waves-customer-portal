// Word budget + one-owner-per-fact guard for the lawn report LEAD (lawn report
// rebuild P7, GATE_LAWN_REPORT_LEAD). Builds real reportV2 payloads across the
// consistency fixtures x weekly plan x watering banner, runs the reconcile tail
// with the gate ON, and asserts the lead stays inside the ~250 visible-word
// contract, never restates a banner or itself, and never talks about watering
// under a banner (the banner owns that task). Synthetic payloads only.

const { buildLawnReportV2 } = require('../services/service-report/lawn-report-v2');
const { applyLawnReportReconciliation } = require('../services/service-report/report-consistency');
const { buildWateringBanner } = require('../services/service-report/report-data');
const { buildWateringInstruction } = require('../services/service-report/lawn-watering-instruction');
const { leadWords, WATERING_WORDS } = require('../services/service-report/lawn-report-lead');

const DYNAMIC_CONTEXT_READY = { reentry: { targets: [{ statusAtGeneratedAt: 'ready' }], petAdvisory: 'Keep pets off treated turf until dry.' } };
const COMPLETED = '2026-09-30T18:40:00Z';
const WORD_BUDGET = 250;

// Same shapes as the golden fixtures in lawn-report-v2-consistency.test.js
// (that file does not export them).
function baseAssessment(overrides = {}) {
  return {
    scores: { turfDensity: 73, weedSuppression: 81, colorHealth: 77, stressDamage: 35, fungusControl: 95, overallScore: 68, season: 'peak' },
    overwateringSignal: false,
    droughtStress: 'minor',
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
    droughtStress: 'none',
    observations: 'Mushrooms and damp patches indicate too much water.',
    scores: { turfDensity: 58, weedSuppression: 44, colorHealth: 49, stressDamage: 35, fungusControl: 40, overallScore: 54, season: 'peak' },
    waterContext: { rainfallInches7d: 1.6, irrigationInchesPerWeek: 1.2, effectiveInches7d: 2.8, targetInchesPerWeek: 1.25, irrigationAdvice: { status: 'surplus', rainKnown: true, profileMissing: false, recommendedInchesPerWeek: 1.25 } },
  }),
  deficit: baseAssessment({
    observations: 'Turf looks dry and is showing drought stress across the lawn.',
    waterContext: { rainfallInches7d: 0.1, irrigationInchesPerWeek: 0.3, effectiveInches7d: 0.4, targetInchesPerWeek: 1.25, irrigationAdvice: { status: 'deficit', rainKnown: true, profileMissing: false, recommendedInchesPerWeek: 1.25 } },
  }),
  healthy: baseAssessment({
    droughtStress: 'none',
    observations: 'Thick, healthy, even turf with strong color and no visible stress.',
    aiSummary: 'Lawn is in excellent shape with strong density and color.',
    scores: { turfDensity: 88, weedSuppression: 92, colorHealth: 86, stressDamage: 90, fungusControl: 95, overallScore: 89, season: 'peak' },
    recommendations: {},
  }),
};

const RUN_PLAN = {
  title: 'This week: one full cycle per turf zone',
  detail: 'On your permitted watering day, about ½" of water per run.',
  action: 'run',
  visitInPlanWeek: true,
  prescribesRun: true,
  depthInches: 0.5,
  afterTreatment: { title: 'This week: covered by today’s treatment watering-in', detail: 'No further turf runs this week.' },
  afterHold: { title: 'This week: one full cycle per turf zone', detail: 'On your permitted watering day, about ½" of water per run. Not before Thu 3 PM: if your permitted watering day comes first, use your next permitted day after it; if there isn’t one this week, skip that run.' },
};

// 'none' = the banner's own "no watering change" state; 'absent' = no banner.
const BANNER_RULES = {
  hold: [{ mode: 'hold', hold_hours: 24, source: 'label', mowHoldDays: 2 }],
  water_in: [{ mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24, source: 'default' }],
  none: [{ mode: 'none', source: 'label' }],
  absent: null,
};

const CELSIUS = [{ product: { name: 'Celsius WG', category: 'herbicide', irrigation_required: false }, targets: ['weeds'] }];

const PROGRESS_26 = 'Since your last visit the thin areas along the front edge have started to fill in, and the color across the whole lawn looks a little deeper green now.';

function build(caseName, weekPlan, bannerKind, { progress = null } = {}) {
  const base = CASES[caseName];
  const rules = BANNER_RULES[bannerKind];
  const instruction = rules ? buildWateringInstruction({ rules, completedAt: COMPLETED }) : null;
  const reportV2 = buildLawnReportV2({
    lawnAssessment: { ...base, waterContext: { ...base.waterContext, weekPlan } },
    applications: CELSIUS,
    wateringInstruction: instruction,
  });
  if (instruction) {
    const banner = buildWateringBanner(instruction, weekPlan);
    if (banner) reportV2.banner = banner;
  }
  if (progress) reportV2.snapshot = { ...reportV2.snapshot, progress };
  const data = applyLawnReportReconciliation(
    { serviceLine: 'lawn', summary: base.aiSummary, lawnAssessment: base, reportV2 },
    DYNAMIC_CONTEXT_READY,
  );
  return data.reportV2;
}

const tokens = (s) => String(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
const jaccard = (a, b) => {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  const inter = [...A].filter((t) => B.has(t)).length;
  return inter / (A.size + B.size - inter || 1);
};
const norm = (s) => tokens(s).join(' ');

function leadStrings(v2) {
  const { lead } = v2;
  return [lead.headline, lead.why, lead.progress, lead.applied, lead.next, ...lead.yourPart].filter(Boolean);
}
function bannerStrings(v2) {
  const banner = v2.banner;
  if (!banner) return [];
  return [...(banner.lines || []), banner.mowHold && banner.mowHold.line].filter(Boolean);
}

const GRID = [];
for (const caseName of Object.keys(CASES)) {
  for (const [planName, plan] of [['no plan', null], ['run plan', RUN_PLAN]]) {
    for (const bannerKind of Object.keys(BANNER_RULES)) GRID.push([caseName, planName, bannerKind, plan]);
  }
}

describe('lawn report lead word budget', () => {
  let previous;
  beforeAll(() => { previous = process.env.GATE_LAWN_REPORT_LEAD; process.env.GATE_LAWN_REPORT_LEAD = 'true'; });
  afterAll(() => {
    if (previous === undefined) delete process.env.GATE_LAWN_REPORT_LEAD;
    else process.env.GATE_LAWN_REPORT_LEAD = previous;
  });

  test('the grid really exercises banner, plan and no-banner paths', () => {
    expect(GRID.length).toBe(4 * 2 * 4);
    const hold = build('healthy', RUN_PLAN, 'hold');
    expect(hold.banner.state).toBe('hold');
    expect(hold.banner.mowHold.line).toBeTruthy();
    expect(build('healthy', null, 'water_in').banner.state).toBe('water_in');
    expect(build('healthy', null, 'none').banner.state).toBe('none');
    expect(build('healthy', null, 'absent').banner).toBeUndefined();
  });

  test.each(GRID)('%s / %s / banner %s: lead stays within the word budget', (caseName, planName, bannerKind, plan) => {
    const v2 = build(caseName, plan, bannerKind);
    expect(v2.lead).toBeTruthy();
    expect(leadWords(v2)).toBeLessThanOrEqual(WORD_BUDGET);
  });

  test.each(GRID)('%s / %s / banner %s: still within budget with a 26-word progress line', (caseName, planName, bannerKind, plan) => {
    const v2 = build(caseName, plan, bannerKind, { progress: PROGRESS_26 });
    expect(v2.lead.progress).toBe(PROGRESS_26);
    expect(leadWords(v2)).toBeLessThanOrEqual(WORD_BUDGET);
  });

  test.each(GRID)('%s / %s / banner %s: no lead or banner string repeats another', (caseName, planName, bannerKind, plan) => {
    const v2 = build(caseName, plan, bannerKind, { progress: PROGRESS_26 });
    const all = [
      ...leadStrings(v2).map((text) => ({ owner: 'lead', text })),
      ...bannerStrings(v2).map((text) => ({ owner: 'banner', text })),
    ].filter(({ text }) => tokens(text).length >= 5);
    for (let i = 0; i < all.length; i += 1) {
      for (let j = i + 1; j < all.length; j += 1) {
        const a = all[i];
        const b = all[j];
        const label = `${a.owner}:"${a.text}" vs ${b.owner}:"${b.text}"`;
        expect({ label, similar: jaccard(a.text, b.text) >= 0.6 }).toEqual({ label, similar: false });
        expect({ label, contains: norm(a.text).includes(norm(b.text)) || norm(b.text).includes(norm(a.text)) }).toEqual({ label, contains: false });
      }
    }
  });

  test.each(GRID.filter(([, , bannerKind]) => bannerKind !== 'absent'))(
    '%s / %s / banner %s: under a banner no lead field mentions watering',
    (caseName, planName, bannerKind, plan) => {
      const v2 = build(caseName, plan, bannerKind, { progress: PROGRESS_26 });
      for (const text of leadStrings(v2)) {
        expect({ text, watering: WATERING_WORDS.test(text) }).toEqual({ text, watering: false });
      }
    },
  );
});
