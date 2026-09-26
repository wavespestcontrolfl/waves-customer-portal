/**
 * Sandy slice 1, PR D — server/scripts/run-voice-relay-benchmark.js.
 *
 * Two things this file pins:
 *
 *   1. The eval CLI's `status: 'inconclusive'` (exit 3) is valid JSON but NOT
 *      a completed run — runOnce/summarizeCondition must never fold it into
 *      `ranOk`, must preserve its error, and the whole benchmark must report
 *      a non-zero exitCode for it, the same as a real crash.
 *   2. The eval CLI's retry-once wrapper only returns its SELECTED
 *      finalAttempt in `result.summary` — summarizeCondition must aggregate
 *      every entry in `result.attempts` instead, so a first-attempt critical
 *      miss a pass-on-retry clears is still visible in the report, and
 *      retried/flaky runs are counted separately from the pass/fail sums.
 *
 * No live model or phone calls: `execFileImpl` is a plain stub matching
 * execFile's own (file, args, opts, cb) callback shape — the same pattern
 * voice-relay-eval.test.js uses to stub runVoiceRelayEvalProcess's child
 * process. Never a real run-voice-relay-eval.js invocation.
 */

const {
  runOnce,
  summarizeCondition,
  runBenchmark,
  rotateConditions,
  buildConditions,
  assertOnlyHasIds,
  CHILD_TIMEOUT_MS,
} = require('../scripts/run-voice-relay-benchmark');

// A stub child process: each call consumes the next queued response (the
// last one repeats if more calls happen than responses were queued).
function stubChild(responses) {
  let call = 0;
  return (file, args, opts, cb) => {
    const { code = 0, stdout = '', stderr = '' } = responses[Math.min(call, responses.length - 1)];
    call += 1;
    const err = code === 0 ? null : Object.assign(new Error(`exit ${code}`), { code });
    cb(err, stdout, stderr);
  };
}

const CONDITION = { id: 'current-block', env: {} };

describe('runOnce — a completed run vs. an inconclusive one vs. a real crash', () => {
  test('status "pass" (exit 0) is a completed run', async () => {
    const execFileImpl = stubChild([{
      code: 0,
      stdout: JSON.stringify({ status: 'pass', summary: { scenarios: 5, passed: 5 }, attempts: [{ status: 'pass', summary: { scenarios: 5, passed: 5 } }] }),
    }]);
    const r = await runOnce(CONDITION, 0, { execFileImpl });
    expect(r.ranOk).toBe(true);
    expect(r.inconclusive).toBe(false);
    expect(r.crashError).toBeNull();
  });

  test('status "fail" (exit 1) is STILL a completed run — a scenario-level miss is not a crash', async () => {
    const execFileImpl = stubChild([{
      code: 1,
      stdout: JSON.stringify({ status: 'fail', summary: { scenarios: 5, failed: 1 }, attempts: [{ status: 'fail', summary: { scenarios: 5, failed: 1 } }] }),
    }]);
    const r = await runOnce(CONDITION, 0, { execFileImpl });
    expect(r.ranOk).toBe(true);
    expect(r.inconclusive).toBe(false);
    expect(r.crashError).toBeNull();
  });

  test('status "inconclusive" (exit 3) is NOT ranOk, is flagged inconclusive, and its error is preserved', async () => {
    const execFileImpl = stubChild([{
      code: 3,
      stdout: JSON.stringify({
        status: 'inconclusive',
        error: { message: 'no scenario completed a model round — model unavailable' },
        attempts: [{ status: 'inconclusive', error: { message: 'no scenario completed a model round — model unavailable' } }],
      }),
    }]);
    const r = await runOnce(CONDITION, 0, { execFileImpl });
    expect(r.ranOk).toBe(false);
    expect(r.inconclusive).toBe(true);
    expect(r.crashError).toMatch(/model unavailable/);
    // The JSON was valid and is still attached — a report can show what the
    // eval itself said, even though it does not count as a completed run.
    expect(r.result.status).toBe('inconclusive');
  });

  test('garbage stdout / a bare crash (exit 2, no JSON) is neither ranOk nor inconclusive', async () => {
    const execFileImpl = stubChild([{ code: 2, stdout: '', stderr: 'Voice relay eval failed to run: boom' }]);
    const r = await runOnce(CONDITION, 0, { execFileImpl });
    expect(r.ranOk).toBe(false);
    expect(r.inconclusive).toBe(false);
    expect(r.crashError).toMatch(/exit 2/);
    expect(r.result).toBeNull();
  });

  // A timeout (execFile's own `timeout` option) kills the child and calls
  // back with `err.killed === true` and `err.signal` set — `err.code` is
  // NOT a number in that case, so this must never be read as a completed or
  // inconclusive run even if a stray write left parseable JSON on stdout
  // (a race between the kill signal and the child's own final write).
  test('a timed-out child is neither ranOk nor inconclusive, even with parseable stdout', async () => {
    const execFileImpl = (file, args, opts, cb) => {
      const err = Object.assign(new Error('command timed out'), { killed: true, signal: 'SIGTERM' });
      cb(err, JSON.stringify({ status: 'pass', summary: { scenarios: 5, passed: 5 }, attempts: [{ status: 'pass', summary: { scenarios: 5, passed: 5 } }] }), '');
    };
    const r = await runOnce(CONDITION, 0, { execFileImpl });
    expect(r.ranOk).toBe(false);
    expect(r.inconclusive).toBe(false);
    expect(r.crashError).toMatch(/timed out/);
  });

  // A signal that did NOT come from our own timeout (e.g. the process was
  // killed externally) must be treated the same way — never a completed run.
  test('a child killed by an external signal (not our own timeout) is neither ranOk nor inconclusive', async () => {
    const execFileImpl = (file, args, opts, cb) => {
      const err = Object.assign(new Error('killed'), { signal: 'SIGKILL' });
      cb(err, JSON.stringify({ status: 'fail', summary: { scenarios: 5, failed: 1 }, attempts: [{ status: 'fail', summary: { scenarios: 5, failed: 1 } }] }), '');
    };
    const r = await runOnce(CONDITION, 0, { execFileImpl });
    expect(r.ranOk).toBe(false);
    expect(r.inconclusive).toBe(false);
    expect(r.crashError).toMatch(/signal SIGKILL/);
  });
});

describe('runOnce — model-stamp verification for a candidate condition', () => {
  const CANDIDATE_CONDITION = { id: 'candidate-block', env: { VOICE_RELAY_INBOUND_MODEL: 'claude-haiku-4-5-20251001' } };

  test('every scenario resolved to the requested model ⇒ no mismatch', async () => {
    const execFileImpl = stubChild([{
      code: 0,
      stdout: JSON.stringify({
        status: 'pass',
        summary: { scenarios: 2, passed: 2 },
        attempts: [{ status: 'pass', summary: { scenarios: 2, passed: 2 } }],
        results: [{ id: 'a', model: 'claude-haiku-4-5-20251001' }, { id: 'b', model: 'claude-haiku-4-5-20251001' }],
      }),
    }]);
    const r = await runOnce(CANDIDATE_CONDITION, 0, { execFileImpl });
    expect(r.ranOk).toBe(true);
    expect(r.modelMismatch).toBe(false);
    expect(r.resolvedModels).toEqual(['claude-haiku-4-5-20251001']);
  });

  test('a scenario resolved to a DIFFERENT model (rejected override, silent fallback) ⇒ mismatch', async () => {
    const execFileImpl = stubChild([{
      code: 0,
      stdout: JSON.stringify({
        status: 'pass',
        summary: { scenarios: 2, passed: 2 },
        attempts: [{ status: 'pass', summary: { scenarios: 2, passed: 2 } }],
        results: [{ id: 'a', model: 'claude-haiku-4-5-20251001' }, { id: 'b', model: 'claude-sonnet-5' }],
      }),
    }]);
    const r = await runOnce(CANDIDATE_CONDITION, 0, { execFileImpl });
    expect(r.ranOk).toBe(true);
    expect(r.modelMismatch).toBe(true);
    expect(r.resolvedModels).toEqual(expect.arrayContaining(['claude-haiku-4-5-20251001', 'claude-sonnet-5']));
  });

  test('a "current" condition (no requested override) is never flagged as a mismatch', async () => {
    const execFileImpl = stubChild([{
      code: 0,
      stdout: JSON.stringify({
        status: 'pass',
        summary: { scenarios: 1, passed: 1 },
        attempts: [{ status: 'pass', summary: { scenarios: 1, passed: 1 } }],
        results: [{ id: 'a', model: 'claude-sonnet-5' }],
      }),
    }]);
    const r = await runOnce(CONDITION, 0, { execFileImpl });
    expect(r.modelMismatch).toBe(false);
  });
});

describe('summarizeCondition — inconclusive and crashed runs are reported, never silently dropped', () => {
  test('one inconclusive run out of two trials shows up as missing data, not as a completed run', () => {
    const runs = [
      {
        condition: 'x', ranOk: true, inconclusive: false,
        result: { summary: { scenarios: 5, passed: 5, durationMs: 1000 }, attempts: [{ status: 'pass', summary: { scenarios: 5, passed: 5 } }] },
      },
      { condition: 'x', ranOk: false, inconclusive: true, result: { status: 'inconclusive', error: { message: 'boom' } } },
    ];
    const s = summarizeCondition('x', runs);
    expect(s.trials).toBe(2);
    expect(s.completedRuns).toBe(1);
    expect(s.inconclusiveRuns).toBe(1);
    expect(s.crashedRuns).toBe(0);
    // Only the completed run's attempt(s) feed the scenario sums.
    expect(s.scenarioAttemptSamples).toBe(5);
    expect(s.scenarioPasses).toBe(5);
  });

  test('a real crash is counted separately from an inconclusive run', () => {
    const runs = [
      { condition: 'x', ranOk: false, inconclusive: false, result: null },
      { condition: 'x', ranOk: false, inconclusive: true, result: { status: 'inconclusive', error: { message: 'boom' } } },
    ];
    const s = summarizeCondition('x', runs);
    expect(s.crashedRuns).toBe(1);
    expect(s.inconclusiveRuns).toBe(1);
    expect(s.completedRuns).toBe(0);
  });
});

describe('summarizeCondition — every attempt counts, not just the retry wrapper\'s selected finalAttempt', () => {
  test('a first-attempt critical miss survives even though the retry passed (flaky)', () => {
    const runs = [{
      condition: 'x',
      ranOk: true,
      inconclusive: false,
      result: {
        status: 'pass',
        flaky: true,
        // The SELECTED (retry) attempt only — this is what a naive reader of
        // result.summary alone would see: zero failures, zero critical misses.
        summary: { scenarios: 5, passed: 5, failed: 0, criticalMisses: 0, durationMs: 900 },
        attempts: [
          { status: 'fail', summary: { scenarios: 5, passed: 4, failed: 1, criticalMisses: 1 } }, // first, failed attempt
          { status: 'pass', summary: { scenarios: 5, passed: 5, failed: 0, criticalMisses: 0 } },  // retry that cleared it
        ],
      },
    }];
    const s = summarizeCondition('x', runs);
    expect(s.retriedRuns).toBe(1);
    expect(s.flakyRuns).toBe(1);
    // attemptCount counts ATTEMPTS only (2: the failed first + the retry) —
    // never itself the scenario-level denominator.
    expect(s.attemptCount).toBe(2);
    // Both attempts are summed (10 scenario-attempt samples, not 5 from
    // result.summary alone), and the first attempt's critical miss is
    // visible in the aggregate. scenarioAttemptSamples is the correct
    // denominator.
    expect(s.scenarioAttemptSamples).toBe(10);
    expect(s.scenarioPasses).toBe(9);
    expect(s.scenarioFailures).toBe(1);
    expect(s.criticalMisses).toBe(1);
  });

  test('a non-retried run (a single attempt) is not double-counted', () => {
    const runs = [{
      condition: 'x', ranOk: true, inconclusive: false,
      result: { status: 'pass', flaky: false, summary: { scenarios: 5, passed: 5 }, attempts: [{ status: 'pass', summary: { scenarios: 5, passed: 5 } }] },
    }];
    const s = summarizeCondition('x', runs);
    expect(s.retriedRuns).toBe(0);
    expect(s.flakyRuns).toBe(0);
    expect(s.attemptCount).toBe(1);
    expect(s.scenarioAttemptSamples).toBe(5);
  });
});

describe('summarizeCondition — model-mismatch runs are surfaced, never silently folded into a clean pass', () => {
  test('a candidate run whose resolved model differs from what was requested is counted, and EXCLUDED from completedRuns', () => {
    const runs = [
      { condition: 'x', ranOk: true, inconclusive: false, modelMismatch: true, resolvedModels: ['claude-sonnet-5'], result: { summary: { scenarios: 2, passed: 2 }, attempts: [{ status: 'pass', summary: { scenarios: 2, passed: 2 } }] } },
      { condition: 'x', ranOk: true, inconclusive: false, modelMismatch: false, result: { summary: { scenarios: 2, passed: 2 }, attempts: [{ status: 'pass', summary: { scenarios: 2, passed: 2 } }] } },
    ];
    const s = summarizeCondition('x', runs);
    // A model-mismatch run is missing data, not a clean pass: it is counted
    // separately (modelMismatchRuns), never rolled into completedRuns.
    expect(s.completedRuns).toBe(1);
    expect(s.modelMismatchRuns).toBe(1);
  });

  test('a model-mismatch run\'s numbers are excluded from every aggregate — latency, judge, and scenario totals', () => {
    const runs = [
      {
        condition: 'x', ranOk: true, inconclusive: false, modelMismatch: true, resolvedModels: ['claude-sonnet-5'],
        // A mismatch run with wildly different numbers than the clean run
        // below — if these ever leaked into the aggregates, the assertions
        // on the clean-only totals would catch it.
        result: {
          summary: { scenarios: 100, passed: 0, failed: 100, criticalMisses: 100, durationMs: 999999, judged: 100, judgeFallbacks: 100, judgeErrors: 100 },
          attempts: [{ status: 'fail', summary: { scenarios: 100, passed: 0, failed: 100, criticalMisses: 100, judged: 100, judgeFallbacks: 100, judgeErrors: 100, durationMs: 999999 } }],
          results: [{ id: 'a', model: 'claude-sonnet-5', judge: { ok: true, verdict: { pass: false } } }],
        },
      },
      {
        condition: 'x', ranOk: true, inconclusive: false, modelMismatch: false,
        result: {
          summary: { scenarios: 2, passed: 2, durationMs: 500, judged: 1, judgeFallbacks: 0, judgeErrors: 0 },
          attempts: [{ status: 'pass', summary: { scenarios: 2, passed: 2, judged: 1, judgeFallbacks: 0, judgeErrors: 0, durationMs: 500 } }],
          results: [{ id: 'b', model: 'claude-haiku-4-5-20251001', judge: { ok: true, verdict: { pass: true } } }],
        },
      },
    ];
    const s = summarizeCondition('x', runs);
    expect(s.completedRuns).toBe(1);
    expect(s.modelMismatchRuns).toBe(1);
    expect(s.scenarioAttemptSamples).toBe(2);
    expect(s.scenarioPasses).toBe(2);
    expect(s.scenarioFailures).toBe(0);
    expect(s.criticalMisses).toBe(0);
    expect(s.judgedCount).toBe(1);
    expect(s.judgeFallbackCount).toBe(0);
    expect(s.judgeErrorCount).toBe(0);
    expect(s.judgedCountFinalAttemptOnly).toBe(1);
    expect(s.judgePassCountFinalAttemptOnly).toBe(1);
    // Only the clean run's own attempt duration (500) — the mismatch run's
    // 999999 never leaks into either latency figure.
    expect(s.durationMsFirstAttemptMedian).toBe(500);
    expect(s.durationMsTotalRunMedian).toBe(500);
  });

  test('no mismatch field on a run (e.g. the "current" conditions) never counts as a mismatch', () => {
    const runs = [{ condition: 'x', ranOk: true, inconclusive: false, result: { summary: { scenarios: 1, passed: 1 }, attempts: [{ status: 'pass', summary: { scenarios: 1, passed: 1 } }] } }];
    const s = summarizeCondition('x', runs);
    expect(s.modelMismatchRuns).toBe(0);
    expect(s.completedRuns).toBe(1);
  });
});

describe('summarizeCondition — judge aggregates: summed across attempts, except the pass count', () => {
  test('judged / judgeFallbacks / judgeErrors sum across every attempt; judge pass count is the final attempt only', () => {
    const runs = [{
      condition: 'x', ranOk: true, inconclusive: false,
      result: {
        summary: { scenarios: 2, passed: 2, judged: 2, judgeFallbacks: 1, judgeErrors: 0 },
        attempts: [
          { status: 'fail', summary: { scenarios: 2, passed: 1, judged: 2, judgeFallbacks: 0, judgeErrors: 0 } },
          { status: 'pass', summary: { scenarios: 2, passed: 2, judged: 2, judgeFallbacks: 1, judgeErrors: 0 } },
        ],
        // Only the FINAL attempt's full results carry a judge verdict.
        results: [
          { id: 'a', judge: { ok: true, verdict: { pass: true } } },
          { id: 'b', judge: { ok: true, verdict: { pass: false } } },
        ],
      },
    }];
    const s = summarizeCondition('x', runs);
    expect(s.judgedCount).toBe(4); // summed across both attempts
    expect(s.judgeFallbackCount).toBe(1);
    expect(s.judgeErrorCount).toBe(0);
    expect(s.judgePassCountFinalAttemptOnly).toBe(1); // only 'a' passed, from the final attempt's results
    // judgedCountFinalAttemptOnly is the same final-attempt POPULATION
    // judgePassCountFinalAttemptOnly draws its numerator from — both 'a' and
    // 'b' were judged (ok + a verdict) in the final attempt, so this is 2,
    // never the attempt-summed judgedCount (4). A naturalness rate is
    // judgePassCountFinalAttemptOnly / judgedCountFinalAttemptOnly = 1/2.
    expect(s.judgedCountFinalAttemptOnly).toBe(2);
  });

  test('a judge that ran but produced no usable verdict (judge.ok: false) is excluded from judgedCountFinalAttemptOnly', () => {
    const runs = [{
      condition: 'x', ranOk: true, inconclusive: false,
      result: {
        summary: { scenarios: 2, passed: 1, judged: 1, judgeFallbacks: 0, judgeErrors: 1 },
        attempts: [{ status: 'fail', summary: { scenarios: 2, passed: 1, judged: 1, judgeFallbacks: 0, judgeErrors: 1 } }],
        results: [
          { id: 'a', judge: { ok: true, verdict: { pass: true } } },
          { id: 'b', judge: { ok: false, reason: 'judge unavailable' } },
        ],
      },
    }];
    const s = summarizeCondition('x', runs);
    expect(s.judgedCountFinalAttemptOnly).toBe(1);
    expect(s.judgePassCountFinalAttemptOnly).toBe(1);
  });
});

describe('summarizeCondition — a fallback-leg (advisory) judge verdict is excluded from the primary judge rate (Codex r5 finding 3)', () => {
  test('a final-attempt result with judge_fallback: true is excluded from judgedCountFinalAttemptOnly / judgePassCountFinalAttemptOnly, and counted separately', () => {
    const runs = [{
      condition: 'x', ranOk: true, inconclusive: false,
      result: {
        summary: { scenarios: 2, passed: 2, judged: 2, judgeFallbacks: 1, judgeErrors: 0 },
        attempts: [{ status: 'pass', summary: { scenarios: 2, passed: 2, judged: 2, judgeFallbacks: 1, judgeErrors: 0 } }],
        results: [
          // 'a' — a genuine primary-leg verdict.
          { id: 'a', judge: { ok: true, judge_fallback: false, verdict: { pass: true } } },
          // 'b' — the fallback leg answered (advisory only, per
          // voice-relay-judge.js's own contract and voice-relay-replay.js's
          // judgeChecks, which marks its checks "advisory" — never pass/fail).
          { id: 'b', judge: { ok: true, judge_fallback: true, verdict: { pass: true } } },
        ],
      },
    }];
    const s = summarizeCondition('x', runs);
    // Primary-judge population: 'a' only.
    expect(s.judgedCountFinalAttemptOnly).toBe(1);
    expect(s.judgePassCountFinalAttemptOnly).toBe(1);
    // Fallback-leg population, reported separately: 'b' only, and it passed.
    expect(s.judgeFallbackVerdictCountFinalAttemptOnly).toBe(1);
    expect(s.judgeFallbackPassCountFinalAttemptOnly).toBe(1);
    // The attempt-summed figures are unaffected — they come from
    // voice-relay-replay.js's own summarize() output, unstripped, and are a
    // different (larger) population than either final-attempt figure above.
    expect(s.judgedCount).toBe(2);
    expect(s.judgeFallbackCount).toBe(1);
  });

  test('a fallback-leg verdict that FAILED is never counted toward judgePassCountFinalAttemptOnly, only judgeFallbackPassCountFinalAttemptOnly (which also stays 0)', () => {
    const runs = [{
      condition: 'x', ranOk: true, inconclusive: false,
      result: {
        summary: { scenarios: 1, passed: 1, judged: 1, judgeFallbacks: 1, judgeErrors: 0 },
        attempts: [{ status: 'pass', summary: { scenarios: 1, passed: 1, judged: 1, judgeFallbacks: 1, judgeErrors: 0 } }],
        results: [{ id: 'a', judge: { ok: true, judge_fallback: true, verdict: { pass: false } } }],
      },
    }];
    const s = summarizeCondition('x', runs);
    expect(s.judgedCountFinalAttemptOnly).toBe(0);
    expect(s.judgePassCountFinalAttemptOnly).toBe(0);
    expect(s.judgeFallbackVerdictCountFinalAttemptOnly).toBe(1);
    expect(s.judgeFallbackPassCountFinalAttemptOnly).toBe(0);
  });

  test('no fallback verdicts at all ⇒ both fallback fields are 0, primary fields unaffected', () => {
    const runs = [{
      condition: 'x', ranOk: true, inconclusive: false,
      result: {
        summary: { scenarios: 1, passed: 1, judged: 1, judgeFallbacks: 0, judgeErrors: 0 },
        attempts: [{ status: 'pass', summary: { scenarios: 1, passed: 1, judged: 1, judgeFallbacks: 0, judgeErrors: 0 } }],
        results: [{ id: 'a', judge: { ok: true, judge_fallback: false, verdict: { pass: true } } }],
      },
    }];
    const s = summarizeCondition('x', runs);
    expect(s.judgeFallbackVerdictCountFinalAttemptOnly).toBe(0);
    expect(s.judgeFallbackPassCountFinalAttemptOnly).toBe(0);
    expect(s.judgedCountFinalAttemptOnly).toBe(1);
    expect(s.judgePassCountFinalAttemptOnly).toBe(1);
  });
});

describe('summarizeCondition — task-accuracy denominator excludes replay errors (Codex r5 finding 4)', () => {
  test('35 pass + 1 replay error across two trials ⇒ 35/35 evaluated, 1 reported separately as missing data', () => {
    const runs = [
      {
        condition: 'x', ranOk: true, inconclusive: false,
        result: {
          summary: { scenarios: 18, passed: 18, failed: 0, replayErrors: 0, criticalMisses: 0 },
          attempts: [{ status: 'pass', summary: { scenarios: 18, passed: 18, failed: 0, replayErrors: 0, criticalMisses: 0 } }],
        },
      },
      {
        condition: 'x', ranOk: true, inconclusive: false,
        // 18 scenarios this trial too, but one of them errored during
        // replay (the harness itself broke on it — never evaluated either
        // way), so only 17 passed and 1 is a replay error, not a scenario
        // failure. 18 (first trial) + 17 (second, evaluated) = 35 passes;
        // 18 + 18 = 36 attempted; 36 - 1 replay error = 35 evaluated.
        result: {
          summary: { scenarios: 18, passed: 17, failed: 0, replayErrors: 1, criticalMisses: 0 },
          attempts: [{ status: 'pass', summary: { scenarios: 18, passed: 17, failed: 0, replayErrors: 1, criticalMisses: 0 } }],
        },
      },
    ];
    const s = summarizeCondition('x', runs);
    expect(s.scenarioPasses).toBe(35);
    expect(s.replayErrors).toBe(1);
    expect(s.scenarioAttemptSamples).toBe(36); // the raw attempted denominator, unaffected
    expect(s.scenarioEvaluatedSamples).toBe(35); // attempted minus the 1 replay error
    // Task accuracy computed from the evaluated denominator: 35/35, not
    // 35/36 (which would understate accuracy for a harness problem, not a
    // model behavior problem).
    expect(s.scenarioPasses / s.scenarioEvaluatedSamples).toBe(1);
  });

  test('a run with no replay errors leaves scenarioEvaluatedSamples equal to scenarioAttemptSamples', () => {
    const runs = [{
      condition: 'x', ranOk: true, inconclusive: false,
      result: {
        summary: { scenarios: 5, passed: 5, failed: 0, replayErrors: 0 },
        attempts: [{ status: 'pass', summary: { scenarios: 5, passed: 5, failed: 0, replayErrors: 0 } }],
      },
    }];
    const s = summarizeCondition('x', runs);
    expect(s.scenarioAttemptSamples).toBe(5);
    expect(s.scenarioEvaluatedSamples).toBe(5);
  });

  test('replay errors sum per attempt across a retried run, consistently with scenarioPasses', () => {
    const runs = [{
      condition: 'x', ranOk: true, inconclusive: false,
      result: {
        status: 'pass',
        flaky: true,
        summary: { scenarios: 5, passed: 5, failed: 0, replayErrors: 0 },
        attempts: [
          { status: 'fail', summary: { scenarios: 5, passed: 3, failed: 1, replayErrors: 1 } }, // first attempt: 1 replay error
          { status: 'pass', summary: { scenarios: 5, passed: 5, failed: 0, replayErrors: 0 } },  // retry: clean
        ],
      },
    }];
    const s = summarizeCondition('x', runs);
    expect(s.scenarioAttemptSamples).toBe(10); // 5 + 5, both attempts
    expect(s.replayErrors).toBe(1);
    expect(s.scenarioEvaluatedSamples).toBe(9); // 10 attempted - 1 replay error
  });
});

describe('summarizeCondition — latency: first-attempt vs. total-run, aggregated from every entry of result.attempts (Codex r5 finding 5)', () => {
  test('a non-retried run: first-attempt and total-run latency are identical (one attempt, so nothing to sum)', () => {
    const runs = [{
      condition: 'x', ranOk: true, inconclusive: false,
      result: {
        summary: { scenarios: 3, passed: 3, durationMs: 900 },
        attempts: [{ status: 'pass', summary: { scenarios: 3, passed: 3, durationMs: 900 } }],
      },
    }];
    const s = summarizeCondition('x', runs);
    expect(s.durationMsFirstAttemptMedian).toBe(900);
    expect(s.durationMsTotalRunMedian).toBe(900);
    expect(s.durationMsFirstAttemptSampleCount).toBe(1);
    expect(s.durationMsTotalRunSampleCount).toBe(1);
  });

  test('a retried run: first-attempt latency is the FIRST attempt alone; total-run latency is first + retry summed — so the retried run does not look artificially faster', () => {
    const runs = [{
      condition: 'x', ranOk: true, inconclusive: false,
      result: {
        status: 'pass',
        flaky: true,
        summary: { scenarios: 5, passed: 5, durationMs: 600 }, // the retry wrapper's SELECTED finalAttempt duration alone
        attempts: [
          { status: 'fail', summary: { scenarios: 5, passed: 4, failed: 1, durationMs: 700 } }, // first attempt: 700ms
          { status: 'pass', summary: { scenarios: 5, passed: 5, durationMs: 600 } },              // retry: 600ms
        ],
      },
    }];
    const s = summarizeCondition('x', runs);
    // First-attempt latency reads the FIRST attempt's own duration (700),
    // never the retry wrapper's selected finalAttempt (600) that
    // result.summary.durationMs alone would have surfaced.
    expect(s.durationMsFirstAttemptMedian).toBe(700);
    // Total-run latency is the SUM of every attempt this run made: 700 + 600
    // = 1300 — the real wall-clock cost, not hidden behind the retry alone.
    expect(s.durationMsTotalRunMedian).toBe(1300);
  });

  test('mixing a retried run with two non-retried runs: first-attempt and total-run are two genuinely different distributions, not the same numbers relabeled', () => {
    const runs = [
      {
        // Retried: first attempt 100ms, retry 400ms — total run 500ms.
        condition: 'x', ranOk: true, inconclusive: false,
        result: {
          summary: { scenarios: 5, passed: 5, durationMs: 400 },
          attempts: [
            { status: 'fail', summary: { scenarios: 5, passed: 4, durationMs: 100 } },
            { status: 'pass', summary: { scenarios: 5, passed: 5, durationMs: 400 } },
          ],
        },
      },
      {
        // Non-retried: 300ms, one attempt — first-attempt and total-run agree.
        condition: 'x', ranOk: true, inconclusive: false,
        result: {
          summary: { scenarios: 5, passed: 5, durationMs: 300 },
          attempts: [{ status: 'pass', summary: { scenarios: 5, passed: 5, durationMs: 300 } }],
        },
      },
      {
        // Non-retried: 900ms, one attempt.
        condition: 'x', ranOk: true, inconclusive: false,
        result: {
          summary: { scenarios: 5, passed: 5, durationMs: 900 },
          attempts: [{ status: 'pass', summary: { scenarios: 5, passed: 5, durationMs: 900 } }],
        },
      },
    ];
    const s = summarizeCondition('x', runs);
    expect(s.durationMsFirstAttemptSampleCount).toBe(3);
    expect(s.durationMsTotalRunSampleCount).toBe(3);
    // First-attempt samples: [100, 300, 900] → median 300 (run 1's REAL first
    // attempt, 100ms, not its selected/retry duration).
    expect(s.durationMsFirstAttemptMedian).toBe(300);
    // Total-run samples: [500 (100+400), 300, 900] → median 500 — the
    // retried run's real wall-clock cost, distinct from its own
    // first-attempt figure and from what result.summary.durationMs alone
    // (400) would have reported.
    expect(s.durationMsTotalRunMedian).toBe(500);
    expect(s.durationMsFirstAttemptMedian).not.toBe(s.durationMsTotalRunMedian);
  });
});

describe('summarizeCondition — real per-round usage (cache-hit logging, this PR), never the old cacheHypothesis guess', () => {
  test('sums input/output/cache tokens across every attempt of every run in the condition, and computes a real cacheHitRate', () => {
    const runs = [
      {
        // Non-retried run: one attempt, usage carried on its own summary.
        condition: 'x', ranOk: true, inconclusive: false,
        result: {
          summary: { scenarios: 2, passed: 2, usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 0, cache_write_tokens: 500, rounds: 1, cacheReadRounds: 0 } },
          attempts: [{ status: 'pass', summary: { scenarios: 2, passed: 2, usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 0, cache_write_tokens: 500, rounds: 1, cacheReadRounds: 0 } } }],
        },
      },
      {
        // Retried run: BOTH attempts' usage counts (real spend, not just the
        // selected finalAttempt) — same rule as durationMs above.
        condition: 'x', ranOk: true, inconclusive: false,
        result: {
          summary: { scenarios: 2, passed: 2, usage: { input_tokens: 90, output_tokens: 15, cached_input_tokens: 500, cache_write_tokens: 0, rounds: 1, cacheReadRounds: 1 } },
          attempts: [
            { status: 'fail', summary: { scenarios: 2, passed: 1, usage: { input_tokens: 80, output_tokens: 10, cached_input_tokens: 0, cache_write_tokens: 500, rounds: 1, cacheReadRounds: 0 } } },
            { status: 'pass', summary: { scenarios: 2, passed: 2, usage: { input_tokens: 90, output_tokens: 15, cached_input_tokens: 500, cache_write_tokens: 0, rounds: 1, cacheReadRounds: 1 } } },
          ],
        },
      },
    ];
    const s = summarizeCondition('x', runs);
    // 100 + 80 + 90 = 270; 20 + 10 + 15 = 45; cache read 0 + 0 + 500 = 500;
    // cache write 500 + 500 + 0 = 1000 — every attempt of every run, summed.
    expect(s.usage.inputTokens).toBe(270);
    expect(s.usage.outputTokens).toBe(45);
    expect(s.usage.cachedInputTokens).toBe(500);
    expect(s.usage.cacheWriteTokens).toBe(1000);
    expect(s.usage.rounds).toBe(3);
    expect(s.usage.cacheReadRounds).toBe(1);
    expect(s.usage.cacheHitRate).toBeCloseTo(1 / 3);
  });

  test('no usage anywhere (an older/mocked result summary) reports zero counts and a null — never NaN or a false zero — cacheHitRate', () => {
    const runs = [{
      condition: 'x', ranOk: true, inconclusive: false,
      result: { summary: { scenarios: 1, passed: 1 }, attempts: [{ status: 'pass', summary: { scenarios: 1, passed: 1 } }] },
    }];
    const s = summarizeCondition('x', runs);
    expect(s.usage.inputTokens).toBe(0);
    expect(s.usage.rounds).toBe(0);
    expect(s.usage.cacheHitRate).toBeNull();
  });
});

describe('rotateConditions — Williams (balanced Latin square) design for the 4 conditions', () => {
  const conditions = buildConditions('claude-haiku-4-5-20251001');
  // Natural order (buildConditions): 0=current-block, 1=current-stream,
  // 2=candidate-block, 3=candidate-stream.
  const EXPECTED_ORDERS = [
    ['current-block', 'current-stream', 'candidate-stream', 'candidate-block'],
    ['current-stream', 'candidate-block', 'current-block', 'candidate-stream'],
    ['candidate-block', 'candidate-stream', 'current-stream', 'current-block'],
    ['candidate-stream', 'current-block', 'candidate-block', 'current-stream'],
  ];

  test.each([0, 1, 2, 3])('trial %i matches the Williams design\'s order for that trial', (trial) => {
    expect(rotateConditions(conditions, trial).map((c) => c.id)).toEqual(EXPECTED_ORDERS[trial]);
  });

  test('the 4 orders cycle: trial 4 repeats trial 0\'s order', () => {
    expect(rotateConditions(conditions, 4).map((c) => c.id)).toEqual(EXPECTED_ORDERS[0]);
  });

  test('every condition takes the first slot exactly once across trials 0..3', () => {
    const firstSlots = [0, 1, 2, 3].map((trial) => rotateConditions(conditions, trial)[0].id);
    expect(new Set(firstSlots).size).toBe(conditions.length);
  });

  // The property a plain cyclic rotation does NOT have: with a fixed
  // condition order, "X immediately followed by Y" is the same pair every
  // trial (current-stream always follows current-block). A Williams design
  // instead gives every ORDERED pair of distinct conditions exactly one
  // immediate adjacency across the 4 trials — first-order carryover balance.
  test('every ordered pair of distinct conditions is an immediate adjacency exactly once across the 4 orders', () => {
    const pairs = [];
    for (let trial = 0; trial < 4; trial += 1) {
      const order = rotateConditions(conditions, trial).map((c) => c.id);
      for (let i = 0; i < order.length - 1; i += 1) pairs.push(`${order[i]}->${order[i + 1]}`);
    }
    const ids = conditions.map((c) => c.id);
    const expectedPairs = [];
    for (const a of ids) for (const b of ids) if (a !== b) expectedPairs.push(`${a}->${b}`);
    expect(pairs).toHaveLength(expectedPairs.length); // 4 trials × 3 adjacencies = 12 = 4×3 ordered pairs
    expect(new Set(pairs).size).toBe(pairs.length); // every pair distinct — none repeats
    expect([...pairs].sort()).toEqual([...expectedPairs].sort()); // and together they are EVERY ordered pair
  });

  test('a condition count other than 4 falls back to a plain cyclic rotation (defensive; never hit by buildConditions)', () => {
    const three = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(rotateConditions(three, 0).map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(rotateConditions(three, 1).map((c) => c.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('runBenchmark — required --candidate-model and the benchmark-level exit code', () => {
  test('rejects with a clear error when --candidate-model is missing, before any child process runs', async () => {
    const execFileImpl = jest.fn();
    await expect(runBenchmark({ argv: ['--trials=1'], execFileImpl })).rejects.toThrow(/--candidate-model is required/);
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  test('rejects when --candidate-model is passed with no value', async () => {
    await expect(runBenchmark({ argv: ['--candidate-model'] })).rejects.toThrow(/--candidate-model is required/);
  });

  test('rejects an unallowlisted --candidate-model, before any child process runs', async () => {
    const execFileImpl = jest.fn();
    await expect(runBenchmark({ argv: ['--candidate-model=not-a-real-model', '--trials=1'], execFileImpl }))
      .rejects.toThrow(/not an allowlisted model id/);
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  test('an inconclusive condition makes the whole benchmark report exitCode 1, even with zero scenario failures', async () => {
    const execFileImpl = stubChild([{ code: 3, stdout: JSON.stringify({ status: 'inconclusive', error: { message: 'model unavailable' } }) }]);
    const { report, exitCode } = await runBenchmark({
      argv: ['--candidate-model=claude-haiku-4-5-20251001', '--trials=1'],
      execFileImpl,
    });
    expect(exitCode).toBe(1);
    expect(report.conditions).toHaveLength(4);
    expect(report.conditions.every((c) => c.inconclusiveRuns === 1)).toBe(true);
  });

  test('replay errors (unevaluated scenarios) make the whole benchmark report exitCode 1', async () => {
    const execFileImpl = stubChild([{
      code: 1,
      stdout: JSON.stringify({ status: 'fail', flaky: false, summary: { scenarios: 3, passed: 2, replayErrors: 1, durationMs: 500 }, attempts: [{ status: 'fail', summary: { scenarios: 3, passed: 2, replayErrors: 1, durationMs: 500 } }] }),
    }]);
    const { report, exitCode } = await runBenchmark({
      argv: ['--candidate-model=claude-haiku-4-5-20251001', '--trials=1'],
      execFileImpl,
    });
    expect(exitCode).toBe(1);
    expect(report.conditions.every((c) => c.replayErrors === 1)).toBe(true);
  });

  test('an unwritable --out destination is rejected before any child runs', async () => {
    const execFileImpl = jest.fn();
    await expect(runBenchmark({
      argv: ['--candidate-model=claude-haiku-4-5-20251001', '--trials=1', '--out=/nonexistent-dir-for-benchmark-test/report.json'],
      execFileImpl,
    })).rejects.toThrow(/--out destination is not writable/);
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  test('a writable --out destination is resolved and returned', async () => {
    const os = require('os');
    const target = require('path').join(os.tmpdir(), `benchmark-out-${process.pid}.json`);
    const execFileImpl = stubChild([{ code: 3, stdout: JSON.stringify({ status: 'inconclusive', error: { message: 'x' } }) }]);
    const { outPath } = await runBenchmark({
      argv: ['--candidate-model=claude-haiku-4-5-20251001', '--trials=1', `--out=${target}`],
      execFileImpl,
    });
    expect(outPath).toBe(target);
  });

  test('a fully clean run (every condition pass, no retries, no crashes) reports exitCode 0', async () => {
    const execFileImpl = stubChild([{
      code: 0,
      stdout: JSON.stringify({ status: 'pass', flaky: false, summary: { scenarios: 3, passed: 3, durationMs: 500 }, attempts: [{ status: 'pass', summary: { scenarios: 3, passed: 3 } }] }),
    }]);
    const { report, exitCode } = await runBenchmark({
      argv: ['--candidate-model=claude-haiku-4-5-20251001', '--trials=1'],
      execFileImpl,
    });
    expect(exitCode).toBe(0);
    expect(report.conditions).toHaveLength(4);
    for (const c of report.conditions) {
      expect(c.crashedRuns).toBe(0);
      expect(c.inconclusiveRuns).toBe(0);
      expect(c.retriedRuns).toBe(0);
    }
  });

  test('invokes the eval CLI with --json and the condition env vars, never mutating candidateModel across conditions', async () => {
    const seenEnvs = [];
    const execFileImpl = (file, args, opts, cb) => {
      expect(file).toBe(process.execPath);
      expect(args[1]).toBe('--json');
      seenEnvs.push({ model: opts.env.VOICE_RELAY_INBOUND_MODEL, renderer: opts.env.VOICE_RELAY_RENDERER });
      cb(null, JSON.stringify({ status: 'pass', summary: { scenarios: 1, passed: 1 }, attempts: [{ status: 'pass', summary: { scenarios: 1, passed: 1 } }] }), '');
    };
    await runBenchmark({ argv: ['--candidate-model=claude-haiku-4-5-20251001', '--trials=1'], execFileImpl });
    // Trial 0's Williams order is current-block, current-stream,
    // candidate-stream, candidate-block (see rotateConditions' describe
    // block) — not the natural buildConditions() order.
    expect(seenEnvs).toEqual([
      { model: '', renderer: '' },
      { model: '', renderer: 'stream' },
      { model: 'claude-haiku-4-5-20251001', renderer: 'stream' },
      { model: 'claude-haiku-4-5-20251001', renderer: '' },
    ]);
  });

  test('rotates condition order per trial per the Williams design (trial 1 does not repeat trial 0\'s order)', async () => {
    const seenOrder = [];
    let call = 0;
    const execFileImpl = (file, args, opts, cb) => {
      seenOrder.push(opts.env.VOICE_RELAY_INBOUND_MODEL ? (opts.env.VOICE_RELAY_RENDERER ? 'candidate-stream' : 'candidate-block') : (opts.env.VOICE_RELAY_RENDERER ? 'current-stream' : 'current-block'));
      call += 1;
      cb(null, JSON.stringify({ status: 'pass', summary: { scenarios: 1, passed: 1 }, attempts: [{ status: 'pass', summary: { scenarios: 1, passed: 1 } }] }), '');
    };
    await runBenchmark({ argv: ['--candidate-model=claude-haiku-4-5-20251001', '--trials=2'], execFileImpl });
    expect(call).toBe(8);
    expect(seenOrder).toEqual([
      'current-block', 'current-stream', 'candidate-stream', 'candidate-block',
      'current-stream', 'candidate-block', 'current-block', 'candidate-stream',
    ]);
  });

  test('a candidate condition whose resolved model never matches the request makes the benchmark exit non-zero', async () => {
    const execFileImpl = (file, args, opts, cb) => {
      cb(null, JSON.stringify({
        status: 'pass',
        summary: { scenarios: 1, passed: 1 },
        attempts: [{ status: 'pass', summary: { scenarios: 1, passed: 1 } }],
        // EVERY condition — including the two "candidate" ones — comes back
        // stamped with the CURRENT model: an unknown-override fallback that
        // silently ignored the requested candidate id.
        results: [{ id: 'a', model: 'claude-sonnet-5' }],
      }), '');
    };
    const { report, exitCode } = await runBenchmark({
      argv: ['--candidate-model=claude-haiku-4-5-20251001', '--trials=1'],
      execFileImpl,
    });
    expect(exitCode).toBe(1);
    const candidateBlock = report.conditions.find((c) => c.condition === 'candidate-block');
    expect(candidateBlock.modelMismatchRuns).toBe(1);
    expect(candidateBlock.completedRuns).toBe(0); // excluded, not folded into a clean pass
    const currentBlock = report.conditions.find((c) => c.condition === 'current-block');
    expect(currentBlock.modelMismatchRuns).toBe(0);
    expect(currentBlock.completedRuns).toBe(1);
  });
});

describe('runBenchmark — --trials must be an explicit positive integer, before any child process runs', () => {
  test('a non-numeric --trials is rejected', async () => {
    const execFileImpl = jest.fn();
    await expect(runBenchmark({ argv: ['--candidate-model=claude-haiku-4-5-20251001', '--trials=abc'], execFileImpl }))
      .rejects.toThrow(/--trials must be an explicit positive integer/);
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  test('--trials=0 is rejected — it used to silently fall back to DEFAULT_TRIALS', async () => {
    const execFileImpl = jest.fn();
    await expect(runBenchmark({ argv: ['--candidate-model=claude-haiku-4-5-20251001', '--trials=0'], execFileImpl }))
      .rejects.toThrow(/--trials must be an explicit positive integer/);
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  test('a negative --trials is rejected — it used to silently clamp to 1', async () => {
    const execFileImpl = jest.fn();
    await expect(runBenchmark({ argv: ['--candidate-model=claude-haiku-4-5-20251001', '--trials=-5'], execFileImpl }))
      .rejects.toThrow(/--trials must be an explicit positive integer/);
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  test('a non-integer --trials (a float) is rejected', async () => {
    const execFileImpl = jest.fn();
    await expect(runBenchmark({ argv: ['--candidate-model=claude-haiku-4-5-20251001', '--trials=2.5'], execFileImpl }))
      .rejects.toThrow(/--trials must be an explicit positive integer/);
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  test('--trials with no value is rejected, not silently defaulted', async () => {
    const execFileImpl = jest.fn();
    await expect(runBenchmark({ argv: ['--candidate-model=claude-haiku-4-5-20251001', '--trials'], execFileImpl }))
      .rejects.toThrow(/--trials must be an explicit positive integer/);
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  test('--trials omitted entirely still resolves to DEFAULT_TRIALS (the documented default, unaffected by this check)', async () => {
    const execFileImpl = stubChild([{
      code: 0,
      stdout: JSON.stringify({ status: 'pass', summary: { scenarios: 1, passed: 1 }, attempts: [{ status: 'pass', summary: { scenarios: 1, passed: 1 } }] }),
    }]);
    const { report } = await runBenchmark({ argv: ['--candidate-model=claude-haiku-4-5-20251001'], execFileImpl });
    expect(report.trials).toBe(3); // DEFAULT_TRIALS
  });

  test('a valid positive integer --trials is accepted', async () => {
    const execFileImpl = stubChild([{
      code: 0,
      stdout: JSON.stringify({ status: 'pass', summary: { scenarios: 1, passed: 1 }, attempts: [{ status: 'pass', summary: { scenarios: 1, passed: 1 } }] }),
    }]);
    const { report } = await runBenchmark({ argv: ['--candidate-model=claude-haiku-4-5-20251001', '--trials=2'], execFileImpl });
    expect(report.trials).toBe(2);
  });
});

describe('runBenchmark — unknown CLI options are refused before any child process runs', () => {
  test('a typo\'d --onyl is rejected with a clear error naming the flag and the supported set', async () => {
    const execFileImpl = jest.fn();
    await expect(runBenchmark({ argv: ['--candidate-model=claude-haiku-4-5-20251001', '--onyl=booking-happy-path'], execFileImpl }))
      .rejects.toThrow(/unknown option: --onyl/);
    await expect(runBenchmark({ argv: ['--candidate-model=claude-haiku-4-5-20251001', '--onyl=booking-happy-path'], execFileImpl }))
      .rejects.toThrow(/--only/); // the supported set is named in the error
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  test('a typo\'d --trail is rejected before any child process runs', async () => {
    const execFileImpl = jest.fn();
    await expect(runBenchmark({ argv: ['--candidate-model=claude-haiku-4-5-20251001', '--trail=5'], execFileImpl }))
      .rejects.toThrow(/unknown option: --trail/);
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  test('every documented flag from the file header is accepted (no false positive)', async () => {
    const execFileImpl = stubChild([{
      code: 0,
      stdout: JSON.stringify({ status: 'pass', summary: { scenarios: 1, passed: 1 }, attempts: [{ status: 'pass', summary: { scenarios: 1, passed: 1 } }] }),
    }]);
    await expect(runBenchmark({
      argv: ['--candidate-model=claude-haiku-4-5-20251001', '--trials=1', '--only=booking-happy-path', '--judge', '--out=/tmp/x.json'],
      execFileImpl,
    })).resolves.toBeDefined();
  });
});

describe('runBenchmark — --out and --only must carry a value, before any child process runs', () => {
  // parseArgs hands back `true` for a bare `--out`/`--only` (no `=value`),
  // which would otherwise silently write the report to a literal path
  // "true", or filter every scenario out, only after every child had already
  // run for up to CHILD_TIMEOUT_MS each.
  test('a bare --out with no value is rejected, exit-2-style, before any child process runs', async () => {
    const execFileImpl = jest.fn();
    await expect(runBenchmark({ argv: ['--candidate-model=claude-haiku-4-5-20251001', '--out'], execFileImpl }))
      .rejects.toThrow(/--out requires a value/);
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  test('a bare --only with no value is rejected before any child process runs', async () => {
    const execFileImpl = jest.fn();
    await expect(runBenchmark({ argv: ['--candidate-model=claude-haiku-4-5-20251001', '--only'], execFileImpl }))
      .rejects.toThrow(/--only requires a value/);
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  test('--out and --only WITH values are accepted (no false positive)', async () => {
    const execFileImpl = stubChild([{
      code: 0,
      stdout: JSON.stringify({ status: 'pass', summary: { scenarios: 1, passed: 1 }, attempts: [{ status: 'pass', summary: { scenarios: 1, passed: 1 } }] }),
    }]);
    await expect(runBenchmark({
      argv: ['--candidate-model=claude-haiku-4-5-20251001', '--trials=1', '--out=/tmp/x.json', '--only=booking-happy-path'],
      execFileImpl,
    })).resolves.toBeDefined();
  });
});

describe('assertOnlyHasIds / runBenchmark — --only must name at least one real scenario id (Codex r5 finding 2)', () => {
  test('an empty --only= is rejected, before any child process runs', async () => {
    expect(() => assertOnlyHasIds({ only: '' })).toThrow(/--only must name at least one scenario id/);
    const execFileImpl = jest.fn();
    await expect(runBenchmark({ argv: ['--candidate-model=claude-haiku-4-5-20251001', '--only='], execFileImpl }))
      .rejects.toThrow(/--only must name at least one scenario id/);
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  test('a lone delimiter --only=, is rejected', async () => {
    expect(() => assertOnlyHasIds({ only: ',' })).toThrow(/--only must name at least one scenario id/);
    const execFileImpl = jest.fn();
    await expect(runBenchmark({ argv: ['--candidate-model=claude-haiku-4-5-20251001', '--only=,'], execFileImpl }))
      .rejects.toThrow(/--only must name at least one scenario id/);
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  test('whitespace-and-delimiters-only --only= , is rejected', async () => {
    expect(() => assertOnlyHasIds({ only: ' , ' })).toThrow(/--only must name at least one scenario id/);
    const execFileImpl = jest.fn();
    await expect(runBenchmark({ argv: ['--candidate-model=claude-haiku-4-5-20251001', '--only= , '], execFileImpl }))
      .rejects.toThrow(/--only must name at least one scenario id/);
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  test('--only with no value at all is still caught by the earlier bare-flag check, not this one (no false positive, no double-throw confusion)', async () => {
    const execFileImpl = jest.fn();
    await expect(runBenchmark({ argv: ['--candidate-model=claude-haiku-4-5-20251001', '--only'], execFileImpl }))
      .rejects.toThrow(/--only requires a value/);
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  test('--only absent entirely is not rejected by this check', () => {
    expect(() => assertOnlyHasIds({})).not.toThrow();
  });

  test('a real --only value with extra commas/whitespace around real ids is accepted', async () => {
    const execFileImpl = stubChild([{
      code: 0,
      stdout: JSON.stringify({ status: 'pass', summary: { scenarios: 1, passed: 1 }, attempts: [{ status: 'pass', summary: { scenarios: 1, passed: 1 } }] }),
    }]);
    await expect(runBenchmark({
      argv: ['--candidate-model=claude-haiku-4-5-20251001', '--trials=1', '--only= booking-happy-path , slot-gone '],
      execFileImpl,
    })).resolves.toBeDefined();
  });
});

describe('CHILD_TIMEOUT_MS — a ceiling compatible with the eval harness\'s own operational bound', () => {
  // Each child this runner spawns IS a full run-voice-relay-eval.js
  // invocation (the shipped fixture, its own retry-once wrapper, and
  // --judge's chains) — exactly the run server/services/eval/
  // voice-relay-replay.js's own CHILD_TIMEOUT_MS (10h, bumped from 8h by the
  // Spanish booking/mechanics slice's 7 added scenarios) is derived to bound.
  // Mirrored as a literal, not required directly (see this file's own
  // comment on the constant), so this test is what actually pins the two
  // numbers together — a future change to one without the other fails here.
  test('mirrors voice-relay-replay.js\'s own CHILD_TIMEOUT_MS exactly', () => {
    const { _internals } = require('../services/eval/voice-relay-replay');
    expect(CHILD_TIMEOUT_MS).toBe(_internals.CHILD_TIMEOUT_MS);
    expect(CHILD_TIMEOUT_MS).toBe(10 * 60 * 60 * 1000);
  });
});
