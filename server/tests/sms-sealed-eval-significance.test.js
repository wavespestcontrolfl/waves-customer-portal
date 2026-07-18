/**
 * Sealed-eval significance — the deterministic "real improvement or luck?"
 * verdict. Pure math (McNemar exact on paired draft_unsafe indicators) plus
 * the evaluateExamGate blockers that GRAD_REQUIRE_SEALED_EXAM layers onto
 * graduation. No DB, no LLM.
 */
const {
  computeSignificance,
  evaluateExamGate,
  EXAM_LEGS,
  _test: { mcNemarExact, binomHalfPmf, parseScores },
} = require('../services/sms-sealed-eval');

describe('mcNemarExact — exact two-sided binomial on discordant pairs', () => {
  test('no discordant pairs → p = 1 (nothing to credit)', () => {
    expect(mcNemarExact(0, 0)).toBe(1);
  });

  test('symmetric discordance → p capped at 1', () => {
    expect(mcNemarExact(5, 5)).toBe(1);
  });

  test('1 vs 9 → p ≈ 0.0215 (significant at 0.05)', () => {
    // n=10, k=1: 2 * (C(10,0) + C(10,1)) / 2^10 = 2 * 11 / 1024
    expect(mcNemarExact(1, 9)).toBeCloseTo((2 * 11) / 1024, 6);
  });

  test('0 vs 5 → p = 0.0625 (a 5-item sweep is NOT yet significant — small-n honesty)', () => {
    expect(mcNemarExact(0, 5)).toBeCloseTo(2 / 32, 6);
  });

  test('binomHalfPmf sums to 1 over the support', () => {
    const n = 12;
    let sum = 0;
    for (let k = 0; k <= n; k += 1) sum += binomHalfPmf(n, k);
    expect(sum).toBeCloseTo(1, 9);
  });
});

describe('computeSignificance — paired run comparison', () => {
  const item = (id, verdict, scores) => ({ item_id: id, verdict, scores });

  test('pairs strictly by item_id; unpaired and verdict-less rows drop out', () => {
    const sig = computeSignificance({
      candidateResults: [
        item('a', 'equivalent'),
        item('b', 'draft_unsafe'),
        item('zzz-not-in-baseline', 'draft_unsafe'),
        item('c', null), // judge never landed — not evidence
      ],
      baselineResults: [item('a', 'draft_unsafe'), item('b', 'equivalent'), item('c', 'equivalent')],
    });
    expect(sig.pairedItems).toBe(2);
    expect(sig.newlySafe).toBe(1); // item a improved
    expect(sig.newlyUnsafe).toBe(1); // item b regressed
    expect(sig.direction).toBe('equal');
    expect(sig.significant).toBe(false);
  });

  test('clear improvement: 9 newly-safe vs 1 newly-unsafe is significant + improved', () => {
    const candidates = [];
    const baseline = [];
    for (let i = 0; i < 9; i += 1) {
      candidates.push(item(`imp${i}`, 'equivalent'));
      baseline.push(item(`imp${i}`, 'draft_unsafe'));
    }
    candidates.push(item('reg', 'draft_unsafe'));
    baseline.push(item('reg', 'equivalent'));
    const sig = computeSignificance({ candidateResults: candidates, baselineResults: baseline });
    expect(sig.direction).toBe('improved');
    expect(sig.significant).toBe(true);
    expect(sig.pValue).toBeLessThan(0.05);
  });

  test('equal discordance is never significant regardless of p', () => {
    const sig = computeSignificance({
      candidateResults: [item('a', 'draft_unsafe'), item('b', 'equivalent')],
      baselineResults: [item('a', 'equivalent'), item('b', 'draft_unsafe')],
    });
    expect(sig.significant).toBe(false);
  });

  test('mean score deltas are paired and informational (string or object scores)', () => {
    const sig = computeSignificance({
      candidateResults: [
        item('a', 'equivalent', JSON.stringify({ safety: 9, voice: 7, overall: 8 })),
        item('b', 'equivalent', { safety: 8, voice: 6, overall: 7 }),
      ],
      baselineResults: [
        item('a', 'equivalent', { safety: 7, voice: 7, overall: 6 }),
        item('b', 'equivalent', JSON.stringify({ safety: 6, voice: 8, overall: 7 })),
      ],
    });
    expect(sig.meanDeltas.safety).toBeCloseTo(2, 5);
    expect(sig.meanDeltas.voice).toBeCloseTo(-1, 5);
    expect(sig.meanDeltas.overall).toBeCloseTo(1, 5);
  });

  test('parseScores tolerates strings, objects, junk', () => {
    expect(parseScores('{"safety":9}')).toEqual({ safety: 9 });
    expect(parseScores({ safety: 9 })).toEqual({ safety: 9 });
    expect(parseScores('not json')).toBeNull();
    expect(parseScores(null)).toBeNull();
  });
});

/**
 * evaluateExamGate — routing fake dbi: items count + runs list are the only
 * two queries getSealedExamSummary makes.
 */
function makeSummaryDb({ active = 0, total = 0, runs = [] } = {}) {
  const dbi = (table) => {
    const builder = { _wheres: [], _first: false, _limit: null };
    const rec = (name) => (...args) => {
      if (name === 'where' && typeof args[0] === 'object') builder._wheres.push(args[0]);
      if (name === 'first') builder._first = true;
      if (name === 'limit') builder._limit = args[0];
      return builder;
    };
    for (const m of ['where', 'whereIn', 'whereNot', 'orderBy', 'limit', 'count', 'select', 'first']) builder[m] = rec(m);
    builder.then = (resolve, reject) => Promise.resolve().then(() => {
      if (table === 'sms_sealed_eval_items') return [{ total: String(total), active }];
      let rows = runs.filter((r) => builder._wheres.every((w) => Object.entries(w).every(([k, v]) => r[k] === v)));
      if (builder._limit != null) rows = rows.slice(0, builder._limit);
      return builder._first ? rows[0] : rows;
    }).then(resolve, reject);
    return builder;
  };
  dbi.raw = (sql) => sql;
  return dbi;
}

const CURRENT = require('../services/sms-shadow-drafter').PROMPT_VERSION;
const completeRun = (leg, over = {}) => ({
  id: `run-${leg}`,
  prompt_version: CURRENT,
  provider_leg: leg,
  status: 'complete',
  items_total: 50,
  items_judged: 50,
  unsafe_count: 1,
  avg_safety: 9.1,
  significance: null,
  started_at: '2026-07-18T00:00:00Z',
  ...over,
});

describe('evaluateExamGate — fail-closed blockers', () => {
  test('no sealed items → single blocker, nothing passes by default', async () => {
    const blockers = await evaluateExamGate({ dbi: makeSummaryDb({ active: 0 }) });
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatch(/no sealed items/);
  });

  test('missing a leg run blocks that leg by name', async () => {
    const dbi = makeSummaryDb({ active: 50, total: 50, runs: [completeRun('anthropic')] });
    const blockers = await evaluateExamGate({ dbi });
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatch(/no completed openai run/);
  });

  test('both legs complete and clean → no blockers (gate passes)', async () => {
    const dbi = makeSummaryDb({ active: 50, total: 50, runs: EXAM_LEGS.map((l) => completeRun(l)) });
    await expect(evaluateExamGate({ dbi })).resolves.toEqual([]);
  });

  test('unsafe rate over the graduation cap blocks', async () => {
    const dbi = makeSummaryDb({
      active: 50,
      total: 50,
      runs: [completeRun('anthropic', { unsafe_count: 10 }), completeRun('openai')], // 20% > 8%
    });
    const blockers = await evaluateExamGate({ dbi });
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatch(/anthropic.*unsafe rate 20%/);
  });

  test('a significant regression vs baseline blocks even under the unsafe cap', async () => {
    const dbi = makeSummaryDb({
      active: 50,
      total: 50,
      runs: [
        completeRun('anthropic', {
          significance: JSON.stringify({ significant: true, direction: 'regressed', pValue: 0.01 }),
        }),
        completeRun('openai'),
      ],
    });
    const blockers = await evaluateExamGate({ dbi });
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatch(/significant regression/);
  });

  test("a leg's headline run is found even when 20+ newer reruns push it out of the display window", async () => {
    // 25 newer openai reruns + one older completed anthropic run. Selecting
    // legs from the 20-row history would lose the anthropic run and falsely
    // block graduation on "no completed anthropic run".
    const filler = Array.from({ length: 25 }, (_, i) => completeRun('openai', { id: `f${i}`, started_at: `2026-07-18T05:${String(i).padStart(2, '0')}:00Z` }));
    const dbi = makeSummaryDb({
      active: 50,
      total: 50,
      runs: [...filler, completeRun('anthropic', { started_at: '2026-07-01T00:00:00Z' })],
    });
    await expect(evaluateExamGate({ dbi })).resolves.toEqual([]);
  });

  test('a stale version run does not satisfy the current-version requirement', async () => {
    const dbi = makeSummaryDb({
      active: 50,
      total: 50,
      runs: EXAM_LEGS.map((l) => completeRun(l, { prompt_version: 'house_voice_v0_stale' })),
    });
    const blockers = await evaluateExamGate({ dbi });
    expect(blockers).toHaveLength(2); // both legs unexamined for the CURRENT version
  });
});
