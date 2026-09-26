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
 * run-voice-relay-eval.js on its own):
 *   node server/scripts/run-voice-relay-benchmark.js
 *   node server/scripts/run-voice-relay-benchmark.js --trials=5
 *   node server/scripts/run-voice-relay-benchmark.js --candidate-model=claude-haiku-4-5-20251001
 *   node server/scripts/run-voice-relay-benchmark.js --only=booking-happy-path,slot-gone
 *   node server/scripts/run-voice-relay-benchmark.js --judge
 *   node server/scripts/run-voice-relay-benchmark.js --out=/tmp/sandy-benchmark.json
 *
 * Exit code is non-zero if any condition's run itself failed to complete
 * (crashed or inconclusive) — a scenario-level pass/fail miss inside a
 * completed run does NOT fail this script; the report below is what carries
 * that verdict, since a candidate that regresses a single scenario is a
 * different outcome than a benchmark that could not run at all.
 */

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const SCRIPT_PATH = path.join(__dirname, 'run-voice-relay-eval.js');
const DEFAULT_CANDIDATE_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_TRIALS = 3;
const CHILD_TIMEOUT_MS = 60 * 60 * 1000; // one hour per trial — generous; the eval's own child ceiling is 8h for the whole fixture

const ARGS = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    if (!arg.startsWith('--')) return [arg, true];
    const [key, value] = arg.slice(2).split('=');
    return [key, value === undefined ? true : value];
  }),
);

const candidateModel = ARGS['candidate-model'] || DEFAULT_CANDIDATE_MODEL;
const trials = Math.max(1, parseInt(ARGS.trials, 10) || DEFAULT_TRIALS);

// The four conditions from the brief §4. Only VOICE_RELAY_INBOUND_MODEL and
// VOICE_RELAY_RENDERER apply here — this is the TEXT-REPLAY harness, which
// never constructs RelayConversation with `sandbox: true` (see
// server/services/eval/voice-relay-replay.js's newConversation), so the
// *_SANDBOX_* override variables have NO EFFECT on this script. A real
// sandbox PHONE CALL is the only path that reads VOICE_RELAY_SANDBOX_MODEL /
// VOICE_RELAY_SANDBOX_RENDERER (server/services/voice-agent/relay-server.js
// passes `sandbox: authenticatedSandboxCall`) — see docs/sandy-benchmark.md.
const CONDITIONS = [
  { id: 'current-block', env: {} },
  { id: 'current-stream', env: { VOICE_RELAY_RENDERER: 'stream' } },
  { id: 'candidate-block', env: { VOICE_RELAY_INBOUND_MODEL: candidateModel } },
  { id: 'candidate-stream', env: { VOICE_RELAY_INBOUND_MODEL: candidateModel, VOICE_RELAY_RENDERER: 'stream' } },
];

function runOnce(condition, trial) {
  return new Promise((resolve) => {
    const args = [SCRIPT_PATH, '--json'];
    if (ARGS.judge) args.push('--judge');
    if (ARGS.only) args.push(`--only=${ARGS.only}`);
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
    execFile(process.execPath, args, { env, timeout: CHILD_TIMEOUT_MS, maxBuffer: 1024 * 1024 * 64 }, (err, stdout) => {
      const wallMs = Date.now() - startedAt;
      let parsed = null;
      try { parsed = JSON.parse(stdout); } catch { /* fall through with parsed = null below */ }
      resolve({
        condition: condition.id, trial, wallMs,
        ranOk: !!parsed,
        crashError: parsed ? null : (err ? err.message : 'no JSON on stdout'),
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
  const durations = completed.map((r) => r.result.summary?.durationMs).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  return {
    condition: id,
    trials: runs.length,
    completedRuns: completed.length,
    crashedRuns: runs.length - completed.length,
    // Per-condition scenario pass/fail is summed ACROSS trials — every trial
    // re-runs the full (or --only) scenario set, so this is a sample of
    // trials × scenarios, not trials alone; report both sample sizes.
    scenarioSamples: completed.reduce((n, r) => n + (r.result.summary?.scenarios || 0), 0),
    scenarioPasses: completed.reduce((n, r) => n + (r.result.summary?.passed || 0), 0),
    scenarioFailures: completed.reduce((n, r) => n + (r.result.summary?.failed || 0), 0),
    replayErrors: completed.reduce((n, r) => n + (r.result.summary?.replayErrors || 0), 0),
    criticalMisses: completed.reduce((n, r) => n + (r.result.summary?.criticalMisses || 0), 0),
    // durationMs here is the TEXT-REPLAY harness's own end-to-end wall clock
    // per run (real Anthropic API calls, no telephony) — see the file header
    // and docs/sandy-benchmark.md for what this does and does not measure.
    durationMsMedian: percentile(durations, 50),
    durationMsP90: durations.length >= 3 ? percentile(durations, 90) : null, // suppress a p90 the sample is too small to support
    durationMsSampleCount: durations.length,
  };
}

(async function main() {
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
      const r = await runOnce(condition, trial);
      r.cacheHypothesis = trial === 0 ? 'cold' : 'warm';
      runs.push(r);
      process.stderr.write(`[benchmark] ${condition.id} trial=${trial} ranOk=${r.ranOk} wallMs=${r.wallMs}\n`);
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
    runs, // full per-trial detail, including any crash message
  };

  const outPath = ARGS.out || path.join(__dirname, '..', '..', `voice-relay-benchmark-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nWrote ${outPath}\n`);
  console.table(byCondition.map((c) => ({
    condition: c.condition, trials: c.trials, completed: c.completedRuns, crashed: c.crashedRuns,
    scenarios: c.scenarioSamples, passed: c.scenarioPasses, failed: c.scenarioFailures, critical: c.criticalMisses,
    'durationMs p50': c.durationMsMedian, 'durationMs p90': c.durationMsP90 ?? 'n/a (n<3)',
  })));

  const anyCrashed = byCondition.some((c) => c.crashedRuns > 0);
  if (anyCrashed) process.exitCode = 1;
})();
