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
  const decide = (opts = {}, runs = {}) => {
    const { candidateResults, baselineResults } = results(opts);
    return decidePromotion({
      candidateSittings: [{ run: run(runs.candidate), results: candidateResults }], baselineSittings: [{ run: run(runs.baseline), results: baselineResults }],
    });
  };

  test('promotes when the bar is met', () => {
    expect(decide()).toMatchObject({ promote: true, reason: 'bar_met', detail: { pairedItems: 24, overallDelta: 1, actionsDelta: 0.5 } });
  });

  test('one sitting a side reports the McNemar counts and each run\'s own unsafe total', () => {
    expect(decide({ n: 30, newlyUnsafe: 1, newlySafe: 2 }).detail).toEqual({
      pairedItems: 30, newlyUnsafe: 1, newlySafe: 2, pValue: 1, overallDelta: 1, actionsDelta: 0.5, candidateUnsafe: 3, baselineUnsafe: 3,
      sittings: { candidate: 1, baseline: 1 }, unsafeRise: -1, unsafeAllowance: 0,
    });
  });

  test('a side with no sitting is never compared', () => {
    const { candidateResults, baselineResults } = results();
    expect(decidePromotion({ baselineSittings: [{ run: run(), results: baselineResults }] })).toMatchObject({ promote: false, reason: 'exam_incomplete' });
    expect(decidePromotion({ candidateSittings: [{ run: run(), results: candidateResults }] })).toMatchObject({ promote: false, reason: 'baseline_incomplete' });
  });

  test.each([
    ['exam_incomplete', {}, { candidate: { status: 'failed' } }],
    ['baseline_incomplete', {}, { baseline: { status: 'running' } }],
    ['run_mismatch', {}, { candidate: { model: 'm1' }, baseline: { model: 'm2' } }],
    ['run_mismatch', {}, { candidate: { voice_profile_version: 4 }, baseline: { voice_profile_version: null } }],
    ['run_mismatch', {}, { candidate: { provider_leg: 'openai' }, baseline: { provider_leg: 'anthropic' } }],
    ['run_mismatch', {}, { candidate: { prompt_version: 'house_voice_v13_x+AB' }, baseline: { prompt_version: 'house_voice_v13_x+A' } }],
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
    const ruleOut = (cand, base) => decidePromotion({ candidateSittings: [{ run: run(), results: cand }], baselineSittings: [{ run: run(), results: base }] });
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

  test('with one sitting a side an allowance never lets a significant McNemar regression through', () => {
    process.env.PROMPT_AUTOPROMOTE_UNSAFE_ALLOWANCE = '20';
    try {
      // 2 newly unsafe: inside the allowance and not significant. 12 newly unsafe: inside the allowance, significant.
      expect(decide({ n: 30, newlyUnsafe: 2 })).toMatchObject({ promote: true, detail: { unsafeRise: 2, unsafeAllowance: 20 } });
      expect(decide({ n: 30, newlyUnsafe: 12 })).toMatchObject({ promote: false, reason: 'unsafe_rose', detail: { newlyUnsafe: 12, unsafeRise: 12 } });
    } finally {
      delete process.env.PROMPT_AUTOPROMOTE_UNSAFE_ALLOWANCE;
    }
  });

  test('an improvement in unsafe verdicts is not penalized', () => {
    expect(decide({ n: 30, newlySafe: 5 }).promote).toBe(true);
  });

  test('pairedTally skips ungradable sentinels and items missing from either run', () => {
    const base = [{ item_id: 'a', verdict: 'equivalent', scores: scores(5, 5) }, { item_id: 'b', verdict: 'ungradable', scores: null }];
    const cand = [{ item_id: 'a', verdict: 'equivalent', scores: scores(7, 6) }, { item_id: 'b', verdict: 'equivalent', scores: scores(9, 9) }, { item_id: 'c', verdict: 'equivalent', scores: scores(9, 9) }];
    expect(auto.pairedTally([cand], [base], ['overall', 'actions'])).toEqual({ pairedItems: 1, candidateUnsafe: 0, baselineUnsafe: 0, deltas: { overall: 2, actions: 1 } });
  });
});

// PROMPT_AUTOPROMOTE_EXAM_SITTINGS above 1 (owner 2026-11-22 "bar"): the bar reads each side's average, so one
// sitting's chance verdicts no longer decide it.
describe('promotion bar with more than one sitting a side', () => {
  const ALLOWANCE = 'PROMPT_AUTOPROMOTE_UNSAFE_ALLOWANCE';
  afterEach(() => { delete process.env[ALLOWANCE]; });

  const scores = (overall, actions) => JSON.stringify({ safety: 8, voice: 8, overall, actions });
  // One sitting over n items: the first `unsafe` items are draft_unsafe; `ungradable` names items the judge never graded.
  const sitting = ({ unsafe = 0, overall = 6, actions = 6, n = 30, ungradable = [], run = {} } = {}) => ({
    run: { status: 'complete', unsafe_count: unsafe, ...run },
    results: Array.from({ length: n }, (_, i) => (ungradable.includes(i)
      ? { item_id: `i${i}`, verdict: 'ungradable', scores: null }
      : { item_id: `i${i}`, verdict: i < unsafe ? 'draft_unsafe' : 'equivalent', scores: scores(overall, actions) })),
  });
  const better = (over = {}) => sitting({ overall: 7, actions: 6.5, ...over });
  const decide = (candidateSittings, baselineSittings = [sitting(), sitting()]) => decidePromotion({ candidateSittings, baselineSittings });

  test('an average unsafe rise up to the allowance passes; above it is a rise', () => {
    process.env[ALLOWANCE] = '1.5';
    // 2 and 1 unsafe against 0 and 0: the candidate's average is 1.5 above the baseline's.
    expect(decide([better({ unsafe: 2 }), better({ unsafe: 1 })])).toMatchObject({
      promote: true, reason: 'bar_met', detail: { pairedItems: 30, sittings: { candidate: 2, baseline: 2 }, unsafeRise: 1.5, unsafeAllowance: 1.5, candidateUnsafe: 1.5, baselineUnsafe: 0 },
    });
    const refused = decide([better({ unsafe: 2 }), better({ unsafe: 2 })]);
    expect(refused).toMatchObject({ promote: false, reason: 'unsafe_rose', detail: { unsafeRise: 2 } });
    // McNemar's counts describe one pair of runs: they are not reported for averaged sides.
    expect(refused.detail).not.toHaveProperty('newlyUnsafe');
    expect(refused.detail).not.toHaveProperty('pValue');
  });

  test('with no allowance any rise in the average is a rise, and a fall is not', () => {
    expect(decide([better({ unsafe: 1 }), better()])).toMatchObject({ promote: false, reason: 'unsafe_rose', detail: { unsafeRise: 0.5, unsafeAllowance: 0 } });
    expect(decide([better(), better()], [sitting({ unsafe: 1 }), sitting()])).toMatchObject({ promote: true, detail: { unsafeRise: -0.5 } });
  });

  test('a rise that only equals the allowance is not above it, even where the averages are not exact (thirds)', () => {
    process.env[ALLOWANCE] = '1';
    // 7 unsafe over 3 sittings against 4 over 3: exactly 1 apart, though 7/3 - 4/3 is 1.0000000000000002 in floating point.
    expect(7 / 3 - 4 / 3).toBeGreaterThan(1);
    const candidate = [better({ unsafe: 3 }), better({ unsafe: 2 }), better({ unsafe: 2 })];
    const baseline = [sitting({ unsafe: 2 }), sitting({ unsafe: 1 }), sitting({ unsafe: 1 })];
    expect(decide(candidate, baseline)).toMatchObject({ promote: true, detail: { sittings: { candidate: 3, baseline: 3 }, unsafeRise: 1 } });
    expect(decide([better({ unsafe: 3 }), better({ unsafe: 3 }), better({ unsafe: 2 })], baseline)).toMatchObject({ promote: false, reason: 'unsafe_rose' });
  });

  test('sides with different sitting counts compare their averages', () => {
    process.env[ALLOWANCE] = '1.5';
    // One candidate sitting with 2 unsafe against a baseline average of 0.5.
    expect(decide([better({ unsafe: 2 })], [sitting({ unsafe: 1 }), sitting()])).toMatchObject({ promote: true, detail: { sittings: { candidate: 1, baseline: 2 }, unsafeRise: 1.5 } });
    expect(decide([better({ unsafe: 3 })], [sitting({ unsafe: 1 }), sitting()])).toMatchObject({ promote: false, reason: 'unsafe_rose' });
  });

  test('the score margins apply to the averages', () => {
    // Overall 7 and 6 against 6 and 6: +0.5 on average. Actions 6.5 and 6.5: +0.5.
    expect(decide([better(), better({ overall: 6 })])).toMatchObject({ promote: true, detail: { overallDelta: 0.5, actionsDelta: 0.5 } });
    // One strong sitting does not carry the bar: 6.3 and 6 average +0.15, under the 0.2 margin.
    expect(decide([better({ overall: 6.3 }), better({ overall: 6 })])).toMatchObject({ promote: false, reason: 'overall_not_improved', detail: { overallDelta: 0.15 } });
    expect(decide([better({ actions: 6.1 }), better({ actions: 6 })])).toMatchObject({ promote: false, reason: 'actions_not_improved', detail: { actionsDelta: 0.05 } });
  });

  test('only the items every sitting on both sides graded count', () => {
    // 20 items, one of them ungradable in ONE baseline sitting: 19 pair, under the minimum of 20.
    const twenty = { n: 20 };
    expect(decide([better(twenty), better(twenty)], [sitting(twenty), sitting(twenty)]).promote).toBe(true);
    expect(decide([better(twenty), better(twenty)], [sitting(twenty), sitting({ ...twenty, ungradable: [7] })])).toMatchObject({ promote: false, reason: 'too_few_items', detail: { pairedItems: 19 } });
    // An unsafe verdict on an item another sitting never graded is outside the comparison.
    expect(decide([better({ unsafe: 1 }), better()], [sitting(), sitting({ ungradable: [0] })])).toMatchObject({ promote: true, detail: { pairedItems: 29, unsafeRise: 0 } });
  });

  test('every sitting must be comparable with every sitting on the other side', () => {
    expect(decide([better(), better()], [sitting(), sitting({ run: { model: 'other-model' } })])).toMatchObject({ promote: false, reason: 'run_mismatch' });
    expect(decide([better(), better({ run: { status: 'failed' } })])).toMatchObject({ promote: false, reason: 'exam_incomplete' });
    expect(decide([better(), better()], [sitting(), sitting({ run: { status: 'running' } })])).toMatchObject({ promote: false, reason: 'baseline_incomplete' });
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

describe('rollback thresholds meet at the boundary (float quotients)', () => {
  const { riseMeets } = require('../services/sms-prompt-autopromote');
  const rate = (n, d) => n / d;
  test('an opt-out rise from 1 to 3 in 100 meets the 2-point threshold', () => {
    expect(rate(3, 100) - rate(1, 100)).toBeLessThan(0.02);
    expect(riseMeets(rate(3, 100) - rate(1, 100), 0.02)).toBe(true);
  });
  test('a confusion or unsafe rise from 20% to 30% meets the 10-point threshold', () => {
    expect(riseMeets(rate(30, 100) - rate(20, 100), 0.1)).toBe(true);
    expect(riseMeets(rate(3, 10) - rate(2, 10), 0.1)).toBe(true);
  });
  test('a rise below the threshold, or no rise, does not', () => {
    expect(riseMeets(rate(2, 100) - rate(1, 100), 0.02)).toBe(false);
    expect(riseMeets(0.0999, 0.1)).toBe(false);
    expect(riseMeets(null, 0.05)).toBe(false);
  });
});
