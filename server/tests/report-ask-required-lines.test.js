/**
 * Service report "Ask Waves" AI answers: required lines (owner 2026-10-05,
 * "ok go"). The fixed-rule answer for a question states recorded customer
 * instructions word for word; the rule functions hand those exact strings back
 * as requiredLines, the fact sheet and prompt carry them, and the answer
 * screen rejects an AI answer that does not repeat every one verbatim.
 * Every name and number here is synthetic; the model call is a stub.
 */
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const {
  exposureSafetyLine,
  ruleAnswerReason,
  medicalExposureAnswer,
  SYSTEM_PROMPT,
  buildReportAskFacts,
  buildReportAskPrompt,
  screenAskAnswer,
  screenRequiredLines,
  answerReportQuestionWithAI,
} = require('../services/service-report/report-ask-ai');
const { routeServiceReportQuestion } = require('../services/service-report/report-assistant');

const route = (question, data, nextAppointment = null) => routeServiceReportQuestion({ question, data, nextAppointment });
// requiredLines entries are { text, source }: 'system' for text the portal
// wrote, 'tech' for text a person typed or approved.
const texts = (routed) => routed.requiredLines.map((line) => line.text);
const system = (...lines) => lines.map((text) => ({ text, source: 'system' }));
const tech = (...lines) => lines.map((text) => ({ text, source: 'tech' }));

const HOLD_LINE = 'Skip your turf watering until Thu 3 PM.';
const HOLD_AFTERCARE = {
  watering: `${HOLD_LINE} That gives today’s treatment time to work.`,
  holdTask: HOLD_LINE,
  evidenceSource: 'product_instruction',
  wateringHold: true,
  creditableWaterIn: false,
  needsReview: false,
  neutral: false,
  waterInRequired: false,
};
const RAW_PLAN = {
  title: 'This week: one full cycle per turf zone',
  detail: 'Run it on your permitted watering day.',
  visitInPlanWeek: true,
  prescribesRun: true,
};
const WATER_IN_AFTERCARE = {
  watering: 'Water the lawn in within a day of the visit.',
  evidenceSource: 'product_instruction',
  wateringHold: false,
  creditableWaterIn: true,
  needsReview: false,
  neutral: false,
  waterInRequired: true,
};

function lawnData(overrides = {}) {
  return {
    serviceLine: 'lawn',
    serviceDisplayName: 'Lawn Care',
    serviceDate: '2026-10-02',
    applications: [],
    pressureIndex: null,
    dynamicContext: {},
    lawnAssessment: {
      scores: {
        overallScore: 82, turfDensity: 80, weedSuppression: 90, colorHealth: 78, stressDamage: null,
      },
      customerSummary: 'The lawn is filling in well.',
      snapshot: {
        summary: 'Your lawn is thickening and the color is coming back.',
        findings: [{ customerCopy: 'A few thin spots near the fence.' }],
        nextWatchItems: ['Dry spots near the fence.'],
        expectedWindow: { minDays: 10, maxDays: 14 },
      },
      recommendationCards: [{ customerCopy: 'Keep mowing at 3.5 inches.' }],
    },
    reportV2: { water: { weekPlan: { ...RAW_PLAN } }, aftercare: { ...HOLD_AFTERCARE } },
    ...overrides,
  };
}

function pestData(overrides = {}) {
  return {
    serviceLine: 'pest',
    serviceDisplayName: 'Quarterly Pest Control',
    serviceDate: '2026-10-02',
    applications: [],
    pressureIndex: null,
    dynamicContext: {},
    ...overrides,
  };
}

describe('requiredLines from the rule functions', () => {
  test('re-entry: the recorded pet precaution and the ready-at summary, word for word', () => {
    const data = pestData({
      dynamicContext: { reentry: { customerSummary: 'Treated areas are ready for normal use.', petAdvisory: 'Keep pets off treated zones until dry.' } },
    });
    const routed = route('When can my dog go back outside?', data);
    expect(routed.topic).toBe('reentry');
    expect(routed.requiredLines).toEqual(system('Keep pets off treated zones until dry.', 'Treated areas are ready for normal use.'));
  });

  test('re-entry without a ready-at summary: the once-dry line and the pet precaution', () => {
    const withWindow = pestData({ advisory: { exterior_reentry_min: 30, pet_advisory: 'Keep pets inside until dry.' } });
    expect(route('Is it ok for the kids to go outside?', withWindow).requiredLines)
      .toEqual(system('Keep pets inside until dry.', 'Give treated areas time to fully dry before normal use.'));
    // No timer recorded: the rule answer's "no timer" sentence is not an instruction.
    const noWindow = pestData({ advisory: { pet_advisory: 'Keep pets inside until dry.' } });
    expect(route('Is it ok for the kids to go outside?', noWindow).requiredLines).toEqual(system('Keep pets inside until dry.'));
    expect(route('Is it ok for the kids to go outside?', pestData()).requiredLines).toEqual([]);
  });

  test('watering with a product hold: the hold, the plan title and the plan detail', () => {
    const routed = route('Can I turn my sprinklers back on?', lawnData());
    expect(routed.topic).toBe('watering');
    expect(texts(routed)).toEqual(expect.arrayContaining([HOLD_AFTERCARE.watering, RAW_PLAN.title, RAW_PLAN.detail]));
    // Aftercare and plan text are system-written.
    expect(routed.requiredLines.every((line) => line.source === 'system')).toBe(true);
    // Every required line is a piece of the rule answer.
    for (const line of texts(routed)) expect(routed.answer).toContain(line);
  });

  test('watering with a "not before" overlay uses the overlay, not the raw plan', () => {
    const afterHold = { title: RAW_PLAN.title, detail: `${RAW_PLAN.detail} Not before Thu 3 PM.` };
    const data = lawnData({ reportV2: { water: { weekPlan: { ...RAW_PLAN, afterHold } }, aftercare: { ...HOLD_AFTERCARE } } });
    const routed = route('Should I water after today’s treatment?', data);
    expect(routed.requiredLines).toEqual(system(HOLD_AFTERCARE.watering, afterHold.title, afterHold.detail));
  });

  test('watering with only a weekly plan: the plan title and detail', () => {
    const data = lawnData({ reportV2: { water: { weekPlan: { ...RAW_PLAN } }, aftercare: {} } });
    const routed = route('How long should I run the sprinklers?', data);
    expect(routed.topic).toBe('watering');
    expect(routed.requiredLines).toEqual(system(RAW_PLAN.title, RAW_PLAN.detail));
  });

  test('next steps: the water-in task, the recommendation cards', () => {
    const data = lawnData({ reportV2: { water: { weekPlan: null }, aftercare: { ...WATER_IN_AFTERCARE } } });
    const routed = route('What should I do next?', data);
    expect(routed.topic).toBe('next_steps');
    // The water-in task is system text; a recommendation card is approved free text.
    expect(routed.requiredLines).toEqual([...system(WATER_IN_AFTERCARE.watering), ...tech('Keep mowing at 3.5 inches.')]);
    for (const line of texts(routed)) expect(routed.answer).toContain(line);
  });

  test('next steps: a watering hold task outranks watering advice and stays required', () => {
    const data = lawnData();
    const routed = route('What should I do next?', data);
    expect(routed.requiredLines[0]).toEqual({ text: HOLD_LINE, source: 'system' });
    expect(routed.requiredLines).toContainEqual({ text: 'Keep mowing at 3.5 inches.', source: 'tech' });
  });

  test('next steps on a pest report: the technician recommendation, the re-entry line, the rinse caution', () => {
    const data = pestData({
      findings: [{
        title: 'Ant trails', detail: 'Along the lanai wall.', severity: 'high', recommendation: 'Trim the shrubs back from the wall.',
      }],
      applications: [{ product: { name: 'Test Spray' }, method: 'spray', methodLabel: 'Spray', applicationArea: 'Foundation perimeter' }],
      dynamicContext: { reentry: { customerSummary: 'Treated areas are ready for normal use.' } },
    });
    const routed = route('What should I do next?', data);
    expect(routed.topic).toBe('next_steps');
    // The recommendation is technician text; the re-entry summary is system text.
    expect(routed.requiredLines).toEqual([...tech('Trim the shrubs back from the wall.'), ...system('Treated areas are ready for normal use.')]);
    // Generic filler and the product-target watch line are never required.
    expect(texts(routed).join(' ')).not.toMatch(/Text Waves|Watch for|Follow the re-entry/);
  });

  test('next steps fallback: the rinse caution is required, generic filler is not', () => {
    const data = pestData({ applications: [{ product: { name: 'Test Spray' }, method: 'spray', methodLabel: 'Spray', applicationArea: 'Foundation perimeter' }] });
    const routed = route('What should I do next?', data);
    expect(routed.requiredLines).toEqual(system('Avoid rinsing, pressure-washing, or disturbing the treated perimeter today unless Waves gives different instructions.'));
  });

  test('findings: each shown finding recommendation; with no findings, the recommendations', () => {
    const withFindings = pestData({
      findings: [{ title: 'Ant trails', detail: 'Along the wall.', recommendation: 'Trim the shrubs back from the wall.' }, { title: 'Spider webs' }],
    });
    const found = route('What did you find?', withFindings);
    expect(found.topic).toBe('findings');
    expect(found.requiredLines).toEqual(tech('Trim the shrubs back from the wall.'));
    const onlyRecs = pestData({ recommendations: ['Seal the gap by the garage door.'] });
    expect(route('What did you find?', onlyRecs).requiredLines).toEqual(tech('Seal the gap by the garage door.'));
  });

  test.each([
    ['What was applied today?', 'applied'],
    ['When is my next appointment?', 'next_visit'],
    ['Is the treatment working?', 'results'],
    ['zzz', 'unrouted'],
  ])('%j states no recorded instruction (%s)', (question, topic) => {
    const routed = route(question, pestData({ recommendations: ['Seal the gap.'] }));
    expect(routed.topic).toBe(topic);
    expect(routed.requiredLines).toEqual([]);
  });

  test('the rule answer is the same text with or without the collector', () => {
    const { answerServiceReportQuestion } = require('../services/service-report/report-assistant');
    for (const q of ['Can I turn my sprinklers back on?', 'What should I do next?', 'When can my dog go out?', 'What did you find?']) {
      expect(answerServiceReportQuestion({ question: q, data: lawnData() })).toBe(route(q, lawnData()).answer);
    }
  });
});

describe('the fact sheet and prompt carry required lines', () => {
  test('required_lines go in the facts and the prompt says to repeat them', () => {
    const lines = ['Keep pets off treated zones until dry.'];
    const prompt = buildReportAskPrompt({ question: 'Is it ok for my dog?', data: pestData(), requiredLines: lines });
    expect(prompt.user).toContain('"required_lines"');
    expect(prompt.user).toContain(lines[0]);
    expect(SYSTEM_PROMPT).toMatch(/REQUIRED LINES/);
    expect(SYSTEM_PROMPT).toMatch(/exactly as written, word for word/);
    expect(buildReportAskFacts({ data: pestData() }).required_lines).toBeUndefined();
  });

  test('a finding recommendation reaches the model only as a required line', () => {
    const data = pestData({ findings: [{ title: 'Ant trails', detail: 'Along the wall.', recommendation: 'Trim the shrubs back.' }] });
    expect(JSON.stringify(buildReportAskFacts({ data }))).not.toContain('Trim the shrubs');
    expect(JSON.stringify(buildReportAskFacts({ data, requiredLines: ['Trim the shrubs back.'] }))).toContain('Trim the shrubs');
  });

  test('lawn assessment: summary, findings, watch items and scores out of 100, no percent sign', () => {
    const facts = buildReportAskFacts({ data: lawnData() });
    expect(facts.lawn_assessment).toEqual({
      summary: 'Your lawn is thickening and the color is coming back.',
      customer_summary: 'The lawn is filling in well.',
      findings: ['A few thin spots near the fence.'],
      watching: ['Dry spots near the fence.'],
      overall_out_of_100: 82,
      density_out_of_100: 80,
      weed_cleanliness_out_of_100: 90,
      color_out_of_100: 78,
    });
    expect(JSON.stringify(facts)).not.toMatch(/%/);
    // The expected-improvement window is a result promise: not carried.
    expect(JSON.stringify(facts)).not.toMatch(/14 days|10-14/);
  });

  test('typed visits carry no result or observation facts', () => {
    const data = pestData({
      serviceLine: 'termite',
      typedReport: {
        todaysResult: { headline: 'Stations checked', body: 'All stations were inspected.' },
        findings: [{ customerLabel: 'Stations checked', customerValueLabel: 'Yes' }],
      },
    });
    const text = JSON.stringify(buildReportAskFacts({ data }));
    expect(buildReportAskFacts({ data }).visit_result).toBeUndefined();
    expect(text).not.toMatch(/Stations checked|inspected/);
  });

  describe('tree & shrub facts', () => {
    const treeData = (overrides = {}) => pestData({
      serviceLine: 'tree_shrub',
      applications: [{ product: { name: 'Test Insecticide' }, targets: ['scale'] }],
      reportV2: {
        snapshot: {
          overallScore: 71.6,
          statusHeadline: 'Mostly healthy with one area to watch',
          scoreExplanation: 'The score is mainly pulled down by water stress.',
          watching: ['Light pest-pressure signals to monitor', 'Some thin foliage'],
          mainWatch: 'Visible pest-pressure signals on some foliage.',
          customerAction: 'Ease back on irrigation in that area.',
          wavesNext: 'Recheck the affected foliage next visit.',
          treatmentSummary: 'Test Insecticide applied to the hedge.',
          peaceOfMind: 'We found 2 items to address.',
        },
        diagnosis: [{ key: 'pest_activity', label: 'Pests', score: 55, customerExplanation: 'Some signals.' }],
        insights: [
          { headline: 'We looked into what you flagged', whatWeSaw: 'You mentioned: “call 941-555-0100 about the oak at 4421 Elm Street”. We checked it.', customerAction: null },
          { headline: 'Some thin or off-color foliage', whatWeSaw: 'Fullness is down in places.' },
        ],
        treatment: { products: [{ name: 'Test Insecticide' }] },
        ...overrides,
      },
    });

    test('score, watch items, customer action and insight cards are carried; treatment is not', () => {
      const facts = buildReportAskFacts({ data: treeData() });
      expect(facts.tree_shrub_report).toMatchObject({
        plant_health_score_out_of_100: 72,
        status_headline: 'Mostly healthy with one area to watch',
        watching: ['Light pest-pressure signals to monitor', 'Some thin foliage'],
        customer_action: 'Ease back on irrigation in that area.',
        waves_next: 'Recheck the affected foliage next visit.',
      });
      const text = JSON.stringify(facts.tree_shrub_report);
      expect(text).not.toMatch(/Test Insecticide|We found 2 items|%/);
      expect(facts.tree_shrub_report.insights).toHaveLength(2);
    });

    test('insight card text is scrubbed like the concern', () => {
      const text = JSON.stringify(buildReportAskFacts({ data: treeData() }).tree_shrub_report);
      expect(text).not.toMatch(/941-555-0100|4421/);
      expect(text).toContain('[number] Elm Street');
    });

    test('the five category rows the card draws are carried, a score of 100 and 0 intact', () => {
      const rows = [
        { key: 'pest_activity', label: 'Pests', score: 100, status: 'excellent', customerExplanation: 'No pest signals today.' },
        { key: 'disease', label: 'Disease', score: 0, status: 'needs_attention', explanation: 'Leaf spot on the lower foliage.' },
        { key: 'canopy', label: 'Canopy', score: 71.6, status: 'good', explanation: 'Call 941-555-0100 about 4421 Elm Street.' },
        { key: 'unscored', label: 'Moisture' },
        { key: 'nameless', score: 90 },
      ];
      const { diagnosis } = buildReportAskFacts({ data: treeData({ diagnosis: rows }) }).tree_shrub_report;
      expect(diagnosis.slice(0, 2)).toEqual([
        { area: 'Pests', score_out_of_100: 100, status: 'excellent', explanation: 'No pest signals today.' },
        { area: 'Disease', score_out_of_100: 0, status: 'needs attention', explanation: 'Leaf spot on the lower foliage.' },
      ]);
      expect(diagnosis[2]).toMatchObject({ area: 'Canopy', score_out_of_100: 72 });
      expect(JSON.stringify(diagnosis)).not.toMatch(/941-555-0100|4421/);
      expect(diagnosis[3]).toEqual({ area: 'Moisture' });
      expect(diagnosis).toHaveLength(4);
    });

    test('at most six category rows, and a row the watering keeper blocks loses its text', () => {
      const many = Array.from({ length: 9 }, (_, i) => ({ key: `k${i}`, label: `Row ${i}`, score: 50 }));
      expect(buildReportAskFacts({ data: treeData({ diagnosis: many }) }).tree_shrub_report.diagnosis).toHaveLength(6);
      const held = treeData({ aftercare: { ...HOLD_AFTERCARE }, diagnosis: [{ label: 'Water', score: 60, explanation: 'Increase irrigation to twice this week.' }] });
      expect(buildReportAskFacts({ data: held }).tree_shrub_report.diagnosis).toEqual([{ area: 'Water', score_out_of_100: 60 }]);
    });

    test('a category answer passes the screen and the row text is not a leaked target list', () => {
      const data = treeData({ diagnosis: [{ label: 'Disease', score: 100, status: 'excellent', explanation: 'No leaf spot seen.' }] });
      const facts = buildReportAskFacts({ data });
      expect(screenAskAnswer('Disease scored 100 out of 100, with no leaf spot seen.', { question: 'How is disease?', data, facts })).toBeNull();
    });

    test('another service line, or a tree & shrub report without a read, carries nothing', () => {
      expect(buildReportAskFacts({ data: treeData() }).tree_shrub_report).toBeDefined();
      expect(buildReportAskFacts({ data: { ...treeData(), serviceLine: 'lawn' } }).tree_shrub_report).toBeUndefined();
      expect(buildReportAskFacts({ data: { ...treeData(), reportV2: null } }).tree_shrub_report).toBeUndefined();
    });

    test('a pest named in a card is not a leaked target list', () => {
      const data = treeData({ insights: [{ headline: 'Scale signals to monitor', whatWeSaw: 'Possible scale on some foliage.' }] });
      const facts = buildReportAskFacts({ data });
      const ask = (answer, f) => screenAskAnswer(answer, { question: 'What did you see?', data, facts: f });
      expect(ask('We saw some scale signals on the foliage.', facts)).toBeNull();
      expect(ask('We saw some scale signals on the foliage.', {})).toBe('target_list');
      // A place the card does not name is not grounded (Codex P1 #5964 r51).
      expect(ask('We saw some scale signals on the hedge.', facts)).toBe('target_list');
    });
  });

  test('while the aftercare holds watering, free text that changes watering is not carried', () => {
    const data = lawnData({
      reportSections: [
        { title: 'Next', text: 'Increase irrigation to twice this week.' },
        { title: 'Found', text: 'The lawn is filling in.' },
      ],
    });
    const facts = buildReportAskFacts({ data });
    expect(JSON.stringify(facts)).not.toMatch(/irrigation/);
    expect(facts.report_sections).toEqual([{ title: 'Found', text: 'The lawn is filling in.' }]);
    // No hold: the same section stays.
    const free = lawnData({ reportV2: { water: { weekPlan: null }, aftercare: {} }, reportSections: data.reportSections });
    expect(buildReportAskFacts({ data: free }).report_sections).toHaveLength(2);
  });

  test('while the aftercare holds watering, the saved Waves summary that changes watering is not carried', () => {
    const aiSummary = { headline: 'Increase irrigation to twice this week', body: 'The lawn is filling in.' };
    const facts = buildReportAskFacts({ data: lawnData({ dynamicContext: { aiSummary } }) });
    expect(JSON.stringify(facts)).not.toMatch(/irrigation/);
    expect(facts.waves_summary).toEqual({ body: 'The lawn is filling in.' });
    const bodyOnly = { headline: 'Good visit', body: 'Increase irrigation to twice this week.' };
    expect(buildReportAskFacts({ data: lawnData({ dynamicContext: { aiSummary: bodyOnly } }) }).waves_summary)
      .toEqual({ headline: 'Good visit' });
    const free = lawnData({ reportV2: { water: { weekPlan: null }, aftercare: {} }, dynamicContext: { aiSummary } });
    expect(buildReportAskFacts({ data: free }).waves_summary).toEqual(aiSummary);
  });

  describe('lawn report facts (reportV2)', () => {
    const v2 = (overrides = {}) => ({
      aftercare: {},
      lead: {
        headline: 'Your lawn is filling in',
        why: 'Density is up since the last visit.',
        yourPart: ['Mow at the high setting this week.'],
        next: 'We recheck the thin spots next visit.',
        techParagraph: 'The fence line is the slowest area to fill in.',
      },
      insights: [{ headline: 'Thin spots by the fence', whatWeSaw: 'Some thin turf.', customerAction: 'Keep traffic off it.' }],
      diagnosis: [{ key: 'turf_density', label: 'Turf density', status: 'needs_attention', explanation: 'A few thin areas.' }],
      water: {
        rainInches: 1.234, irrigationInches: 0.5, totalInches: 1.73, targetInches: 1.25, status: 'balanced', explanation: 'Water is on target.', weekPlan: null,
      },
      rain7d: [{ d: 'Mon', in: 0.5 }, { d: 'Tue', in: 0 }, { d: 'Wed', in: 0.73 }],
      mowing: {
        measuredHeightInches: 3, idealMinInches: 3.5, idealMaxInches: 4, status: 'too_short', recommendation: 'Raise the mower one setting.',
      },
      trends: { overall: [{ label: 'Aug', value: 70 }, { label: 'Oct', value: 100 }], mowing: [{ label: 'Aug', value: 3.5 }] },
      ...overrides,
    });

    test('the lead, cards, water, seven-day rain, mowing and trends the page shows are carried', () => {
      const facts = buildReportAskFacts({ data: lawnData({ reportV2: v2() }) });
      expect(facts.lawn_report).toMatchObject({
        headline: 'Your lawn is filling in',
        your_part: ['Mow at the high setting this week.'],
        from_your_technician: 'The fence line is the slowest area to fill in.',
        diagnosis: [{ area: 'Turf density', status: 'needs attention', explanation: 'A few thin areas.' }],
        water_this_week: {
          rain_last_7_days_inches: 1.23, irrigation_inches_per_week: 0.5, total_inches_7_days: 1.73, target_inches_per_week: 1.25, status: 'balanced',
        },
        rain_by_day_last_7_days: { total_inches: 1.23, days: [{ day: 'Mon', inches: 0.5 }, { day: 'Tue', inches: 0 }, { day: 'Wed', inches: 0.73 }] },
        mowing: {
          measured_height_inches: 3, ideal_min_inches: 3.5, ideal_max_inches: 4, status: 'too short', recommendation: 'Raise the mower one setting.',
        },
        // Numbers, not a string: a 100 survives the 3-digit scrub.
        trends: { overall_out_of_100: { from: { month: 'Aug', value: 70 }, to: { month: 'Oct', value: 100 } } },
      });
      // A one-point series is not a trend.
      expect(facts.lawn_report.trends.mowing_height_inches).toBeUndefined();
      expect(buildReportAskPrompt({ data: lawnData({ reportV2: v2() }) }).user).toContain('rain_by_day_last_7_days');
    });

    test('the prompt tells the visit weather apart from the week of rain', () => {
      expect(SYSTEM_PROMPT).toMatch(/weather_during_visit is the weather at the visit only/);
      expect(SYSTEM_PROMPT).toMatch(/rain_by_day_last_7_days/);
    });

    test('while the aftercare holds watering, lawn report text that changes watering is not carried', () => {
      const data = lawnData({
        reportV2: v2({
          aftercare: { ...HOLD_AFTERCARE },
          insights: [{ headline: 'Running dry', customerAction: 'Increase irrigation to twice this week.' }, { headline: 'Thin spots' }],
        }),
      });
      const facts = buildReportAskFacts({ data });
      expect(JSON.stringify(facts.lawn_report.insights)).not.toMatch(/Increase irrigation/);
      expect(facts.lawn_report.insights).toEqual([{ headline: 'Running dry' }, { headline: 'Thin spots' }]);
    });

    test('lawn report text is scrubbed like the concern', () => {
      const data = lawnData({ reportV2: v2({ lead: { techParagraph: 'Call 941-555-0100 about the gate at 4421 Elm Street.' } }) });
      const text = JSON.stringify(buildReportAskFacts({ data }).lawn_report);
      expect(text).not.toMatch(/941-555-0100|4421/);
    });

    test('a lawn numbers answer passes the screen', () => {
      const data = lawnData({ reportV2: v2() });
      const facts = buildReportAskFacts({ data });
      const answer = 'Your lawn got about 1.23 inches of rain over the past week. The mower is at 3 inches, and the ideal range is 3.5 to 4 inches.';
      expect(screenAskAnswer(answer, { question: 'How much rain did we get?', data, facts })).toBeNull();
    });

    test('a lawn answer with trend months, a score of 100 and a watering day passes the screen', () => {
      const data = lawnData({ reportV2: v2({ water: { status: 'balanced', weekPlan: { title: 'Water', detail: 'Not before Tuesday morning.' } } }) });
      const facts = buildReportAskFacts({ data });
      const ask = (answer) => screenAskAnswer(answer, { question: 'How is my lawn doing?', data, facts });
      expect(ask('Your lawn score went from 70 in Aug to 100 in Oct.')).toBeNull();
      // A weekday is the rule answer's to state (required lines), not the model's.
      expect(ask('Hold off watering until Tuesday morning.')).toBe('states_a_date');
    });

    test('another service line, or a lawn report without reportV2, carries nothing', () => {
      expect(buildReportAskFacts({ data: pestData({ reportV2: v2() }) }).lawn_report).toBeUndefined();
      expect(buildReportAskFacts({ data: lawnData({ reportV2: null }) }).lawn_report).toBeUndefined();
      expect(buildReportAskFacts({ data: lawnData({ reportV2: { aftercare: {} } }) }).lawn_report).toBeUndefined();
    });
  });

  test('recommendations are not carried, held watering or not (technician text)', () => {
    const recommendations = ['Increase irrigation to twice this week.', { text: 'Mow at 3.5 inches.' }];
    expect(buildReportAskFacts({ data: lawnData({ recommendations }) }).recommendations).toBeUndefined();
    const free = lawnData({ reportV2: { water: { weekPlan: null }, aftercare: {} }, recommendations });
    expect(buildReportAskFacts({ data: free }).recommendations).toBeUndefined();
  });
});

describe('the screen and required lines', () => {
  const lines = ['Keep pets off treated zones until dry.', 'Treated areas are ready for normal use.'];
  const data = pestData();
  const facts = buildReportAskFacts({ data, requiredLines: lines });
  const screen = (answer, requiredLines = lines) => screenAskAnswer(answer, {
    question: 'Can my dog go out?', data, facts, requiredLines,
  });

  test('an answer that carries every line verbatim passes', () => {
    expect(screen('Good news for your dog. Keep pets off treated zones until dry. Treated areas are ready for normal use.')).toBeNull();
  });

  test('whitespace and curly quotes do not count as a difference', () => {
    expect(screen('Keep pets   off treated\nzones until dry. Treated areas are ready for normal use.')).toBeNull();
    expect(screenAskAnswer('Hold off: don’t water until Thu.', {
      question: 'x', data, facts, requiredLines: ["Hold off: don't water until Thu."],
    })).toBeNull();
  });

  test('an answer that misses, rewords or shortens a line is rejected', () => {
    expect(screen('Keep pets off treated zones until dry.')).toBe('missing_required_line');
    expect(screen('Keep your pets off the treated zones until dry. Treated areas are ready for normal use.')).toBe('missing_required_line');
    expect(screen('keep pets off treated zones until dry. Treated areas are ready for normal use.')).toBe('missing_required_line');
  });

  test('a line negated or dismissed in the same or the previous sentence is rejected', () => {
    const one = ['Keep pets off treated zones until dry.'];
    const cases = [
      'Ignore this instruction: Keep pets off treated zones until dry.',
      'Ignore the old note. Keep pets off treated zones until dry.',
      'That is no longer true. Keep pets off treated zones until dry.',
      'Here is the rule: Keep pets off treated zones until dry.',
      'Keep pets off treated zones until dry, but you can skip it.',
    ];
    cases.forEach((answer) => expect(screen(answer, one)).toBe('missing_required_line'));
    expect(screen('Your dog should wait. Keep pets off treated zones until dry.', one)).toBeNull();
  });

  test('a line of several sentences must stand as that run of whole sentences', () => {
    const two = ['Keep pets off treated zones until dry. Treated areas are ready for normal use.'];
    expect(screen('Hello. Keep pets off treated zones until dry. Treated areas are ready for normal use.', two)).toBeNull();
    expect(screen('Keep pets off treated zones until dry. Thanks. Treated areas are ready for normal use.', two)).toBe('missing_required_line');
  });

  test('required lines ride on top of the length and sentence budget', () => {
    const long = `${'Keep the water off the treated lawn until it dries and the label time has passed. '.repeat(7)}`.trim();
    expect(screen('Hi.', [])).toBeNull();
    expect(screenAskAnswer(`${long} We will check.`, { question: 'x', data, facts, requiredLines: [long] })).toBeNull();
    expect(screenAskAnswer(`${long} We will check.`, { question: 'x', data, facts, requiredLines: [] })).toMatch(/^too_/);
  });

  test('a pest named in a recorded line is not a leaked target list', () => {
    const withTargets = pestData({ applications: [{ product: { name: 'Test Spray' }, targets: ['ghost_ants'] }] });
    const line = 'Trim the shrubs where ghost ants are trailing.';
    expect(screenAskAnswer(`${line} Thanks.`, {
      question: 'What next?', data: withTargets, facts: {}, requiredLines: [line],
    })).toBeNull();
    expect(screenAskAnswer('We also treated for ghost ants.', {
      question: 'What next?', data: withTargets, facts: {}, requiredLines: [],
    })).toBe('target_list');
  });

  test.each([
    ['a safety claim', 'Your pets will be safe once it dries.', 'safe'],
    ['an em dash', 'No timer was recorded — call us.', 'em dash'],
    ['a percent sign', 'Water 50% less this week.', 'amount'],
    ['a fixed re-entry wait', 'Keep pets inside for 2 hours.', 'banned_copy'],
  ])('a required line that trips the screen (%s) is caught before any model call', async (_label, line, reason) => {
    expect(screenRequiredLines([line], { question: 'x', data, facts })).toBe(reason);
    const callModel = jest.fn();
    const out = await answerReportQuestionWithAI({
      question: 'Can my dog go out?', data, requiredLines: ['Keep pets off treated zones until dry.', line],
    }, { callModel });
    expect(out).toBeNull();
    expect(callModel).not.toHaveBeenCalled();
  });
});

describe('answerReportQuestionWithAI with required lines', () => {
  const lines = ['Keep pets off treated zones until dry.'];
  const base = { question: 'Can my dog go out?', data: pestData(), requiredLines: system(...lines) };
  const ok = (answer) => ({ ok: true, json: { answer }, provider: 'anthropic' });

  test('an answer with every line verbatim is returned; the hook screens the same way', async () => {
    const callModel = jest.fn().mockResolvedValue(ok('Yes, once it is dry. Keep pets off treated zones until dry.'));
    const out = await answerReportQuestionWithAI(base, { callModel });
    expect(out.answer).toBe('Yes, once it is dry. Keep pets off treated zones until dry.');
    const [payload, options] = callModel.mock.calls[0];
    expect(payload.text).toContain(lines[0]);
    expect(payload.maxTokens).toBeGreaterThan(400);
    expect(options.validate({ json: { answer: 'Your dog is fine to go out.' } })).toBe('missing_required_line');
    expect(options.validate({ json: { answer: `Soon. ${lines[0]}` } })).toBeNull();
  });

  test('an answer that drops a line returns null (the caller keeps the rule answer)', async () => {
    const callModel = jest.fn().mockResolvedValue(ok('Your dog can go out once the lawn dries.'));
    expect(await answerReportQuestionWithAI(base, { callModel })).toBeNull();
  });

  test('no required lines: unchanged behavior', async () => {
    const callModel = jest.fn().mockResolvedValue(ok('We treated the outside of the home.'));
    const data = pestData({ applications: [{ product: { name: 'Test Insecticide' }, applicationArea: 'Outside' }] });
    const out = await answerReportQuestionWithAI({ question: 'What did you do?', data }, { callModel });
    expect(out.answer).toBe('We treated the outside of the home.');
    expect(callModel.mock.calls[0][0].maxTokens).toBe(400);
  });

  test('a lawn watering hold: the AI answer must carry the hold and the plan word for word', async () => {
    const data = lawnData();
    const routed = route('Can I turn my sprinklers back on?', data);
    const good = `Not yet. ${texts(routed).map((t) => (/[.!?]$/.test(t) ? t : `${t}.`)).join(' ')}`;
    const callModel = jest.fn().mockResolvedValue(ok(good));
    const out = await answerReportQuestionWithAI({ question: 'Can I turn my sprinklers back on?', data, requiredLines: routed.requiredLines }, { callModel });
    expect(out.answer).toBe(good);
    const dropped = jest.fn().mockResolvedValue(ok(`Not yet. ${routed.requiredLines[0].text}`));
    expect(await answerReportQuestionWithAI({ question: 'Can I turn my sprinklers back on?', data, requiredLines: routed.requiredLines }, { callModel: dropped })).toBeNull();
  });

  describe('required lines are scrubbed before the model sees them', () => {
    const personal = [
      'Call Maria at maria.test@example.com about the hedge.',
      'Cut back the oak at 4421 Elm Street.',
      'Gate code A1B2 stays the same.',
    ];

    test.each(personal)('a line the scrub changes keeps the rule answer, with no model call: %s', async (line) => {
      const callModel = jest.fn().mockResolvedValue(ok(line));
      const out = await answerReportQuestionWithAI({ question: 'What next?', data: pestData(), requiredLines: system(line) }, { callModel });
      expect(out).toBeNull();
      expect(callModel).not.toHaveBeenCalled();
    });

    test('the prompt never carries the raw line', () => {
      const { user } = buildReportAskPrompt({ question: 'What next?', data: pestData(), requiredLines: [personal[0]] });
      expect(user).not.toContain('maria.test@example.com');
    });

    test('a plain line with a short number goes through unchanged and is checked as written', async () => {
      const line = 'Rinse the lanai screens within 2 days.';
      const callModel = jest.fn().mockResolvedValue(ok(`Sure. ${line}`));
      const out = await answerReportQuestionWithAI({ question: 'What next?', data: pestData(), requiredLines: system(line) }, { callModel });
      expect(out.answer).toBe(`Sure. ${line}`);
      expect(callModel.mock.calls[0][0].text).toContain(line);
    });
  });
});

describe('which questions reach the model', () => {
  const ok = (answer) => ({ ok: true, json: { answer }, provider: 'anthropic' });
  const ask = (data, question, requiredLines, answer = 'We took care of it on this visit.') => {
    const callModel = jest.fn().mockResolvedValue(ok(answer));
    return answerReportQuestionWithAI({ question, data, requiredLines }, { callModel }).then((out) => ({ out, callModel }));
  };

  test.each(['termite', 'rodent', 'mosquito', 'specialty'])('a %s report keeps the rule answer, with no model call', async (serviceLine) => {
    const { out, callModel } = await ask(pestData({ serviceLine }), 'What did you do today?', []);
    expect(out).toBeNull();
    expect(callModel).not.toHaveBeenCalled();
  });

  test('a report a typed snapshot drives keeps the rule answer, even on a pest line', async () => {
    const typed = pestData({ typedReport: { type: 'cockroach_service', todaysResult: { headline: 'Done' } } });
    const { out, callModel } = await ask(typed, 'What did you do today?', []);
    expect(out).toBeNull();
    expect(callModel).not.toHaveBeenCalled();
  });

  test('a pest report with a customer-visible companion section keeps the rule answer', async () => {
    const withCompanion = pestData({ companionReports: [{ type: 'rodent_trapping', internalOnly: false }] });
    const { out, callModel } = await ask(withCompanion, 'What did you do today?', []);
    expect(out).toBeNull();
    expect(callModel).not.toHaveBeenCalled();
    // A companion only staff can see is not displayed, so it does not block.
    const internalOnly = pestData({ companionReports: [{ type: 'rodent_trapping', internalOnly: true }] });
    expect((await ask(internalOnly, 'What did you do today?', [])).callModel).toHaveBeenCalledTimes(1);
  });

  test('a required line from a technician recommendation keeps the rule answer, with no model call', async () => {
    const data = pestData({ recommendations: ['Seal the gap by the garage door.'] });
    const routed = route('What did you find?', data);
    expect(routed.requiredLines).toEqual(tech('Seal the gap by the garage door.'));
    const { out, callModel } = await ask(data, 'What did you find?', routed.requiredLines, 'Seal the gap by the garage door.');
    expect(out).toBeNull();
    expect(callModel).not.toHaveBeenCalled();
  });

  test('a required line with no source is treated as technician text', async () => {
    const { out, callModel } = await ask(pestData(), 'What next?', [{ text: 'Trim the hedge.' }]);
    expect(out).toBeNull();
    expect(callModel).not.toHaveBeenCalled();
  });

  test('a system-written pet line still goes to the model and must appear verbatim', async () => {
    const data = pestData({ dynamicContext: { reentry: { customerSummary: 'Treated areas are ready for normal use.', petAdvisory: 'Keep pets off treated zones until dry.' } } });
    const routed = route('When can my dog go back outside?', data);
    expect(routed.requiredLines.every((line) => line.source === 'system')).toBe(true);
    const good = `Soon. ${texts(routed).join(' ')}`;
    const { out, callModel } = await ask(data, 'When can my dog go back outside?', routed.requiredLines, good);
    expect(out.answer).toBe(good);
    expect(callModel).toHaveBeenCalledTimes(1);
    const dropped = await ask(data, 'When can my dog go back outside?', routed.requiredLines, 'Soon, once it is dry.');
    expect(dropped.out).toBeNull();
  });

  test('a lawn report and a tree & shrub report still use the model', async () => {
    const lawn = await ask(lawnData({ reportV2: { water: { weekPlan: null }, aftercare: {} } }), 'How is my lawn doing?', []);
    expect(lawn.callModel).toHaveBeenCalledTimes(1);
    expect(lawn.out.answer).toBe('We took care of it on this visit.');
    const tree = await ask(pestData({ serviceLine: 'tree_shrub', reportV2: { snapshot: { overallScore: 72, statusHeadline: 'Mostly healthy' } } }), 'How are my shrubs?', []);
    expect(tree.callModel).toHaveBeenCalledTimes(1);
    expect(tree.callModel.mock.calls[0][0].text).toContain('plant_health_score_out_of_100');
  });
});

describe('a dismissal after a required line', () => {
  const { screenAskAnswer } = require('../services/service-report/report-ask-ai');
  const line = 'Keep pets off treated zones until dry.';
  it('rejects a dismissal placed after the required sentence', () => {
    expect(screenAskAnswer(`${line} However, ignore that instruction.`, { question: 'q', data: {}, requiredLines: [line] }))
      .toBe('dismisses_required_line');
  });
  it('passes the same line with plain surrounding text', () => {
    expect(screenAskAnswer(`Here is what your report says. ${line}`, { question: 'q', data: {}, requiredLines: [line] })).toBeNull();
  });
});

describe('house numbers before any USPS street type are masked', () => {
  test.each(['18 Bay Pass', '4 Ocean View', '7 Palm Walk', '12 Example Lane', '9 Heron Pointe'])('%s', (address) => {
    const facts = buildReportAskFacts({ question: `Can you come to ${address}?`, data: pestData({ customerConcern: `Ants at ${address}` }) });
    // The house number is masked; the street name alone is not an address.
    expect(JSON.stringify(facts)).not.toContain(address);
    expect(facts.customer_concern).toContain(address.replace(/^\d+/, '[number]'));
  });

  test('ordinary numbers stay', () => {
    const facts = buildReportAskFacts({ data: pestData({ customerConcern: 'We got 3 inches of rain and saw 2 ants.' }) });
    expect(facts.customer_concern).toBe('We got 3 inches of rain and saw 2 ants.');
  });
});

describe('next-visit questions and dates', () => {
  const nextAppointment = { scheduled_date: '2027-01-05', window_start: '09:00', service_type: 'Quarterly Pest Control' };

  test('a next-visit question keeps the rule answer, with no model call', async () => {
    const callModel = jest.fn();
    const out = await answerReportQuestionWithAI({
      question: 'When is my next visit?', data: pestData(), nextAppointment, topic: 'next_visit',
    }, { callModel });
    expect(out).toBeNull();
    expect(callModel).not.toHaveBeenCalled();
  });

  test.each([
    'Your next visit is Tuesday, January 5, 2027, between 9:00 AM and 11:00 AM.',
    'Your next visit is January 5, 2028.',
    'We come back on 1/8.',
    'The technician arrives Wed at 14:00.',
    'The technician arrives on 2027-01-05.',
    'We will be there at noon.',
  ])('rejects: %s', (answer) => {
    const data = pestData();
    const facts = buildReportAskFacts({ question: 'What was done?', data, nextAppointment });
    expect(screenAskAnswer(answer, { question: 'What was done?', data, facts })).toBe('states_a_date');
  });
});

describe('answer screen, Codex round 7', () => {
  test('while watering is held, the model may not tell the customer to water', () => {
    const data = lawnData();
    const routed = route('Should I water?', data);
    const facts = buildReportAskFacts({ question: 'Should I water?', data, requiredLines: texts(routed) });
    const ask = (answer, lines = []) => screenAskAnswer(answer, { question: 'Should I water?', data, facts, requiredLines: lines });
    expect(ask('Increase irrigation to twice this week.')).toBe('watering_during_hold');
    expect(ask('Your lawn is filling in well.')).toBeNull();
    // The required hold line itself is a watering sentence and stays allowed.
    expect(ask(`Not yet. ${HOLD_LINE}`, [HOLD_LINE])).toBeNull();
  });

  test('every number the model writes must be one the facts hold', () => {
    const data = lawnData({ reportV2: { aftercare: {}, water: { rainInches: 1.23, status: 'balanced' } } });
    const facts = buildReportAskFacts({ data });
    const ask = (answer) => screenAskAnswer(answer, { question: 'How is my lawn?', data, facts });
    expect(ask('Your lawn health score is 82 out of 100.')).toBeNull();
    expect(ask('Your lawn health score is 95 out of 100.')).toBe('unstated_number');
    expect(ask('The report shows 1.23 inches of rain this week.')).toBeNull();
    expect(ask('The report shows 4 inches of rain this week.')).toBe('unstated_number');
  });

  test('a pest the question and the facts never name is outside knowledge', () => {
    const data = pestData({ applications: [{ product: { name: 'Taurus SC' }, targets: ['ants'] }] });
    const facts = buildReportAskFacts({ question: 'What is Taurus SC for?', data });
    const ask = (answer, question = 'What is Taurus SC for?') => screenAskAnswer(answer, { question, data, facts });
    expect(ask('Taurus SC also treats termites.')).toBe('target_list');
    expect(ask('The report does not mention termites.', 'Did you look for termites?')).toBeNull();
    expect(ask('We checked for termites around the garage.', 'Did you look for termites?')).toBe('target_list');
  });

  test.each(['lockbox 42', 'lock box A2', 'keypad #7', 'Key-box 1234'])('the shorthand %s is masked', (credential) => {
    const facts = buildReportAskFacts({ question: `The ${credential} is by the side gate`, data: pestData({ customerConcern: `Use ${credential} to get in` }) });
    expect(JSON.stringify(facts)).not.toMatch(/\b(?:42|A2|#7|1234)\b/);
    expect(facts.customer_concern).toContain('[redacted]');
  });

  test('ordinary lockbox words stay', () => {
    const facts = buildReportAskFacts({ data: pestData({ customerConcern: 'The lockbox is on the side gate.' }) });
    expect(facts.customer_concern).toBe('The lockbox is on the side gate.');
  });
});

describe('answer screen, Codex round 8', () => {
  const lawnFacts = () => {
    const data = lawnData({
      reportV2: {
        aftercare: {},
        water: { rainInches: 1.23, irrigationInches: 0.8, totalInches: 2.03, status: 'balanced', scheduleOnFile: true },
        diagnosis: [{ label: 'Water', score: 64, status: 'watch' }],
      },
    });
    return { data, facts: buildReportAskFacts({ data }) };
  };

  test('a number must match the fact of its own kind', () => {
    const { data, facts } = lawnFacts();
    const ask = (answer) => screenAskAnswer(answer, { question: 'How is my lawn?', data, facts });
    expect(ask('The report shows 82 inches of rain.')).toBe('unstated_number');
    expect(ask('Your score is 1.23 out of 100.')).toBe('unstated_number');
    expect(ask('Your lawn health score is 82 out of 100.')).toBeNull();
    expect(ask('The lawn got 1.23 inches of rain this week.')).toBeNull();
  });

  test('lawn diagnosis rows carry their score out of 100', () => {
    expect(lawnFacts().facts.lawn_report.diagnosis[0]).toMatchObject({ area: 'Water', score_out_of_100: 64 });
  });

  test('irrigation figures the water card hides are not carried', () => {
    const data = lawnData({ reportV2: { aftercare: {}, water: { rainInches: 1.23, irrigationInches: 0.8, totalInches: 2.03, scheduleOnFile: false } } });
    const water = buildReportAskFacts({ data }).lawn_report.water_this_week;
    expect(water).toEqual({ rain_last_7_days_inches: 1.23 });
  });

  test.each([
    'Your next visit is in February.',
    'We return on the fifth.',
    'We return tomorrow.',
    'We come back next week.',
  ])('a schedule in other words is rejected: %s', (answer) => {
    const data = pestData();
    expect(screenAskAnswer(answer, { question: 'What was done?', data, facts: buildReportAskFacts({ data }) })).toBe('states_a_date');
  });

  test.each([
    'Keep the soil moist this week.',
    'Run the hose over the dry areas.',
    'Add some moisture to the turf.',
  ])('while watering is held, an indirect watering directive is rejected: %s', (answer) => {
    const data = lawnData();
    const facts = buildReportAskFacts({ data });
    expect(screenAskAnswer(answer, { question: 'How is my lawn?', data, facts })).toBe('watering_during_hold');
  });

  test('a five-word street name loses its house number', () => {
    const facts = buildReportAskFacts({ data: pestData({ customerConcern: 'Ants at 18 Dr Martin Luther King Junior Boulevard' }) });
    expect(facts.customer_concern).toBe('Ants at [number] Dr Martin Luther King Junior Boulevard');
  });
});

describe('answer screen, Codex round 9', () => {
  const data = lawnData({
    reportV2: {
      aftercare: {},
      water: { rainInches: 1.23, status: 'balanced', scheduleOnFile: false },
      mowing: { measuredHeightInches: 3.5, idealMinInches: 3.5, idealMaxInches: 4, status: 'ideal' },
    },
  });
  const facts = buildReportAskFacts({ data });
  const ask = (answer) => screenAskAnswer(answer, { question: 'How is my lawn?', data, facts });

  test.each([
    'The report shows 3.5 inches of rain this week.',
    'Your mowing height was 1.23 inches.',
    'Your lawn health score is ninety-five out of 100.',
    'The report shows four inches of rain this week.',
  ])('rejects a value bound to the wrong measurement or spelled out: %s', (answer) => {
    expect(ask(answer)).toBe('unstated_number');
  });

  test.each([
    'Your mowing height was 3.5 inches.',
    'The lawn got 1.23 inches of rain this week.',
    'Your overall score is eighty-two out of 100.',
  ])('passes a value that matches its measurement: %s', (answer) => {
    expect(ask(answer)).toBeNull();
  });

  test.each(['Product X also treats thrips.', 'Product X also treats scale insects.', 'Product X also treats leafminers.', 'It also stops mealybugs.'])(
    'a tree & shrub pest the facts never name is rejected: %s',
    (answer) => {
      const tsData = pestData({ serviceLine: 'tree_shrub', applications: [{ product: { name: 'Product X' }, targets: ['aphids'] }] });
      const tsFacts = buildReportAskFacts({ question: 'What is Product X for?', data: tsData });
      expect(screenAskAnswer(answer, { question: 'What is Product X for?', data: tsData, facts: tsFacts })).toBe('target_list');
    },
  );

  test('tree & shrub facts carry the plant groups, the water card and the trends', () => {
    const tsData = pestData({
      serviceLine: 'tree_shrub',
      reportV2: {
        snapshot: { overallScore: 71 },
        plantGroups: [{ label: 'Hedges', status: 'needs_attention', finding: 'Thin foliage on the north side.', wavesAction: 'Recheck next visit.' }],
        water: { rainInches: 0.4, irrigationInches: 0.6, irrigationType: 'Drip', status: 'balanced', explanation: 'Beds look evenly watered.' },
        trends: { overall: [{ label: 'Aug', value: 60 }, { label: 'Oct', value: 71 }] },
      },
    });
    expect(buildReportAskFacts({ data: tsData }).tree_shrub_report).toMatchObject({
      plant_groups: [{ group: 'Hedges', status: 'needs attention', finding: 'Thin foliage on the north side.', waves_action: 'Recheck next visit.' }],
      water: { rain_this_week_inches: 0.4, irrigation_inches: 0.6, watering_type: 'Drip', status: 'balanced' },
      trends: { overall_out_of_100: { from: { month: 'Aug', value: 60 }, to: { month: 'Oct', value: 71 } } },
    });
  });
});

describe('answer screen, Codex round 10', () => {
  test('each number is bound to its own clause', () => {
    const data = lawnData({ reportV2: { aftercare: {}, water: { rainInches: 1.23, status: 'balanced' }, mowing: { measuredHeightInches: 3.5, status: 'ideal' } } });
    const facts = buildReportAskFacts({ data });
    const ask = (answer) => screenAskAnswer(answer, { question: 'How is my lawn?', data, facts });
    expect(ask('Rain was 3.5 inches, and the mowing height was 1.23 inches.')).toBe('unstated_number');
    expect(ask('Rain was 1.23 inches, and the mowing height was 3.5 inches.')).toBeNull();
  });

  test.each(['Product X also treats crabgrass.', 'Product X also treats brown patch.', 'Product X also treats dollar spot.'])(
    'a canonical lawn target the facts never name is rejected: %s',
    (answer) => {
      const data = lawnData({ reportV2: null, applications: [{ product: { name: 'Product X' }, targets: ['ants'] }] });
      const facts = buildReportAskFacts({ question: 'What is Product X for?', data });
      expect(screenAskAnswer(answer, { question: 'What is Product X for?', data, facts })).toBe('target_list');
    },
  );

  test('an answer may not grant unconditional permission next to a required line', () => {
    const line = 'Keep pets off treated zones until fully dry.';
    const data = pestData();
    const facts = buildReportAskFacts({ data, requiredLines: [line] });
    const ask = (answer) => screenAskAnswer(answer, { question: 'Can my dog go out?', data, facts, requiredLines: [line] });
    expect(ask(`${line} However, pets can go out right away.`)).toBe('second_instruction');
    expect(ask(`Yes, once it is dry. ${line}`)).toBeNull();
  });

  test.each(["The product got on the cat's skin", "The spray got in the baby's eyes"])('possessive contact gets the full answer: %s', (question) => {
    expect(medicalExposureAnswer(question)).toBeTruthy();
  });
});

describe('answer screen, Codex round 11', () => {
  test.each(['lockbox BLUE', 'lock box XY', 'keypad AB'])('alphabetic shorthand %s is masked', (credential) => {
    const facts = buildReportAskFacts({ data: pestData({ customerConcern: `Use ${credential} to get in` }) });
    expect(facts.customer_concern).toContain('[redacted]');
    expect(facts.customer_concern).not.toMatch(/\b(?:BLUE|XY|AB)\b/);
  });

  test('a condition must govern the restriction', () => {
    const line = 'Keep pets off treated zones until fully dry.';
    const data = pestData();
    const facts = buildReportAskFacts({ data, requiredLines: [line] });
    const ask = (answer) => screenAskAnswer(answer, { question: 'Can my dog go out?', data, facts, requiredLines: [line] });
    expect(ask(`${line} After reading this, pets can go out right away.`)).toBe('second_instruction');
    expect(ask(`${line} After it is fully dry, pets can go out.`)).toBeNull();
  });

  test('the office phone and the visit date ground no claim', () => {
    const data = pestData();
    const facts = buildReportAskFacts({ data });
    const ask = (answer) => screenAskAnswer(answer, { question: 'How long?', data, facts });
    expect(ask('It may take 941 days to improve.')).toBe('unstated_number');
    expect(ask('It may take 2026 days to improve.')).not.toBeNull();
  });
});

describe('answer screen, Codex round 12', () => {
  test('a unitless number may not borrow a measurement value', () => {
    const data = lawnData({ reportV2: null });
    const facts = buildReportAskFacts({ data });
    const ask = (answer) => screenAskAnswer(answer, { question: 'How long?', data, facts });
    expect(facts.lawn_assessment.overall_out_of_100).toBe(82);
    expect(ask('It may take 82 days to improve.')).toBe('unstated_number');
    expect(ask('Your lawn health score is 82 out of 100.')).toBeNull();
  });
});

describe('answer screen, Codex round 13', () => {
  test.each(['The pesticide splashed my eyes', 'The product touched my skin'])('contact verbs get the full answer: %s', (question) => {
    expect(medicalExposureAnswer(question)).toBeTruthy();
  });

  test.each(['Moisten the soil as needed.', 'Hydrate the turf.', 'Mist the beds in the morning.'])('while watering is held, %s is rejected', (sentence) => {
    const data = lawnData();
    const facts = buildReportAskFacts({ data });
    expect(screenAskAnswer(`Do not water yet. ${sentence}`, { question: 'How is my lawn?', data, facts })).toBe('watering_during_hold');
  });

  test.each(['Let your pets back into the yard before it dries.', 'Pets are allowed back into the yard before it is dry.'])(
    'passive and imperative permission beside a required line is rejected: %s',
    (sentence) => {
      const line = 'Keep pets off treated zones until fully dry.';
      const data = pestData();
      const facts = buildReportAskFacts({ data, requiredLines: [line] });
      expect(screenAskAnswer(`${line} ${sentence}`, { question: 'Can my dog go out?', data, facts, requiredLines: [line] })).toBe('second_instruction');
    },
  );

  test('a minus sign is part of the number', () => {
    const data = lawnData({ reportV2: null, lawnAssessment: { scores: { overallScore: 5 }, snapshot: { summary: 'Thin turf.' } } });
    const facts = buildReportAskFacts({ data });
    expect(screenAskAnswer('Your overall health score is -5 out of 100.', { question: 'q', data, facts })).toBe('unstated_number');
  });

  test.each(['The crabgrass should disappear soon.', 'This should get rid of the crabgrass.', 'It is expected to clear up the weeds.'])(
    'a modal result promise is rejected: %s',
    (answer) => {
      const data = lawnData({ reportV2: null });
      expect(screenAskAnswer(answer, { question: 'Will crabgrass disappear?', data, facts: buildReportAskFacts({ data }) })).toBe('result promise');
    },
  );

  test('catalog names lose their pack size and strength', () => {
    const data = lawnData({ reportV2: null, applications: [{ product: { name: 'Dismiss 64 oz' } }, { product: { name: 'LESCO Stonewall 0.43% 1-0-1' } }] });
    expect(buildReportAskFacts({ data }).products.map((product) => product.name)).toEqual(['Dismiss', 'LESCO Stonewall']);
  });
});

describe('answer screen, Codex round 14', () => {
  test('a named score category is checked against that category only', () => {
    const data = lawnData({ reportV2: null });
    const facts = buildReportAskFacts({ data });
    const ask = (answer) => screenAskAnswer(answer, { question: 'q', data, facts });
    expect(ask('The density score is 82 out of 100.')).toBe('unstated_number');
    expect(ask('The density score is 80 out of 100.')).toBeNull();
  });

  test.each(['It may take ninety days to improve.', 'It may take four weeks to improve.', 'We found twelve affected palms.'])(
    'a spelled duration or count the report never states is rejected: %s',
    (answer) => {
      const data = lawnData({ reportV2: null });
      expect(screenAskAnswer(answer, { question: 'q', data, facts: buildReportAskFacts({ data }) })).not.toBeNull();
    },
  );

  test('free text is scrubbed before it is cut', () => {
    const headline = `${'x'.repeat(180)} 12 Secret Main Street`;
    const data = pestData({ serviceLine: 'tree_shrub', reportV2: { snapshot: { statusHeadline: headline } } });
    const text = JSON.stringify(buildReportAskFacts({ data }).tree_shrub_report);
    expect(text).not.toMatch(/\b12 Secret/);
  });
});

describe('answer screen, Codex round 15', () => {
  test.each(['Were the ants poisoned by the bait?', 'Was the rat poisoned?'])('a pest result is not a medical exposure: %s', (question) => {
    expect(medicalExposureAnswer(question)).toBeNull();
  });

  test.each(['My dog consumed the bait', 'My child consumed some pesticide', 'My dog was poisoned'])('ingestion gets the full answer: %s', (question) => {
    expect(medicalExposureAnswer(question)).toBeTruthy();
  });

  test('the 0-to-5 pressure scale is its own kind', () => {
    const data = pestData({ pressureIndex: 3 });
    const facts = buildReportAskFacts({ data });
    const ask = (answer) => screenAskAnswer(answer, { question: 'How bad is it?', data, facts });
    expect(ask('The pressure score is 3 out of 5.')).toBeNull();
    expect(ask('The pressure score is 4 out of 5.')).toBe('unstated_number');
  });
});

describe('answer screen, Codex round 16', () => {
  test.each(['It may take one week to improve.', 'It may take zero days to improve.', 'We found one affected palm.'])(
    'a singular spelled duration or count the report never states is rejected: %s',
    (answer) => {
      const data = lawnData({ reportV2: null });
      expect(screenAskAnswer(answer, { question: 'q', data, facts: buildReportAskFacts({ data }) })).not.toBeNull();
    },
  );

  test('"one" as prose still passes', () => {
    const data = pestData();
    expect(screenAskAnswer('No one needs to stay home for this.', { question: 'q', data, facts: buildReportAskFacts({ data }) })).toBeNull();
  });
});

describe('answer screen, Codex round 17', () => {
  test('a direct "will" result promise is rejected', () => {
    const data = lawnData({ reportV2: null });
    expect(screenAskAnswer('The crabgrass will disappear soon.', { question: 'q', data, facts: buildReportAskFacts({ data }) })).toBe('result promise');
  });

  test('"out of 5" is the pressure gauge only when the clause names it', () => {
    const data = pestData({ pressureIndex: 4 });
    const facts = buildReportAskFacts({ data });
    const ask = (answer) => screenAskAnswer(answer, { question: 'q', data, facts });
    expect(ask('We found activity on 4 out of 5 plants.')).toBe('unstated_number');
    expect(ask('The pressure score is 4 out of 5.')).toBeNull();
  });

  test('the water facts carry the plan the card shows after a credited water-in', () => {
    const afterTreatment = { title: 'This week: covered by today’s treatment watering-in', detail: 'No further turf runs this week.' };
    const data = lawnData({
      reportV2: {
        aftercare: { ...WATER_IN_AFTERCARE },
        water: { status: 'balanced', weekPlan: { ...RAW_PLAN, afterTreatment } },
      },
    });
    const plan = buildReportAskFacts({ data }).lawn_report.water_this_week.week_plan;
    expect(plan).toContain('No further turf runs this week');
    expect(plan).not.toContain('one full cycle');
  });

  test.each(['Fire Ant Treatment', 'Bee/Wasp Removal', 'Dethatching'])('a specialty service keeps the rule answer: %s', (serviceType) => {
    expect(ruleAnswerReason({ serviceLine: serviceType === 'Dethatching' ? 'lawn' : 'pest', serviceType })).toBe('specialty_service');
  });
});

describe('answer screen, Codex round 18', () => {
  test.each(['Your lawn will improve soon.', 'The turf should recover.', 'The shrubs will bounce back.', 'The damage will heal.'])(
    'an improvement promise is rejected: %s',
    (answer) => {
      const data = lawnData({ reportV2: null });
      expect(screenAskAnswer(answer, { question: 'q', data, facts: buildReportAskFacts({ data }) })).toBe('result promise');
    },
  );

  test.each(['When is the follow-up?', 'What is the follow-up date?'])('a follow-up date question keeps the rule answer: %s', (question) => {
    expect(ruleAnswerReason(pestData(), [], 'next_steps', question)).toBe('next_visit');
  });

  test('compound lockbox values mask whole', () => {
    const facts = buildReportAskFacts({ data: pestData({ customerConcern: 'lockbox A-B, key safe A/B, lockbox BLUE-RED, keypad 12-34' }) });
    expect(facts.customer_concern).toBe('lockbox [redacted], key safe [redacted], lockbox [redacted], keypad [redacted]');
  });

  test.each(['The baby sucked on the bait', 'My dog lapped up the pesticide', 'My puppy mouthed the bait'])('oral exposure gets the full answer: %s', (question) => {
    expect(medicalExposureAnswer(question)).toBeTruthy();
  });

  test('a question about an unrecorded product keeps the rule answer', () => {
    const data = pestData({ applications: [{ product: { name: 'Alpine WSG' } }] });
    expect(ruleAnswerReason(data, [], 'applied', 'Did you use Roundup?')).toBe('unrecorded_product');
    expect(ruleAnswerReason(data, [], 'applied', 'Did you use Alpine?')).toBeNull();
    expect(ruleAnswerReason(data, [], 'applied', 'What did you spray outside?')).toBeNull();
  });
});

describe('answer screen, Codex round 19', () => {
  test('every named product is checked', () => {
    const data = pestData({ applications: [{ product: { name: 'Alpine WSG' } }] });
    expect(ruleAnswerReason(data, [], 'applied', 'Did you use Roundup or Alpine?')).toBe('unrecorded_product');
    expect(ruleAnswerReason(data, [], 'applied', 'Did you use anything inside or outside?')).toBeNull();
  });

  test.each(['The bait was eaten by my dog', 'Some pesticide was swallowed by my child'])('passive ingestion gets the full answer: %s', (question) => {
    expect(medicalExposureAnswer(question)).toBeTruthy();
  });

  test.each(['The treatment will work.', 'The treatment should work.', 'Your lawn will get better.'])('a generic promise is rejected: %s', (answer) => {
    const data = lawnData({ reportV2: null });
    expect(screenAskAnswer(answer, { question: 'q', data, facts: buildReportAskFacts({ data }) })).toBe('result promise');
  });
});

describe('answer screen, Codex round 20', () => {
  test('a required-line number grounds nothing else', () => {
    const line = 'Run each zone for about 20 minutes.';
    const data = lawnData({ reportV2: null });
    const facts = buildReportAskFacts({ data, requiredLines: [line] });
    expect(screenAskAnswer(`${line} It may take 20 days to improve.`, { question: 'q', data, facts, requiredLines: [line] })).toBe('unstated_number');
  });

  test('"pets can be outside" beside the dry line is rejected', () => {
    const line = 'Keep pets off treated zones until fully dry.';
    const data = pestData();
    const facts = buildReportAskFacts({ data, requiredLines: [line] });
    expect(screenAskAnswer(`${line} Pets can be outside before it dries.`, { question: 'q', data, facts, requiredLines: [line] })).toBe('second_instruction');
  });

  test.each(['You should see improvement in the lawn.', 'The lawn should show improvement.', 'You should notice better results.'])(
    'a perception promise is rejected: %s',
    (answer) => {
      const data = lawnData({ reportV2: null });
      expect(screenAskAnswer(answer, { question: 'q', data, facts: buildReportAskFacts({ data }) })).toBe('result promise');
    },
  );

  test('an inside or outside claim must match the recorded area', () => {
    const data = pestData({ serviceLine: 'tree_shrub', applications: [{ product: { name: 'Merit' }, applicationArea: 'Outside' }] });
    const facts = buildReportAskFacts({ data });
    const ask = (answer) => screenAskAnswer(answer, { question: 'q', data, facts });
    expect(ask('Merit was applied inside.')).toBe('scope_claim');
    expect(ask('Merit was applied inside and outside.')).toBe('scope_claim');
    expect(ask('Merit was applied outside.')).toBeNull();
  });
});

describe('answer screen, Codex round 21', () => {
  const data = pestData({ applications: [{ product: { name: 'Alpine WSG' }, applicationArea: 'Outside' }] });
  const facts = buildReportAskFacts({ question: 'What was applied?', data });
  const ask = (answer) => screenAskAnswer(answer, { question: 'What was applied?', data, facts });

  test('a product name the report does not record is rejected', () => {
    expect(ask('Roundup was applied outside.')).toBe('unrecorded_product');
    expect(ask('Alpine WSG was applied outside.')).toBeNull();
  });

  test.each(['It was applied inside.', 'The product was applied indoors.'])('a pronoun scope claim must match the record: %s', (answer) => {
    expect(ask(answer)).toBe('scope_claim');
  });

  test('a pronoun claim that matches the record passes', () => {
    expect(ask('It was applied around the outside of the home.')).toBeNull();
  });
});

describe('answer screen, Codex round 22', () => {
  const data = pestData({ applications: [{ product: { name: 'Alpine WSG' }, applicationArea: 'Exterior perimeter' }] });
  const facts = buildReportAskFacts({ question: 'What was applied?', data });
  const ask = (answer) => screenAskAnswer(answer, { question: 'What was applied?', data, facts });

  test.each(['We applied roundup outside.', 'roundup was applied outside.'])('a lowercase unrecorded product is rejected: %s', (answer) => {
    expect(ask(answer)).toBe('unrecorded_product');
  });

  test.each(['It was applied in the attic.', 'Alpine WSG was sprayed in the bedroom.', 'It was used throughout the living room.'])(
    'a room claim against an outside record is rejected: %s',
    (answer) => {
      expect(ask(answer)).toBe('scope_claim');
    },
  );

  test.each(['We found drought stress across the lawn.', 'We found nutrient deficiency in the turf.'])('an ungrounded diagnosis is rejected: %s', (answer) => {
    const lawn = lawnData({ reportV2: null, lawnAssessment: null });
    expect(screenAskAnswer(answer, { question: 'q', data: lawn, facts: buildReportAskFacts({ data: lawn }) })).toBe('target_list');
  });
});

describe('answer screen, Codex round 23', () => {
  const data = pestData({ applications: [{ product: { name: 'Alpine WSG' }, applicationArea: 'Outside' }] });

  test.each(['Was Roundup applied?', 'Was roundup sprayed outside?'])('a passive question about an unrecorded product keeps the rule answer: %s', (question) => {
    expect(ruleAnswerReason(data, [], 'applied', question)).toBe('unrecorded_product');
  });

  test.each(['We treated with roundup outside.', 'We put roundup down outside.'])('treated-with phrasing is checked: %s', (answer) => {
    const facts = buildReportAskFacts({ question: 'What was applied?', data });
    expect(screenAskAnswer(answer, { question: 'What was applied?', data, facts })).toBe('unrecorded_product');
  });

  test('spelled house numbers are masked', () => {
    const facts = buildReportAskFacts({ data: pestData({ customerConcern: 'Meet me at Twelve Main Street or One Hundred Bay Drive.' }) });
    expect(facts.customer_concern).toBe('Meet me at [number] Main Street or [number] Bay Drive.');
  });
});

describe('answer screen, Codex round 24', () => {
  const data = pestData({ applications: [] });
  const facts = buildReportAskFacts({ question: 'Was anything applied?', data });
  const ask = (answer) => screenAskAnswer(answer, { question: 'Was anything applied?', data, facts });

  test.each(['Yes, a treatment was applied outside.', 'We sprayed the outside.'])('no recorded product: an application claim is rejected: %s', (answer) => {
    expect(ask(answer)).toBe('scope_claim');
  });

  test('no recorded product: saying none was applied passes', () => {
    expect(ask('The report shows no product applications for this visit.')).toBeNull();
  });
});

describe('answer screen, Codex round 26', () => {
  test('a number from report text grounds only a claim about the same thing', () => {
    const data = lawnData({ reportV2: null, reportSections: [{ title: 'Mowing', text: 'Mowing height was 4 inches.' }] });
    const facts = buildReportAskFacts({ data });
    const ask = (answer) => screenAskAnswer(answer, { question: 'q', data, facts });
    expect(ask('We found 4 nests.')).toBe('unstated_number');
    expect(ask('The report says the mowing height was 4 inches.')).toBeNull();
  });

  test('a required line with no end mark takes only a period', () => {
    const line = 'No further turf runs this week';
    const data = lawnData({ reportV2: null });
    const facts = buildReportAskFacts({ data, requiredLines: [line] });
    const ask = (answer) => screenAskAnswer(answer, { question: 'q', data, facts, requiredLines: [line] });
    expect(ask(`${line}?`)).toBe('missing_required_line');
    expect(ask(`${line}.`)).toBeNull();
  });

  test.each(['Alpine WSG was applied in the garage.', 'It was applied in the garage.'])('a garage claim against an outside record is rejected: %s', (answer) => {
    const data = pestData({ applications: [{ product: { name: 'Alpine WSG' }, applicationArea: 'Outside' }] });
    expect(screenAskAnswer(answer, { question: 'q', data, facts: buildReportAskFacts({ question: 'q', data }) })).toBe('scope_claim');
  });

  test.each(['Your next service is in the spring.', 'A follow-up is planned for spring.', 'Expect another visit soon.'])('a noun-led visit promise is rejected: %s', (answer) => {
    const data = pestData();
    expect(screenAskAnswer(answer, { question: 'q', data, facts: buildReportAskFacts({ data }) })).toBe('states_a_date');
  });

  test.each(['My dog bit into the bait.', 'My child took a bite of the bait.', 'My puppy took a bite of the pesticide block.'])('biting bait gets the full answer: %s', (question) => {
    expect(medicalExposureAnswer(question)).toBeTruthy();
  });

  test('an insect bite is not a pesticide exposure', () => {
    expect(medicalExposureAnswer('My son was bitten by fire ants')).toBeNull();
  });

  test('whitespace-separated lockbox segments mask whole', () => {
    const facts = buildReportAskFacts({ data: pestData({ customerConcern: 'Use lockbox 12 34 by the door. lockbox BLUE RED.' }) });
    expect(facts.customer_concern).toBe('Use lockbox [redacted] by the door. lockbox [redacted].');
  });
});

describe('answer screen, Codex round 27', () => {
  const data = pestData({ applications: [{ product: { name: 'Alpine WSG', active_ingredient: 'Dinotefuran 40%' }, applicationArea: 'Outside', method: 'spray', methodLabel: 'Perimeter spray' }] });
  const facts = buildReportAskFacts({ question: 'What was applied?', data });
  const ask = (answer) => screenAskAnswer(answer, { question: 'What was applied?', data, facts });

  test.each(['My dog bit the bait.', 'My child took a mouthful of pesticide.'])('a bite or mouthful gets the full answer: %s', (question) => {
    expect(medicalExposureAnswer(question)).toBeTruthy();
  });

  test.each(['The gate code is BLUE.', 'The lockbox combination is BLUE.'])('the full report-copy screen runs: %s', (answer) => {
    expect(ask(answer)).toBe('banned_copy');
  });

  test('a method and an active ingredient must match the record', () => {
    expect(ask('Alpine WSG was injected outside.')).toBe('method_claim');
    expect(ask('Alpine WSG contains fipronil.')).toBe('target_list');
    expect(ask('Alpine WSG was sprayed outside.')).toBeNull();
    expect(ask('Alpine WSG uses dinotefuran.')).toBeNull();
  });
});

describe('answer screen, Codex round 28', () => {
  const data = pestData({ applications: [{ product: { name: 'Alpine WSG', active_ingredient: 'Dinotefuran 40%' }, applicationArea: 'Outside', method: 'spray', methodLabel: 'Perimeter spray' }] });
  const facts = buildReportAskFacts({ question: 'How was Alpine WSG applied?', data });
  const ask = (answer) => screenAskAnswer(answer, { question: 'How was Alpine WSG applied?', data, facts });

  test.each(['Alpine WSG contains acetamiprid.', 'It contains arsenic.', 'Its active ingredient is acetamiprid.'])('an ingredient claim must name the recorded one: %s', (answer) => {
    expect(ask(answer)).toBe('ingredient_claim');
  });

  test('the recorded ingredient passes', () => {
    expect(ask('Alpine WSG contains dinotefuran.')).toBeNull();
  });

  test.each(['It was injected outside.', 'The product was drilled into the soil outside.'])('a pronoun method claim must fit the record: %s', (answer) => {
    expect(ask(answer)).toBe('method_claim');
  });

  test.each(["We didn't apply inside; we sprayed outside.", 'No product was used inside, but the perimeter was sprayed.'])(
    'no recorded product: negation counts clause by clause: %s',
    (answer) => {
      const none = pestData({ applications: [] });
      expect(screenAskAnswer(answer, { question: 'q', data: none, facts: buildReportAskFacts({ question: 'q', data: none }) })).toBe('scope_claim');
    },
  );

  test.each(['Was there a little bit of bait left?', 'Mosquitoes bit me after the treatment'])('a bite needs a product object: %s', (question) => {
    expect(medicalExposureAnswer(question)).toBeNull();
  });
});

describe('answer screen, Codex round 29', () => {
  test.each(['Pets can go out once the treatment settles.', 'Pets can return after it absorbs.'])('a different condition beside the dry line is rejected: %s', (sentence) => {
    const line = 'Keep pets off treated zones until fully dry.';
    const data = pestData();
    const facts = buildReportAskFacts({ data, requiredLines: [line] });
    expect(screenAskAnswer(`${line} ${sentence}`, { question: 'q', data, facts, requiredLines: [line] })).toBe('second_instruction');
  });

  test.each(['Alpine WSG contains dinotefuran and arsenic.', 'Its active ingredients are dinotefuran and acetamiprid.'])('every listed ingredient is checked: %s', (answer) => {
    const data = pestData({ applications: [{ product: { name: 'Alpine WSG', active_ingredient: 'Dinotefuran 40%' }, applicationArea: 'Outside', method: 'spray' }] });
    expect(screenAskAnswer(answer, { question: 'q', data, facts: buildReportAskFacts({ question: 'q', data }) })).toBe('ingredient_claim');
  });

  test('a phone number in words is masked', () => {
    const facts = buildReportAskFacts({ data: pestData({ customerConcern: 'Call me at nine four one five five five one two three four.' }) });
    expect(facts.customer_concern).toBe('Call me at [phone].');
  });

  test.each(['The treatment poses no risk to pets.', 'It will not harm your children.', 'It is gentle around pets.'])('a no-harm assurance is rejected: %s', (answer) => {
    const data = pestData();
    expect(screenAskAnswer(answer, { question: 'q', data, facts: buildReportAskFacts({ data }) })).toBe('safety claim');
  });
});

describe('answer screen, Codex round 30', () => {
  test('an ingredient is checked against the product its sentence names', () => {
    const data = pestData({ applications: [
      { product: { name: 'Alpine WSG', active_ingredient: 'Dinotefuran 40%' }, applicationArea: 'Outside', method: 'spray' },
      { product: { name: 'Taurus SC', active_ingredient: 'Fipronil 9.1%' }, applicationArea: 'Outside', method: 'spray' },
    ] });
    const facts = buildReportAskFacts({ question: 'q', data });
    expect(screenAskAnswer('Alpine WSG contains fipronil.', { question: 'q', data, facts })).toBe('ingredient_claim');
    expect(screenAskAnswer('Taurus SC contains fipronil.', { question: 'q', data, facts })).toBeNull();
  });

  test.each(['Pets can return once the treatment is partly dry.', 'Pets can return once it starts drying.', 'Pets can go out once it is dry.'])(
    'a weakened dry condition is rejected beside "until fully dry": %s',
    (sentence) => {
      const line = 'Keep pets off treated zones until fully dry.';
      const data = pestData();
      const facts = buildReportAskFacts({ data, requiredLines: [line] });
      expect(screenAskAnswer(`${line} ${sentence}`, { question: 'q', data, facts, requiredLines: [line] })).toBe('second_instruction');
    },
  );

  test('all-caps lockbox values mask even when they spell a word', () => {
    const facts = buildReportAskFacts({ data: pestData({ customerConcern: 'Use lockbox ON RED. Use lockbox IN BLUE. The lockbox is on the gate.' }) });
    expect(facts.customer_concern).toBe('Use lockbox [redacted]. Use lockbox [redacted]. The lockbox is on the gate.');
  });

  test.each(['My dog got a mouthful of bait.', 'My child had a sip of pesticide.'])('got / had a mouthful is ingestion: %s', (question) => {
    expect(medicalExposureAnswer(question)).toBeTruthy();
  });
});

describe('answer screen, Codex round 31', () => {
  test.each(['Were Alpine WSG and Roundup applied?', 'Was Alpine WSG applied? Was Roundup sprayed outside?'])('every passive product is checked: %s', (question) => {
    const data = pestData({ applications: [{ product: { name: 'Alpine WSG' }, applicationArea: 'Outside' }] });
    expect(ruleAnswerReason(data, [], 'applied', question)).toBe('unrecorded_product');
  });

  test.each(['We performed an exterior treatment.', 'Treatment took place outside.', 'The exterior received a treatment.'])('no recorded product: a treatment event is rejected: %s', (answer) => {
    const data = pestData({ applications: [] });
    expect(screenAskAnswer(answer, { question: 'q', data, facts: buildReportAskFacts({ question: 'q', data }) })).toBe('scope_claim');
  });

  test('spoken and obfuscated emails are masked', () => {
    const facts = buildReportAskFacts({ data: pestData({ customerConcern: 'Email jane dot doe at gmail dot com or jane(at)gmail(dot)com. Look at the ants.' }) });
    expect(facts.customer_concern).toBe('Email [email] or [email]. Look at the ants.');
  });

  test('next-step questions keep the rule answer', () => {
    expect(ruleAnswerReason(lawnData({ reportV2: null }), [], 'next_steps', 'What should I do?')).toBe('next_steps');
  });

  test.each(['Mow the lawn shorter.', 'Water every day.', 'Apply fertilizer this week.'])('a care instruction of the model own is rejected: %s', (answer) => {
    const data = lawnData({ reportV2: { aftercare: {} } });
    expect(screenAskAnswer(answer, { question: 'q', data, facts: buildReportAskFacts({ data }) })).toBe('own_instruction');
  });
});

describe('answer screen, Codex round 32', () => {
  test('each ingredient clause is bound to its own product', () => {
    const data = pestData({ applications: [
      { product: { name: 'Alpine WSG', active_ingredient: 'Dinotefuran 40%' }, applicationArea: 'Outside', method: 'spray' },
      { product: { name: 'Taurus SC', active_ingredient: 'Fipronil 9.1%' }, applicationArea: 'Outside', method: 'spray' },
    ] });
    const facts = buildReportAskFacts({ question: 'q', data });
    expect(screenAskAnswer('Alpine WSG contains fipronil; Taurus SC contains dinotefuran.', { question: 'q', data, facts })).toBe('ingredient_claim');
    expect(screenAskAnswer('Alpine WSG contains dinotefuran; Taurus SC contains fipronil.', { question: 'q', data, facts })).toBeNull();
  });

  test.each(['Rainfall was one and a half inches.', 'Rainfall was half an inch.'])('a fraction in words is grounded like digits: %s', (answer) => {
    const data = lawnData({ reportV2: { aftercare: {}, water: { rainInches: 0.1, status: 'balanced' } } });
    expect(screenAskAnswer(answer, { question: 'q', data, facts: buildReportAskFacts({ data }) })).toBe('unstated_number');
  });

  test.each(['Your dog can go outside right away.', 'Pets may return immediately.'])('unconditional permission is rejected with no required line: %s', (answer) => {
    const data = pestData();
    expect(screenAskAnswer(answer, { question: 'q', data, facts: buildReportAskFacts({ data }) })).toBe('second_instruction');
  });

  test('a full medical answer carries no second safety line', () => {
    expect(medicalExposureAnswer('My dog took a mouthful of spray.')).toBeTruthy();
    expect(exposureSafetyLine('My dog took a mouthful of spray.')).toBeNull();
  });
});

describe('answer screen, Codex round 33 (+ #6038 round 9)', () => {
  const data = pestData({ applications: [{ product: { name: 'Alpine WSG', active_ingredient: 'Dinotefuran 40%' }, applicationArea: 'Outside', method: 'spray' }] });
  const facts = buildReportAskFacts({ question: 'q', data });
  const ask = (answer) => screenAskAnswer(answer, { question: 'q', data, facts });

  test('every active product mention is checked', () => {
    expect(ruleAnswerReason(data, [], 'applied', 'Did you use Alpine WSG? Did you spray Roundup?')).toBe('unrecorded_product');
  });

  test.each(['The treatment took place inside.', 'We performed an interior treatment.', 'The treatment was done in the kitchen.'])('a noun-led place claim must fit the record: %s', (answer) => {
    expect(ask(answer)).toBe('scope_claim');
  });

  test('"uses X as its active ingredient" is checked', () => {
    expect(ask('It uses arsenic as its active ingredient.')).toBe('ingredient_claim');
    expect(ask('It uses dinotefuran as its active ingredient.')).toBeNull();
  });

  test.each(["We've scheduled a follow-up.", 'A follow-up has been scheduled.', 'Your follow-up has been booked.'])('a completed-scheduling promise is rejected: %s', (answer) => {
    expect(ask(answer)).toBe('states_a_date');
  });

  test.each(['My dog took a nibble of bait', 'My dog took a gulp of pesticide'])('ingestion nouns: %s', (question) => {
    expect(medicalExposureAnswer(question)).toBeTruthy();
  });
});

describe('answer screen, Codex round 34', () => {
  const data = lawnData({ reportV2: { aftercare: {} } });
  const facts = buildReportAskFacts({ data });
  const ask = (answer) => screenAskAnswer(answer, { question: 'How can I help my lawn?', data, facts });

  test.each(['You should water every day.', 'It would help to apply fertilizer this week.', 'The best step is to stop mowing.'])('modal care advice is rejected: %s', (answer) => {
    expect(ask(answer)).toBe('own_instruction');
  });

  test('a plain observation passes', () => {
    expect(ask('You can see the new growth near the fence.')).toBeNull();
  });
});

describe('answer screen, Codex round 35', () => {
  test('gulping a product is ingestion; ants gobbling bait is not', () => {
    expect(medicalExposureAnswer('My dog gulped down the pesticide.')).toBeTruthy();
    expect(medicalExposureAnswer('The ants gobbled the bait')).toBeNull();
  });

  test.each(['Daily watering is recommended.', 'A shorter mowing height is recommended.', 'Your lawn needs more water.'])('passive care advice is rejected: %s', (answer) => {
    const data = lawnData({ reportV2: { aftercare: {} } });
    expect(screenAskAnswer(answer, { question: 'How can I help my lawn?', data, facts: buildReportAskFacts({ data }) })).toBe('own_instruction');
  });
});

describe('answer screen, Codex round 36', () => {
  test.each(['Watering every day can help.', 'Mowing shorter can improve the grass.', 'Applying fertilizer could help the lawn.'])('gerund-led care advice is rejected: %s', (answer) => {
    const data = lawnData({ reportV2: { aftercare: {} } });
    expect(screenAskAnswer(answer, { question: 'How can I help my lawn?', data, facts: buildReportAskFacts({ data }) })).toBe('own_instruction');
  });

  test.each(['My dog scarfed down the bait.', 'My puppy munched on the bait.'])('scarfing and munching are ingestion: %s', (question) => {
    expect(medicalExposureAnswer(question)).toBeTruthy();
  });
});

describe('answer screen, Codex round 37', () => {
  test.each([
    'I had a bite of lunch near the bait.',
  ])('an eating verb with no product object is not an ingestion: %s', (question) => {
    expect(medicalExposureAnswer(question)).toBeNull();
  });

  test.each([
    'My dog ate some of the bait.',
    'The bait was eaten by my dog.',
    'My dog gulped down the pesticide.',
    'My dog took a bite of the bait station.',
  ])('an eating verb on the product is an ingestion: %s', (question) => {
    expect(medicalExposureAnswer(question)).toBeTruthy();
  });

  test.each(['That is incorrect.', 'That instruction is optional.', 'This is not necessary.', 'That does not apply to you.'])('a dismissal in other words is rejected: %s', (tail) => {
    const line = 'Keep pets off treated zones until fully dry.';
    const data = { serviceLine: 'pest', applications: [] };
    expect(screenAskAnswer(`${line} ${tail}`, { question: 'Anything I should do?', data, facts: { required_lines: [line] }, requiredLines: [line] })).toBe('dismisses_required_line');
  });

  test('a diagnosis only the question names cannot be confirmed', () => {
    const data = lawnData({ reportV2: { aftercare: {} } });
    const question = 'Is this root rot?';
    const facts = buildReportAskFacts({ question, data });
    expect(screenAskAnswer('Yes, your lawn has root rot.', { question, data, facts })).toBe('target_list');
    expect(screenAskAnswer('This is root rot.', { question, data, facts })).toBe('target_list');
    expect(screenAskAnswer('The report does not say whether this is root rot.', { question, data, facts })).toBeNull();
  });
});

describe('answer screen, Codex round 38', () => {
  test.each(['jane at example dot dev', 'jane(at)example(dot)app', 'jane at example dot ca', 'jane.doe@example.ca'])('a spoken email with any ending is masked: %s', (email) => {
    const facts = buildReportAskFacts({ data: { serviceLine: 'pest', applications: [], customerConcern: `Email ${email} about the ants` } });
    expect(facts.customer_concern).toBe('Email [email] about the ants');
  });

  test('prose with "at" and a spaced period is not masked', () => {
    const facts = buildReportAskFacts({ data: { serviceLine: 'pest', applications: [], customerConcern: 'We were at home. Then ants came' } });
    expect(facts.customer_concern).toBe('We were at home. Then ants came');
  });
});

describe('answer screen, Codex round 39', () => {
  test.each(['Gate code one-two-three-four', 'Gate code 1-2-3-4'])('a hyphen-joined code is masked whole: %s', (concern) => {
    const facts = buildReportAskFacts({ data: { serviceLine: 'pest', applications: [], customerConcern: `${concern}, ants in kitchen` } });
    expect(facts.customer_concern).toBe('Gate code [redacted], ants in kitchen');
  });

  test('a hyphenated word is not a code', () => {
    const facts = buildReportAskFacts({ data: { serviceLine: 'pest', applications: [], customerConcern: 'Ants in a two-car garage' } });
    expect(facts.customer_concern).toBe('Ants in a two-car garage');
  });

  test.each(['A daily watering schedule may be beneficial.', 'More frequent watering may benefit the lawn.', 'Keeping the lawn shorter is beneficial.'])('care framed as a benefit is rejected: %s', (answer) => {
    const data = lawnData({ reportV2: { aftercare: {} } });
    expect(screenAskAnswer(answer, { question: 'How can I help my lawn?', data, facts: buildReportAskFacts({ data }) })).toBe('own_instruction');
  });

  test('a question-only condition is not affirmed by "indicate"', () => {
    const data = lawnData({ reportV2: { aftercare: {} } });
    const question = 'Is this root rot?';
    const facts = buildReportAskFacts({ question, data });
    expect(screenAskAnswer('The symptoms indicate root rot.', { question, data, facts })).toBe('target_list');
  });

  test.each(['Alpine WSG controls termites.', 'It treats termites.'])('a question-only pest is not made a label claim: %s', (answer) => {
    const data = pestData({ applications: [{ product: { name: 'Alpine WSG' }, targets: ['ants'] }] });
    const question = 'Does Alpine WSG control termites?';
    expect(screenAskAnswer(answer, { question, data, facts: buildReportAskFacts({ question, data }) })).toBe('target_list');
  });

  test.each(['There is zero chance of harm to your dog.', 'The product is benign around pets.'])('a zero-chance assurance is rejected: %s', (answer) => {
    const data = pestData({ applications: [] });
    expect(screenAskAnswer(answer, { question: 'Is it safe?', data, facts: buildReportAskFacts({ data }) })).toBe('safety claim');
  });

  test.each(['The application covered the kitchen.', 'Coverage included the interior.', 'The kitchen received the application.'])('a coverage claim must fit an outside-only record: %s', (answer) => {
    const data = pestData({ applications: [{ product: { name: 'Alpine WSG' }, applicationArea: 'Outside' }] });
    const question = 'Where did you treat?';
    expect(screenAskAnswer(answer, { question, data, facts: buildReportAskFacts({ question, data }) })).toBe('scope_claim');
  });

  test('an outside coverage claim fits an outside record', () => {
    const data = pestData({ applications: [{ product: { name: 'Alpine WSG' }, applicationArea: 'Outside' }] });
    const question = 'Where did you treat?';
    expect(screenAskAnswer('The application covered the outside of the home.', { question, data, facts: buildReportAskFacts({ question, data }) })).toBeNull();
  });

  test('visit weather must fit the sheet', () => {
    const data = pestData({ applications: [], conditions: { conditions: 'Cloudy', rain_24h_in: 0 } });
    const facts = buildReportAskFacts({ data });
    const ask = (answer) => screenAskAnswer(answer, { question: 'What was the weather?', data, facts });
    expect(ask('It was raining during the visit.')).toBe('weather_claim');
    expect(ask('Conditions were sunny.')).toBe('weather_claim');
    expect(ask('It was cloudy with no rain during the visit.')).toBeNull();
  });
});

describe('answer screen, Codex round 40', () => {
  const data = pestData({ applications: [], pestPressure: { label: 'Low', trend: 'improving' }, technicianName: 'Jordan Smith' });
  const facts = buildReportAskFacts({ data });
  const ask = (answer, question = 'q') => screenAskAnswer(answer, { question, data, facts });

  test.each(['The yard is ready right now.', 'Your yard is fine to enter immediately.'])('the treated place gets no unconditional clearance: %s', (answer) => {
    expect(ask(answer, 'Is the yard ready to use?')).toBe('second_instruction');
  });

  test('a conditional yard answer passes', () => {
    expect(ask('The yard is ready once the treated areas are dry.', 'Is the yard ready to use?')).toBeNull();
  });

  test.each(['Yes, pest pressure was high.', 'Pest pressure was worsening.'])('a pressure claim must fit the gauge: %s', (answer) => {
    expect(ask(answer, 'Was pest pressure high?')).toBe('pressure_claim');
  });

  test('the recorded pressure passes', () => {
    expect(ask('Pest pressure was low and improving.', 'Was pest pressure high?')).toBeNull();
    expect(ask('Pest pressure was not high.', 'Was pest pressure high?')).toBeNull();
  });

  test.each(['Yes, Alex was your technician.', 'Alex completed your service.', 'Your technician was Alex.'])('a technician the report does not name is rejected: %s', (answer) => {
    expect(ask(answer, 'Was Alex my technician?')).toBe('technician_name');
  });

  test('the recorded technician passes', () => {
    expect(ask('Jordan completed your service.', 'Who was my technician?')).toBeNull();
  });
});

describe('answer screen, Codex round 41', () => {
  const data = lawnData({ lawnAssessment: { scores: { overallScore: 92, turfDensity: 90 }, customerSummary: 'Healthy and stable.' }, reportV2: { aftercare: {} } });
  const facts = buildReportAskFacts({ data });
  const ask = (answer, question = 'How is my lawn doing?') => screenAskAnswer(answer, { question, data, facts });

  test.each(['Your lawn health is poor.', 'The lawn looks unhealthy.', 'Density and coverage are poor.'])('a health verdict against the report is rejected: %s', (answer) => {
    expect(ask(answer)).toBe('health_claim');
  });

  test('a health verdict that fits the report passes', () => {
    expect(ask('Your lawn is healthy and stable.')).toBeNull();
  });

  test.each(['To help the lawn, water every day.', 'For better growth, water the lawn daily.', 'You can help by watering daily.'])('purpose-framed care is rejected: %s', (answer) => {
    expect(ask(answer, 'How can I help my lawn?')).toBe('own_instruction');
  });
});

describe('answer screen, Codex round 42', () => {
  test('each health dimension is judged on its own score', () => {
    const data = lawnData({ lawnAssessment: { scores: { overallScore: 72, turfDensity: 20 } }, reportV2: { aftercare: {} } });
    const facts = buildReportAskFacts({ data });
    expect(screenAskAnswer('Density and coverage are excellent.', { question: 'How is the density?', data, facts })).toBe('health_claim');
  });

  test('a pressure claim after a negated clause is still judged', () => {
    const data = pestData({ applications: [], pestPressure: { label: 'Low', trend: 'improving' } });
    const facts = buildReportAskFacts({ data });
    expect(screenAskAnswer('Pest pressure was not low; it was high.', { question: 'Was pressure high?', data, facts })).toBe('pressure_claim');
  });

  test('a grass type must be the recorded one', () => {
    const data = lawnData({ lawnAssessment: { scores: { overallScore: 82 }, turfProfile: { grassType: 'st_augustine' } }, reportV2: { aftercare: {} } });
    const facts = buildReportAskFacts({ data });
    expect(facts.lawn_assessment.grass_type).toBe('st augustine');
    const ask = (answer) => screenAskAnswer(answer, { question: 'Is this Bermuda grass?', data, facts });
    expect(ask('Yes, your lawn is Bermuda grass.')).toBe('grass_type');
    expect(ask('Your lawn is St. Augustine grass.')).toBeNull();
    expect(ask('Your lawn is not Bermuda grass.')).toBeNull();
  });

  test.each(['Yes, we inspected the attic.', 'We sealed the entry points.', 'Yes, the nest was removed.'])('work the report does not record is rejected: %s', (answer) => {
    const data = pestData({ applications: [] });
    expect(screenAskAnswer(answer, { question: 'Did you do that?', data, facts: buildReportAskFacts({ data }) })).toBe('unrecorded_work');
  });

  test('saying the report does not show the work passes', () => {
    const data = pestData({ applications: [] });
    expect(screenAskAnswer('The report does not say the attic was inspected.', { question: 'Did you inspect the attic?', data, facts: buildReportAskFacts({ data }) })).toBeNull();
  });
});

describe('answer screen, Codex round 43', () => {
  test('a pronoun object is an ingestion when the sentence names the product', () => {
    expect(medicalExposureAnswer('John swallowed it after touching the pesticide.')).toBeTruthy();
  });

  test('pests eating bait with an adverb is not an ingestion', () => {
    expect(medicalExposureAnswer('Did the roaches quickly devour the bait?')).toBeNull();
  });

  test('a finding about one dimension does not ground another', () => {
    const data = lawnData({ lawnAssessment: { scores: { overallScore: 92, colorHealth: 20 }, snapshot: { summary: 'Color is poor.', findings: [] } }, reportV2: { aftercare: {} } });
    const facts = buildReportAskFacts({ data });
    const ask = (answer) => screenAskAnswer(answer, { question: 'How is my lawn?', data, facts });
    expect(ask('Your lawn health is poor.')).toBe('health_claim');
    expect(ask('Overall lawn health is poor.')).toBe('health_claim');
    expect(ask('The color is poor.')).toBeNull();
  });

  test('an inspection needs recorded inspection work at that place', () => {
    const data = pestData({ applications: [], findings: [{ customerCopy: 'Ant trail found along the lanai' }] });
    const facts = buildReportAskFacts({ data });
    const ask = (answer) => screenAskAnswer(answer, { question: 'Did you inspect the attic?', data, facts });
    expect(ask('We inspected the attic.')).toBe('unrecorded_work');
    expect(ask('The technician checked under the roof.')).toBe('unrecorded_work');
  });
});

describe('answer screen, Codex round 43 (lines and measurements)', () => {
  test('a fragment of a required line is not exempt', () => {
    const line = 'Run it on your permitted watering day.';
    const data = lawnData({ reportV2: { water: { weekPlan: { ...RAW_PLAN } }, aftercare: { ...HOLD_AFTERCARE } } });
    const facts = buildReportAskFacts({ data });
    expect(screenAskAnswer(`${line} Run it.`, { question: 'Should I water?', data, facts, requiredLines: [line] })).not.toBeNull();
  });

  test('every named measurement must fit the number', () => {
    const data = lawnData({ reportV2: { aftercare: {} } });
    const facts = { lawn_report: { water_this_week: { rain_last_7_days_inches: 1.23, irrigation_inches_per_week: 0.5, total_inches_7_days: 1.73 } } };
    const ask = (answer) => screenAskAnswer(answer, { question: 'How much rain did we get?', data, facts });
    expect(ask('Total rain was 1.73 inches.')).toBe('unstated_number');
    expect(ask('Total rain was 1.23 inches.')).toBeNull();
  });
});

describe('answer screen, Codex round 44', () => {
  test('weather polarity is judged per clause', () => {
    const data = pestData({ applications: [], conditions: { conditions: 'Cloudy', rain_24h_in: 0 } });
    const facts = buildReportAskFacts({ data });
    expect(screenAskAnswer("It wasn't sunny, but it was raining during the visit.", { question: 'What was the weather?', data, facts })).toBe('weather_claim');
  });

  test('a plant health claim takes the Tree & Shrub score', () => {
    const data = { serviceLine: 'tree_shrub', applications: [] };
    const facts = { tree_shrub_report: { plant_health_score_out_of_100: 20, plant_groups: [{ name: 'Hedge', status: 'healthy' }] } };
    expect(screenAskAnswer('Your plants are healthy.', { question: 'How are my plants?', data, facts })).toBe('health_claim');
  });
});

describe('answer screen, Codex round 45', () => {
  const data = pestData({ applications: [{ product: { name: 'Alpine WSG' }, applicationArea: 'Outside' }] });
  const facts = buildReportAskFacts({ question: 'What was applied?', data });
  const ask = (answer) => screenAskAnswer(answer, { question: 'What was applied?', data, facts });

  test.each(['No, Alpine WSG was not applied.', 'Alpine WSG was not used today.', 'Nothing was applied today.'])('a recorded application may not be denied: %s', (answer) => {
    expect(ask(answer)).toBe('denies_application');
  });

  test('the recorded application passes', () => {
    expect(ask('Alpine WSG was applied outside.')).toBeNull();
  });
});

describe('answer screen, Codex round 46', () => {
  test.each(['Alpine WSG was not applied outside.', 'No Alpine WSG was applied to the exterior.'])('a denial of the recorded place is rejected: %s', (answer) => {
    const data = pestData({ applications: [{ product: { name: 'Alpine WSG' }, applicationArea: 'Outside' }] });
    const question = 'Where was it applied?';
    expect(screenAskAnswer(answer, { question, data, facts: buildReportAskFacts({ question, data }) })).toBe('denies_application');
  });

  test('a trend claim must run the recorded way', () => {
    const data = lawnData({ reportV2: { aftercare: {}, trends: { overall: [{ label: 'Aug', value: 80 }, { label: 'Oct', value: 50 }] } } });
    const facts = buildReportAskFacts({ data });
    const ask = (answer) => screenAskAnswer(answer, { question: 'Is my lawn improving?', data, facts });
    expect(ask('Your overall score improved from 50 out of 100 to 80 out of 100.')).toBe('trend_claim');
    expect(ask('Your lawn is improving.')).toBe('trend_claim');
    expect(ask('Your overall score dropped from 80 out of 100 to 50 out of 100.')).toBeNull();
  });
});

describe('answer screen, Codex round 47', () => {
  test('entry while still wet contradicts the drying line', () => {
    const line = 'Keep pets off treated zones until fully dry.';
    const data = pestData({ applications: [] });
    expect(screenAskAnswer(`${line} Pets can enter while the treatment is still wet.`, { question: 'Can my dog go out?', data, facts: { required_lines: [line] }, requiredLines: [line] })).not.toBeNull();
  });

  test('a negative label claim on a question-only pest is rejected', () => {
    const data = pestData({ applications: [{ product: { name: 'Alpine WSG' }, targets: ['ants'] }] });
    const question = 'Does Alpine WSG control termites?';
    const facts = buildReportAskFacts({ question, data });
    expect(screenAskAnswer('Alpine WSG is not labeled for termites.', { question, data, facts })).toBe('target_list');
    expect(screenAskAnswer('The report does not list termites for Alpine WSG.', { question, data, facts })).toBeNull();
  });

  test('a denial of the recorded grass is rejected', () => {
    const data = lawnData({ lawnAssessment: { scores: { overallScore: 82 }, turfProfile: { grassType: 'st_augustine' } }, reportV2: { aftercare: {} } });
    const facts = buildReportAskFacts({ data });
    const ask = (answer) => screenAskAnswer(answer, { question: 'Is this St. Augustine?', data, facts });
    expect(ask('No, this is not St. Augustine grass.')).toBe('grass_type');
    expect(ask('Your lawn is not Bermuda grass.')).toBeNull();
  });

  test.each(['We did not inspect the attic.', 'The technician never checked the attic.', 'No entry points were sealed.'])('a denial of recorded work is rejected: %s', (answer) => {
    const data = pestData({ applications: [], reportSections: [{ title: 'Visit', text: 'We inspected the attic and sealed entry points.' }] });
    expect(screenAskAnswer(answer, { question: 'Did you inspect the attic?', data, facts: buildReportAskFacts({ data }) })).toBe('unrecorded_work');
  });

  test('the service kind must be the recorded one', () => {
    const data = pestData({ applications: [], serviceDisplayName: 'Quarterly Pest Control' });
    const facts = buildReportAskFacts({ data });
    const ask = (answer) => screenAskAnswer(answer, { question: 'Was this a lawn service?', data, facts });
    expect(ask('Yes, this was a lawn service.')).toBe('service_kind');
    expect(ask('This was not a pest service.')).toBe('service_kind');
    expect(ask('This was a pest service.')).toBeNull();
  });

  test('a passive booking question keeps the fixed answer', () => {
    expect(ruleAnswerReason({ serviceLine: 'pest' }, [], 'applied', 'Is another treatment booked?')).toBe('next_visit');
  });
});

describe('answer screen, Codex round 48', () => {
  const data = pestData({
    applications: [{ product: { name: 'Alpine WSG', activeIngredient: 'dinotefuran' }, applicationArea: 'Outside' }],
    findings: [{ title: 'Ant trail', customerCopy: 'Active ant trail along the lanai.' }],
  });
  const question = 'What is in Alpine WSG?';
  const facts = buildReportAskFacts({ question, data });
  const ask = (answer) => screenAskAnswer(answer, { question, data, facts });

  test.each(['Alpine WSG does not contain dinotefuran.', 'Alpine WSG contains no dinotefuran.', 'Dinotefuran is not the active ingredient in Alpine WSG.'])('a recorded ingredient may not be denied: %s', (answer) => {
    expect(ask(answer)).toBe('denies_ingredient');
  });

  test.each(['The report has no findings.', 'There are no findings on the report.', 'Your report lists no findings.'])('recorded findings may not be denied: %s', (answer) => {
    expect(ask(answer)).toBe('denies_findings');
  });

  test('the recorded ingredient passes', () => {
    expect(ask('Alpine WSG contains dinotefuran.')).toBeNull();
  });
});

describe('answer screen, Codex round 49', () => {
  const data = pestData({ applications: [], customerConcern: 'Ants seen in the kitchen.' });
  const question = 'Did I report ants?';
  const facts = buildReportAskFacts({ question, data });
  const ask = (answer) => screenAskAnswer(answer, { question, data, facts });

  test.each(['No, you did not report ants.', 'You did not mention ants in the kitchen.'])('the recorded concern may not be denied: %s', (answer) => {
    expect(ask(answer)).toBe('denies_concern');
  });

  test('the recorded concern passes', () => {
    expect(ask('Yes, you reported ants in the kitchen.')).toBeNull();
  });
});

describe('answer screen, Codex round 50', () => {
  test('a concern is not a finding', () => {
    const data = pestData({ applications: [], customerConcern: 'Ants reported in the kitchen.' });
    const question = 'What did you find?';
    const facts = buildReportAskFacts({ question, data });
    const ask = (answer) => screenAskAnswer(answer, { question, data, facts });
    expect(ask('We found ants in the kitchen.')).toBe('target_list');
    expect(ask('You reported ants in the kitchen.')).toBeNull();
  });
});

describe('answer screen, Codex round 51', () => {
  const tree = {
    serviceLine: 'tree_shrub',
    applications: [],
    reportV2: {
      snapshot: { overallScore: 60 },
      diagnosis: [{ key: 'ganoderma', label: 'Ganoderma conk', status: 'No', explanation: 'No conk observed' }],
      trends: { overall: [{ label: 'Aug', value: 80 }, { label: 'Oct', value: 50 }] },
    },
  };
  const treeFacts = buildReportAskFacts({ data: tree });
  const askTree = (answer) => screenAskAnswer(answer, { question: 'How are my plants?', data: tree, facts: treeFacts });

  test('a diagnosis row recorded as clear may not be affirmed', () => {
    expect(askTree('We detected a Ganoderma conk.')).toBe('diagnosis_claim');
    expect(askTree('No Ganoderma conk was observed.')).toBeNull();
  });

  test('a Tree & Shrub trend claim must run the recorded way', () => {
    expect(askTree('Your plant health improved from 50 out of 100 to 80 out of 100.')).toBe('trend_claim');
  });

  test.each(['We found ants in the attic.', 'Ants were found in the garage.'])('a finding keeps its recorded place: %s', (answer) => {
    const data = pestData({ applications: [], findings: [{ title: 'Ants', detail: 'Ants found in the kitchen.' }] });
    const question = 'What did you find?';
    expect(screenAskAnswer(answer, { question, data, facts: buildReportAskFacts({ question, data }) })).toBe('target_list');
  });

  test.each(['Alpine WSG was poured around the exterior.', 'Alpine WSG was brushed onto the exterior.', 'Alpine WSG was aerosolized outside.'])('a method off the record is rejected: %s', (answer) => {
    const data = pestData({ applications: [{ product: { name: 'Alpine WSG' }, applicationArea: 'Outside', method: 'Sprayed' }] });
    const question = 'How was it applied?';
    expect(screenAskAnswer(answer, { question, data, facts: buildReportAskFacts({ question, data }) })).toBe('method_claim');
  });
});

describe('answer screen, Codex round 52', () => {
  test.each(['Your lawn is not healthy.', 'Your lawn health is not good.'])('a negated verdict against the score is rejected: %s', (answer) => {
    const data = lawnData({ lawnAssessment: { scores: { overallScore: 92 } }, reportV2: { aftercare: {} } });
    expect(screenAskAnswer(answer, { question: 'Is my lawn healthy?', data, facts: buildReportAskFacts({ data }) })).toBe('health_claim');
  });

  test('a Tree & Shrub component claim takes its own score', () => {
    const data = { serviceLine: 'tree_shrub', applications: [], reportV2: { snapshot: { overallScore: 80 }, trends: { foliage: [{ label: 'Aug', value: 60 }, { label: 'Oct', value: 20 }] } } };
    expect(screenAskAnswer('The foliage is excellent.', { question: 'How is the foliage?', data, facts: buildReportAskFacts({ data }) })).toBe('health_claim');
  });

  test('an N-P-K analysis leaves the product name', () => {
    const data = lawnData({ applications: [{ product: { name: 'LESCO 15-0-15' } }, { product: { name: '24-0-11' } }], reportV2: { aftercare: {} } });
    expect(buildReportAskFacts({ question: 'What was applied?', data }).products.map((product) => product.name)).toEqual(['LESCO', 'Fertilizer']);
  });
});

describe('answer screen, pre-push audit on round 52', () => {
  test.each(["We're on our way.", "We're coming soon.", 'We are coming soon.'])('a contracted arrival promise is rejected: %s', (answer) => {
    const data = pestData({ applications: [] });
    expect(screenAskAnswer(answer, { question: 'When are you coming?', data, facts: buildReportAskFacts({ data }) })).toBe('states_a_date');
  });

  test('a diagnosis score is grounded only by its own row', () => {
    const data = { serviceLine: 'tree_shrub', applications: [], reportV2: { snapshot: { overallScore: 80 }, diagnosis: [{ key: 'pest_activity', label: 'Pests', score: 55 }, { key: 'disease', label: 'Disease', score: 100 }] } };
    const facts = buildReportAskFacts({ data });
    const ask = (answer) => screenAskAnswer(answer, { question: 'How are the categories?', data, facts });
    expect(ask('Disease scored 55 out of 100.')).toBe('unstated_number');
    expect(ask('Pests scored 55 out of 100.')).toBeNull();
  });
});

describe('answer screen, Codex round 53', () => {
  test('a named plant group is judged on its own status', () => {
    const data = { serviceLine: 'tree_shrub', applications: [], reportV2: { snapshot: { overallScore: 82 }, plantGroups: [{ label: 'Hibiscus', status: 'needs_attention' }] } };
    expect(screenAskAnswer('The hibiscus plants are healthy.', { question: 'How is the hibiscus?', data, facts: buildReportAskFacts({ data }) })).toBe('health_claim');
  });

  const data = pestData({
    technicianName: 'Alex Rivera',
    pestPressure: { label: 'Low', trend: 'stable' },
    applications: [
      { product: { name: 'Alpine WSG', activeIngredient: 'dinotefuran' }, applicationArea: 'Outside' },
      { product: { name: 'Taurus SC', activeIngredient: 'fipronil' }, applicationArea: 'Outside' },
    ],
  });
  const facts = buildReportAskFacts({ question: 'What did you use?', data });
  const ask = (answer) => screenAskAnswer(answer, { question: 'What did you use?', data, facts });

  test('each named product must hold the ingredient', () => {
    expect(ask('Alpine WSG and Taurus SC contain fipronil.')).toBe('ingredient_claim');
    expect(ask('Taurus SC contains fipronil.')).toBeNull();
  });

  test.each(['Pest pressure was not low.', 'No, the pest pressure was not low.'])('a denial of the recorded pressure is rejected: %s', (answer) => {
    expect(ask(answer)).toBe('pressure_claim');
  });

  test.each(['Alex was not your technician.', 'Your technician was not Alex.', 'Alex did not complete your service.'])('a denial of the recorded technician is rejected: %s', (answer) => {
    expect(ask(answer)).toBe('technician_name');
  });
});

describe('answer screen, pre-push audit on round 53', () => {
  test.each(['Alex swallowed a small amount of pesticide.', 'Alex drank water contaminated with pesticide.'])('a quantity or contaminated thing is an ingestion: %s', (question) => {
    expect(medicalExposureAnswer(question)).toBeTruthy();
  });
});

test('a time or count noun does not borrow a score value (pre-push audit)', () => {
  const data = lawnData({ lawnAssessment: { scores: { overallScore: 82 } }, reportV2: { aftercare: {} } });
  const facts = buildReportAskFacts({ data });
  expect(screenAskAnswer('Lawn health can take 82 days to improve.', { question: 'How long?', data, facts })).toBe('unstated_number');
  expect(screenAskAnswer('Your lawn health score is 82 out of 100.', { question: 'How is it?', data, facts })).toBeNull();
});

test('the spoken-email mask stays fast on hostile input (pre-push audit P0)', () => {
  const started = Date.now();
  for (const text of [`x at ${'adot'.repeat(120)}!`, `x at ${'a dot '.repeat(80)}!`, `${'a.'.repeat(240)} at b`]) {
    buildReportAskFacts({ data: { serviceLine: 'pest', applications: [], customerConcern: text } });
  }
  expect(Date.now() - started).toBeLessThan(1000);
});

test('swallowing sprayed material gets the medical answer (pre-push audit)', () => {
  expect(medicalExposureAnswer('Alex swallowed the liquid you sprayed.')).toBeTruthy();
  expect(medicalExposureAnswer('My dog licked the treated grass.')).toBeTruthy();
});

test('a prose number keeps its measurement (pre-push audit)', () => {
  const data = lawnData({ reportV2: { aftercare: {} } });
  const facts = { report_sections: [{ title: 'Visit', text: 'Mowing height was 4 inches.' }] };
  expect(screenAskAnswer('Rain was 4 inches this week.', { question: 'How much rain?', data, facts })).toBe('unstated_number');
  expect(screenAskAnswer('The mowing height was 4 inches.', { question: 'How high?', data, facts })).toBeNull();
});

describe('answer screen, Codex round 54', () => {
  test('a scored diagnosis card keeps its polarity', () => {
    const data = { serviceLine: 'tree_shrub', applications: [], reportV2: { snapshot: { overallScore: 80 }, diagnosis: [{ key: 'disease', label: 'Disease / Leaf Spot Signals', score: 95, status: 'strong', explanation: 'No leaf spot signals were visible.' }] } };
    const facts = buildReportAskFacts({ data });
    const ask = (answer) => screenAskAnswer(answer, { question: 'Any disease?', data, facts });
    expect(ask('Disease and leaf-spot signals were present.')).toBe('diagnosis_claim');
    expect(ask('Leaf spot signals scored 95 out of 100.')).toBeNull();
  });

  const lawn = lawnData({
    reportV2: {
      aftercare: {},
      trends: { overall: [{ label: 'Aug', value: 50 }, { label: 'Oct', value: 80 }] },
      water: { status: 'deficit', totalInches: 0.5, targetInches: 1, explanation: 'Short on water.' },
      mowing: { measuredHeightInches: 5, idealMinInches: 3.5, idealMaxInches: 4, status: 'too_tall' },
    },
  });
  const lawnFacts = buildReportAskFacts({ data: lawn });
  const askLawn = (answer) => screenAskAnswer(answer, { question: 'How is my lawn?', data: lawn, facts: lawnFacts });

  test.each(['Your lawn has not improved.', 'Your lawn did not get better.'])('a negated trend claim is judged the other way: %s', (answer) => {
    expect(askLawn(answer)).toBe('trend_claim');
  });

  test.each(['Yes, your lawn received enough water this week.', 'The lawn received more water than it needed.', 'The lawn was cut too short.', 'The mowing height was ideal.'])('a water or mowing verdict must fit the status: %s', (answer) => {
    expect(askLawn(answer)).toBe('lawn_status_claim');
  });

  test('verdicts that fit the status pass', () => {
    expect(askLawn('The lawn did not get enough water this week.')).toBeNull();
    expect(askLawn('The grass is too tall.')).toBeNull();
  });

  test('a negated pressure direction is judged against the trend', () => {
    const data = pestData({ applications: [], pestPressure: { label: 'Low', trend: 'improving' } });
    expect(screenAskAnswer('Pest pressure has not improved.', { question: 'Is it better?', data, facts: buildReportAskFacts({ data }) })).toBe('pressure_claim');
  });
});

describe('answer screen, Codex round 55', () => {
  test.each(['The product was Roundup.', 'Roundup was the product.'])('a product identity off the record is rejected: %s', (answer) => {
    const data = pestData({ applications: [{ product: { name: 'Alpine WSG' }, applicationArea: 'Outside' }] });
    const question = 'What product was used?';
    expect(screenAskAnswer(answer, { question, data, facts: buildReportAskFacts({ question, data }) })).toBe('unrecorded_product');
  });

  test('a Lawn diagnosis row keeps its status', () => {
    const data = lawnData({ reportV2: { aftercare: {}, diagnosis: [{ key: 'turf_density', label: 'Turf density', score: 90, status: 'strong', explanation: 'Thick turf.' }] } });
    const facts = buildReportAskFacts({ data });
    const ask = (answer) => screenAskAnswer(answer, { question: 'Does my turf density need attention?', data, facts });
    expect(ask('Yes, your turf density needs attention.')).toBe('diagnosis_claim');
    expect(ask('Your turf density is strong.')).toBeNull();
  });

  test.each(['The gate opens with 12-34', 'Door code 4-5-6-7'])('a split access code is masked: %s', (concern) => {
    const facts = buildReportAskFacts({ data: { serviceLine: 'pest', applications: [], customerConcern: `${concern}, ants by the pool` } });
    expect(facts.customer_concern).not.toMatch(/\d/);
  });
});

describe('answer screen, Codex round 56', () => {
  test('swallowing something from a treated surface gets the medical answer', () => {
    expect(medicalExposureAnswer('John swallowed something from the treated floor after the pesticide was sprayed.')).toBeTruthy();
  });

  test('a word credential after an opening phrase is masked and never repeated', () => {
    const data = lawnData({ customerConcern: 'The side gate opens with SUNSET, ants by the pool', reportV2: { aftercare: {} } });
    const facts = buildReportAskFacts({ data });
    expect(facts.customer_concern).toBe('The side gate opens with [redacted], ants by the pool');
    expect(screenAskAnswer('The side gate opens with SUNSET.', { question: 'q', data, facts })).toBe('access_phrase');
  });
});

test('the drying guidance exempts only its own clause (pre-push audit)', () => {
  const data = lawnData({ reportV2: { aftercare: {} } });
  const facts = buildReportAskFacts({ data });
  expect(screenAskAnswer('Keep pets off treated areas until dry and water the lawn daily.', { question: 'q', data, facts })).toBe('own_instruction');
  expect(screenAskAnswer('Keep kids and pets off treated areas until dry.', { question: 'q', data, facts })).toBeNull();
});

describe('answer screen, Codex round 57', () => {
  test('a multiword credential is masked whole', () => {
    const facts = buildReportAskFacts({ data: { serviceLine: 'pest', applications: [], customerConcern: 'The gate opens with BLUE MOON and ants by the pool' } });
    expect(facts.customer_concern).toBe('The gate opens with [redacted] and ants by the pool');
  });

  test('the water gap improves toward zero', () => {
    const data = lawnData({ reportV2: { aftercare: {}, trends: { waterGap: [{ label: 'Aug', value: 1 }, { label: 'Oct', value: 0.2 }] } } });
    const facts = buildReportAskFacts({ data });
    expect(screenAskAnswer('The water gap got worse.', { question: 'q', data, facts })).toBe('trend_claim');
    expect(screenAskAnswer('The water gap improved.', { question: 'q', data, facts })).toBeNull();
  });

  test.each(['Was Roundup the product?', 'Did you put Roundup down?'])('a product identity question keeps the fixed answer: %s', (question) => {
    expect(ruleAnswerReason(pestData({ applications: [{ product: { name: 'Alpine WSG' } }] }), [], 'unrouted', question)).toBe('unrecorded_product');
  });

  test('serviced areas ground coverage answers', () => {
    const data = pestData({ applications: [], areasServiced: ['Garage', 'Exterior perimeter'] });
    const facts = buildReportAskFacts({ data });
    const ask = (answer) => screenAskAnswer(answer, { question: 'Did you do the garage?', data, facts });
    expect(facts.areas_serviced).toEqual(['Garage', 'Exterior perimeter']);
    expect(ask('The garage was not serviced.')).toBe('unrecorded_work');
    expect(ask('We did not inspect the garage.')).toBe('unrecorded_work');
    expect(ask('We inspected the garage.')).toBeNull();
  });

  test.each(['Can I mow now?', 'Is it necessary to fertilize?'])('a care-permission question keeps the fixed answer: %s', (question) => {
    expect(ruleAnswerReason(lawnData(), [], 'unrouted', question)).toBe('next_steps');
  });
});

describe('answer screen, Codex round 58', () => {
  test.each(['The shrubs received enough water this week.', 'The landscape was overwatered.'])('a Tree & Shrub water verdict must fit the card: %s', (answer) => {
    const data = { serviceLine: 'tree_shrub', applications: [], reportV2: { snapshot: { overallScore: 80 }, water: { status: 'deficit', explanation: 'Beds are dry.' } } };
    expect(screenAskAnswer(answer, { question: 'q', data, facts: buildReportAskFacts({ data }) })).toBe('lawn_status_claim');
  });

  test.each([['surplus', 'There was no excess water.'], ['deficit', 'There was no water deficit.']])('a negated water verdict on %s is rejected', (status, answer) => {
    const data = lawnData({ reportV2: { aftercare: {}, water: { status, explanation: 'Water card.' } } });
    expect(screenAskAnswer(answer, { question: 'q', data, facts: buildReportAskFacts({ data }) })).toBe('lawn_status_claim');
  });

  test('a copular care permission is rejected', () => {
    const data = lawnData({ reportV2: { aftercare: {} } });
    expect(screenAskAnswer('Mowing now is fine.', { question: 'q', data, facts: buildReportAskFacts({ data }) })).toBe('own_instruction');
  });

  test('a fourth finding reaches the facts and may not be denied', () => {
    const data = pestData({ applications: [], findings: [1, 2, 3, 4].map((i) => ({ title: i === 4 ? 'Termite tubes' : `Ant trail ${i}`, detail: '' })) });
    const question = 'Did you find termite tubes?';
    const facts = buildReportAskFacts({ question, data });
    expect(facts.findings).toHaveLength(4);
    expect(screenAskAnswer('The report does not show termite tubes.', { question, data, facts })).toBe('denies_findings');
  });
});

describe('answer screen, Codex round 59', () => {
  test.each([
    'John swallowed grass from the lawn after pesticide was sprayed there.',
    'My cat got pesticide on its paws and licked them. What should I do?',
  ])('treated-surface and grooming ingestion get the medical answer: %s', (question) => {
    expect(medicalExposureAnswer(question)).toBeTruthy();
  });

  test.each(['Did the roaches quickly devour the bait?', 'Was the bait eaten?', 'Mosquitoes bit me after the spray.'])('no person eating is no ingestion: %s', (question) => {
    expect(medicalExposureAnswer(question)).toBeNull();
  });

  test('a re-entry question keeps the fixed answer', () => {
    expect(ruleAnswerReason(pestData(), [], 'reentry', 'Can my dog go out?')).toBe('reentry');
  });

  test('a long credential is masked whole, and a stated gate word too', () => {
    const facts = buildReportAskFacts({ data: { serviceLine: 'pest', applications: [], customerConcern: 'The gate opens with BLUE MOON SECRET WORD ALPHA, ants by the pool. Gate word is ZEBRA.' } });
    expect(facts.customer_concern).toBe('The gate opens with [redacted], ants by the pool. Gate word is [redacted].');
  });

  test('temperature and wind words must fit the readings', () => {
    const data = lawnData({ conditions: { conditions: 'Sunny', temp_f: 95, wind_mph: 20, rain_24h_in: 0 }, reportV2: { aftercare: {} } });
    const facts = buildReportAskFacts({ data });
    const ask = (answer) => screenAskAnswer(answer, { question: 'What was the weather?', data, facts });
    expect(ask('It was freezing during the visit.')).toBe('weather_claim');
    expect(ask('It was calm during the visit.')).toBe('weather_claim');
    expect(ask('It was hot and windy during the visit.')).toBeNull();
  });

  test('each finding keeps its own place', () => {
    const data = pestData({ applications: [], findings: [{ title: 'Ant activity', detail: 'Observed in the kitchen' }, { title: 'Spider activity', detail: 'Observed in the attic' }] });
    const question = 'What did you find?';
    const facts = buildReportAskFacts({ question, data });
    const ask = (answer) => screenAskAnswer(answer, { question, data, facts });
    expect(ask('We found ants in the attic.')).toBe('target_list');
    expect(ask('We found spiders in the kitchen.')).toBe('target_list');
    expect(ask('We found ants in the kitchen.')).toBeNull();
  });

  test.each(['This was pest control.', 'Today was for tree and shrub care.'])('a service kind without a service noun is judged: %s', (answer) => {
    const data = lawnData({ serviceDisplayName: 'Lawn Care', reportV2: { aftercare: {} } });
    expect(screenAskAnswer(answer, { question: 'What service was this?', data, facts: buildReportAskFacts({ data }) })).toBe('service_kind');
  });
});

// Reversed from round 37 on Codex security P1 #5964 r59: an eating verb and a
// product word with a person in one sentence fail safe to the medical answer.
test.each(['My kids snacked outside after the spray dried. Is that okay?', 'The kids snacked on chips after the treatment dried.'])('eating near a product word fails safe: %s', (question) => {
  expect(medicalExposureAnswer(question)).toBeTruthy();
});

test('"one hundred" is read as 100, not "one" (pre-push audit)', () => {
  const data = lawnData({ lawnAssessment: { scores: { overallScore: 82 } }, reportV2: { aftercare: {} } });
  const facts = buildReportAskFacts({ data });
  expect(screenAskAnswer('Your overall score is one hundred out of 100.', { question: 'q', data, facts })).toBe('unstated_number');
  expect(screenAskAnswer('Your overall score is eighty-two out of 100.', { question: 'q', data, facts })).toBeNull();
});

describe('answer screen, Codex round 60', () => {
  const lawn = lawnData({
    conditions: { conditions: 'Sunny', temp_f: 95, wind_mph: 20, humidity_pct: 85, rain_24h_in: 0 },
    reportV2: { aftercare: {}, mowing: { measuredHeightInches: 5, idealMinInches: 3.5, idealMaxInches: 4, status: 'too_tall' } },
  });
  const lawnFacts = buildReportAskFacts({ data: lawn });
  const askLawn = (answer) => screenAskAnswer(answer, { question: 'q', data: lawn, facts: lawnFacts });

  test.each(['It was not hot during the visit.', 'It was not humid during the visit.', 'It was not windy during the visit.'])('a negated reading is judged the other way: %s', (answer) => {
    expect(askLawn(answer)).toBe('weather_claim');
  });

  test.each(['The lawn was not too tall.', 'The lawn was not overgrown.'])('a negated mowing verdict is judged the other way: %s', (answer) => {
    expect(askLawn(answer)).toBe('lawn_status_claim');
  });

  const tree = {
    serviceLine: 'tree_shrub',
    applications: [],
    reportV2: {
      snapshot: { overallScore: 80 },
      water: { rainInches: 0.4, irrigationInches: 0.6, totalInches: 1, explanation: 'Balanced.', status: 'balanced' },
      plantGroups: Array.from({ length: 8 }, (_, i) => ({ label: i === 6 ? 'Groundcover beds' : `Hedge ${i}`, status: 'healthy' })),
    },
  };
  const treeFacts = buildReportAskFacts({ data: tree });

  test('every plant group reaches the facts and may not be denied', () => {
    expect(treeFacts.tree_shrub_report.plant_groups).toHaveLength(8);
    expect(screenAskAnswer('The report does not list groundcover beds.', { question: 'q', data: tree, facts: treeFacts })).toBe('denies_findings');
  });

  test('the landscape water total is on the sheet', () => {
    expect(treeFacts.tree_shrub_report.water.total_inches).toBe(1);
    expect(screenAskAnswer('The landscape received 1 inch of total water.', { question: 'q', data: tree, facts: treeFacts })).toBeNull();
  });

  test('a credential before the access verb is masked and never repeated', () => {
    const facts = buildReportAskFacts({ data: { serviceLine: 'pest', applications: [], customerConcern: 'Use BLUE MOON to unlock the side gate. Ants by the pool.' } });
    expect(facts.customer_concern).toBe('Use [redacted] to unlock the side gate. Ants by the pool.');
    expect(screenAskAnswer('Enter BLUE MOON at the gate.', { question: 'q', data: pestData({ applications: [] }), facts })).toBe('access_phrase');
  });
});

test('a pet eating wins over a pest elsewhere in the sentence (pre-push audit)', () => {
  expect(medicalExposureAnswer('My dog took a bite of bait that was gnawed by rats.')).toBeTruthy();
  expect(medicalExposureAnswer('Did the roaches quickly devour the bait?')).toBeNull();
});

describe('answer screen, Codex round 61', () => {
  test('a verb-device-value credential is masked and never repeated', () => {
    const facts = buildReportAskFacts({ data: { serviceLine: 'pest', applications: [], customerConcern: 'Unlock the side gate with BLUE MOON. Ants by the pool.' } });
    expect(facts.customer_concern).toBe('Unlock the side gate with [redacted]. Ants by the pool.');
    expect(screenAskAnswer('Unlock the side gate with BLUE MOON.', { question: 'q', data: pestData({ applications: [] }), facts })).toBe('access_phrase');
  });

  test('the Tree & Shrub technician paragraph is on the sheet and may not be denied', () => {
    const data = { serviceLine: 'tree_shrub', applications: [], reportV2: { snapshot: { overallScore: 80 }, techParagraph: 'We observed scale insects on the hibiscus.' } };
    const question = 'Did you find scale insects?';
    const facts = buildReportAskFacts({ question, data });
    expect(facts.tree_shrub_report.tech_paragraph).toBe('We observed scale insects on the hibiscus.');
    expect(screenAskAnswer('The report does not mention scale insects.', { question, data, facts })).toBe('denies_recorded_term');
    expect(screenAskAnswer('We observed scale insects on the hibiscus.', { question, data, facts })).toBeNull();
  });
});

test.each([['low', 'The lawn received enough water this week.'], ['high', 'The lawn did not get enough water this week.']])('the lawn card status %s is read as the builder writes it (pre-push audit)', (status, answer) => {
  const data = lawnData({ reportV2: { aftercare: {}, water: { status, explanation: 'Water card.' } } });
  expect(screenAskAnswer(answer, { question: 'q', data, facts: buildReportAskFacts({ data }) })).toBe('lawn_status_claim');
});

describe('answer screen, Codex round 62', () => {
  const lawn = lawnData({ reportV2: null, lawnAssessment: { scores: { overallScore: 80 }, waterContext: { rainfallInches7d: 3.27, targetInchesPerWeek: 1 } } });
  const facts = buildReportAskFacts({ data: lawn });
  const ask = (answer) => screenAskAnswer(answer, { question: 'How much rain did we get?', data: lawn, facts });

  test('a legacy lawn water card reaches the facts', () => {
    expect(facts.lawn_assessment.water_this_week).toMatchObject({ rain_last_7_days_inches: 3.27, target_inches_per_week: 1 });
    expect(ask('You received 3.27 inches of rain this week.')).toBeNull();
  });

  test('a recorded measurement may not be called missing', () => {
    expect(ask('The report does not show weekly rainfall.')).toBe('denies_recorded_term');
  });

  test("a possessive technician name must be the recorded one", () => {
    const data = pestData({ applications: [], technicianName: 'Alex Rivera' });
    const pf = buildReportAskFacts({ data });
    expect(screenAskAnswer("Your technician's name is Jordan.", { question: 'Who was my technician?', data, facts: pf })).toBe('technician_name');
    expect(screenAskAnswer("Your technician's name is Alex.", { question: 'Who was my technician?', data, facts: pf })).toBeNull();
  });
});

describe('answer screen, Codex round 63', () => {
  test('photo and watering questions keep the fixed answer', () => {
    expect(ruleAnswerReason(lawnData(), [], 'results', 'What did the photos show?')).toBe('photos');
    expect(ruleAnswerReason(lawnData(), [], 'watering', 'Can I turn my sprinklers back on?')).toBe('watering');
  });

  test('a grass identity must be the recorded one, listed name or not', () => {
    const data = lawnData({ lawnAssessment: { scores: { overallScore: 82 }, turfProfile: { grassType: 'st_augustine', cultivar: 'Floratam' } }, reportV2: { aftercare: {} } });
    const facts = buildReportAskFacts({ data });
    const ask = (answer) => screenAskAnswer(answer, { question: 'What is my grass type?', data, facts });
    expect(ask('Your grass is CitraBlue.')).toBe('grass_type');
    expect(ask('Your grass is St. Augustine Floratam.')).toBeNull();
  });
});

test('a trend starting point grounds only a past claim (pre-push audit)', () => {
  const data = lawnData({ lawnAssessment: { scores: { overallScore: 82 } }, reportV2: { aftercare: {}, trends: { overall: [{ label: 'Aug', value: 50 }, { label: 'Oct', value: 82 }] } } });
  const facts = buildReportAskFacts({ data });
  expect(screenAskAnswer('Your current overall score is 50 out of 100.', { question: 'q', data, facts })).toBe('unstated_number');
  expect(screenAskAnswer('Your overall score went from 50 out of 100 to 82 out of 100.', { question: 'q', data, facts })).toBeNull();
});

describe('answer screen, Codex round 64', () => {
  test('every insight field the card renders is on the sheet', () => {
    const data = { serviceLine: 'tree_shrub', applications: [], reportV2: { snapshot: { overallScore: 80 }, insights: [{ headline: 'Scale', whatWeSaw: 'Scale on hedge.', wavesAction: 'We applied horticultural oil.', whyItMatters: 'Weakens plants.' }] } };
    expect(buildReportAskFacts({ data }).tree_shrub_report.insights[0]).toMatchObject({ waves_action: 'We applied horticultural oil.', why_it_matters: 'Weakens plants.' });
  });

  const data = pestData({ applications: [{ product: { name: 'Alpine WSG' }, applicationArea: 'Outside', method: 'Sprayed' }] });
  const question = 'How was Alpine WSG applied?';
  const facts = buildReportAskFacts({ question, data });
  const ask = (answer) => screenAskAnswer(answer, { question, data, facts });

  test.each(['No, Alpine WSG was not one of the products.', 'Alpine WSG was not part of today’s treatment.'])('a recorded product may not be denied as a member: %s', (answer) => {
    expect(ask(answer)).toBe('denies_application');
  });

  test.each(['The application area was the kitchen.', 'The location was inside the home.'])('a direct location must fit the record: %s', (answer) => {
    expect(ask(answer)).toBe('scope_claim');
  });

  test.each(['The method was injection.', 'It was poured around the perimeter.'])('a noun or pronoun method must fit the record: %s', (answer) => {
    expect(ask(answer)).toBe('method_claim');
  });

  test('the recorded method passes', () => {
    expect(ask('It was sprayed around the outside.')).toBeNull();
  });

  test.each(['I noticed the bait was eaten.', 'We found the bait was eaten.'])('bait taken with no person eating is no exposure: %s', (question) => {
    expect(medicalExposureAnswer(question)).toBeNull();
  });
});

test('an ideal value grounds only an ideal claim (pre-push audit)', () => {
  const data = lawnData({ reportV2: { aftercare: {}, mowing: { measuredHeightInches: 3, idealMinInches: 3.5, idealMaxInches: 4, status: 'too_short' } } });
  const facts = buildReportAskFacts({ data });
  expect(screenAskAnswer('The measured mowing height was 4 inches.', { question: 'q', data, facts })).toBe('unstated_number');
  expect(screenAskAnswer('The mower is at 3 inches, and the ideal range is 3.5 to 4 inches.', { question: 'q', data, facts })).toBeNull();
});

describe('answer screen, Codex round 65', () => {
  const lawn = lawnData({ reportV2: { aftercare: {}, banner: { mowHold: { line: 'Wait 3 days before mowing so the product can work.' } }, trends: { overall: [{ label: 'Jun', value: 60 }, { label: 'Aug', value: 65 }, { label: 'Oct', value: 80 }] } } });
  const facts = buildReportAskFacts({ data: lawn });
  const ask = (answer) => screenAskAnswer(answer, { question: 'q', data: lawn, facts });

  test('a displayed mowing hold is on the sheet, may not be denied, and keeps mowing questions fixed', () => {
    expect(facts.lawn_report.mowing_hold).toBe('Wait 3 days before mowing so the product can work.');
    expect(ask('The report does not mention a mowing hold.')).toBe('denies_recorded_term');
    expect(ruleAnswerReason(lawn, [], 'unrouted', 'What does the mowing banner say?')).toBe('mow_hold');
  });

  test('every trend reading is on the sheet as a past reading', () => {
    expect(facts.lawn_report.trends.overall_out_of_100.readings).toEqual([{ month: 'Aug', value: 65 }]);
    expect(ask('The middle overall reading was 65 out of 100.')).toBeNull();
    expect(ask('Your overall score is 65 out of 100.')).toBe('unstated_number');
  });
});

describe('answer screen, Codex round 66', () => {
  test('product wording is not evidence of a visit finding', () => {
    const data = pestData({ applications: [{ product: { name: 'Alpine WSG', report_copy: { how_it_works: 'Alpine WSG slows ants and roaches at entry points.' } }, applicationArea: 'Outside' }] });
    const question = 'What did you find?';
    const facts = buildReportAskFacts({ question, data });
    const ask = (answer) => screenAskAnswer(answer, { question, data, facts });
    expect(ask('We found ants during the visit.')).toBe('target_list');
    expect(ask('The technician observed roaches at the entry points.')).toBe('target_list');
    expect(ask('Alpine WSG slows ants and roaches at entry points.')).toBeNull();
  });
});

test('serviced areas come from the payload field serviceAreas (pre-push audit)', () => {
  const data = pestData({ applications: [], serviceAreas: ['Garage', 'Exterior perimeter'] });
  const facts = buildReportAskFacts({ data });
  expect(facts.areas_serviced).toEqual(['Garage', 'Exterior perimeter']);
  expect(screenAskAnswer('The garage was not serviced.', { question: 'Was the garage serviced?', data, facts })).toBe('unrecorded_work');
});
