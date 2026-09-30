// Golden-fixture consistency tests for the Lawn Report V2 synthesis layer.
// Renders the report from representative payloads and asserts the report can never
// (a) emit banned/over-claiming customer copy, or (b) contradict itself — the trust
// failures the report-consistency layer exists to prevent. Synthetic payloads only
// (no customer PII). If a future copy/LLM/logic change reintroduces a contradiction,
// one of these fails.

const { buildLawnReportV2 } = require('../services/service-report/lawn-report-v2');
const { reconcileLawnReport, applyLawnReportReconciliation } = require('../services/service-report/report-consistency');
const { findBannedCustomerCopy } = require('../services/service-report/activity-indicators');
const { buildServiceReportV1SmsVars } = require('../services/service-report/delivery');
const { frozenSmsSummary } = require('../services/service-report/lawn-report-write-gate');
const {
  hasCreditableWaterIn, normalizeLawnAftercare, renderedWeekPlan, resolveLawnAftercare,
} = require('../services/service-report/lawn-aftercare');

const APPLICATIONS = [
  { product: { name: 'SedgeHammer Plus', active_ingredient: 'halosulfuron-methyl', category: 'herbicide', reentry_summary: 'Follow the product label before re-entering treated areas.' }, targets: ['weeds'] },
];
const DYNAMIC_CONTEXT_READY = { reentry: { targets: [{ statusAtGeneratedAt: 'ready' }], petAdvisory: 'Keep pets off treated turf until dry.' } };

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

describe('unconfirmed product directions take precedence throughout the report', () => {
  test.each([
    ['healthy', null, 'balanced'],
    ['deficit', null, 'deficit'],
    ['deficit', { title: 'Run two cycles this week', action: 'run' }, 'deficit'],
    ['overWatered', { title: 'Skip watering this week', action: 'hold' }, 'surplus'],
    ['balancedDryCoverage', null, 'balanced'],
    ['balancedDryCoverage', null, 'unknown'],
  ])('%s with plan %j and %s water retains one confirmation task', (scenario, weekPlan, waterStatus) => {
    const assessment = CASES[scenario];
    const waterContext = { ...assessment.waterContext, weekPlan };
    waterContext.irrigationAdvice = { ...waterContext.irrigationAdvice, status: waterStatus };
    const report = buildLawnReportV2({
      lawnAssessment: { ...assessment, waterContext },
      applications: [{ product: { irrigation_required: true } }],
    });
    expect(report.aftercare.needsReview).toBe(true);
    expect(report.snapshot.customerAction).toMatch(/Confirm the product watering directions/);
    expect(report.snapshot.customerAction.match(/Confirm the product watering directions/g)).toHaveLength(1);
    if (scenario === 'balancedDryCoverage') expect(report.snapshot.customerAction).toContain('Check sprinkler coverage');
    expect(report.snapshot.noActionNeeded).toBe(false);
    expect(report.snapshot.rootCause).toBeNull();
    expect(report.water.explanation).toMatch(/Confirm the product watering directions/);
    expect(report.snapshot.customerAction).not.toMatch(/follow it as written|a bit more even watering|Add a little irrigation time/);
    const reconciled = reconcileLawnReport({
      data: { lawnAssessment: { ...assessment, recommendations: { nextVisitFocus: 'Recheck the recorded lawn areas next visit.' } } },
      reportV2: report,
    });
    expect(reconciled.followUp.customerAction).toMatch(/Confirm the product watering directions/);
    expect(reconciled.followUp.customerAction).not.toMatch(/No action is needed/);
  });
});

// PR #5033: each review finding, one row. Every surface reads the verdict
// lawn-aftercare.js resolves, so a row failing names the surface that drifted.
describe('aftercare verdict fixture table (PR #5033 findings)', () => {
  const { answerServiceReportQuestion } = require('../services/service-report/report-assistant');
  const { buildAftercare } = require('../services/service-report/lawn-report-v2');
  const { applyLawnReportNarrative } = require('../services/service-report/lawn-report-narrative');
  const CONFIRM = /Confirm the product watering directions/;
  const PLAN_CONDITION = /before applying the plan below/;
  const RUN_PLAN = { title: 'This week: run once', detail: 'One turf cycle before Friday.', action: 'run' };
  const reviewAftercare = () => buildAftercare([{ product: { irrigation_required: true } }]);
  const render = (scenario, weekPlan = null) => buildLawnReportV2({
    lawnAssessment: { ...CASES[scenario], waterContext: { ...CASES[scenario].waterContext, weekPlan } },
    applications: [{ product: { irrigation_required: true } }],
  });
  const ask = (question, water = { weekPlan: null }) => answerServiceReportQuestion({
    question,
    data: {
      pressureIndex: null,
      dynamicContext: {},
      findings: [{ title: 'Mushrooms observed', detail: 'Near the sprinkler heads.' }],
      reportV2: { aftercare: reviewAftercare(), water },
    },
  });

  const creditedAftercare = () => ({
    watering: 'Water in with 0.25 inches today.', waterInRequired: true, neutral: false,
    creditableWaterIn: true, evidenceSource: 'product_instruction', wateringHold: false, needsReview: false,
  });
  const CREDIT_PLAN = {
    ...RUN_PLAN, visitInPlanWeek: true, prescribesRun: true,
    afterTreatment: { title: 'This week: covered by today’s treatment watering-in', detail: 'No further turf runs this week.' },
  };
  // A report built as the product-note classifier will build it: the visit's
  // aftercare resolves to a verified, credited water-in.
  const renderWithCredit = (scenario, weekPlan = null) => {
    let report;
    jest.isolateModules(() => {
      const real = jest.requireActual('../services/service-report/lawn-aftercare');
      jest.doMock('../services/service-report/lawn-aftercare', () => ({
        ...real,
        normalizeLawnAftercare: (a, opts) => (a && a.waterInRequired === true && !a.evidenceSource ? creditedAftercare() : real.normalizeLawnAftercare(a, opts)),
      }));
      report = require('../services/service-report/lawn-report-v2').buildLawnReportV2({
        lawnAssessment: { ...CASES[scenario], waterContext: { ...CASES[scenario].waterContext, weekPlan } },
        applications: [{ product: { irrigation_required: true } }],
      });
    });
    return report;
  };
  const neutralAftercare = () => ({ watering: 'No special watering is needed because of today’s treatment.', neutral: true });
  // Drought-signal report (the only one the overlay rewrites) whose model
  // output swaps every customer action for generic drought advice.
  const GENERIC_DROUGHT = 'Add extra irrigation every day this week to beat the drought.';
  const rewrite = async (aftercare, observations) => {
    const report = buildLawnReportV2({ lawnAssessment: CASES.deficit });
    report.aftercare = aftercare;
    const before = JSON.parse(JSON.stringify(report));
    const callModel = jest.fn(async () => ({ ok: true, json: {
      customerAction: GENERIC_DROUGHT,
      insights: report.insights.map(() => ({ customerAction: GENERIC_DROUGHT })),
    } }));
    return { before, callModel, out: await applyLawnReportNarrative(report, { observations }, { callModel }) };
  };
  const keepsCreditedActions = ({ before, callModel, out }) => {
    expect(before.water.droughtSignal).toBe(true);
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(out.aftercare).toEqual(creditedAftercare());
    expect(out.snapshot.customerAction).toBeTruthy();
    expect(out.snapshot.customerAction).toBe(before.snapshot.customerAction);
    expect(out.insights.map((i) => i.customerAction)).toEqual(before.insights.map((i) => i.customerAction));
    expect(JSON.stringify(out)).not.toContain(GENERIC_DROUGHT);
  };

  test.each([
    ['P1 hero watering advice waits on aftercare review', () => render('deficit', RUN_PLAN), (report) => {
      expect(report.snapshot.rootCause).toBeNull();
      expect(report.water.explanation).toMatch(CONFIRM);
    }],
    ['P1 no-action claim is suppressed while water-in needs review', () => render('healthy'), (report) => {
      expect(report.snapshot.noActionNeeded).toBe(false);
      expect(report.snapshot.customerAction).toMatch(CONFIRM);
    }],
    ['P1 generic next-step answer includes the confirmation', () => ask('What should I do next?'), (answer) => {
      expect(answer).toMatch(/^Confirm the product watering directions/);
    }],
    ['P2 observation-qualified action request routes to next steps', () => ask('What are the next steps for the mushrooms you found?'), (answer) => {
      expect(answer).toMatch(/^Confirm the product watering directions/);
      expect(answer).not.toMatch(/Mushrooms observed/);
    }],
    ['P2 need-to-water question outranks findings wording', () => ask('I observed dry spots; do I need to water?', { weekPlan: { ...RUN_PLAN, visitInPlanWeek: true } }), (answer) => {
      expect(answer).toMatch(PLAN_CONDITION);
      expect(answer).toContain(RUN_PLAN.title);
      expect(answer).not.toMatch(/Mushrooms observed/);
    }],
    ['P2 past-visit aftercare does not gate the current plan', () => ask('Should I water this week?', { weekPlan: { ...RUN_PLAN, visitInPlanWeek: false } }), (answer) => {
      expect(answer).toContain(RUN_PLAN.title);
      expect(answer).not.toMatch(PLAN_CONDITION);
    }],
    ['P2 a recorded amount or timing is never denied', () => buildAftercare([{ product: { irrigation_required: true, irrigation_notes: 'Apply 0.25 inches within 24 hours.' } }]), (aftercare) => {
      expect(aftercare.watering).toContain('Apply 0.25 inches within 24 hours.');
      expect(aftercare.watering).not.toMatch(/not recorded/);
      expect(aftercare).toMatchObject({ needsReview: true, creditableWaterIn: false });
    }],
    ['P1 narrative rewrite keeps credited aftercare customer actions', () => rewrite(creditedAftercare(), 'Credited aftercare rewrite.'), keepsCreditedActions],
    ['P1 narrative cache never serves another aftercare verdict', async () => {
      await rewrite(neutralAftercare(), 'Shared narrative facts.');
      return rewrite(creditedAftercare(), 'Shared narrative facts.');
    }, keepsCreditedActions],
    ['P2 passive watering question outranks findings wording', () => ['I found mushrooms; should the lawn be watered?', 'I found mushrooms; may I water?', 'You found dry spots; does it need water?']
      .map((question) => ask(question, { weekPlan: { ...RUN_PLAN, visitInPlanWeek: true } })), (answers) => {
      for (const answer of answers) {
        expect(answer).toMatch(PLAN_CONDITION);
        expect(answer).toContain(RUN_PLAN.title);
        expect(answer).not.toMatch(/Mushrooms observed/);
      }
    }],
    // Round 4 (PR #5033 findings on fb3f59b606).
    ['P1 no recorded instruction never earns water-in credit', () => resolveLawnAftercare({ ...creditedAftercare(), watering: '  ' }), (state) => {
      expect(state).toEqual({ verdict: 'review', customerTask: expect.stringMatching(CONFIRM), restricts: true, credited: false });
      expect(renderedWeekPlan({ ...creditedAftercare(), watering: '' }, CREDIT_PLAN)).toBe(CREDIT_PLAN);
    }],
    ['P1 a credited water-in stays the customer task on hero, follow-up and next steps', () => {
      const report = renderWithCredit('healthy');
      const followUp = reconcileLawnReport({
        data: { lawnAssessment: { ...CASES.healthy, recommendations: { nextVisitFocus: 'Recheck the lawn next visit.' } } },
        reportV2: report,
      }).followUp;
      const nextSteps = answerServiceReportQuestion({ question: 'What should I do next?', data: { pressureIndex: null, dynamicContext: {}, reportV2: { aftercare: creditedAftercare() } } });
      return { report, followUp, nextSteps };
    }, ({ report, followUp, nextSteps }) => {
      expect(report.aftercare.creditableWaterIn).toBe(true);
      expect(report.snapshot.customerAction).toContain(creditedAftercare().watering);
      expect(report.snapshot.noActionNeeded).toBe(false);
      expect(followUp.customerAction).toBe(creditedAftercare().watering);
      expect(nextSteps).toMatch(/^Water in with 0\.25 inches today\./);
    }],
    ['P1 an unsupported evidence source fails closed into review', () => normalizeLawnAftercare({ watering: 'Water in today.', evidenceSource: 'irrigation_requirement', creditableWaterIn: true, needsReview: false }), (aftercare) => {
      expect(aftercare).toMatchObject({ needsReview: true, creditableWaterIn: false, evidenceSource: 'legacy_unverified_instruction' });
      expect(aftercare.watering).toContain('Water in today.');
      expect(resolveLawnAftercare(aftercare)).toMatchObject({ verdict: 'review', restricts: true });
    }],
    ['P1 sprinkler activation requests are watering requests', () => ['Can I turn my sprinklers back on?', 'Should I switch irrigation back on?', 'May I start the sprinkler system?', 'Can I start watering?']
      .map((question) => ask(question, { weekPlan: { ...RUN_PLAN, visitInPlanWeek: true } })), (answers) => {
      for (const answer of answers) {
        expect(answer).toMatch(PLAN_CONDITION);
        expect(answer).toContain(RUN_PLAN.title);
      }
    }],
    ['P1 narrative water copy is grounded in the rendered reduced plan', async () => {
      const report = buildLawnReportV2({ lawnAssessment: { ...CASES.deficit, waterContext: { ...CASES.deficit.waterContext, weekPlan: CREDIT_PLAN } } });
      report.aftercare = creditedAftercare();
      const before = JSON.parse(JSON.stringify(report));
      const callModel = jest.fn(async () => ({ ok: true, json: { water: 'Rain this week was low, so water once on Wednesday for the week.' } }));
      return { before, callModel, out: await applyLawnReportNarrative(report, { observations: 'Reduced plan grounding.' }, { callModel }) };
    }, ({ before, callModel, out }) => {
      const facts = callModel.mock.calls[0][0].text;
      expect(facts).toContain(CREDIT_PLAN.afterTreatment.title);
      expect(facts).not.toContain(CREDIT_PLAN.detail);
      expect(out.water.explanation).toBe(before.water.explanation);
    }],
    ['P2 credited water explanation is never rewritten against the product note', async () => {
      const report = buildLawnReportV2({ lawnAssessment: CASES.deficit });
      report.aftercare = creditedAftercare();
      const before = JSON.parse(JSON.stringify(report));
      const callModel = jest.fn(async () => ({ ok: true, json: { water: 'Rain this week was low, so skip the product watering-in and delay irrigation until next week.' } }));
      return { before, out: await applyLawnReportNarrative(report, { observations: 'Credited no-plan water copy.' }, { callModel }) };
    }, ({ before, out }) => {
      expect(out.water.explanation).toBe(before.water.explanation);
      expect(out.water.explanation).not.toMatch(/skip the product watering-in/);
    }],
    // Round 10 (PR #5033, codex P2 on lawn-report-v2.js:653): a reopened/
    // history-carried report's own attached weekPlan can mark
    // visitInPlanWeek: false — that visit's aftercare (review confirmation
    // or a credited instruction) must stay a historical Aftercare-section
    // note, never this week's hero action, noActionNeeded flip, or SMS line.
    ['P2 a past-visit review confirmation does not become this visit’s current action', () => render('healthy', { ...RUN_PLAN, visitInPlanWeek: false }), (report) => {
      expect(report.aftercare.needsReview).toBe(true);
      expect(String(report.snapshot.customerAction || '')).not.toMatch(CONFIRM);
      expect(String(report.smsSummary || '')).not.toMatch(CONFIRM);
    }],
    ['P2 a past-visit credited water-in does not become this visit’s current action', () => renderWithCredit('healthy', { ...RUN_PLAN, visitInPlanWeek: false }), (report) => {
      expect(report.aftercare.creditableWaterIn).toBe(true);
      expect(String(report.snapshot.customerAction || '')).not.toContain(creditedAftercare().watering);
      expect(String(report.smsSummary || '')).not.toContain(creditedAftercare().watering);
    }],
    // Round 7 (PR #5033 findings on ca8bbecf87): the hero-action fix above
    // (round 10) only guarded the direct-task promotion. Three more surfaces
    // still read the unscoped verdict: the water card's own action, the
    // follow-up card, and the assistant's generic "what's next" answer.
    ['P2 a past-visit review confirmation is stripped from the water card action', () => render('deficit', { ...RUN_PLAN, visitInPlanWeek: false }), (report) => {
      const waterCard = report.insights.find((c) => c.category === 'water');
      expect(waterCard).toBeDefined();
      expect(waterCard.customerAction).not.toMatch(CONFIRM);
      expect(report.water.explanation).not.toMatch(CONFIRM);
    }],
    ['P2 a past-visit review confirmation is stripped from the follow-up card', () => {
      const report = render('deficit', { ...RUN_PLAN, visitInPlanWeek: false });
      return reconcileLawnReport({
        data: { lawnAssessment: { ...CASES.deficit, recommendations: { nextVisitFocus: 'Recheck the recorded lawn areas next visit.' } } },
        reportV2: report,
      }).followUp;
    }, (followUp) => {
      expect(followUp).toBeTruthy();
      expect(followUp.customerAction).not.toMatch(CONFIRM);
      expect(followUp.customerAction).toMatch(/No action is needed/);
    }],
    ['P2 a past-visit review confirmation is stripped from assistant next steps', () => ask('What should I do next?', { weekPlan: { ...RUN_PLAN, visitInPlanWeek: false } }), (answer) => {
      expect(answer).not.toMatch(CONFIRM);
    }],
    // Round 8 (PR #5033 on lawn-report-v2.js:654): a credited watering-in
    // instruction can itself read like drought advice ("Water in
    // drought-stressed areas…"); promoting it into snapshot.customerAction
    // must not expose it to the SAME rain-vs-drought rewrite that reconciles
    // the surrounding prose, or the hero disagrees with the Aftercare
    // section's own (untouched) instruction.
    ['P1 drought reconciliation preserves a credited instruction word for word', () => {
      const report = renderWithCredit('deficit');
      report.aftercare = { ...creditedAftercare(), watering: 'Water in drought-stressed areas with 0.25 inches today.' };
      report.water = { ...report.water, droughtSignal: true, rainInches: 3, targetInches: 1.25 };
      report.snapshot = {
        ...report.snapshot,
        customerAction: `${report.aftercare.watering} Damage could be drought-related in the other zones.`,
      };
      const fix = reconcileLawnReport({ data: { lawnAssessment: CASES.deficit }, reportV2: report });
      return { report, fix };
    }, ({ report, fix }) => {
      expect(fix).toBeTruthy();
      // The credited instruction survives verbatim…
      expect(fix.snapshot.customerAction).toContain(report.aftercare.watering);
      // …while the surrounding drought hypothesis is still reconciled.
      expect(fix.snapshot.customerAction).toMatch(/sprinkler-coverage-related/);
    }],
    // Round 8 (PR #5033 on lawn-report-v2.js:657): a credited water-in on a
    // surplus/damp water card phrases the SAME task generically ("Water in
    // today's application as directed…") rather than quoting the recorded
    // instruction — the literal `includes` check missed that semantic
    // duplicate and the hero repeated the watering command twice.
    ['P2 a credited water-in is not repeated when the water card already states it', () => renderWithCredit('overWatered'), (report) => {
      const waterCard = report.insights.find((c) => c.category === 'water');
      expect(waterCard).toBeDefined();
      expect(waterCard.customerAction).toMatch(/^Water in today’s application as directed/);
      // The hero shows the card's own wording once — not the card's generic
      // phrasing AND the recorded instruction concatenated.
      expect(report.snapshot.customerAction).toBe(waterCard.customerAction);
      expect(report.snapshot.customerAction).not.toContain(creditedAftercare().watering);
    }],
    // PR #5033 round 5 routing findings, moved to this follow-up.
    ['P1 an activation request outranks observation wording', () => ['I found dry spots; can I turn my sprinklers back on?', 'You spotted fungus; should I switch irrigation back on?']
      .map((question) => ask(question)), (answers) => {
      for (const answer of answers) {
        expect(answer).toMatch(CONFIRM);
        expect(answer).not.toMatch(/Mushrooms observed/);
      }
    }],
    ['P1 watering-adjustment requests carry the aftercare task', () => ['Should I adjust my irrigation?', 'Can I reduce irrigation?', 'Can I increase watering?', 'Should I turn off the sprinklers?', 'Should I cut back on watering?', 'Can I water less this week?']
      .map((question) => ask(question)), (answers) => {
      for (const answer of answers) expect(answer).toMatch(CONFIRM);
    }],
    // PR #5258 round 1.
    ['P1 system-subject activation requests carry the aftercare task', () => ['Can the sprinklers be turned back on?', 'Should the irrigation stay off?', 'When can watering be resumed?', 'Can my sprinklers run tonight?', 'Can the irrigation be reduced?']
      .map((question) => ask(question)), (answers) => {
      for (const answer of answers) expect(answer).toMatch(CONFIRM);
    }],
    // PR #5258 round 2: any question naming watering is a watering question
    // unless the word is incidental.
    ['P1 keep / leave watering requests carry the aftercare task', () => ['Can I leave the sprinklers off?', 'Is it okay to leave irrigation off?', 'Am I supposed to keep the sprinklers off?']
      .map((question) => ask(question)), (answers) => {
      for (const answer of answers) expect(answer).toMatch(CONFIRM);
    }],
  ])('%s', async (_finding, run, check) => check(await run()));
});

// The aftercare state table (lawn-aftercare.js). Every combination of the
// inputs resolves by the documented first-match rules, the outputs follow
// from the verdict, and normalization never changes the verdict.
describe('aftercare state table covers every input combination', () => {
  const INSTRUCTION = 'Water in with 0.25 inches today.';
  const combos = [];
  for (const neutral of [false, true]) {
    for (const watering of [INSTRUCTION, '', undefined]) {
      for (const evidenceSource of ['product_instruction', 'legacy_unverified_instruction', 'irrigation_requirement', undefined]) {
        for (const needsReview of [false, true]) {
          for (const wateringHold of [false, true]) {
            for (const creditableWaterIn of [false, true]) {
              combos.push({ neutral, watering, evidenceSource, needsReview, wateringHold, creditableWaterIn });
            }
          }
        }
      }
    }
  }
  // The documented table, first match wins.
  const expected = (a) => {
    const claimed = a.needsReview || a.wateringHold || a.creditableWaterIn || Boolean(a.evidenceSource);
    if (a.neutral && !claimed) return 'none';
    if (!a.watering) return claimed ? 'review' : 'none';
    if (a.evidenceSource !== 'product_instruction' || a.needsReview) return 'review';
    if (a.wateringHold) return 'hold';
    if (a.creditableWaterIn) return 'credit';
    return 'none';
  };

  test(`${combos.length} combinations resolve by the table`, () => {
    expect(combos).toHaveLength(192);
    for (const input of combos) {
      const verdict = expected(input);
      const state = resolveLawnAftercare(input);
      expect({ input, verdict: state.verdict }).toEqual({ input, verdict });
      expect(state.credited).toBe(verdict === 'credit');
      expect(state.restricts).toBe(verdict === 'review' || verdict === 'hold');
      expect(Boolean(state.customerTask)).toBe(verdict !== 'none');
      if (verdict === 'credit') expect(state.customerTask).toBe(INSTRUCTION);
      // Credit requires a recorded, verified, unrestricted instruction.
      if (state.credited) expect(input).toMatchObject({ watering: INSTRUCTION, evidenceSource: 'product_instruction', needsReview: false, wateringHold: false });
      const normalized = normalizeLawnAftercare(input);
      expect({ input, verdict: resolveLawnAftercare(normalized).verdict }).toEqual({ input, verdict });
      expect(resolveLawnAftercare(normalizeLawnAftercare(normalized)).verdict).toBe(verdict);
      expect(hasCreditableWaterIn(normalized)).toBe(verdict === 'credit');
    }
  });
});

describe('structured moisture evidence owns sprinkler advice', () => {
  const render = (overrides = {}) => buildLawnReportV2({
    lawnAssessment: baseAssessment({ ...CASES.healthy, ...overrides }),
  });
  const waterCard = report => report.insights.find(card => card.category === 'water');

  // Counterexamples from every hosted review of #3952. The categorical finding
  // travels separately from these captions; grammar cannot add or erase it.
  test.each([
    'Tan blades and curling point to under-watering.',
    'No weed activity is evident and mild underwatering is visible along the pavement.',
    'Tan blades and curling at the pavement edge suggest the sprinkler is not reaching that zone.',
    "Tan blades and curling suggest the sprinkler heads aren't reaching that zone.",
    'Tan patches are consistent with insufficient irrigation along the pavement.',
    'There is underwatering along the pavement edge.',
    'Localized underwatering persists along the pavement edge.',
    'Visible signs of underwatering have not yet resolved.',
    'Underwatering symptoms have never cleared.',
    'No weeds visible, tan blades and curling point to underwatering.',
    'Underwatering has resolved in the center; the edges remain under-watered.',
  ])('retains structured drought evidence with caption: %s', observations => {
    const report = render({ droughtStress: 'minor', observations });
    expect(report.water.coverageWatch).toBe(true);
    expect(waterCard(report).customerAction).toMatch(/Check sprinkler coverage/);
    expect(report.snapshot.rootCause).toMatch(/uneven sprinkler coverage/);
    expect(report.water.status).toBe('balanced');
  });

  test.each([
    'Minor tan patches near pavement are normal wear. No watering problems are visible.',
    'No signs of underwatering are visible.',
    'The lawn is not under-watered.',
    'Underwatering was excluded based on the even turf color.',
    'The photo is inconsistent with underwatering.',
    'Underwatering was considered but excluded after reviewing the even turf color.',
    'No visible moisture stress. Continue monitoring for underwatering during hot weather.',
    'Previously under-watered turf has recovered.',
    'It is unclear whether underwatering is present.',
    'There is insufficient evidence to conclude the lawn is under-watered.',
    'Signs of underwatering: not observed.',
    'Signs of underwatering have yet to be observed.',
    'Signs of underwatering were suspected but later ruled out.',
    'Signs of underwatering were observed last month but have now resolved.',
    'Let the damp areas dry out between waterings.',
  ])('does not invent advice when the structured finding is none: %s', observations => {
    const report = render({ droughtStress: 'none', observations });
    expect(report.water.coverageWatch).toBe(false);
    expect(waterCard(report)).toBeUndefined();
    expect(report.snapshot.customerAction).toBeNull();
    expect(report.snapshot.noActionNeeded).toBe(true);
    expect(report.smsSummary).not.toMatch(/sprinkler|watching watering/i);
  });

  test.each(['minor', 'moderate', 'severe'])('%s moisture stress works even without a caption', droughtStress => {
    const report = render({ droughtStress, observations: '', aiSummary: '' });
    expect(report.water.coverageWatch).toBe(true);
    expect(waterCard(report)).toBeDefined();
  });

  test.each([undefined, null, '', 'unknown', true, ['severe']])('absent or unusable evidence %j cannot be replaced by prose or an unrelated stress score', droughtStress => {
    const report = render({
      droughtStress,
      observations: 'There is underwatering along the pavement edge.',
      aiSummary: 'Dry tan areas show drought stress and uneven sprinkler coverage.',
      scores: { ...CASES.healthy.scores, stressDamage: 35 },
    });
    expect(report.water.coverageWatch).toBe(false);
    expect(waterCard(report)).toBeUndefined();
    expect(report.snapshot.noActionNeeded).toBe(false);
  });

  test('missing historical moisture evidence does not promise no action is needed', () => {
    const report = render({ droughtStress: null });
    expect(report.snapshot.noActionNeeded).toBe(false);
    expect(report.smsSummary).not.toMatch(/No action needed/);
  });

  test.each([
    ['none', undefined, false],
    [null, undefined, false],
    ['severe', false, false],
    ['minor', undefined, true],
    ['none', true, true],
  ])('final public/PDF reconciliation honors severity %j and technician flag %j', (droughtStress, flag, rewritten) => {
    const hypothesis = 'Drought stress may be contributing to thinning.';
    const nextVisitFocus = 'Recheck the flagged edge for drought stress next visit.';
    const lawnAssessment = baseAssessment({
      ...CASES.healthy,
      droughtStress,
      scores: { ...CASES.healthy.scores, stressFlags: { drought_stress: flag } },
      observations: hypothesis, aiSummary: hypothesis, customerSummary: hypothesis,
      recommendations: { nextVisitFocus },
      snapshot: { summary: hypothesis, nextWatchItems: [nextVisitFocus], findings: [{ customerCopy: hypothesis }] },
      recommendationCards: [{ customerCopy: hypothesis }],
      waterContext: {
        rainfallInches7d: 2.96, irrigationInchesPerWeek: 0, effectiveInches7d: 2.96, targetInchesPerWeek: 0.75,
        irrigationAdvice: { status: 'surplus', rainKnown: true, profileMissing: false, recommendedInchesPerWeek: 0.75 },
      },
    });
    const reportV2 = buildLawnReportV2({ lawnAssessment });
    // Narrative overlays may replace existing card/hero text before this final pass.
    reportV2.insights[0].whatWeSaw = hypothesis;
    reportV2.snapshot.mainWatch = hypothesis;
    reportV2.snapshot.customerAction = nextVisitFocus;
    const data = {
      serviceLine: 'lawn', lawnAssessment, reportV2,
      summary: `Recent rainfall totaling 2.72 inches raised pressure this week. ${hypothesis}`,
    };
    applyLawnReportReconciliation(data, null);
    expect(data.summary).toContain('2.96 inches');
    const surfaces = [
      data.summary, data.reportV2.photoSummary, data.reportV2.insights[0].whatWeSaw,
      data.reportV2.snapshot.mainWatch, data.reportV2.snapshot.customerAction,
      data.reportV2.followUp.reason, data.lawnAssessment.aiSummary,
      data.lawnAssessment.customerSummary, data.lawnAssessment.observations,
      data.lawnAssessment.snapshot.summary, data.lawnAssessment.snapshot.nextWatchItems[0],
      data.lawnAssessment.snapshot.findings[0].customerCopy, data.lawnAssessment.recommendationCards[0].customerCopy,
    ];
    for (const copy of surfaces) {
      expect(/uneven sprinkler coverage/i.test(copy)).toBe(rewritten);
    }
    expect(data.reportV2.water.rainInches).toBe(2.96);
  });

  test.each([
    [true, 'none'],
    [true, null],
    [false, 'severe'],
  ])('an explicit technician flag %s overrides photo severity %s', (flag, droughtStress) => {
    const report = render({
      droughtStress,
      scores: { ...CASES.healthy.scores, stressFlags: { drought_stress: flag } },
    });
    expect(report.water.coverageWatch).toBe(flag);
    expect(!!waterCard(report)).toBe(flag);
    if (flag) expect(waterCard(report).confidence).toBe('tech_confirmed');
  });

  test.each([undefined, {}, { shade_stress: true }, { drought_stress: 'true' }])('other or malformed technician flags %j cannot create a drought diagnosis', stressFlags => {
    const report = render({ droughtStress: null, scores: { ...CASES.healthy.scores, stressFlags } });
    expect(report.water.coverageWatch).toBe(false);
    expect(waterCard(report)).toBeUndefined();
  });

  test.each([null, 'minor'])('measured water deficit gives amount advice with drought evidence %s', droughtStress => {
    const report = render({ droughtStress, waterContext: CASES.deficit.waterContext });
    expect(report.water.coverageWatch).toBe(false);
    expect(waterCard(report).headline).toBe('The lawn is running a little dry');
  });

  test('measured surplus and overwatering keep their advice with no drought evidence', () => {
    const report = render({ ...CASES.overWatered, droughtStress: null });
    expect(report.water.coverageWatch).toBe(false);
    expect(waterCard(report).headline).toBe('The lawn is likely getting too much water');
    expect(waterCard(report).customerAction).not.toMatch(/Check sprinkler coverage/);
  });

  test('an eligible stored coverage snapshot still supplies evidence for an older assessment', () => {
    const report = buildLawnReportV2({
      lawnAssessment: baseAssessment({
        ...CASES.healthy, droughtStress: null,
        waterContext: { ...CASES.healthy.waterContext, rainfallInches7d: null },
      }),
      waterSnapshot: {
        status: 'balanced', interpretation: 'coverage_issue_possible',
        rain_7day_inches: 0.9, irrigation_inches_per_week: 0.7,
        total_water_7day_inches: 1.6, target_water_inches_per_week: 1.25,
      },
    });
    expect(waterCard(report).customerAction).toMatch(/Check sprinkler coverage/);
    expect(waterCard(report).confidence).toBe('area_estimated');
  });
});

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
      droughtStress: 'none',
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

// ── GATE_LAWN_WATERING_RULE (lawn report rebuild P2) ─────────────────────────
// Additive: nothing above changes. A rule-driven visit records
// evidenceSource 'product_instruction' and rides the EXISTING verdict table
// (no new verdict, no new flag); a mixed visit resolves to hold.
describe('watering instruction drives the aftercare through the existing verdict table', () => {
  const { buildWateringInstruction, composeBannerLines } = require('../services/service-report/lawn-watering-instruction');
  const { findBannedCustomerCopy: banned } = require('../services/service-report/activity-indicators');
  const { reentrySafetyClaimFinding } = require('../services/content/content-guardrails');

  const COMPLETED = '2026-09-30T18:40:00Z'; // 2:40 PM ET
  const CELSIUS = [{ product: { name: 'Celsius WG', category: 'herbicide', irrigation_required: false }, targets: ['weeds'] }];
  const HOLD_RULE = { mode: 'hold', hold_hours: 24, source: 'label' };
  const WATER_IN_RULE = { mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24, source: 'default' };
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
  // A visit with no drought or sprinkler-coverage insight, so the only watering
  // instruction on the report is the product one.
  const clean = (weekPlan = RUN_PLAN) => baseAssessment({
    droughtStress: 'none',
    observations: 'Thick, even turf with good color.',
    aiSummary: 'Lawn is in good shape with strong density and color.',
    scores: { turfDensity: 88, weedSuppression: 92, colorHealth: 86, stressDamage: 90, fungusControl: 95, overallScore: 89, season: 'peak' },
    recommendations: {},
    waterContext: { ...baseAssessment().waterContext, weekPlan },
  });
  const build = (rules, { runtime = null, assessment = clean(), applications = CELSIUS } = {}) => {
    const instruction = buildWateringInstruction({ rules, completedAt: COMPLETED, runtime });
    return { instruction, report: buildLawnReportV2({ lawnAssessment: assessment, applications, wateringInstruction: instruction }) };
  };
  // The PDF prints these, in this order, through a de-duplicating pushRec
  // (client/src/pages/ServiceReportDocument.jsx).
  const pdfRecommendations = (v2) => {
    const list = [];
    const push = (t) => { const x = String(t || '').trim(); if (x && !list.includes(x)) list.push(x); };
    push(v2.aftercare?.watering);
    push(v2.snapshot?.customerAction);
    push(v2.followUp?.customerAction);
    (v2.insights || []).forEach((i) => push(i?.customerAction));
    return list;
  };

  test('Celsius end to end: hold verdict, banner state hold, product_instruction evidence', () => {
    const { instruction, report } = build([HOLD_RULE]);
    expect(instruction.state).toBe('hold');
    expect(report.aftercare).toMatchObject({
      evidenceSource: 'product_instruction', wateringHold: true, creditableWaterIn: false, needsReview: false, neutral: false, ruleSource: 'label',
    });
    expect(report.aftercare.watering).toBe(`${instruction.lines[0]} ${instruction.lines[1]}`);
    expect(report.aftercare.watering).not.toMatch(/No special watering/);
    expect(resolveLawnAftercare(report.aftercare, report.water.weekPlan)).toMatchObject({ verdict: 'hold', restricts: true, credited: false });
    // The hero task IS the banner's first line, verbatim (aftercare.holdTask).
    expect(report.aftercare.holdTask).toBe(instruction.lines[0]);
    expect(report.snapshot.customerAction).toBe(instruction.lines[0]);
    expect(report.snapshot.noActionNeeded).toBe(false);
    // The water card and every insight action agree with the banner.
    expect(report.water.explanation).toBe(instruction.lines[0]);
    for (const insight of report.insights) {
      if (insight.customerAction) expect(insight.customerAction).toContain(instruction.lines[0]);
    }
    // The hold plan callout is the not-before overlay, never the raw plan.
    expect(renderedWeekPlan(report.aftercare, report.water.weekPlan)).toBe(RUN_PLAN.afterHold);
  });

  test('exactly one watering line reaches the PDF recommendations list', () => {
    for (const rules of [[HOLD_RULE], [HOLD_RULE, WATER_IN_RULE], [WATER_IN_RULE]]) {
      const { instruction, report } = build(rules);
      const applied = applyLawnReportReconciliation({ reportV2: report }, null);
      const list = pdfRecommendations(applied.reportV2);
      const sentences = list.flatMap((entry) => entry.split(/(?<=[.!?])\s+/)).filter((sentence) => /watering|water in/i.test(sentence));
      // Entries may restate the banner's first line, never a different watering instruction.
      expect([...new Set(sentences)]).toEqual([instruction.lines[0]]);
      expect(list.join(' ')).not.toMatch(/No special watering|Confirm the (product )?(watering )?directions/i);
    }
  });

  test('mixed hold + water-in resolves to hold; the water-in is banner text only', () => {
    const { instruction, report } = build([HOLD_RULE, WATER_IN_RULE]);
    expect(instruction.state).toBe('hold_then_water_in');
    expect(report.aftercare).toMatchObject({ evidenceSource: 'product_instruction', wateringHold: true, creditableWaterIn: false });
    expect(resolveLawnAftercare(report.aftercare, report.water.weekPlan).verdict).toBe('hold');
    expect(report.aftercare.holdTask).toBe('Skip your turf watering until Thu 3 PM, then water in.');
    expect(report.aftercare.watering).toContain('After that, run');
    expect(renderedWeekPlan(report.aftercare, report.water.weekPlan)).toBe(RUN_PLAN.afterHold);
  });

  test('a water-in as deep as the plan run credits it and reduces the plan', () => {
    const { report } = build([{ ...WATER_IN_RULE, water_in_inches: 0.5 }], { runtime: { headTypes: ['rotor'] } });
    expect(report.aftercare).toMatchObject({ evidenceSource: 'product_instruction', wateringHold: false, creditableWaterIn: true, waterInRequired: true, needsReview: false });
    expect(report.aftercare).not.toHaveProperty('waterInTask');
    expect(resolveLawnAftercare(report.aftercare, report.water.weekPlan)).toMatchObject({ verdict: 'credit', credited: true, restricts: false });
    expect(renderedWeekPlan(report.aftercare, report.water.weekPlan)).toBe(RUN_PLAN.afterTreatment);
  });

  test('a quarter-inch water-in against a half-inch run is NOT credited: the plan stays whole and the banner says it counts toward the week', () => {
    const { instruction, report } = build([WATER_IN_RULE], { runtime: { headTypes: ['rotor'] } });
    expect(instruction.waterInInches).toBe(0.25);
    const banner = composeBannerLines(instruction, { hasWeekPlan: true, planRunInches: 0.5 });
    expect(banner[2]).toBe('Run it even if it is not your usual day. That counts toward this week’s watering.');
    expect(banner[2]).not.toMatch(/one of this week/);
    expect(report.aftercare).toMatchObject({ evidenceSource: 'product_instruction', wateringHold: false, creditableWaterIn: false, waterInRequired: true, needsReview: false });
    expect(resolveLawnAftercare(report.aftercare, report.water.weekPlan)).toMatchObject({ credited: false, restricts: false });
    const shown = renderedWeekPlan(report.aftercare, report.water.weekPlan);
    expect(shown).toBe(report.water.weekPlan);
    expect(`${shown.title} ${shown.detail}`).not.toMatch(/No further turf runs|covered by today/);
    // The water-in is still the customer's task: the hero carries it, never "no action needed".
    expect(report.snapshot.customerAction).toBe(instruction.lines[0]);
    expect(report.snapshot.noActionNeeded).toBe(false);
    expect(banned(banner[2])).toEqual([]);
  });

  test('a water-in with no plan to reduce is unchanged: creditable, and no "counts toward" line', () => {
    const noPlan = clean(null);
    const instruction = buildWateringInstruction({ rules: [WATER_IN_RULE], completedAt: COMPLETED, runtime: { headTypes: ['rotor'] } });
    expect(instruction.lines[2]).toBe('Run it even if it is not your usual day.');
    const report = buildLawnReportV2({ lawnAssessment: noPlan, applications: CELSIUS, wateringInstruction: instruction });
    expect(report.aftercare.creditableWaterIn).toBe(true);
    expect(report.aftercare).not.toHaveProperty('waterInTask');
    // A plan that prescribes no run this week has nothing to reduce either.
    const hold = { ...RUN_PLAN, action: 'hold', prescribesRun: false, depthInches: null };
    expect(build([WATER_IN_RULE], { assessment: clean(hold) }).report.aftercare.creditableWaterIn).toBe(true);
  });

  test('a run plan whose depth is null (the production shape) or absent credits nothing: fail closed, never Number(null) = 0', () => {
    const { depthInches, ...absent } = RUN_PLAN;
    for (const plan of [{ ...RUN_PLAN, depthInches: null }, absent, { ...RUN_PLAN, depthInches: '' }]) {
      for (const inches of [0.25, 0.5, 2]) {
        const { report } = build([{ ...WATER_IN_RULE, water_in_inches: inches }], { assessment: clean(plan) });
        expect(report.aftercare.creditableWaterIn).toBe(false);
        expect(report.aftercare.waterInTask).toBeTruthy();
        expect(renderedWeekPlan(report.aftercare, report.water.weekPlan)).toBe(report.water.weekPlan);
      }
    }
  });

  test('aftercare.watering carries every treatment sentence (the PDF and Ask Waves read only that field)', () => {
    const { instruction, report } = build([WATER_IN_RULE], { runtime: { headTypes: ['rotor'] } });
    expect(instruction.lines).toHaveLength(3);
    expect(report.aftercare.watering).toBe(instruction.lines.join(' '));
    expect(report.aftercare.watering).toContain('Run it even if it is not your usual day.');
    const mixed = build([HOLD_RULE, WATER_IN_RULE], { runtime: { headTypes: ['rotor'] } });
    expect(mixed.report.aftercare.watering).toBe(mixed.instruction.lines.join(' '));
    expect(mixed.report.aftercare.watering).toContain('Run it even if it is not your usual day.');
    // A hold has two treatment sentences.
    const hold = build([HOLD_RULE]);
    expect(hold.report.aftercare.watering).toBe(`${hold.instruction.lines[0]} ${hold.instruction.lines[1]}`);
    for (const r of [report, mixed.report, hold.report]) {
      expect(banned(r.aftercare.watering)).toEqual([]);
      expect(reentrySafetyClaimFinding(r.aftercare.watering)).toBeFalsy();
    }
  });

  test('without an afterHold overlay a hold keeps today\'s plan object', () => {
    const { afterHold, ...planWithoutOverlay } = RUN_PLAN;
    const { report } = build([HOLD_RULE], { assessment: clean(planWithoutOverlay) });
    expect(renderedWeekPlan(report.aftercare, report.water.weekPlan)).toBe(report.water.weekPlan);
  });

  test('state none keeps the neutral aftercare (no claim, no restriction, no credit)', () => {
    const { instruction, report } = build([{ mode: 'none', source: 'label' }]);
    expect(instruction.state).toBe('none');
    expect(report.aftercare.neutral).toBe(true);
    expect(report.aftercare.ruleSource).toBe('label');
    expect(report.aftercare.evidenceSource).toBeUndefined();
    expect(resolveLawnAftercare(report.aftercare, report.water.weekPlan)).toMatchObject({ verdict: 'none', restricts: false, credited: false });
  });

  test('state null (unresolved product) leaves the fail-closed aftercare exactly as it was', () => {
    const assessment = clean();
    const legacy = buildLawnReportV2({ lawnAssessment: assessment, applications: [{ product: { irrigation_required: true } }] });
    const { instruction, report } = build([null], { assessment, applications: [{ product: { irrigation_required: true } }] });
    expect(instruction.state).toBeNull();
    expect(report.aftercare.needsReview).toBe(true);
    expect(JSON.parse(JSON.stringify(report))).toEqual(JSON.parse(JSON.stringify(legacy)));
  });

  test('a null or absent instruction leaves the whole payload unchanged (gate off)', () => {
    const args = { lawnAssessment: clean(), applications: CELSIUS };
    const before = JSON.parse(JSON.stringify(buildLawnReportV2(args)));
    expect(JSON.parse(JSON.stringify(buildLawnReportV2({ ...args, wateringInstruction: null })))).toEqual(before);
    const off = buildWateringInstruction({ rules: [null], completedAt: COMPLETED });
    expect(JSON.parse(JSON.stringify(buildLawnReportV2({ ...args, wateringInstruction: off })))).toEqual(before);
    expect(before.aftercare.neutral).toBe(true);
    expect(before.banner).toBeUndefined();
  });

  test('every customer-facing string the instruction adds passes the copy guards', () => {
    for (const rules of [[HOLD_RULE], [WATER_IN_RULE], [HOLD_RULE, WATER_IN_RULE]]) {
      const { report } = build(rules);
      const texts = [report.aftercare.watering, report.aftercare.holdTask, report.snapshot.customerAction, report.water.explanation, report.smsSummary].filter(Boolean);
      for (const text of texts) {
        expect(banned(text)).toEqual([]);
        expect(reentrySafetyClaimFinding(text)).toBeFalsy();
      }
    }
  });

  test('the banner payload is built once from the instruction and expires with it', () => {
    const { buildWateringBanner, applyAfterHoldOverlay } = require('../services/service-report/report-data');
    const hold = buildWateringInstruction({ rules: [HOLD_RULE], completedAt: COMPLETED, hasWeekPlan: true });
    expect(buildWateringBanner(hold)).toEqual({
      state: 'hold', lines: hold.lines, holdUntil: '2026-10-01T19:00:00.000Z', waterInBy: null, expiresAt: '2026-10-01T19:00:00.000Z', ruleSource: 'label',
    });
    const mixed = buildWateringInstruction({ rules: [HOLD_RULE, WATER_IN_RULE], completedAt: COMPLETED });
    expect(buildWateringBanner(mixed)).toMatchObject({ state: 'hold_then_water_in', expiresAt: '2026-10-02T19:00:00.000Z' });
    expect(buildWateringBanner(buildWateringInstruction({ rules: [{ mode: 'none', source: 'label' }], completedAt: COMPLETED })))
      .toMatchObject({ state: 'none', expiresAt: null });
    expect(buildWateringBanner(buildWateringInstruction({ rules: [null], completedAt: COMPLETED }))).toBeNull();

    // The {holdUntil} token is replaced for a hold and never survives otherwise.
    const tokenPlan = { ...RUN_PLAN, afterHold: { title: RUN_PLAN.afterHold.title, detail: 'Not before {holdUntil}: skip that run.' } };
    const filled = applyAfterHoldOverlay({ weekPlan: tokenPlan }, hold);
    expect(filled.weekPlan.afterHold.detail).toBe('Not before Thu 3 PM: skip that run.');
    expect(tokenPlan.afterHold.detail).toContain('{holdUntil}'); // input untouched
    for (const instruction of [buildWateringInstruction({ rules: [WATER_IN_RULE], completedAt: COMPLETED }), null]) {
      const dropped = applyAfterHoldOverlay({ weekPlan: tokenPlan }, instruction);
      expect(dropped.weekPlan).not.toHaveProperty('afterHold');
      expect(JSON.stringify(dropped)).not.toContain('{holdUntil}');
    }
    // A plan without an overlay is returned as is.
    const plain = { weekPlan: { title: 'x' } };
    expect(applyAfterHoldOverlay(plain, hold)).toBe(plain);
  });

  test('an until-dry hold (holdUntil null) still resolves to hold with the banner line as the hero task', () => {
    const { buildWateringBanner, applyAfterHoldOverlay } = require('../services/service-report/report-data');
    const dry = { mode: 'hold', hold_hours: null, hold_until: 'dry', source: 'label' };
    const { instruction, report } = build([dry]);
    expect(instruction.state).toBe('hold');
    expect(report.aftercare).toMatchObject({ evidenceSource: 'product_instruction', wateringHold: true, creditableWaterIn: false, holdUntil: null });
    expect(report.aftercare.holdTask).toBe('Skip your turf watering until today’s treatment has dried.');
    expect(resolveLawnAftercare(report.aftercare, report.water.weekPlan)).toMatchObject({ verdict: 'hold', customerTask: report.aftercare.holdTask });
    expect(report.snapshot.customerAction).toBe(report.aftercare.holdTask);
    expect(renderedWeekPlan(report.aftercare, report.water.weekPlan)).toBe(RUN_PLAN.afterHold);
    for (const text of [report.aftercare.watering, report.snapshot.customerAction, report.water.explanation]) {
      expect(banned(text)).toEqual([]);
      expect(reentrySafetyClaimFinding(text)).toBeFalsy();
    }
    // Banner: no clock time, expires at the end of the visit day (ET).
    expect(buildWateringBanner(instruction)).toEqual({
      state: 'hold', lines: instruction.lines, holdUntil: null, waterInBy: null, expiresAt: '2026-10-01T03:59:59.000Z', ruleSource: 'label',
    });
    // The plan sentence names the dry state, never a time.
    const tokenPlan = { ...RUN_PLAN, afterHold: { title: RUN_PLAN.afterHold.title, detail: 'Not before {holdUntil}: skip that run.' } };
    expect(applyAfterHoldOverlay({ weekPlan: tokenPlan }, instruction).weekPlan.afterHold.detail).toBe('Not before the spray has dried: skip that run.');
  });
});
