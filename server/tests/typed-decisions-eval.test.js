/**
 * Typed-decisions evaluation: exact-binomial lower bounds, the representative
 * vs development split, the §9 tiers and their blockers, the capability
 * roll-up, and the read-only status query. Pure logic plus a capturing fake
 * connection; no DB.
 */
jest.mock('../models/db', () => jest.fn());

const {
  TIERS, CONFIDENCE, binomialLowerBound, labelsToFloor, scoreRows, clampDays, evaluateCapabilities,
} = require('../services/typed-decisions/eval');

const noul = (p, confident = true) => JSON.stringify({ p, yes: p >= 0.5, confident });
const label = (verdict, correct_value = null) => JSON.stringify({ verdict, correct_value, note: null });
const status = { jev_right: 'confirmed_correct', jev_wrong: 'confirmed_error', unclear: 'disagreement' };

// One labeled sms_courtesy row (a yes/no question in a registered package).
function row({ verdict = 'jev_right', p = 0.9, confident = true, sampled = 'random_audit', correct = null, question = 'is_courtesy_only', pkg = 'sms_courtesy.v1', capability = 'sms_courtesy', model = 'jev-1.13.0' } = {}) {
  return {
    capability, package_id: pkg, question_id: question, served_model: model, sampled_for: sampled,
    label_status: status[verdict], jev_answer: noul(p, confident), label: label(verdict, correct),
  };
}
const rows = (n, over) => Array.from({ length: n }, () => row(over));

describe('binomialLowerBound (95% one-sided, exact)', () => {
  test('k = n gives alpha^(1/n): 29/29 clears 0.90, 59/59 clears 0.95, 598/598 clears 0.995', () => {
    expect(binomialLowerBound(29, 29)).toBeCloseTo(0.9018, 3);
    expect(binomialLowerBound(59, 59)).toBeCloseTo(0.9505, 3);
    expect(binomialLowerBound(598, 598)).toBeCloseTo(0.9950, 3);
    expect(binomialLowerBound(58, 58)).toBeLessThan(0.95);
    expect(binomialLowerBound(597, 597)).toBeLessThan(0.995);
  });

  test('no successes, or no trials, bounds at 0; successes above trials is an error', () => {
    expect(binomialLowerBound(0, 10)).toBe(0);
    expect(binomialLowerBound(0, 0)).toBe(0);
    expect(binomialLowerBound(3, 0)).toBe(0);
    expect(() => binomialLowerBound(5, 4)).toThrow(RangeError);
  });

  test('k < n solves the exact tail: 90 of 100 bounds near 0.83, and the bound rises with k', () => {
    const b = binomialLowerBound(90, 100);
    expect(b).toBeGreaterThan(0.82);
    expect(b).toBeLessThan(0.85);
    expect(binomialLowerBound(50, 100)).toBeLessThan(b);
    expect(binomialLowerBound(99, 100)).toBeGreaterThan(b);
    // a point estimate never clears the bar the bound is for
    expect(b).toBeLessThan(0.9);
  });

  test('a different confidence moves the bound the right way', () => {
    expect(binomialLowerBound(59, 59, { confidence: 0.99 })).toBeLessThan(binomialLowerBound(59, 59));
    expect(CONFIDENCE).toBe(0.95);
  });
});

describe('labelsToFloor', () => {
  test('counts the all-correct labels still needed: 40/40 needs 19 more for 0.95 (59 clears it), 70/70 needs 528 more for 0.995', () => {
    expect(labelsToFloor({ numerator: 40, denominator: 40 }, 0.95)).toBe(19);
    expect(labelsToFloor({ numerator: 70, denominator: 70 }, 0.995)).toBe(528);
    expect(labelsToFloor({ numerator: 0, denominator: 0 }, 0.9)).toBe(29);
  });
});

describe('scoreRows — tiers from the representative set only', () => {
  test('60 all-correct random-audit labels reach tier 1; the tier 2 blocker names precision and the labels still needed', () => {
    const labeled = [...rows(40, { p: 0.9 }), ...rows(20, { p: 0.1 })];
    const [cap] = scoreRows(labeled, []);
    const [q] = cap.questions;
    expect(q.type).toBe('noul');
    expect(q.representative.counts).toMatchObject({ labeled: 60, correct: 60, errors: 0, unclear: 0, tp: 40, tn: 20, fp: 0, fn: 0 });
    expect(q.representative.metrics.precision).toMatchObject({ value: 1, numerator: 40, denominator: 40 });
    expect(q.representative.metrics.precision.lowerBound).toBeCloseTo(0.9278, 3);
    expect(q.tier).toBe(1);
    expect(q.nextTier).toBe(2);
    expect(q.blocker).toMatch(/Tier 2 \(reversible internal automation\): precision 1 \(lower bound 0\.9278, 40\/40\) is below 0\.95; about 19 more/);
    expect(cap).toMatchObject({ capability: 'sms_courtesy', servedModel: 'jev-1.13.0', tier: 1, nextTier: 2, packageIds: ['sms_courtesy.v1'] });
    expect(cap.labeled).toEqual({ representative: 60, development: 0 });
  });

  test('70 confident all-correct yes labels reach tier 2; tier 3 needs about 528 more', () => {
    const [cap] = scoreRows(rows(70, { p: 0.95 }), []);
    const [q] = cap.questions;
    expect(q.tier).toBe(2);
    expect(q.nextTier).toBe(3);
    expect(q.representative.metrics.acceptedCorrect).toMatchObject({ numerator: 70, denominator: 70 });
    expect(q.blocker).toMatch(/Tier 3 \(narrow customer-flow automation\): correct among confident answers .* is below 0\.995; about 528 more/);
  });

  test('development (disagreement) labels never clear a tier, however many and however good', () => {
    const [cap] = scoreRows(rows(200, { sampled: 'disagreement' }), []);
    const [q] = cap.questions;
    expect(q.development.counts.labeled).toBe(200);
    expect(q.representative.counts.labeled).toBe(0);
    expect(q.tier).toBe(0);
    expect(q.blocker).toMatch(/No representative labels yet/);
    expect(cap.labeled).toEqual({ representative: 0, development: 200 });
  });

  test('held-out rows count as representative; labels outside any sample are shown, never scored', () => {
    const [cap] = scoreRows([...rows(5, { sampled: 'heldout' }), ...rows(3, { sampled: null })], []);
    const [q] = cap.questions;
    expect(q.representative.counts.labeled).toBe(5);
    expect(q.otherLabeled).toBe(3);
  });

  test('wrong answers land in the right cell: a yes called wrong is a false positive, a no called wrong with correct_value true is a false negative', () => {
    const labeled = [
      row({ verdict: 'jev_wrong', p: 0.9, correct: false }),
      row({ verdict: 'jev_wrong', p: 0.2, correct: true }),
      row({ verdict: 'jev_wrong', p: 0.8 }), // no correct_value: read as the opposite answer
      ...rows(7, { p: 0.9 }),
    ];
    const [cap] = scoreRows(labeled, []);
    const c = cap.questions[0].representative.counts;
    expect(c).toMatchObject({ labeled: 10, correct: 7, errors: 3, tp: 7, fp: 2, fn: 1, tn: 0, actionable: 8 });
    expect(cap.questions[0].representative.metrics.recall).toMatchObject({ numerator: 7, denominator: 8 });
  });

  test('unclear labels are counted and excluded from every rate', () => {
    const [cap] = scoreRows([...rows(10), row({ verdict: 'unclear' }), row({ verdict: 'unclear' })], []);
    const c = cap.questions[0].representative.counts;
    expect(c.unclear).toBe(2);
    expect(c.labeled).toBe(10);
    expect(cap.labeled.representative).toBe(12);
  });

  test('unconfident answers are not "accepted": they count for precision, not for the tier 3 automation rates', () => {
    const [cap] = scoreRows([...rows(10, { confident: true }), ...rows(10, { confident: false })], []);
    const m = cap.questions[0].representative.metrics;
    expect(m.precision).toMatchObject({ numerator: 20, denominator: 20 });
    expect(m.acceptedCorrect).toMatchObject({ numerator: 10, denominator: 10 });
    expect(m.actionableRecall).toMatchObject({ numerator: 10, denominator: 20 });
  });

  test('a second provider on the same question reports beside the first, keyed by served model', () => {
    const caps = scoreRows([...rows(10, { model: 'jev-1.13.0' }), ...rows(10, { model: 'clef-flash' })], []);
    expect(caps.map((c) => c.servedModel).sort()).toEqual(['clef-flash', 'jev-1.13.0']);
    expect(caps.every((c) => c.questions[0].representative.counts.labeled === 10)).toBe(true);
  });

  test('a capability takes the lowest tier of its questions and that question\'s blocker', () => {
    const labeled = [
      ...rows(70, { capability: 'call_judge', pkg: 'call_judge.v2', question: 'is_spam', p: 0.95 }),
      ...rows(5, { capability: 'call_judge', pkg: 'call_judge.v2', question: 'is_lead', p: 0.95 }),
    ];
    const [cap] = scoreRows(labeled, []);
    expect(cap.questions.map((q) => [q.questionId, q.tier])).toEqual([['is_lead', 0], ['is_spam', 2]]);
    expect(cap.tier).toBe(0);
    expect(cap.nextTier).toBe(1);
    expect(cap.blocker).toMatch(/Tier 1 \(reviewed suggestions\): precision .* 5\/5/);
    expect(cap.labeled.representative).toBe(75);
  });

  test('coverage counts every recorded answer, labeled or not, and the confident share', () => {
    const coverage = [{ capability: 'sms_courtesy', package_id: 'sms_courtesy.v1', question_id: 'is_courtesy_only', served_model: 'jev-1.13.0', answered: '400', confident: '300' }];
    const [cap] = scoreRows(rows(3), coverage);
    expect(cap.questions[0].coverage).toEqual({ answered: 400, confident: 300, confidentShare: 0.75 });
    const [bare] = scoreRows([], coverage);
    expect(bare.questions[0].representative.counts.labeled).toBe(0);
    expect(bare.tier).toBe(0);
  });

  test('a choice question (no yes class) reports accuracy as precision and recall, and says so; the type is read from the answer when the package is unregistered', () => {
    const choice = (verdict, correct = null) => ({
      capability: 'routing', package_id: 'routing.v0', question_id: 'team', served_model: 'clef-flash', sampled_for: 'random_audit',
      label_status: status[verdict], jev_answer: JSON.stringify({ choice: 'billing', confidence: 0.9, probabilities: {}, confident: true }), label: label(verdict, correct),
    });
    const labeled = [choice('jev_right'), choice('jev_right'), choice('jev_right'), choice('jev_right'), choice('jev_right'), choice('jev_wrong', 'technical')];
    const [cap] = scoreRows(labeled, []);
    const [q] = cap.questions;
    expect(q.type).toBe('choice');
    expect(q.note).toMatch(/No yes class/);
    expect(q.representative.metrics.precision).toEqual(q.representative.metrics.accuracy);
    expect(q.representative.metrics.accuracy).toMatchObject({ numerator: 5, denominator: 6 });
    expect(q.representative.counts).toMatchObject({ tp: 0, fp: 0, fn: 0, tn: 0, actionable: 0 });
  });

  test('a stored answer whose shape fits no type is counted as unclear, never scored', () => {
    const odd = { ...row(), package_id: 'gone.v1', jev_answer: JSON.stringify({ mystery: 1 }) };
    const [cap] = scoreRows([odd], []);
    expect(cap.questions[0].type).toBeNull();
    expect(cap.questions[0].representative.counts).toMatchObject({ labeled: 0, unclear: 1 });
  });

  test('unreviewed rows are ignored even if handed in', () => {
    const [cap] = scoreRows([{ ...row(), label_status: 'unreviewed', label: null }, row()], []);
    expect(cap.questions[0].representative.counts.labeled).toBe(1);
  });

  test('tiers are judged on the full-precision bound: 597/597 (0.99499) does not round up past 0.995, 598/598 does clear it', () => {
    const [almost] = scoreRows(rows(597, { p: 0.95 }), []);
    expect(almost.questions[0].tier).toBe(2);
    expect(almost.questions[0].representative.metrics.acceptedCorrect.lowerBound).toBe(0.995); // display rounding only
    expect(almost.questions[0].blocker).toMatch(/about 1 more/);
    const [clears] = scoreRows(rows(598, { p: 0.95 }), []);
    expect(clears.questions[0].tier).toBe(3);
    expect(clears.questions[0].nextTier).toBeNull();
    expect(clears.questions[0].blocker).toBeNull();
  });

  test('a group opened by a coverage row for an unregistered package still learns its type from the labeled answers', () => {
    const coverage = [{ capability: 'gone', package_id: 'gone.v1', question_id: 'q', served_model: 'jev-1.13.0', answered: 40, confident: 30 }];
    const [cap] = scoreRows(rows(10, { capability: 'gone', pkg: 'gone.v1', question: 'q' }), coverage);
    expect(cap.questions[0].type).toBe('noul');
    expect(cap.questions[0].representative.counts).toMatchObject({ labeled: 10, unclear: 0 });
    expect(cap.questions[0].coverage.answered).toBe(40);
  });

  test('the tiers are the owner\'s floors, in order', () => {
    expect(TIERS.map((t) => t.tier)).toEqual([1, 2, 3]);
    expect(TIERS[0].floors).toEqual({ precision: 0.9, recall: 0.9 });
    expect(TIERS[1].floors).toEqual({ precision: 0.95, recall: 0.95 });
    expect(TIERS[2].floors).toEqual({ acceptedCorrect: 0.995, actionableRecall: 0.99 });
  });
});

describe('evaluateCapabilities — the read-only status query', () => {
  // Chainable, thenable fake: each await resolves the next prepared result.
  function fakeConn(results) {
    const calls = [];
    let i = 0;
    const b = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') { const r = results[i++] || []; return (res, rej) => Promise.resolve(r).then(res, rej); }
        return (...a) => { calls.push([prop, a]); return b; };
      },
    });
    const conn = () => b;
    conn.raw = (sql) => ({ sql });
    conn.calls = calls;
    return conn;
  }

  test('reads labeled rows and grouped answer counts inside the window, then scores them', async () => {
    const now = new Date('2026-10-02T00:00:00Z');
    const conn = fakeConn([
      rows(60, { p: 0.9 }),
      [{ capability: 'sms_courtesy', package_id: 'sms_courtesy.v1', question_id: 'is_courtesy_only', served_model: 'jev-1.13.0', answered: 500, confident: 450 }],
    ]);
    const out = await evaluateCapabilities({ days: 30, now, conn });
    expect(out).toMatchObject({ windowDays: 30, confidence: 0.95, generatedAt: now.toISOString() });
    expect(out.tiers).toBe(TIERS);
    expect(out.capabilities).toHaveLength(1);
    expect(out.capabilities[0]).toMatchObject({ capability: 'sms_courtesy', tier: 2 });
    expect(out.capabilities[0].questions[0].coverage).toEqual({ answered: 500, confident: 450, confidentShare: 0.9 });
    const since = new Date('2026-09-02T00:00:00Z');
    expect(conn.calls.filter(([m]) => m === 'where')).toEqual([['where', ['created_at', '>=', since]], ['where', ['created_at', '>=', since]]]);
    expect(conn.calls).toContainEqual(['whereIn', ['label_status', ['confirmed_correct', 'confirmed_error', 'disagreement']]]);
    expect(conn.calls).toContainEqual(['groupBy', ['capability', 'package_id', 'question_id', 'served_model']]);
    expect(conn.calls.some(([m, a]) => m === 'select' && a[0] && /FILTER \(WHERE \(jev_answer->>'confident'\)::boolean\)/.test(a[0].sql))).toBe(true);
    // reads only
    expect(conn.calls.some(([m]) => ['insert', 'update', 'delete'].includes(m))).toBe(false);
  });

  test('the window is clamped: nothing below 1 day, nothing above 365, default 90', () => {
    expect(clampDays(0)).toBe(1);
    expect(clampDays('9999')).toBe(365);
    expect(clampDays(undefined)).toBe(90);
    expect(clampDays('x')).toBe(90);
  });

  test('a database error propagates (the route maps it); nothing is swallowed into an empty status', async () => {
    const conn = () => { throw new Error('relation missing'); };
    conn.raw = () => ({});
    await expect(evaluateCapabilities({ conn })).rejects.toThrow(/relation missing/);
  });
});
