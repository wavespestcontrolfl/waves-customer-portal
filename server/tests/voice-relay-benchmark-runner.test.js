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
    expect(s.attemptSamples).toBe(2);
    // Both attempts are summed (10 scenario samples, not 5 from
    // result.summary alone), and the first attempt's critical miss is
    // visible in the aggregate.
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
    expect(s.attemptSamples).toBe(1);
    expect(s.scenarioSamples).toBe(5);
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
});
