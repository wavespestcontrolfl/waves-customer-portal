#!/usr/bin/env node
/**
 * Sandy slice 1, PR D — four-condition text-replay benchmark runner.
 *
 * Runs the EXISTING voice-relay eval CLI (`run-voice-relay-eval.js`) once per
 * condition, per trial, each as its own child process with the env vars that
 * condition needs — never mutating this process's own env, and never a new
 * evaluation harness. See docs/sandy-benchmark.md for what this measures,
 * what it does NOT measure (telephony/audio latency — text replay only), and
 * the decision rule for reading the output.
 *
 * This script makes NO live model or phone calls by itself: it only shells
 * out to the same CLI a person would run by hand. It is not wired into any
 * npm script, cron, or CI job — nothing invokes it automatically.
 *
 * Usage (each condition still needs ANTHROPIC_API_KEY, exactly like
 * run-voice-relay-eval.js on its own). `--candidate-model` is REQUIRED — this
 * runner has no default candidate: the model registry (server/config/models.js)
 * has no "candidate under test" tier, because a benchmark candidate is a
 * deliberate, one-off comparison choice, not a standing production tier a
 * literal here could pin (AGENTS.md "Hardcoded Anthropic model IDs" — a
 * `'claude-…'` default here would be exactly that violation). Pass any
 * allowlisted `MODEL_CATALOG` id (see docs/sandy-benchmark.md for how to list
 * them and a worked example):
 *   node server/scripts/run-voice-relay-benchmark.js --candidate-model=claude-haiku-4-5-20251001
 *   node server/scripts/run-voice-relay-benchmark.js --candidate-model=claude-haiku-4-5-20251001 --trials=5
 *   node server/scripts/run-voice-relay-benchmark.js --candidate-model=claude-haiku-4-5-20251001 --only=booking-happy-path,slot-gone
 *   node server/scripts/run-voice-relay-benchmark.js --candidate-model=claude-haiku-4-5-20251001 --judge
 *   node server/scripts/run-voice-relay-benchmark.js --candidate-model=claude-haiku-4-5-20251001 --out=/tmp/sandy-benchmark.json
 *
 * Exit code is non-zero if any condition's run itself failed to complete
 * (crashed OR inconclusive) — a scenario-level pass/fail miss inside a
 * completed run does NOT fail this script; the report below is what carries
 * that verdict, since a candidate that regresses a single scenario is a
 * different outcome than a benchmark that could not run at all. A missing
 * `--candidate-model` is a usage error (exit 2), same as a runner crash,
 * since no condition ran at all.
 */

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const SCRIPT_PATH = path.join(__dirname, 'run-voice-relay-eval.js');
const DEFAULT_TRIALS = 3;
const CHILD_TIMEOUT_MS = 60 * 60 * 1000; // one hour per trial — generous; the eval's own child ceiling is 8h for the whole fixture

function parseArgs(argv) {
  return Object.fromEntries(
    argv.map((arg) => {
      if (!arg.startsWith('--')) return [arg, true];
      const [key, value] = arg.slice(2).split('=');
      return [key, value === undefined ? true : value];
    }),
  );
}

// The four conditions from the brief §4. Only VOICE_RELAY_INBOUND_MODEL and
// VOICE_RELAY_RENDERER apply here — this is the TEXT-REPLAY harness, which
// never constructs RelayConversation with `sandbox: true` (see
// server/services/eval/voice-relay-replay.js's newConversation), so the
// *_SANDBOX_* override variables have NO EFFECT on this script. A real
// sandbox PHONE CALL is the only path that reads VOICE_RELAY_SANDBOX_MODEL /
// VOICE_RELAY_SANDBOX_RENDERER (server/services/voice-agent/relay-server.js
// passes `sandbox: authenticatedSandboxCall`) — see docs/sandy-benchmark.md.
function buildConditions(candidateModel) {
  return [
    { id: 'current-block', env: {} },
    { id: 'current-stream', env: { VOICE_RELAY_RENDERER: 'stream' } },
    { id: 'candidate-block', env: { VOICE_RELAY_INBOUND_MODEL: candidateModel } },
    { id: 'candidate-stream', env: { VOICE_RELAY_INBOUND_MODEL: candidateModel, VOICE_RELAY_RENDERER: 'stream' } },
  ];
}

/**
 * One condition × trial, as its own child process. Only a parsed result
 * whose status is 'pass' or 'fail' is a COMPLETED run (ranOk) — those are
 * the eval CLI's own two "the eval evaluated something" outcomes (exit 0 / 1;
 * see run-voice-relay-eval.js). 'inconclusive' (exit 3, "the eval could not
 * run") is valid JSON but NOT a completed run: it must never be silently
 * folded into ranOk, and its error must survive into the report. Anything
 * else (no JSON, exit 2, a signal, a timeout) is a plain crash.
 */
function runOnce(condition, trial, { cliArgs = {}, scriptPath = SCRIPT_PATH, execFileImpl = execFile, timeoutMs = CHILD_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const args = [scriptPath, '--json'];
    if (cliArgs.judge) args.push('--judge');
    if (cliArgs.only) args.push(`--only=${cliArgs.only}`);
    const env = {
      ...process.env,
      ...condition.env,
      // Explicitly unset every override this condition does not set, so a
      // leftover value in the invoking shell can never leak into a
      // "current" condition and silently turn it into a second candidate run.
      ...(condition.env.VOICE_RELAY_INBOUND_MODEL ? {} : { VOICE_RELAY_INBOUND_MODEL: '' }),
      ...(condition.env.VOICE_RELAY_RENDERER ? {} : { VOICE_RELAY_RENDERER: '' }),
    };
    const startedAt = Date.now();
    execFileImpl(process.execPath, args, { env, timeout: timeoutMs, maxBuffer: 1024 * 1024 * 64 }, (err, stdout) => {
      const wallMs = Date.now() - startedAt;
      let parsed = null;
      try { parsed = JSON.parse(stdout); } catch { /* fall through with parsed = null below */ }

      const completed = !!(parsed && (parsed.status === 'pass' || parsed.status === 'fail'));
      const inconclusive = !!(parsed && parsed.status === 'inconclusive');
      resolve({
        condition: condition.id,
        trial,
        wallMs,
        ranOk: completed,
        inconclusive,
        exitCode: err && typeof err.code === 'number' ? err.code : (err ? null : 0),
        crashError: completed
          ? null
          : inconclusive
            ? ((parsed.error && parsed.error.message) || 'eval reported inconclusive with no error detail')
            : (err ? err.message : 'no JSON on stdout'),
        result: parsed,
      });
    });
  });
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarizeCondition(id, runs) {
  const completed = runs.filter((r) => r.ranOk);
  const inconclusiveRuns = runs.filter((r) => r.inconclusive);
  const crashedRuns = runs.filter((r) => !r.ranOk && !r.inconclusive);
  const durations = completed.map((r) => r.result.summary?.durationMs).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);

  // Aggregate EVERY attempt the eval CLI made (result.attempts, its own
  // compact {status, summary, error} list — 1 entry, or 2 when a first
  // attempt failed and the harness retried once), not just result.summary
  // (the retry wrapper's SELECTED finalAttempt). A first-attempt critical
  // miss that a pass-on-retry clears never appears in result.summary, so
  // reading only that field silently drops it and undercounts scenario
  // samples. See docs/sandy-benchmark.md "Retry accounting" for the
  // resulting sample-size note. An inconclusive attempt carries no `summary`
  // (attemptReplay returns no `run` for it) and is excluded from these sums
  // — it is already reflected in inconclusiveRuns/retriedRuns above.
  const attemptSummaries = completed.flatMap((r) => (r.result.attempts || []).map((a) => a.summary).filter(Boolean));
  const sumAttempts = (key) => attemptSummaries.reduce((n, s) => n + (s[key] || 0), 0);
  const retriedRuns = completed.filter((r) => (r.result.attempts || []).length > 1).length;
  const flakyRuns = completed.filter((r) => r.result.flaky === true).length;

  return {
    condition: id,
    trials: runs.length,
    completedRuns: completed.length,
    inconclusiveRuns: inconclusiveRuns.length,
    crashedRuns: crashedRuns.length,
    // How many completed runs needed the eval CLI's own retry-once (a failed
    // first attempt), and how many of those retries flipped to a pass
    // (flaky — see voice-relay-replay.js's attemptWithRetry). Reported
    // separately from the pass/fail/miss sums below, never folded into them.
    retriedRuns,
    flakyRuns,
    // Per-condition scenario pass/fail/misses is summed ACROSS every attempt
    // of every trial — a retried trial contributes twice (its first, failed
    // attempt AND its retry), so this is a sample of attempts × scenarios,
    // not trials × scenarios; attemptSamples below is the true denominator.
    attemptSamples: attemptSummaries.length,
    scenarioSamples: sumAttempts('scenarios'),
    scenarioPasses: sumAttempts('passed'),
    scenarioFailures: sumAttempts('failed'),
    replayErrors: sumAttempts('replayErrors'),
    criticalMisses: sumAttempts('criticalMisses'),
    // durationMs here is the TEXT-REPLAY harness's own end-to-end wall clock
    // for the SELECTED final attempt only (real Anthropic API calls, no
    // telephony) — see the file header and docs/sandy-benchmark.md for what
    // this does and does not measure.
    durationMsMedian: percentile(durations, 50),
    durationMsP90: durations.length >= 3 ? percentile(durations, 90) : null, // suppress a p90 the sample is too small to support
    durationMsSampleCount: durations.length,
  };
}

/**
 * Runs every condition × trial and returns the combined report, without
 * touching stdout/the filesystem unless asked — the CLI entry point below
 * is the only caller that prints/writes by default, so tests can drive this
 * directly against a stubbed child process.
 */
async function runBenchmark({ argv = process.argv.slice(2), execFileImpl = execFile, scriptPath = SCRIPT_PATH, timeoutMs = CHILD_TIMEOUT_MS, log = () => {} } = {}) {
  const ARGS = parseArgs(argv);
  if (!ARGS['candidate-model'] || ARGS['candidate-model'] === true) {
    throw new Error(
      "--candidate-model is required (e.g. --candidate-model=claude-haiku-4-5-20251001). "
      + 'There is no default: the model registry has no standing "candidate under test" '
      + 'tier a fallback could safely pin (see server/config/models.js and the file header above).',
    );
  }
  const candidateModel = ARGS['candidate-model'];
  const trials = Math.max(1, parseInt(ARGS.trials, 10) || DEFAULT_TRIALS);
  const CONDITIONS = buildConditions(candidateModel);

  const runs = [];
  // Interleaved order: one trial of every condition before the next trial of
  // any condition, per the brief — never all of condition A's trials, then
  // all of B's. Trial index 0 of each condition is the ONLY one to treat as
  // a cold/cache-miss observation candidate; trials 1..N-1 are warm.
  for (let trial = 0; trial < trials; trial += 1) {
    for (const condition of CONDITIONS) {
      // Deliberately sequential: this is a benchmark, not a load test —
      // concurrent children would contend for the same rate limit and
      // confound latency across conditions.
      const r = await runOnce(condition, trial, { cliArgs: ARGS, scriptPath, execFileImpl, timeoutMs });
      r.cacheHypothesis = trial === 0 ? 'cold' : 'warm';
      runs.push(r);
      log(`[benchmark] ${condition.id} trial=${trial} ranOk=${r.ranOk}${r.inconclusive ? ' inconclusive=true' : ''} wallMs=${r.wallMs}\n`);
    }
  }

  const byCondition = CONDITIONS.map((c) => summarizeCondition(c.id, runs.filter((r) => r.condition === c.id)));
  const report = {
    generatedAt: new Date().toISOString(),
    candidateModel,
    trials,
    only: ARGS.only || null,
    judge: !!ARGS.judge,
    conditions: byCondition,
    runs, // full per-trial detail, including any crash/inconclusive error
  };

  // Missing data — a crash OR an inconclusive eval run — makes the whole
  // benchmark exit non-zero: neither is a scenario-level miss inside a
  // completed run, so neither is allowed to look like a clean pass.
  const anyIncomplete = byCondition.some((c) => c.crashedRuns > 0 || c.inconclusiveRuns > 0);
  return { report, outPath: ARGS.out || null, exitCode: anyIncomplete ? 1 : 0 };
}

module.exports = {
  parseArgs,
  buildConditions,
  runOnce,
  percentile,
  summarizeCondition,
  runBenchmark,
  DEFAULT_TRIALS,
  CHILD_TIMEOUT_MS,
  SCRIPT_PATH,
};

/* istanbul ignore next -- exercised via the CLI, not unit tests */
if (require.main === module) {
  (async function main() {
    try {
      const { report, exitCode } = await runBenchmark({ log: (line) => process.stderr.write(line) });
      const outPath = parseArgs(process.argv.slice(2)).out
        || path.join(__dirname, '..', '..', `voice-relay-benchmark-${Date.now()}.json`);
      fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
      console.log(`\nWrote ${outPath}\n`);
      console.table(report.conditions.map((c) => ({
        condition: c.condition, trials: c.trials, completed: c.completedRuns,
        inconclusive: c.inconclusiveRuns, crashed: c.crashedRuns, retried: c.retriedRuns,
        scenarios: c.scenarioSamples, passed: c.scenarioPasses, failed: c.scenarioFailures, critical: c.criticalMisses,
        'durationMs p50': c.durationMsMedian, 'durationMs p90': c.durationMsP90 ?? 'n/a (n<3)',
      })));
      process.exitCode = exitCode;
    } catch (err) {
      console.error(err.message);
      process.exitCode = 2;
    }
  })();
}
