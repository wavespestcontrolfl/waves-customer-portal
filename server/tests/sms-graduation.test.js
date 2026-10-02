/**
 * SMS graduation readiness engine — pure-logic coverage (no DB, no LLM).
 * Guards the Phase E gate: an intent graduates only when the data earns it.
 */
const { evaluateRung, evaluateAutoSendHealth, resolveCohortVersions, THRESHOLDS, LADDER } = require('../services/sms-graduation');

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

describe('judge-signal cohort (superseded prompt versions are not readiness evidence)', () => {
  test('default cohort = the current drafter version only', () => {
    expect(resolveCohortVersions({ raw: undefined, currentVersion: 'house_voice_v8' })).toEqual(['house_voice_v8']);
    expect(resolveCohortVersions({ raw: '   ', currentVersion: 'house_voice_v8' })).toEqual(['house_voice_v8']);
  });

  test('default tracks the LIVE drafter PROMPT_VERSION (no drift between modules)', () => {
    const { PROMPT_VERSION } = require('../services/sms-shadow-drafter');
    expect(resolveCohortVersions({ raw: undefined })).toEqual([PROMPT_VERSION]);
  });

  test('default tracks currentPromptVersion(), not the static PROMPT_VERSION — GATE_SMS_REAL_ANSWERS on shifts the cohort to v12 (pre-push audit P1)', () => {
    // PROMPT_VERSION never moves once the real-answers gate goes live (it
    // stays house_voice_v11 forever, by design — see sms-shadow-drafter.js).
    // Readiness evidence must track whichever prompt is ACTUALLY drafting
    // right now, or a gate flip would silently freeze the cohort on a
    // drafter that stopped running and never count the new prompt's own
    // evidence.
    const drafter = require('../services/sms-shadow-drafter');
    const prior = process.env.GATE_SMS_REAL_ANSWERS;
    try {
      delete process.env.GATE_SMS_REAL_ANSWERS;
      expect(resolveCohortVersions({ raw: undefined })).toEqual([drafter.PROMPT_VERSION]);

      process.env.GATE_SMS_REAL_ANSWERS = 'true';
      expect(resolveCohortVersions({ raw: undefined })).toEqual([drafter.REAL_ANSWERS_PROMPT_VERSION]);
      expect(drafter.REAL_ANSWERS_PROMPT_VERSION).not.toBe(drafter.PROMPT_VERSION);

      // and back off again — no residue from the flip
      process.env.GATE_SMS_REAL_ANSWERS = 'false';
      expect(resolveCohortVersions({ raw: undefined })).toEqual([drafter.PROMPT_VERSION]);
    } finally {
      if (prior === undefined) delete process.env.GATE_SMS_REAL_ANSWERS;
      else process.env.GATE_SMS_REAL_ANSWERS = prior;
    }
  });

  test('a list naming the current version pools it with compatible priors (trimmed, empties dropped, deduped)', () => {
    expect(resolveCohortVersions({ raw: ' house_voice_v7 , house_voice_v8 ,', currentVersion: 'house_voice_v8' }))
      .toEqual(['house_voice_v7', 'house_voice_v8']);
  });

  test('a stale override omitting the current version is discarded — old evidence can neither exclude the running drafter nor qualify a new prompt (Codex P1 ×2)', () => {
    expect(resolveCohortVersions({ raw: 'house_voice_v7', currentVersion: 'house_voice_v8' }))
      .toEqual(['house_voice_v8']);
  });

  test("'all_live' restores the pre-cohort behavior (null = no version filter)", () => {
    expect(resolveCohortVersions({ raw: 'all_live', currentVersion: 'x' })).toBeNull();
    expect(resolveCohortVersions({ raw: 'ALL_LIVE', currentVersion: 'x' })).toBeNull();
  });

  test('a degenerate override (only commas/spaces) falls back to the current version', () => {
    expect(resolveCohortVersions({ raw: ' , ,  ', currentVersion: 'house_voice_v8' })).toEqual(['house_voice_v8']);
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

describe('suggest → auto_send via judge-graded replies (owner ruling 2026-10-01, D2)', () => {
  // Path (b): the nightly judge grades a live draft against the reply a human
  // actually sent. draft_better + equivalent = accepted, human_better +
  // draft_unsafe = corrected. Cards go unworked at Waves' volume, so this is
  // the path a reply intent can actually earn.
  const noHuman = { accepted: 0, corrected: 0, ignored: 0 };
  const cleanBackstop = { recentUnsafe: 0, judged: 80 };

  test('judge-graded evidence alone earns auto_send when the backstop is clean', () => {
    const r = evalR({ mode: 'suggest', suggest: noHuman, judge: { ...cleanBackstop, gradedAccepted: 70, gradedCorrected: 6 } }); // 76 graded, 92% / 8%
    expect(r.eligible).toBe(true);
    expect(r.basis).toBe('judge_graded');
    expect(r.nextRung).toBe('auto_send');
    expect(r.blockers).toEqual([]);
  });

  test('human decisions remain a first-class path and name their basis', () => {
    const r = evalR({ mode: 'suggest', suggest: { accepted: 90, corrected: 6, ignored: 4 }, judge: { ...cleanBackstop, gradedAccepted: 10, gradedCorrected: 30 } });
    expect(r.eligible).toBe(true);
    expect(r.basis).toBe('human_outcomes');
  });

  test('the 2026-10-01 prod shape (0 unsafe, humans mostly better) does NOT graduate, and both paths are explained', () => {
    // prod, 30 d: 0 unsafe; 34 equivalent-or-better vs 80 human-better; 9 human decisions ever.
    const r = evalR({ mode: 'suggest', suggest: { accepted: 2, corrected: 7, ignored: 0 }, judge: { recentUnsafe: 0, judged: 114, gradedAccepted: 34, gradedCorrected: 80 } });
    expect(r.eligible).toBe(false);
    expect(r.basis).toBeNull();
    const text = r.blockers.join(' ');
    expect(text).toMatch(/Needs 51 more human-decided suggestions \(9\/60\)/);
    expect(text).toMatch(/Judge path: equivalent-or-better 30% < 85% required/);
    expect(text).toMatch(/Judge path: human-better 70% > 10% cap/);
  });

  test('too few graded replies reports the exact shortfall', () => {
    const r = evalR({ mode: 'suggest', suggest: noHuman, judge: { ...cleanBackstop, gradedAccepted: 20, gradedCorrected: 1 } });
    expect(r.eligible).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/Judge path: needs 39 more judge-graded replies \(21\/60\)/);
  });

  test('a single recent unsafe blocks the judge path too (shared backstop), without re-listing a clear path', () => {
    const r = evalR({ mode: 'suggest', suggest: noHuman, judge: { recentUnsafe: 1, judged: 80, gradedAccepted: 75, gradedCorrected: 3 } });
    expect(r.eligible).toBe(false);
    expect(r.basis).toBeNull();
    expect(r.blockers.join(' ')).toMatch(/1 unsafe in last 30 judged/);
    expect(r.blockers.join(' ')).not.toMatch(/Judge path/);
  });

  test('an empty backstop blocks the judge path exactly like the human path', () => {
    const r = evalR({ mode: 'suggest', suggest: noHuman, judge: { recentUnsafe: 0, judged: 8, gradedAccepted: 70, gradedCorrected: 2 } });
    expect(r.eligible).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/22 more live judged drafts for the safety backstop \(8\/30\)/);
  });

  test('draft_unsafe counts as a correction on the judge path (rate math), never as accepted', () => {
    const r = evalR({ mode: 'suggest', suggest: noHuman, judge: { recentUnsafe: 0, judged: 80, gradedAccepted: 60, gradedCorrected: 8 } }); // 68 graded, 88% / 12%
    expect(r.eligible).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/Judge path: human-better 12% > 10% cap/);
  });

  test('no-reply verdicts carry no ground truth: scored volume alone never satisfies the judge path', () => {
    const r = evalR({ mode: 'suggest', suggest: noHuman, judge: { recentUnsafe: 0, judged: 200 } });
    expect(r.eligible).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/Judge path: needs 60 more judge-graded replies \(0\/60\)/);
  });

  test('judge signal unavailable fails CLOSED for the judge path as well', () => {
    const r = evalR({ mode: 'suggest', suggest: noHuman, judge: { gradedAccepted: 70, gradedCorrected: 2, judged: 80 }, judgeAvailable: false });
    expect(r.eligible).toBe(false);
    expect(r.basis).toBeNull();
  });

  test('judge-path bars default to the human-path bars (separately env-tunable)', () => {
    const t = THRESHOLDS.suggestToAutosend;
    expect(t.minGraded).toBe(t.minDecided);
    expect(t.minGradedAcceptedRate).toBe(t.minAcceptedRate);
    expect(t.maxGradedCorrectedRate).toBe(t.maxCorrectedRate);
    // a thresholds object that predates the judge-path keys (like T above) still evaluates it
    const r = evalR({ mode: 'suggest', suggest: noHuman, judge: { ...cleanBackstop, gradedAccepted: 55, gradedCorrected: 5 } });
    expect(r.eligible).toBe(true);
    expect(r.basis).toBe('judge_graded');
  });

  test('a stricter judge-path bar is honored when supplied', () => {
    const strict = { ...T, suggestToAutosend: { ...T.suggestToAutosend, minGraded: 100 } };
    const r = evaluateRung({ thresholds: strict, mode: 'suggest', suggest: noHuman, judge: { ...cleanBackstop, gradedAccepted: 70, gradedCorrected: 6 } });
    expect(r.eligible).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/Judge path: needs 24 more judge-graded replies \(76\/100\)/);
  });

  test('active auto-send health carries the basis the executor would send on', () => {
    const h = evaluateAutoSendHealth({ suggest: noHuman, judge: { ...cleanBackstop, gradedAccepted: 70, gradedCorrected: 6 } });
    expect(h.sendReady).toBe(true);
    expect(h.basis).toBe('judge_graded');
    const gated = evaluateAutoSendHealth({ suggest: noHuman, judge: { recentUnsafe: 0, judged: 0 } });
    expect(gated.sendReady).toBe(false);
    expect(gated.basis).toBeNull();
  });
});

describe('top of ladder', () => {
  test('auto_send has no further rung', () => {
    const r = evalR({ mode: 'auto_send' });
    expect(r.nextRung).toBeNull();
    expect(r.eligible).toBe(true);
  });
});

describe('active auto-send health (Codex P1: UI must mirror the send-time gate)', () => {
  const good = { accepted: 90, corrected: 6, ignored: 4 };

  test('an intent whose data still clears the rung reads send-ready', () => {
    const h = evaluateAutoSendHealth({ suggest: good, judge: { recentUnsafe: 0, judged: 40 } });
    expect(h.sendReady).toBe(true);
    expect(h.blockers).toEqual([]);
  });

  test('a prompt bump that reset the cohort evidence reads gated, with the executor blockers', () => {
    // Fresh version: zero cohort judged, zero cohort decided — exactly what
    // the send-time gate sees, so the UI must show gated, not top-of-ladder.
    const h = evaluateAutoSendHealth({ suggest: { accepted: 0, corrected: 0, ignored: 0 }, judge: { recentUnsafe: 0, judged: 0 } });
    expect(h.sendReady).toBe(false);
    expect(h.blockers.join(' ')).toMatch(/safety backstop/);
  });

  test('judge signal unavailable is not send-ready (fail closed)', () => {
    const h = evaluateAutoSendHealth({ suggest: good, judge: {}, judgeAvailable: false });
    expect(h.sendReady).toBe(false);
  });
});
