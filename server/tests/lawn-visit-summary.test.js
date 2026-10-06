// PROTOTYPE ONLY. Lawn Visit Summary writer (GATE_LAWN_VISIT_SUMMARY_V2): the facts
// builder, the prompt's grounding, the code-side validator, the one model call (never
// a real one: every call is injected or mocked), the first-writer-wins freeze and the
// report-side read. Synthetic data only.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));

const { dispatchWithFallback } = require('../services/llm/call');
const summary = require('../services/service-report/lawn-visit-summary');
const { gatherVisitSummaryFacts, wateringFacts, seasonOf, recentRainOf } = require('../services/service-report/lawn-visit-summary-inputs');

const { splitSentences } = require('../services/service-report/next-visit-claims');
const sourcesFor = (text, from = ['applied']) => splitSentences(text).map((sentence) => ({ sentence, from }));
const answer = (text) => ({ summary: text, sources: sourcesFor(text) });

const RAW = {
  season: 'fall',
  programLine: 'In October the program focuses on the fall feeding with a pre-emergent weed barrier where it fits the property, plus spot treatment for large patch, grubs and weeds where needed.',
  applied: [
    { name: 'Arena 50 WDG', activeIngredient: 'clothianidin', kind: 'insecticide', method: 'spray' },
    { name: 'LESCO 24-0-11', kind: 'fertilizer', method: 'granular' },
    { name: 'Prodiamine 65 WDG', activeIngredient: 'prodiamine', kind: 'pre_emergent', method: 'granular' },
  ],
  findings: [
    { label: 'weed pressure', confidence: 'moderate' },
    { label: 'thinning turf', confidence: 'low' },
  ],
  areas: [
    { label: 'Turf Density', status: 'watch' },
    { label: 'Weed Pressure', status: 'watch' },
    { label: 'Color & Vigor', status: 'healthy' },
  ],
  headline: 'Your lawn is in good shape',
  watering: { state: 'water_in', inches: 0.5, hours: 24 },
  recentRain: false,
  watchNext: ['weeds', 'stressed areas'],
  technicianNote: 'Front yard has some thin spots by the driveway. Put the fall feeding down.',
  knownProductNames: ['Arena 50 WDG', 'LESCO 24-0-11', 'Prodiamine 65 WDG', 'Celsius WG', 'Talstar P'],
};
const FACTS = summary.normalizeFacts(RAW);

const GOOD = 'Today we put down a fall feeding along with a pre-emergent weed barrier, which fits the season. '
  + 'The photo read showed some weed pressure in the lawn, and we are keeping an eye on a few thin spots near the driveway. '
  + 'Feedings like this build gradually, so color and thickness improve a little at a time rather than all at once. '
  + 'Please water the treated lawn in with 0.5 inches within 24 hours so the feeding reaches the roots. '
  + 'At the next visit we will look at the weeds and the thin areas again.';

const check = (text, facts = FACTS) => summary.validateSummary(answer(text), facts);
const problems = (text, facts) => check(text, facts).problems;

describe('facts builder', () => {
  test('applied products become plain categories; names stay in the facts for the validator only', () => {
    expect(FACTS.applied.map((p) => p.category)).toEqual(['insect control', 'a feeding', 'a pre-emergent weed barrier']);
    expect(FACTS.applied[0]).toMatchObject({ name: 'Arena 50 WDG', method: 'liquid' });
  });

  test('two products of one kind and method collapse into one category line', () => {
    const f = summary.normalizeFacts({ applied: [{ name: 'A', kind: 'fertilizer', method: 'granular' }, { name: 'B', kind: 'fertilizer', method: 'granular' }] });
    expect(f.applied).toHaveLength(1);
  });

  test('a half-known water-in step (no hours) is dropped, never guessed', () => {
    expect(summary.normalizeFacts({ watering: { state: 'water_in', inches: 0.5 } }).watering).toBeNull();
    expect(summary.normalizeFacts({ watering: { state: 'bogus' } }).watering).toBeNull();
    expect(summary.normalizeFacts({ watering: { state: 'hold' } }).watering).toEqual({ state: 'hold', inches: null, hours: null });
  });

  test('wateringFacts: inches from the frozen instruction, hours from the catalog rule, never longer than the frozen deadline', () => {
    const rows = [{ name: 'LESCO 24-0-11', post_application_watering: { mode: 'water_in', water_in_inches: 0.5, water_in_by_hours: 24, source: 'label' } }];
    const instruction = { state: 'water_in', waterInInches: 0.5, completedAt: '2026-10-06T14:40:00Z', waterInBy: '2026-10-07T14:00:00Z' };
    expect(wateringFacts(instruction, rows)).toEqual({ state: 'water_in', inches: 0.5, hours: 24 });
    // A same-day cap shortens the window: the paragraph asks for the shorter one.
    expect(wateringFacts({ ...instruction, waterInBy: '2026-10-06T23:00:00Z' }, rows)).toEqual({ state: 'water_in', inches: 0.5, hours: 9 });
    expect(wateringFacts({ state: 'hold' }, rows)).toEqual({ state: 'hold' });
    expect(wateringFacts({ state: null }, rows)).toBeNull();
    expect(wateringFacts(null, rows)).toBeNull();
  });

  test('season and rain helpers', () => {
    expect(seasonOf(10)).toBe('fall');
    expect(seasonOf(7)).toBe('summer');
    expect(seasonOf(null)).toBeNull();
    expect(recentRainOf({ conditions: { rain_24h_in: 0.4 } })).toBe(true);
    expect(recentRainOf({ conditions: '{"rain_24h_in":0}' })).toBe(false);
    expect(recentRainOf({ conditions: null })).toBeNull();
  });

  describe('gatherVisitSummaryFacts reads the report data the render uses', () => {
    const fakeKnex = ({ catalog = RAW.knownProductNames.map((name) => ({ name })), rules = [] } = {}) => {
      const knex = (table) => {
        const q = { ids: null };
        q.where = (c) => { q.criteria = c; return q; };
        q.whereIn = (_col, names) => { q.names = names; return q; };
        q.first = async () => {
          if (table === 'lawn_assessments') return { id: 77, customer_id: 9, confirmed_by_tech: true };
          if (table === 'lawn_assessment_runs') {
            return { assessment_id: 77, customer_id: 9, reviewed_at: '2026-10-06T10:00:00Z', reviewed_findings: [{ label: 'weed pressure', confidence: 'moderate', keep: true }, { label: 'thinning turf', confidence: 'low', keep: true }], added_details: [] };
          }
          return null;
        };
        q.select = async (col) => (q.names ? rules.filter((r) => q.names.includes(r.name)) : (col === 'name' ? catalog : []));
        return q;
      };
      return knex;
    };
    const DATA = {
      lawnAssessment: { assessmentId: 77 },
      reportV2: {
        snapshot: { statusHeadline: 'Your lawn is in good shape', seasonalNote: RAW.programLine, seasonalNoteSource: 'program', overallScore: 91 },
        diagnosis: [{ label: 'Turf Density', score: 62, status: 'watch' }, { label: 'Color & Vigor', score: 88, status: 'strong' }],
        insights: [{ category: 'weeds', status: 'watch' }, { category: 'water', status: 'watch' }, { category: 'mowing', status: 'healthy' }],
        treatment: { products: [
          { name: 'LESCO 24-0-11', activeIngredient: 'nitrogen', kind: 'fertilizer', method: 'granular', targets: [] },
          { name: 'Wetting Agent', kind: 'other', activeIngredient: 'surfactant blend' },
        ] },
      },
    };
    const RECORD = { id: 's1', technician_notes: 'Thin spots by the driveway.', service_date: '2026-10-06', conditions: { rain_24h_in: 0 } };

    test('builds the grounded facts: program line, categories, kept findings, areas, watch list, rain, watering', async () => {
      const rules = [{ name: 'LESCO 24-0-11', category: 'fertilizer', post_application_watering: { mode: 'water_in', water_in_inches: 0.5, water_in_by_hours: 24, source: 'label' } }];
      const instruction = { state: 'water_in', waterInInches: 0.5, completedAt: '2026-10-06T14:00:00Z', waterInBy: '2026-10-07T14:00:00Z' };
      const facts = await gatherVisitSummaryFacts({ record: RECORD, data: DATA, instruction, knex: fakeKnex({ rules }) });
      expect(facts).toMatchObject({
        season: 'fall',
        programLine: RAW.programLine,
        applied: [{ kind: 'fertilizer', category: 'a feeding', method: 'granular' }],
        findings: [{ label: 'weed pressure', confidence: 'moderate' }, { label: 'thinning turf', confidence: 'low' }],
        areas: [{ label: 'Turf Density', status: 'watch' }, { label: 'Color & Vigor', status: 'strong' }],
        watering: { state: 'water_in', inches: 0.5, hours: 24 },
        recentRain: false,
        watchNext: ['weeds', 'weed pressure', 'thinning turf'],
      });
      expect(facts.knownProductNames).toContain('Celsius WG');
    });

    test('no confirmed assessment id or a degraded report read: no facts, so no summary', async () => {
      expect(await gatherVisitSummaryFacts({ record: RECORD, data: { reportV2: DATA.reportV2 }, knex: fakeKnex() })).toBeNull();
      expect(await gatherVisitSummaryFacts({ record: RECORD, data: { ...DATA, lawnAssessment: { assessmentId: 77, lawnCopyV6Unfrozen: true } }, knex: fakeKnex() })).toBeNull();
    });

    test('a read that throws propagates (the caller stores nothing)', async () => {
      const boom = () => { throw new Error('read failed'); };
      await expect(gatherVisitSummaryFacts({ record: RECORD, data: DATA, knex: boom })).rejects.toThrow('read failed');
    });
  });
});

describe('prompt grounding', () => {
  const prompt = summary.buildPrompt(FACTS);

  test('the user message carries every labeled fact', () => {
    for (const label of ['SEASON: fall', 'PROGRAM LINE', 'WHAT WE APPLIED', 'PHOTO FINDINGS THE TECHNICIAN KEPT', 'AREAS OF THE LAWN', 'REPORT HEADLINE', 'WATERING STEP', 'RECENT RAIN', 'WE WILL LOOK AT', 'TECHNICIAN NOTE']) {
      expect(prompt.text).toContain(label);
    }
    expect(prompt.text).toContain('- a feeding (granular)');
    expect(prompt.text).toContain('- a pre-emergent weed barrier (granular)');
    expect(prompt.text).toContain('weed pressure (moderate confidence)');
    expect(prompt.text).toContain('thinning turf (low confidence)');
    expect(prompt.text).toContain('Turf coverage (healthy = thick, few bare spots): worth watching');
    expect(prompt.text).toContain('water_in: 0.5 inches, within 24 hours');
    expect(prompt.text).toContain('RECENT RAIN: no');
  });

  test('no product name, active ingredient, score or catalog list ever reaches the model', () => {
    expect(prompt.text).not.toMatch(/Arena|LESCO|Prodiamine|Celsius|Talstar|clothianidin|prodiamine/i);
    expect(prompt.text).not.toMatch(/\bscore\b.*\d/i);
  });

  test('the system prompt carries the owner rules the code then enforces', () => {
    const sys = prompt.system.toLowerCase();
    for (const phrase of [
      '4 to 6 sentences', 'category', 'never name a product', 'not a sighting', 'exact inches and hours',
      'no numbers of any kind', 'no guarantee', 'hedge', 'next visit', 'human prose rules', 'water_in',
    ]) expect(sys).toContain(phrase.toLowerCase());
  });

  test('a visit with no watering step says so, and rain is not offered', () => {
    const none = summary.buildPrompt(summary.normalizeFacts({ ...RAW, watering: null, recentRain: null })).text;
    expect(none).toContain('WATERING STEP: (none)');
    expect(none).toContain('RECENT RAIN: (unknown)');
  });

  test('the schema asks for a summary and per-sentence sources from a closed set', () => {
    const schema = prompt.jsonSchema;
    expect(schema.required).toEqual(['summary', 'sources']);
    expect(schema.properties.sources.items.properties.from.items.enum).toEqual(summary.SOURCE_KEYS);
  });
});

describe('validator', () => {
  test('a grounded paragraph passes', () => {
    const verdict = check(GOOD);
    expect(verdict.problems).toEqual([]);
    expect(verdict.ok).toBe(true);
    expect(verdict.paragraph).toBe(GOOD);
    expect(verdict.sources).toHaveLength(5);
  });

  test('rejects a pest the findings and note do not contain (invented, or lifted from the program line)', () => {
    const invented = GOOD.replace('some weed pressure', 'chinch bugs');
    expect(problems(invented)).toContain('invented_condition:chinch');
    const fromProgramLine = GOOD.replace('some weed pressure', 'some large patch');
    expect(problems(fromProgramLine)).toContain('invented_condition:large_patch');
    expect(problems(GOOD.replace('some weed pressure', 'grubs'))).toContain('invented_condition:grub');
    expect(problems(GOOD.replace('some weed pressure', 'fungus'))).toContain('invented_condition:fungus');
  });

  test('a cause the technician named in the note may be repeated; a cause the note denies may not', () => {
    const named = summary.normalizeFacts({ ...RAW, technicianNote: 'Possible chinch bugs by the driveway.' });
    expect(problems(GOOD.replace('some weed pressure', 'possible chinch bugs'), named)).toEqual([]);
    const denied = summary.normalizeFacts({ ...RAW, technicianNote: 'No chinch bugs found.' });
    expect(problems(GOOD.replace('some weed pressure', 'chinch bugs'), denied)).toContain('invented_condition:chinch');
  });

  test('rejects a product name: applied, catalog-only, or an active ingredient', () => {
    expect(problems(GOOD.replace('a fall feeding', 'a fall feeding of LESCO 24-0-11'))).toContain('product_name');
    expect(problems(GOOD.replace('a fall feeding', 'a round of Arena'))).toContain('product_name');
    expect(problems(GOOD.replace('a fall feeding', 'a Celsius WG pass'))).toContain('product_name');
    // An applied product's own name token (here also its active) and a common active that was never applied.
    expect(problems(GOOD.replace('a fall feeding', 'a prodiamine barrier'))).toEqual(expect.arrayContaining(['product_name']));
    expect(problems(GOOD.replace('a fall feeding', 'a bifenthrin pass'))).toContain('active_ingredient');
  });

  test('a low-confidence finding stated as fact needs a hedge', () => {
    const asFact = GOOD.replace('we are keeping an eye on a few thin spots near the driveway', 'the lawn has thin spots near the driveway');
    expect(problems(asFact)).toContain('unhedged_low_confidence:thin');
    expect(problems(GOOD)).not.toContain('unhedged_low_confidence:thin');
  });

  test('numbers: only the exact watering inches and hours', () => {
    expect(problems(GOOD.replace('0.5 inches', '1 inch'))).toEqual(expect.arrayContaining(['number', 'watering_inches_missing']));
    expect(problems(GOOD.replace('24 hours', '48 hours'))).toEqual(expect.arrayContaining(['number', 'watering_hours_missing']));
    expect(problems(GOOD.replace('color and thickness', '30 percent more color and thickness'))).toContain('number');
    expect(problems(GOOD.replace('color and thickness', 'two weeks of color and thickness'))).toContain('spelled_number');
    // Spelled "half an inch" and "twenty-four hours" are the same exact amounts.
    expect(problems(GOOD.replace('0.5 inches within 24 hours', 'half an inch within twenty-four hours'))).toEqual([]);
  });

  test('result timing, dates, guarantees and an all-clear are rejected', () => {
    expect(problems(GOOD.replace('a little at a time', 'in 2 weeks'))).toEqual(expect.arrayContaining(['number', 'result_timing']));
    expect(problems(GOOD.replace('a little at a time', 'over time'))).toContain('result_timing');
    expect(problems(GOOD.replace('a little at a time', 'in the days ahead'))).toContain('result_timing');
    expect(problems(GOOD.replace('a little at a time', 'by next Tuesday'))).toContain('result_timing');
    expect(problems(GOOD.replace('rather than all at once', 'and we guarantee it'))).toContain('banned_wording');
    expect(problems(GOOD.replace('some weed pressure', 'no problems'))).toContain('banned_wording');
    expect(problems(GOOD.replace('build gradually', 'eliminate the weeds'))).toContain('banned_wording');
  });

  test('watering: the required step must be there; no step in the facts means no watering advice', () => {
    expect(problems(GOOD.replace('Please water the treated lawn in with 0.5 inches within 24 hours so the feeding reaches the roots. ', ''))).toEqual(expect.arrayContaining(['watering_step_missing']));
    const none = summary.normalizeFacts({ ...RAW, watering: null });
    expect(problems(GOOD.replace('0.5 inches within 24 hours', 'a good soaking'), none)).toContain('watering_not_in_facts');
    expect(problems(GOOD.replace('Please water the treated lawn in with 0.5 inches within 24 hours so the feeding reaches the roots. ', 'The feeding settles in on its own. '), none)).not.toContain('watering_not_in_facts');
  });

  test('rain is mentioned only when the facts say it rained', () => {
    expect(problems(GOOD.replace('so the feeding reaches the roots', 'since the rain only helped a little'))).toContain('rain_not_in_facts');
    const rainy = summary.normalizeFacts({ ...RAW, recentRain: true });
    expect(problems(GOOD.replace('so the feeding reaches the roots', 'on top of the rain we had'), rainy)).not.toContain('rain_not_in_facts');
  });

  test('the photos never confirm a cause', () => {
    expect(problems(GOOD.replace('The photo read showed', 'The photos confirmed'))).toContain('photo_confirms');
  });

  test('shape: sentence count, length, markup, first person, greeting', () => {
    expect(problems('We fed the lawn. We watered it in.')).toContain('sentence_count');
    expect(problems(`${GOOD} Also, I think the lawn looks better.`)).toEqual(expect.arrayContaining(['first_person']));
    expect(problems(`Hi there, ${GOOD}`)).toContain('greeting_or_signoff');
    expect(problems(GOOD.replace('Today we put down', '**Today** we put down'))).toContain('markup');
    expect(summary.validateSummary({ summary: '', sources: [] }, FACTS).problems).toEqual(['empty']);
  });

  test('sources: one per sentence, from the closed set', () => {
    const bad = { summary: GOOD, sources: [{ sentence: 'x', from: ['guess'] }] };
    expect(summary.validateSummary(bad, FACTS).problems).toEqual(expect.arrayContaining(['sources_count']));
  });

  test('a hold step carries no numbers', () => {
    const hold = summary.normalizeFacts({ ...RAW, watering: { state: 'hold' } });
    const text = GOOD.replace('Please water the treated lawn in with 0.5 inches within 24 hours so the feeding reaches the roots.', 'Please hold off watering and follow the watering note in this report.');
    expect(problems(text, hold)).toEqual([]);
    expect(problems(text.replace('hold off', 'hold off for 12 hours'), hold)).toContain('number');
  });
});

describe('one model call, frozen, with the generic recap as the fallback', () => {
  const modelReturns = (json) => dispatchWithFallback.mockImplementation(async (_policy, _payload, options) => {
    const result = { ok: true, json };
    return options.validate(result) ? { ok: false, reason: 'all_providers_failed' } : result;
  });
  beforeEach(() => { jest.clearAllMocks(); });

  test('a grounded answer is returned with its sources and an inputs hash; the call goes out on its own lane', async () => {
    modelReturns(answer(GOOD));
    const out = await summary.generateVisitSummary(RAW);
    expect(out.ok).toBe(true);
    expect(out.paragraph).toBe(GOOD);
    expect(out.inputsHash).toMatch(/^[0-9a-f]{12}$/);
    const payload = dispatchWithFallback.mock.calls[0][1];
    expect(payload.laneId).toBe('lawn_visit_summary');
    expect(payload.promptVersion).toBe(summary.PROMPT_VERSION);
    expect(payload.text).not.toMatch(/Arena|LESCO/);
  });

  test('FALLBACK: an invented pest or a product name means no summary (the report keeps the generic recap)', async () => {
    modelReturns(answer(GOOD.replace('some weed pressure', 'chinch bugs')));
    const a = await summary.generateVisitSummary(RAW);
    expect(a).toMatchObject({ ok: false, reason: 'rejected' });
    expect(a.problems).toContain('invented_condition:chinch');
    modelReturns(answer(GOOD.replace('a fall feeding', 'Arena')));
    const b = await summary.generateVisitSummary(RAW);
    expect(b).toMatchObject({ ok: false, reason: 'rejected' });
    expect(b.problems).toContain('product_name');
  });

  test('FALLBACK: a provider miss, a thrown error and a timeout all return no summary and never throw', async () => {
    dispatchWithFallback.mockResolvedValueOnce({ ok: false, reason: 'all_providers_failed' });
    expect((await summary.generateVisitSummary(RAW)).ok).toBe(false);
    dispatchWithFallback.mockRejectedValueOnce(new Error('boom'));
    expect(await summary.generateVisitSummary(RAW)).toMatchObject({ ok: false, reason: 'error' });
    expect(await summary.generateVisitSummary(RAW, { budgetMs: 500 })).toMatchObject({ ok: false, reason: 'timeout' });
  });

  test('nothing to ground (no products and no kept findings) makes no call at all', async () => {
    const out = await summary.generateVisitSummary({ ...RAW, applied: [], findings: [] });
    expect(out).toEqual({ ok: false, reason: 'nothing_to_ground' });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  // First-writer-wins freeze against a fake record, the way Postgres applies it.
  function fakeKnex(initialNotes = {}) {
    const state = { notes: JSON.parse(JSON.stringify(initialNotes)) };
    const knex = () => {
      const q = { guardKey: null };
      q.where = () => q;
      q.whereRaw = (_sql, bindings) => { q.guardKey = Array.isArray(bindings) ? bindings[0] : null; return q; };
      q.first = async () => ({ structured_notes: JSON.stringify(state.notes) });
      q.update = async ({ structured_notes: raw }) => {
        const patch = JSON.parse(raw.bindings[0]);
        if ((state.notes.lawnVisitSummary || {})[q.guardKey]) return 0;
        state.notes.lawnVisitSummary = { ...(state.notes.lawnVisitSummary || {}), ...patch };
        return 1;
      };
      return q;
    };
    knex.raw = (sql, bindings) => ({ sql, bindings });
    return { knex, state };
  }

  test('freezes under lawnVisitSummary[assessmentId]; a retry spends no second call; the render reads it back', async () => {
    modelReturns(answer(GOOD));
    const { knex, state } = fakeKnex({});
    const step = () => summary.createAndFreezeVisitSummary({
      serviceRecordId: 's1',
      assessmentId: 77,
      getStructuredNotes: async () => state.notes,
      gatherInputs: async () => RAW,
      knex,
    });
    const first = await step();
    expect(first.status).toBe('frozen');
    expect(state.notes.lawnVisitSummary['77']).toMatchObject({ v: 1, text: GOOD, assessmentId: '77', promptVersion: summary.PROMPT_VERSION });
    expect((await step()).status).toBe('already_frozen');
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
    expect(summary.readFrozenVisitSummary(state.notes, 77)).toBe(GOOD);
    expect(summary.visitSummarySignature(state.notes, 77)).toMatch(/^:tp=[0-9a-f]{8}$/);
  });

  test('FALLBACK: a rejected answer freezes nothing', async () => {
    modelReturns(answer(GOOD.replace('some weed pressure', 'chinch bugs')));
    const { knex, state } = fakeKnex({});
    const out = await summary.createAndFreezeVisitSummary({
      serviceRecordId: 's1', assessmentId: 77, getStructuredNotes: async () => state.notes, gatherInputs: async () => RAW, knex,
    });
    expect(out.status).toBe('rejected');
    expect(state.notes.lawnVisitSummary).toBeUndefined();
  });

  test('the read-time guard drops a frozen text that was hand-edited into banned copy', () => {
    const notes = { lawnVisitSummary: { 77: { v: 1, assessmentId: '77', text: 'We guarantee your lawn is cured.' } } };
    expect(summary.readFrozenVisitSummary(notes, 77)).toBeNull();
    expect(summary.readFrozenVisitSummary({}, 77)).toBeNull();
    expect(summary.readFrozenVisitSummary(notes, null)).toBeNull();
  });
});

describe('the gate', () => {
  const gates = require('../config/feature-gates');
  afterEach(() => { delete process.env.GATE_LAWN_VISIT_SUMMARY_V2; });

  test('dark by default, strict opt-in, read at call time', () => {
    expect(gates.lawnVisitSummaryV2Live()).toBe(false);
    process.env.GATE_LAWN_VISIT_SUMMARY_V2 = '1';
    expect(gates.lawnVisitSummaryV2Live()).toBe(false);
    process.env.GATE_LAWN_VISIT_SUMMARY_V2 = 'true';
    expect(gates.lawnVisitSummaryV2Live()).toBe(true);
    delete process.env.GATE_LAWN_VISIT_SUMMARY_V2;
    expect(gates.lawnVisitSummaryV2Live()).toBe(false);
  });
});

describe('owner 2026-10-06 local-test fixes', () => {
  const COMBO = summary.normalizeFacts({
    ...RAW,
    applied: [{ name: 'LESCO Stonewall 0.43% 15-0-15 50% PolyPlus OPTI45 Pre-Emergent Plus Fertilizer', activeIngredient: 'prodiamine 0.43% + 15-0-15', kind: 'pre_emergent', method: 'granular' }],
    knownProductNames: [...RAW.knownProductNames, 'LESCO Stonewall 0.43% 15-0-15 50% PolyPlus OPTI45 Pre-Emergent Plus Fertilizer', 'LESCO Moisture Manager'],
  });

  test('a weed barrier that carries a fertilizer analysis is both a feeding and a barrier', () => {
    expect(COMBO.applied[0].category).toBe('a feeding with a pre-emergent weed barrier');
    expect(summary.buildUserMessage(COMBO)).toContain('- a feeding with a pre-emergent weed barrier (granular)');
    expect(summary.normalizeFacts(RAW).applied.map((a) => a.category)).toEqual(['insect control', 'a feeding', 'a pre-emergent weed barrier']);
  });

  test('category words and plain words from catalog names are not product names; a brand still is', () => {
    expect(problems(GOOD, COMBO)).not.toContain('product_name');
    expect(problems(GOOD.replace('which fits the season', 'and the soil moisture should help it settle'), COMBO)).not.toContain('product_name');
    expect(problems(GOOD.replace('a pre-emergent weed barrier', 'Stonewall'), COMBO)).toContain('product_name');
  });

  test('"keep an eye on" and "look again at" count as hedges for a low-confidence finding', () => {
    const text = GOOD.replace('we are keeping an eye on a few thin spots near the driveway', 'we want to keep an eye on some thinning turf near the driveway');
    expect(problems(text).filter((p) => p.startsWith('unhedged'))).toEqual([]);
  });

  test('the score-card labels reach the writer with their meaning', () => {
    const msg = summary.buildUserMessage(FACTS);
    expect(msg).toContain('Weed control (strong or healthy = few weeds): worth watching');
    expect(msg).not.toContain('Weed Pressure:');
  });
});

describe('Codex round 1 on #6087', () => {
  const sourcesOf = (text) => splitSentences(text).map((sentence) => ({ sentence, from: ['applied'] }));

  describe('1. a category word licenses wording only in the sentence that says what we applied', () => {
    const FUNGUS_FACTS = summary.normalizeFacts({
      season: 'fall', applied: [{ name: 'Headway G', kind: 'fungicide', method: 'granular' }], findings: [], areas: [], watering: null, recentRain: null, watchNext: ['how the lawn responds'], technicianNote: '', knownProductNames: [],
    });
    const base = (second) => `Today we applied disease protection across the lawn, which fits the season. ${second} Protection like this builds gradually, a little at a time. At the next visit we will look again at how the lawn responds.`;

    test('a fungicide-only visit may say what it applied, never that the lawn has the disease', () => {
      expect(problems(base('The turf coverage holds steady in the areas we checked.'), FUNGUS_FACTS)).toEqual([]);
      expect(problems(base('The lawn has fungus in the front yard.'), FUNGUS_FACTS).some((p) => p.includes('fungus'))).toBe(true);
      expect(problems(base('The photo read showed some disease on the lawn.'), FUNGUS_FACTS).some((p) => p.includes('fungus'))).toBe(true);
      expect(problems(base('We treated the front yard, which has fungus.'), FUNGUS_FACTS).some((p) => p.includes('fungus'))).toBe(true);
    });

    test('an insecticide visit does not turn "insect control" into a sighting', () => {
      const facts = summary.normalizeFacts({ ...RAW, applied: [{ name: 'Arena 50 WDG', kind: 'insecticide', method: 'spray' }], findings: [], technicianNote: '', watering: null, recentRain: null, knownProductNames: [] });
      expect(problems(GOOD.replace('Please water the treated lawn in with 0.5 inches within 24 hours so the feeding reaches the roots. ', '').replace('some weed pressure', 'a lot of insects'), facts).some((p) => p.includes('insect'))).toBe(true);
    });
  });

  describe('2. the watering action must match the frozen state', () => {
    const HOLD = summary.normalizeFacts({ ...RAW, watering: { state: 'hold' } });
    const HOLD_SENTENCE = 'Please hold off watering and follow the watering note in this report.';
    const WATER_SENTENCE = 'Please water the treated lawn in with 0.5 inches within 24 hours so the feeding reaches the roots.';
    const holdText = (s) => GOOD.replace(WATER_SENTENCE, s);

    test('hold: must tell the customer to hold off, never that we watered or to water in', () => {
      expect(problems(holdText(HOLD_SENTENCE), HOLD)).toEqual([]);
      expect(problems(holdText('We watered the treatment today.'), HOLD)).toContain('hold_state_waters');
      expect(problems(holdText('Please water the treated lawn in as soon as you can.'), HOLD)).toContain('hold_state_waters');
      expect(problems(holdText('Please run the sprinklers now.'), HOLD)).toContain('hold_state_waters');
      expect(problems(holdText('Please keep the lawn well supplied with water.'), HOLD)).toContain('watering_hold_missing');
    });

    test('water_in: must not say hold or skip', () => {
      expect(problems(GOOD)).toEqual([]);
      expect(problems(GOOD.replace(WATER_SENTENCE, 'Please hold off watering, then water with 0.5 inches within 24 hours.'))).toContain('watering_hold_in_water_state');
      expect(problems(GOOD.replace(WATER_SENTENCE, 'Please skip watering; 0.5 inches within 24 hours is noted.'))).toContain('watering_hold_in_water_state');
      expect(problems(GOOD.replace(WATER_SENTENCE, 'The feeding settles in with 0.5 inches within 24 hours.'))).toContain('watering_action_missing');
    });

    test('hold_then_water_in: both the hold and the later water-in', () => {
      const both = summary.normalizeFacts({ ...RAW, watering: { state: 'hold_then_water_in', inches: 0.5, hours: 24 } });
      const ok = 'Please hold off watering until the report says it is time, then water the lawn in with 0.5 inches within 24 hours.';
      expect(problems(holdText(ok), both)).toEqual([]);
      expect(problems(holdText(WATER_SENTENCE), both)).toContain('watering_hold_missing');
      expect(problems(holdText('Please hold off watering and follow the watering note in this report.'), both)).toEqual(expect.arrayContaining(['watering_inches_missing']));
      expect(problems(holdText('Please water the lawn in with 0.5 inches within 24 hours, after you hold off watering.'), both)).toContain('watering_order');
    });
  });

  describe('3. a tentative technician-note term keeps its hedge', () => {
    const tentative = summary.normalizeFacts({ ...RAW, technicianNote: 'Possible chinch bugs by the driveway.' });
    test('stated as fact it fails; hedged it passes', () => {
      const asFact = GOOD.replace('The photo read showed some weed pressure in the lawn, and we are keeping an eye on a few thin spots near the driveway.', 'The photo read showed chinch bugs damaging the lawn near the driveway.');
      expect(problems(asFact, tentative)).toContain('unhedged_low_confidence:chinch');
      expect(problems(GOOD.replace('some weed pressure', 'possible chinch bugs'), tentative)).toEqual([]);
    });
    test('a definite note term needs no hedge', () => {
      const definite = summary.normalizeFacts({ ...RAW, technicianNote: 'Chinch bugs by the driveway.' });
      expect(problems(GOOD.replace('some weed pressure', 'chinch bugs'), definite)).toEqual([]);
    });
  });

  describe('4. every spelled-out quantity is rejected, except the exact watering amounts', () => {
    test.each([
      ['two thin spots', 'a few thin spots', 'two thin spots'],
      ['thirteen affected areas', 'a few thin spots', 'thirteen affected areas'],
      ['a dozen spots', 'a few thin spots', 'a dozen thin spots'],
      ['one thin spot', 'a few thin spots', 'one thin spot'],
      ['hundreds', 'color and thickness', 'hundred percent color and thickness'],
    ])('%s', (_name, from, to) => {
      expect(problems(GOOD.replace(from, to))).toContain('spelled_number');
    });
    test('the exact watering amounts and plain "the last one" pass', () => {
      expect(problems(GOOD.replace('0.5 inches within 24 hours', 'half an inch within twenty-four hours'))).toEqual([]);
      expect(problems(GOOD.replace('0.5 inches within 24 hours', 'a half inch within 24 hours'))).toEqual([]);
      expect(problems(GOOD.replace('rather than all at once', 'and each visit builds on the last one'))).toEqual([]);
      // Not the exact amount: a spelled number of inches that the facts do not carry.
      expect(problems(GOOD.replace('0.5 inches within 24 hours', 'two inches within twelve hours'))).toContain('spelled_number');
    });
  });

  describe('5. catalog active ingredients are screened (validator only)', () => {
    const withActives = summary.normalizeFacts({ ...RAW, knownActiveIngredients: ['Penthiopyrad 20%', 'prodiamine 0.43% + 15-0-15', 'Nitrogen, Iron'] });
    test('a catalog active outside the fixed list is rejected; generic nutrient words are not', () => {
      expect(problems(GOOD.replace('a fall feeding', 'a fall feeding with penthiopyrad'), withActives)).toContain('active_ingredient');
      expect(problems(GOOD, withActives)).toEqual([]);
    });
    test('the facts builder reads every catalog active_ingredient, and the model never sees one', async () => {
      const catalog = [{ name: 'Velista', active_ingredient: 'Penthiopyrad 20%' }, { name: 'Wetting Agent', active_ingredient: null }];
      const knex = (table) => {
        const q = {};
        q.where = () => q;
        q.whereIn = () => q;
        q.first = async () => (table === 'lawn_assessments' ? { id: 77, customer_id: 9 } : { assessment_id: 77, customer_id: 9, reviewed_at: '2026-10-06T10:00:00Z', reviewed_findings: [{ label: 'thinning turf', confidence: 'low', keep: true }], added_details: [] });
        q.select = async (...cols) => { q.cols = cols; return cols[0] === 'name' ? catalog : []; };
        return q;
      };
      const facts = await gatherVisitSummaryFacts({
        record: { id: 's1', technician_notes: 'x', service_date: '2026-10-06' },
        data: { lawnAssessment: { assessmentId: 77 }, reportV2: { snapshot: {}, diagnosis: [], insights: [], treatment: { products: [{ name: 'LESCO 24-0-11', kind: 'fertilizer', method: 'granular' }] } } },
        knex,
      });
      expect(facts.knownActiveIngredients).toEqual(['Penthiopyrad 20%']);
      expect(summary.buildUserMessage(facts)).not.toMatch(/penthiopyrad/i);
    });
  });

  describe('6. each source sentence must be its paragraph sentence, in order', () => {
    const goodSources = () => sourcesOf(GOOD);
    test('"unrelated" sentences or a reordered list are rejected; spacing and quote style are normalized', () => {
      expect(summary.validateSummary({ summary: GOOD, sources: goodSources() }, FACTS).problems).toEqual([]);
      expect(summary.validateSummary({ summary: GOOD, sources: goodSources().map((s) => ({ ...s, sentence: 'unrelated' })) }, FACTS).problems).toContain('sources_sentence_mismatch');
      expect(summary.validateSummary({ summary: GOOD, sources: goodSources().reverse() }, FACTS).problems).toContain('sources_sentence_mismatch');
      const spaced = goodSources().map((s) => ({ ...s, sentence: `  ${s.sentence.replace(/ /g, '  ')} ` }));
      expect(summary.validateSummary({ summary: GOOD, sources: spaced }, FACTS).problems).toEqual([]);
      const curly = 'Today we put down a fall feeding that fits the season. The photo read showed some weed pressure, and we are keeping an eye on a few thin spots. Feedings like this build gradually, so the lawn’s color improves a little at a time. At the next visit we will look at the weeds again.';
      const straightSources = splitSentences(curly).map((sentence) => ({ sentence: sentence.replace(/’/g, "'"), from: ['applied'] }));
      expect(summary.validateSummary({ summary: curly, sources: straightSources }, summary.normalizeFacts({ ...RAW, watering: null })).problems).toEqual([]);
    });
  });

  describe('real good outputs still pass', () => {
    const REAL = summary.normalizeFacts({
      season: 'fall',
      programLine: RAW.programLine,
      applied: [{ name: 'LESCO Stonewall 0.43% 15-0-15 50% PolyPlus OPTI45 Pre-Emergent Plus Fertilizer', activeIngredient: 'prodiamine 0.43% + 15-0-15', kind: 'pre_emergent', method: 'granular' }],
      findings: [{ label: 'thinning turf', confidence: 'low' }],
      areas: [{ label: 'Turf Density', status: 'healthy' }, { label: 'Weed Pressure', status: 'strong' }, { label: 'Stress or Damage', status: 'watch' }, { label: 'Color & Vigor', status: 'healthy' }],
      headline: 'Your lawn is in good shape',
      watering: null,
      recentRain: true,
      watchNext: ['stressed areas', 'thinning turf'],
      technicianNote: '',
      knownProductNames: ['LESCO Stonewall 0.43% 15-0-15 50% PolyPlus OPTI45 Pre-Emergent Plus Fertilizer', 'LESCO Moisture Manager'],
      knownActiveIngredients: ['prodiamine 0.43% + 15-0-15', 'Penthiopyrad 20%'],
    });
    const A = 'Today we laid down a pre-emergent weed barrier across the parts of your lawn where it fits, which suits the fall and sets up the season ahead. The photo read showed turf coverage coming in thick with healthy color, and weed control holding strong with no stress signs in the areas we checked. We did note what may be a little thinning in the turf, and we are keeping an eye on that. A barrier like this works quietly in the soil, building a little at a time so weeds have a harder time taking hold with each visit. At the next visit we will take another look at that thinning turf.';
    const B = 'Today we laid down a pre-emergent weed barrier across the property, a step that fits the fall feeding window and holds back weeds before they take hold. Reading the photos, the turf shows thick coverage with good color, and weeds are staying well in check, though we are keeping an eye on a few spots that look thin and on some areas showing stress. A barrier like this builds a little at a time, with each visit adding to the last. The rain that fell before our visit helps the treatment settle into the soil. At the next visit we will look again at the stressed areas and those thinning spots.';
    test.each([['a', A], ['b', B]])('output %s', (_n, text) => {
      expect(summary.validateSummary({ summary: text, sources: sourcesOf(text) }, REAL).problems).toEqual([]);
    });
  });
});
