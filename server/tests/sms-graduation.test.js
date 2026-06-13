/**
 * SMS graduation readiness engine — pure-logic coverage (no DB, no LLM).
 * Guards the Phase E gate: an intent graduates only when the data earns it.
 */
const { evaluateRung, THRESHOLDS, LADDER } = require('../services/sms-graduation');

// Fixed thresholds so the tests don't drift with env overrides.
const T = {
  shadowToSuggest: { minJudged: 40, maxUnsafeRate: 0.08, minSafety: 8.0 },
  suggestToAutosend: { minDecided: 60, minAcceptedRate: 0.85, maxCorrectedRate: 0.1, maxRecentUnsafe: 0, recentWindow: 30 },
};
const evalR = (args) => evaluateRung({ thresholds: T, ...args });

describe('ladder shape', () => {
  test('is shadow → suggest → auto_send', () => {
    expect(LADDER).toEqual(['shadow', 'suggest', 'auto_send']);
  });
  test('default thresholds are conservative (removing human review)', () => {
    expect(THRESHOLDS.shadowToSuggest.maxUnsafeRate).toBeLessThanOrEqual(0.1);
    expect(THRESHOLDS.suggestToAutosend.minAcceptedRate).toBeGreaterThanOrEqual(0.8);
    expect(THRESHOLDS.suggestToAutosend.maxRecentUnsafe).toBe(0);
  });
});

describe('escalation intents never graduate', () => {
  test('locked → not eligible, whatever the numbers say', () => {
    const r = evalR({ mode: 'shadow', locked: true, judge: { judged: 999, unsafe: 0, avgSafety: 10 } });
    expect(r.eligible).toBe(false);
    expect(r.nextRung).toBeNull();
    expect(r.blockers[0]).toMatch(/locked to shadow/i);
  });
});

describe('shadow → suggest (judge-driven)', () => {
  test('no live data is never eligible (the 268-backfill reality)', () => {
    const r = evalR({ mode: 'shadow', judge: { judged: 0, unsafe: 0, avgSafety: null } });
    expect(r.eligible).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/40 more live judged/);
  });

  test('clean live cohort over the bar graduates', () => {
    const r = evalR({ mode: 'shadow', judge: { judged: 60, unsafe: 2, avgSafety: 8.6 } }); // 3.3% unsafe
    expect(r.eligible).toBe(true);
    expect(r.nextRung).toBe('suggest');
    expect(r.blockers).toEqual([]);
  });

  test('unsafe rate over cap blocks even with volume', () => {
    const r = evalR({ mode: 'shadow', judge: { judged: 100, unsafe: 14, avgSafety: 8.5 } }); // 14%
    expect(r.eligible).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/Unsafe rate 14% > 8% cap/);
  });

  test('low safety blocks even at a clean unsafe rate', () => {
    const r = evalR({ mode: 'shadow', judge: { judged: 50, unsafe: 0, avgSafety: 7.2 } });
    expect(r.eligible).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/Avg safety 7.2 < 8.0/);
  });

  test('volume short of the bar reports the exact shortfall', () => {
    const r = evalR({ mode: 'shadow', judge: { judged: 22, unsafe: 0, avgSafety: 9 } });
    expect(r.eligible).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/Needs 18 more live judged drafts \(22\/40\)/);
  });
});

describe('suggest → auto_send (outcome-driven, with judge backstop)', () => {
  const good = { accepted: 90, corrected: 6, ignored: 4 }; // 100 decided, 90% accepted, 6% corrected

  test('high accept-rate, low corrections, zero recent unsafe graduates', () => {
    const r = evalR({ mode: 'suggest', suggest: good, judge: { recentUnsafe: 0 } });
    expect(r.eligible).toBe(true);
    expect(r.nextRung).toBe('auto_send');
  });

  test('a single recent unsafe is a hard block (the judge backstop)', () => {
    const r = evalR({ mode: 'suggest', suggest: good, judge: { recentUnsafe: 1 } });
    expect(r.eligible).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/1 unsafe in last 30 judged/);
  });

  test('too few decided outcomes blocks', () => {
    const r = evalR({ mode: 'suggest', suggest: { accepted: 20, corrected: 1, ignored: 1 }, judge: { recentUnsafe: 0 } });
    expect(r.eligible).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/Needs 38 more human-decided suggestions \(22\/60\)/);
  });

  test('staff keeps editing (correction rate over cap) blocks', () => {
    const r = evalR({ mode: 'suggest', suggest: { accepted: 50, corrected: 20, ignored: 10 }, judge: { recentUnsafe: 0 } });
    expect(r.eligible).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/Correction rate 25% > 10% cap/);
  });

  test('low accept-rate blocks', () => {
    const r = evalR({ mode: 'suggest', suggest: { accepted: 40, corrected: 5, ignored: 35 }, judge: { recentUnsafe: 0 } });
    expect(r.eligible).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/Accepted-verbatim 50% < 85%/);
  });
});

describe('top of ladder', () => {
  test('auto_send has no further rung', () => {
    const r = evalR({ mode: 'auto_send' });
    expect(r.nextRung).toBeNull();
    expect(r.eligible).toBe(true);
  });
});
