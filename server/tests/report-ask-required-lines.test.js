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
      expect(text).toContain('[address]');
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
      expect(ask('We saw some scale signals on the hedge.', facts)).toBeNull();
      expect(ask('We saw some scale signals on the hedge.', {})).toBe('target_list');
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

  test('while the aftercare holds watering, a recommendation that changes watering is not carried', () => {
    const recommendations = ['Increase irrigation to twice this week.', { text: 'Mow at 3.5 inches.' }];
    const facts = buildReportAskFacts({ data: lawnData({ recommendations }) });
    expect(JSON.stringify(facts)).not.toMatch(/irrigation/);
    expect(facts.recommendations).toEqual(['Mow at 3.5 inches.']);
    const free = lawnData({ reportV2: { water: { weekPlan: null }, aftercare: {} }, recommendations });
    expect(buildReportAskFacts({ data: free }).recommendations).toHaveLength(2);
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
    const out = await answerReportQuestionWithAI({ question: 'What did you do?', data: pestData() }, { callModel });
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
