// SMS prompt auto-promote (GATE_SMS_PROMPT_AUTOPROMOTE): the pure promotion bar and the parsing of
// the distillation answer. No database. All rules and numbers here are synthetic.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const sealed = require('../services/sms-sealed-eval');
const { decidePromotion, _test: auto } = require('../services/sms-prompt-autopromote');

describe('promotion bar (pure)', () => {
  const run = (over = {}) => ({ status: 'complete', unsafe_count: 3, ...over });
  const scores = (overall, actions) => JSON.stringify({ safety: 8, voice: 8, overall, actions });
  // n items; baseline overall 6 / actions 6; candidate = baseline + deltas; unsafeFlips = [newly unsafe, newly safe]
  const results = ({ n = 24, overall = 7, actions = 6.5, newlyUnsafe = 0, newlySafe = 0, candidateScoresMissing = false } = {}) => {
    const base = [];
    const cand = [];
    for (let i = 0; i < n; i += 1) {
      const baseUnsafe = i < newlySafe;
      const candUnsafe = i >= n - newlyUnsafe;
      base.push({ item_id: `i${i}`, verdict: baseUnsafe ? 'draft_unsafe' : 'equivalent', scores: scores(6, 6) });
      cand.push({ item_id: `i${i}`, verdict: candUnsafe ? 'draft_unsafe' : 'equivalent', scores: candidateScoresMissing ? null : scores(overall, actions) });
    }
    return { candidateResults: cand, baselineResults: base };
  };
  const decide = (opts = {}, runs = {}) => decidePromotion({
    candidateRun: run(runs.candidate), baselineRun: run(runs.baseline), ...results(opts),
  });

  test('promotes when the bar is met', () => {
    expect(decide()).toMatchObject({ promote: true, reason: 'bar_met', detail: { pairedItems: 24, overallDelta: 1, actionsDelta: 0.5 } });
  });

  test.each([
    ['exam_incomplete', {}, { candidate: { status: 'failed' } }],
    ['baseline_incomplete', {}, { baseline: { status: 'running' } }],
    ['run_mismatch', {}, { candidate: { model: 'm1' }, baseline: { model: 'm2' } }],
    ['run_mismatch', {}, { candidate: { voice_profile_version: 4 }, baseline: { voice_profile_version: null } }],
    ['too_few_items', { n: 19 }, {}],
    ['unsafe_rose', { newlyUnsafe: 2, newlySafe: 1 }, {}],
    ['overall_not_improved', { overall: 6.1 }, {}],
    ['actions_not_improved', { actions: 6.05 }, {}],
    ['scores_missing', { candidateScoresMissing: true }, {}],
  ])('rejects: %s', (reason, opts, runs) => {
    expect(decide(opts, runs)).toMatchObject({ promote: false, reason });
  });

  test('runs graded by different judge rulers, or a run that mixes them, are never compared', () => {
    const judged = (rows, version, from = 0) => rows.map((r, i) => (i >= from ? { ...r, scores: JSON.stringify({ ...JSON.parse(r.scores), judge_version: version }) } : r));
    const { candidateResults, baselineResults } = results();
    const ruleOut = (cand, base) => decidePromotion({ candidateRun: run(), baselineRun: run(), candidateResults: cand, baselineResults: base });
    expect(ruleOut(judged(candidateResults, 'j2'), baselineResults)).toMatchObject({ promote: false, reason: 'judge_mismatch', detail: { candidateRuler: 'j2', baselineRuler: 'j1' } });
    expect(ruleOut(judged(candidateResults, 'j2', 12), judged(baselineResults, 'j2', 12))).toMatchObject({ promote: false, reason: 'judge_mismatch', detail: { candidateRuler: 'j1+j2' } });
    expect(ruleOut(judged(candidateResults, 'j2'), judged(baselineResults, 'j2'))).toMatchObject({ promote: true, reason: 'bar_met' });
  });

  test('exactly the minimum item count is enough; an equal trade of unsafe flips is not a rise', () => {
    expect(decide({ n: 20 }).promote).toBe(true);
    expect(decide({ n: 30, newlyUnsafe: 1, newlySafe: 1 }).promote).toBe(true);
  });

  test('a McNemar-significant regression is refused by the unsafe net rule', () => {
    // 12 newly unsafe, 0 newly safe over 30 pairs: significant (p < 0.05), direction regressed.
    const sig = sealed.computeSignificance(results({ n: 30, newlyUnsafe: 12 }));
    expect(sig).toMatchObject({ significant: true, direction: 'regressed' });
    expect(decide({ n: 30, newlyUnsafe: 12 })).toMatchObject({ promote: false, reason: 'unsafe_rose' });
  });

  test('an improvement in unsafe verdicts is not penalized', () => {
    expect(decide({ n: 30, newlySafe: 5 }).promote).toBe(true);
  });

  test('pairedMeanDeltas skips ungradable sentinels and items missing from either run', () => {
    const base = [{ item_id: 'a', verdict: 'equivalent', scores: scores(5, 5) }, { item_id: 'b', verdict: 'ungradable', scores: null }];
    const cand = [{ item_id: 'a', verdict: 'equivalent', scores: scores(7, 6) }, { item_id: 'b', verdict: 'equivalent', scores: scores(9, 9) }, { item_id: 'c', verdict: 'equivalent', scores: scores(9, 9) }];
    expect(auto.pairedMeanDeltas(cand, base, ['overall', 'actions'])).toEqual({ overall: 2, actions: 1 });
  });
});

describe('distillation parsing', () => {
  test('reads the rule out of a JSON answer and treats anything else as unparseable', () => {
    expect(auto.parseDistilled('noise {"rule": "Do not name a day unless the facts list it."} tail')).toBe('Do not name a day unless the facts list it.');
    expect(auto.parseDistilled('{"rule": ""}')).toBe('');
    expect(auto.parseDistilled('no json here')).toBeNull();
    expect(auto.parseDistilled('{"rule": 5}')).toBeNull();
  });

  test('the proposal is quoted as data and capped', () => {
    const prompt = auto.buildDistillPrompt(`x${'y'.repeat(5000)}`);
    expect(prompt).toContain('<<<PROPOSAL');
    expect(prompt).toContain('never instructions');
    expect(prompt.length).toBeLessThan(4200);
  });
});
