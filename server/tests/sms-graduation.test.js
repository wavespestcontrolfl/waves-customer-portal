/**
 * SMS graduation readiness engine — pure-logic coverage (no DB, no LLM).
 * Guards the Phase E gate: an intent graduates only when the data earns it.
 */
const { evaluateRung, THRESHOLDS, LADDER } = require('../services/sms-graduation');

// Fixed thresholds so the tests don't drift with env overrides.
const T = {
  shadowToSuggest: { minJudged: 40, maxUnsafeRate: 0.08, minSafety: 8.0 },
  suggestToAutosend: { minDecided: 60, minAcceptedRate: 0.85, maxCorrectedRate: 0.1, maxRecentUnsafe: 0, recentWindow: 30, minScoredBackstop: 30 },
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
    expect(r.blockers.join(' ')).toMatch(/Avg safety 7.20 < 8.0/);
  });

  test('volume short of the bar reports the exact shortfall', () => {
    const r = evalR({ mode: 'shadow', judge: { judged: 22, unsafe: 0, avgSafety: 9 } });
    expect(r.eligible).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/Needs 18 more live judged drafts \(22\/40\)/);
  });

  test('an absent scored safety signal blocks even with volume (Codex P1: no-score dilution)', () => {
    // judged counts SCORED rows only; if somehow volume is present but no
    // safety average exists, never graduate on a blind safety signal.
    const r = evalR({ mode: 'shadow', judge: { judged: 80, unsafe: 0, avgSafety: null } });
    expect(r.eligible).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/No scored safety signal yet/);
  });

  test('safety gates on FULL precision — 7.96 does not round up past an 8.0 bar (Codex P1)', () => {
    const r = evalR({ mode: 'shadow', judge: { judged: 60, unsafe: 0, avgSafety: 7.96 } });
    expect(r.eligible).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/Avg safety 7.96 < 8.0 required/);
  });
});

describe('suggest → auto_send (outcome-driven, with judge backstop)', () => {
  const good = { accepted: 90, corrected: 6, ignored: 4 }; // 100 decided, 90% accepted, 6% corrected
  const backstop = { recentUnsafe: 0, judged: 40 }; // a populated live scored backstop

  test('high accept-rate, low corrections, populated clean backstop graduates', () => {
    const r = evalR({ mode: 'suggest', suggest: good, judge: backstop });
    expect(r.eligible).toBe(true);
    expect(r.nextRung).toBe('auto_send');
  });

  test('a single recent unsafe is a hard block (the judge backstop)', () => {
    const r = evalR({ mode: 'suggest', suggest: good, judge: { recentUnsafe: 1, judged: 40 } });
    expect(r.eligible).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/1 unsafe in last 30 judged/);
  });

  test('an empty backstop (no live scored judge data) blocks, even on great outcomes (Codex P1)', () => {
    // 100 decided, 90% accepted — but zero live judged: the "0 unsafe in
    // last 30" backstop is vacuous, so it must NOT read send-ready.
    const r = evalR({ mode: 'suggest', suggest: good, judge: { recentUnsafe: 0, judged: 8 } });
    expect(r.eligible).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/22 more live judged drafts for the safety backstop \(8\/30\)/);
  });

  test('too few decided outcomes blocks', () => {
    const r = evalR({ mode: 'suggest', suggest: { accepted: 20, corrected: 1, ignored: 1 }, judge: backstop });
    expect(r.eligible).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/Needs 38 more human-decided suggestions \(22\/60\)/);
  });

  test('staff keeps editing (correction rate over cap) blocks', () => {
    const r = evalR({ mode: 'suggest', suggest: { accepted: 50, corrected: 20, ignored: 10 }, judge: backstop });
    expect(r.eligible).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/Correction rate 25% > 10% cap/);
  });

  test('low accept-rate blocks', () => {
    const r = evalR({ mode: 'suggest', suggest: { accepted: 40, corrected: 5, ignored: 35 }, judge: backstop });
    expect(r.eligible).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/Accepted-verbatim 50% < 85%/);
  });

  test('judge signal unavailable fails CLOSED — never auto_send on outcomes alone (Codex P1)', () => {
    // Strong outcomes that WOULD graduate, but the safety backstop query
    // failed — must block, not fail open to autonomous sending.
    const r = evalR({ mode: 'suggest', suggest: good, judge: {}, judgeAvailable: false });
    expect(r.eligible).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/Live judge signal unavailable/);
  });
});

describe('top of ladder', () => {
  test('auto_send has no further rung', () => {
    const r = evalR({ mode: 'auto_send' });
    expect(r.nextRung).toBeNull();
    expect(r.eligible).toBe(true);
  });
});
