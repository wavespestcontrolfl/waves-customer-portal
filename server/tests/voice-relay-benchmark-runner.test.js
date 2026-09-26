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
    expect(s.scenarioSamples).toBe(5);
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
    // denominator; scenarioSamples is kept identical for back-compat.
    expect(s.scenarioAttemptSamples).toBe(10);
    expect(s.scenarioSamples).toBe(10);
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
    expect(s.scenarioSamples).toBe(5);
  });
});

describe('summarizeCondition — model-mismatch runs are surfaced, never silently folded into a clean pass', () => {
  test('a candidate run whose resolved model differs from what was requested is counted', () => {
    const runs = [
      { condition: 'x', ranOk: true, inconclusive: false, modelMismatch: true, resolvedModels: ['claude-sonnet-5'], result: { summary: { scenarios: 2, passed: 2 }, attempts: [{ status: 'pass', summary: { scenarios: 2, passed: 2 } }] } },
      { condition: 'x', ranOk: true, inconclusive: false, modelMismatch: false, result: { summary: { scenarios: 2, passed: 2 }, attempts: [{ status: 'pass', summary: { scenarios: 2, passed: 2 } }] } },
    ];
    const s = summarizeCondition('x', runs);
    expect(s.completedRuns).toBe(2);
    expect(s.modelMismatchRuns).toBe(1);
  });

  test('no mismatch field on a run (e.g. the "current" conditions) never counts as a mismatch', () => {
    const runs = [{ condition: 'x', ranOk: true, inconclusive: false, result: { summary: { scenarios: 1, passed: 1 }, attempts: [{ status: 'pass', summary: { scenarios: 1, passed: 1 } }] } }];
    const s = summarizeCondition('x', runs);
    expect(s.modelMismatchRuns).toBe(0);
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
  });
});

describe('rotateConditions — Latin-square-style rotation by trial index', () => {
  const conditions = buildConditions('claude-haiku-4-5-20251001');

  test('trial 0 keeps the natural order', () => {
    expect(rotateConditions(conditions, 0).map((c) => c.id)).toEqual(conditions.map((c) => c.id));
  });

  test('trial 1 starts from the second condition and wraps', () => {
    expect(rotateConditions(conditions, 1).map((c) => c.id)).toEqual([
      'current-stream', 'candidate-block', 'candidate-stream', 'current-block',
    ]);
  });

  test('every condition takes the first slot exactly once across trials 0..n-1', () => {
    const firstSlots = conditions.map((_, trial) => rotateConditions(conditions, trial)[0].id);
    expect(new Set(firstSlots).size).toBe(conditions.length);
  });

  test('trial index wraps past the condition count (trial === n behaves like trial 0)', () => {
    expect(rotateConditions(conditions, conditions.length).map((c) => c.id)).toEqual(conditions.map((c) => c.id));
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
    expect(seenEnvs).toEqual([
      { model: '', renderer: '' },
      { model: '', renderer: 'stream' },
      { model: 'claude-haiku-4-5-20251001', renderer: '' },
      { model: 'claude-haiku-4-5-20251001', renderer: 'stream' },
    ]);
  });

  test('rotates condition order per trial (trial 1 does not start with current-block again)', async () => {
    const seenOrder = [];
    let call = 0;
    const execFileImpl = (file, args, opts, cb) => {
      seenOrder.push(opts.env.VOICE_RELAY_INBOUND_MODEL ? (opts.env.VOICE_RELAY_RENDERER ? 'candidate-stream' : 'candidate-block') : (opts.env.VOICE_RELAY_RENDERER ? 'current-stream' : 'current-block'));
      call += 1;
      cb(null, JSON.stringify({ status: 'pass', summary: { scenarios: 1, passed: 1 }, attempts: [{ status: 'pass', summary: { scenarios: 1, passed: 1 } }] }), '');
    };
    await runBenchmark({ argv: ['--candidate-model=claude-haiku-4-5-20251001', '--trials=2'], execFileImpl });
    expect(call).toBe(8);
    // Trial 0: natural order. Trial 1: rotated by 1 (starts at current-stream).
    expect(seenOrder).toEqual([
      'current-block', 'current-stream', 'candidate-block', 'candidate-stream',
      'current-stream', 'candidate-block', 'candidate-stream', 'current-block',
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
    const currentBlock = report.conditions.find((c) => c.condition === 'current-block');
    expect(currentBlock.modelMismatchRuns).toBe(0);
  });
});
