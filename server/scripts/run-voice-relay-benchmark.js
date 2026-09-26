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
// Each child here IS a full run of run-voice-relay-eval.js — the shipped
// 36-scenario fixture (up to 90 caller turns, six 20s model streams per turn)
// plus the eval's own retry-once wrapper, plus --judge's chains. That is
// exactly the run the eval harness's own operational ceiling is sized for
// (server/services/eval/voice-relay-replay.js CHILD_TIMEOUT_MS derivation,
// exported as _internals.CHILD_TIMEOUT_MS: up to 3h/attempt, doubled for the
// retry = 7h12m, +48m overhead = 8h) — so this runner must use a ceiling AT
// LEAST that generous, or it would kill a legitimately still-running child
// well before the eval's own wrapper would. Mirrored as a literal rather
// than required directly: voice-relay-eval.js's module graph is heavier
// (call-extraction-replay, the relay conversation loader, etc.) than this
// file's own runOnce/summarizeCondition unit tests need — see runBenchmark's
// existing lazy require of relay-conversation below for the same reason.
// Re-derive together if that file's ceiling ever changes.
const CHILD_TIMEOUT_MS = 8 * 60 * 60 * 1000;
// The full set of flags this runner understands (see the file header's
// usage examples). An unrecognized flag — a typo like --onyl or --trail — is
// a usage error caught here, before any child process runs, rather than
// silently doing nothing (parseArgs accepts any --key=value) or running the
// wrong condition set for hours before anyone notices the typo.
const SUPPORTED_OPTIONS = new Set(['candidate-model', 'trials', 'only', 'judge', 'out']);

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

// A Williams (balanced Latin square) design for exactly 4 conditions: these
// 4 orders (as index permutations of the natural buildConditions() order)
// give every ordered pair of DISTINCT conditions exactly one immediate
// adjacency across the 4 orders — first-order carryover balance, not just
// "every condition gets every slot once" (a plain cyclic rotation keeps
// each condition's neighbor fixed across trials — current-stream always
// follows current-block — which a Latin square does not fix). Trial counts
// that are not a multiple of 4 leave a residual imbalance — see
// docs/sandy-benchmark.md "Interleaving, rotation, and why there is no
// cold/warm label" for the recommendation to run multiples of 4.
const WILLIAMS_ORDER_INDEXES = Object.freeze([
  [0, 1, 3, 2],
  [1, 2, 0, 3],
  [2, 3, 1, 0],
  [3, 0, 2, 1],
]);

/**
 * Reorders the condition list by trial index using the Williams design
 * above (cycling every 4 trials): the SET of conditions run in a trial is
 * unchanged, only their order. Falls back to a plain cyclic rotation for any
 * condition count other than 4 — buildConditions() always returns exactly 4,
 * so this branch is defensive only, never exercised today.
 */
function rotateConditions(conditions, trial) {
  const n = conditions.length;
  if (!n) return conditions;
  if (n !== 4) {
    const offset = ((trial % n) + n) % n;
    return [...conditions.slice(offset), ...conditions.slice(0, offset)];
  }
  const order = WILLIAMS_ORDER_INDEXES[((trial % 4) + 4) % 4];
  return order.map((i) => conditions[i]);
}

/**
 * Classifies one child process outcome. Only a parsed result whose status
 * is 'pass' or 'fail' AND whose child exited normally is a COMPLETED run
 * (ranOk) — those are the eval CLI's own two "the eval evaluated something"
 * outcomes (exit 0 / 1; see run-voice-relay-eval.js). 'inconclusive' (exit 3,
 * "the eval could not run") is valid JSON but NOT a completed run: it must
 * never be silently folded into ranOk, and its error must survive into the
 * report. "Exited normally" means exit 0/1/3 with no signal/timeout,
 * mirroring runVoiceRelayEvalProcess() in voice-relay-replay.js: execFile
 * hands back a non-null `err` for any non-zero exit code AND for a
 * killed/timed-out child; `err.code` is a number only for a plain exit code,
 * never for a signal kill, so a timeout/signal always falls through to
 * `code = null` here even if a stray, stale write left something
 * JSON-parseable on stdout — that stdout can never be trusted as a result.
 * Anything else (no JSON, exit 2, a signal, a timeout) is a plain crash.
 */
function signalCrashError(err) {
  return `child ${err.killed ? 'timed out' : `received signal ${err.signal || 'unknown'}`} before producing a trustworthy result`;
}

function classifyChildResult(err, parsed) {
  const code = err && typeof err.code === 'number' ? err.code : (err ? null : 0);
  const signaled = !!(err && (err.killed === true || err.signal));
  const exitOk = !signaled && (code === 0 || code === 1 || code === 3);
  const completed = !!(parsed && exitOk && (parsed.status === 'pass' || parsed.status === 'fail'));
  const inconclusive = !!(parsed && exitOk && parsed.status === 'inconclusive');
  if (completed) return { code, completed, inconclusive, crashError: null };
  if (inconclusive) return { code, completed, inconclusive, crashError: (parsed.error && parsed.error.message) || 'eval reported inconclusive with no error detail' };
  const crashError = signaled ? signalCrashError(err) : (err ? err.message : 'no JSON on stdout');
  return { code, completed, inconclusive, crashError };
}

/**
 * P1: a candidate condition's requested model must be the one the session
 * actually pinned. `results[].model` is the resolved session model stamp
 * (voice-relay-replay.js: `record.model = convo.model`) — an
 * unknown/rejected override id silently falls back down the chain
 * (relay-conversation.js resolveSessionModel), which would otherwise make a
 * "candidate" run silently re-run the CURRENT model instead. Only checked
 * for a completed run against an expected (non-null) model — the two
 * "current" conditions have no override to verify.
 */
function checkModelStamp(completed, expectedModel, parsed) {
  if (!completed || !expectedModel) return { modelMismatch: false, resolvedModels: [] };
  const resolvedModels = [...new Set((parsed.results || []).map((s) => s && s.model).filter(Boolean))];
  return { modelMismatch: resolvedModels.some((m) => m !== expectedModel), resolvedModels };
}

// --out and --only take a value; parseArgs hands back `true` for a bare
// `--out` or `--only` with no `=value` (indistinguishable from a real string
// value once destructured elsewhere), which would otherwise write the report
// to the literal path "true" or filter scenarios down to none — silently,
// after every child has already run for up to CHILD_TIMEOUT_MS. Checked
// before any child runs, same as --candidate-model and --trials below.
const VALUE_OPTIONS_NEEDING_A_VALUE = Object.freeze(['out', 'only']);
function assertValueOptions(ARGS) {
  for (const key of VALUE_OPTIONS_NEEDING_A_VALUE) {
    if (ARGS[key] === true) {
      throw new Error(`--${key} requires a value (got --${key} with no value)`);
    }
  }
}

/**
 * --only, once it has passed assertValueOptions above (so it is a real
 * string, not the bare-flag `true`), must still name at least one actual
 * scenario id. `--only=`, `--only=,`, and `--only= , ` all pass a non-empty
 * STRING through to every child's own `--only=<value>` (runOnce) that
 * run-voice-relay-eval.js's own comma-split reduces to an EMPTY ids array —
 * and voice-relay-replay.js's `selectScenarios` treats an empty (or absent)
 * ids array as "no filter" and returns every scenario in the fixture. A
 * delimiter-only value would therefore silently run the FULL fixture on
 * every condition instead of the narrowed set actually intended, for up to
 * CHILD_TIMEOUT_MS each, before anyone noticed the filter never took
 * effect. Checked before any child runs, same as the other usage checks in
 * this file.
 */
function assertOnlyHasIds(ARGS) {
  if (ARGS.only === undefined || ARGS.only === true) return; // absent, or already rejected above
  const ids = String(ARGS.only).split(',').map((s) => s.trim()).filter(Boolean);
  if (!ids.length) {
    throw new Error(`--only must name at least one scenario id (got "${ARGS.only}")`);
  }
}

/**
 * --trials, when given at all, must be an explicit positive integer — no
 * value (`--trials` alone, parseArgs hands back `true`), a non-numeric
 * string, zero, or a negative number all used to fall through
 * `parseInt(...) || DEFAULT_TRIALS` and silently run the default trial count
 * instead of erroring, which could run the WRONG number of trials (or, for a
 * typo'd non-numeric value, none of the caller's intent) for up to an hour
 * per condition before anyone noticed. The flag being absent entirely is
 * unaffected — that is the documented default (see the file header's usage
 * examples) and still resolves to DEFAULT_TRIALS. Pulled out of runBenchmark
 * so its own branching doesn't push that function over the complexity cap.
 */
function resolveTrials(ARGS) {
  if (!Object.prototype.hasOwnProperty.call(ARGS, 'trials')) return DEFAULT_TRIALS;
  const raw = ARGS.trials;
  const parsed = typeof raw === 'string' && /^-?\d+$/.test(raw) ? parseInt(raw, 10) : NaN;
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `--trials must be an explicit positive integer (got ${raw === true ? '--trials with no value' : `"${raw}"`})`,
    );
  }
  return parsed;
}

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
    // The one model this condition actually requested via the override env
    // (unset for the two "current" conditions) — used below to catch the
    // relay silently falling back to a different model than the one asked
    // for (an unknown/rejected override id, or a stale allowlist).
    const expectedModel = condition.env.VOICE_RELAY_INBOUND_MODEL || null;
    const startedAt = Date.now();
    execFileImpl(process.execPath, args, { env, timeout: timeoutMs, maxBuffer: 1024 * 1024 * 64 }, (err, stdout) => {
      const wallMs = Date.now() - startedAt;
      let parsed = null;
      try { parsed = JSON.parse(stdout); } catch { /* fall through with parsed = null below */ }

      const { code, completed, inconclusive, crashError } = classifyChildResult(err, parsed);
      const { modelMismatch, resolvedModels } = checkModelStamp(completed, expectedModel, parsed);

      resolve({
        condition: condition.id,
        trial,
        wallMs,
        ranOk: completed,
        inconclusive,
        exitCode: code,
        modelMismatch,
        resolvedModels,
        crashError,
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
  const ranOk = runs.filter((r) => r.ranOk);
  // A model-mismatch run (see runOnce's modelMismatch / checkModelStamp) is
  // missing data, not a clean pass: its resolved session silently ran a
  // DIFFERENT model than the candidate condition requested, so none of its
  // numbers — latency, judge counts, scenario totals — are evidence about
  // the model actually asked for. Excluded from `completed` (and so from
  // every aggregate below) and from `completedRuns`; counted separately as
  // `modelMismatchRuns`, same as a crash or an inconclusive run.
  const completed = ranOk.filter((r) => r.modelMismatch !== true);
  const modelMismatchRuns = ranOk.filter((r) => r.modelMismatch === true).length;
  const inconclusiveRuns = runs.filter((r) => r.inconclusive);
  const crashedRuns = runs.filter((r) => !r.ranOk && !r.inconclusive);
  // Latency: aggregate durationMs from EVERY entry of result.attempts (each
  // attempt's own summary.durationMs — voice-relay-replay.js's tallyRecord
  // sums it per attempt, and compactAttempt carries the whole run summary
  // through unstripped), never just result.summary (the retry wrapper's
  // SELECTED finalAttempt) — reading only that field would silently swap in
  // the RETRY's duration for a retried run, discarding the failed first
  // attempt's real cost and making a flaky condition look no slower than a
  // clean one. Reported as two SEPARATE distributions, never blended (see
  // docs/sandy-benchmark.md "Latency" for which one to compare):
  //   - first-attempt: this run's FIRST attempt only. Every completed run
  //     has exactly one, retried or not, so this is the apples-to-apples
  //     figure across conditions — a retry can never inflate or deflate it.
  //   - total-run: the SUM of every attempt this run made (first + retry,
  //     when retried) — the real wall-clock cost of the run as it actually
  //     happened, so a retried run's true cost stays visible instead of
  //     hiding behind the selected attempt alone.
  const firstAttemptDurations = completed
    .map((r) => (r.result.attempts || [])[0] && (r.result.attempts || [])[0].summary && (r.result.attempts || [])[0].summary.durationMs)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  const totalRunDurations = completed
    .map((r) => (r.result.attempts || []).reduce((n, a) => n + ((a.summary && a.summary.durationMs) || 0), 0))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

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
  // Every attempt's summary carries `judged` / `judgeFallbacks` / `judgeErrors`
  // (voice-relay-replay.js's `summarize()` output, unstripped by
  // `compactAttempt` — see call site), so these three sum cleanly across every
  // attempt, same as the scenario counts above. A judge PASS count is a
  // different story: no attempt summary carries a pass/fail split, only the
  // FINAL (selected) attempt's full `results[].judge.verdict.pass` does — so
  // that one figure is drawn from the final attempt only, across trials,
  // and is labeled accordingly (see `judgePassCountFinalAttemptOnly` below and
  // docs/sandy-benchmark.md "Metrics to report").
  const judgedCount = sumAttempts('judged');
  const judgeFallbackCount = sumAttempts('judgeFallbacks');
  const judgeErrorCount = sumAttempts('judgeErrors');
  // The same final-attempt population judgePassCountFinalAttemptOnly draws
  // its numerator from (a result with `judge.ok` and a verdict at all — pass
  // or fail), so a naturalness RATE can be computed as
  // judgePassCountFinalAttemptOnly / judgedCountFinalAttemptOnly without
  // mixing it with the attempt-summed judgedCount above, which is a
  // different, larger sample (every attempt, not just the final one).
  //
  // A FALLBACK-LEG verdict (`judge.judge_fallback === true`) is excluded from
  // both figures below: voice-relay-judge.js's own contract (and
  // voice-relay-replay.js's judgeChecks, which marks such a verdict's checks
  // "advisory" rather than pass/fail) treats a fallback-leg verdict as
  // advisory ONLY — it can never flip a scenario's pass/fail, so it must not
  // be folded into the naturalness rate's primary-judge population either.
  // Reported separately, under its own name, so a fallback-heavy run is
  // visible rather than silently blended into the rate.
  const finalAttemptJudgeResults = (r) => (r.result.results || []).filter((s) => s && s.judge && s.judge.ok === true && s.judge.verdict);
  const judgedCountFinalAttemptOnly = completed.reduce(
    (n, r) => n + finalAttemptJudgeResults(r).filter((s) => s.judge.judge_fallback !== true).length,
    0,
  );
  const judgePassCountFinalAttemptOnly = completed.reduce(
    (n, r) => n + finalAttemptJudgeResults(r).filter((s) => s.judge.judge_fallback !== true && s.judge.verdict.pass === true).length,
    0,
  );
  // The fallback-leg population, kept separate and labeled as such: how many
  // final-attempt results got an advisory (fallback-leg) verdict at all, and
  // how many of those advisory verdicts said "pass" — never mixed into the
  // primary-judge figures above.
  const judgeFallbackVerdictCountFinalAttemptOnly = completed.reduce(
    (n, r) => n + finalAttemptJudgeResults(r).filter((s) => s.judge.judge_fallback === true).length,
    0,
  );
  const judgeFallbackPassCountFinalAttemptOnly = completed.reduce(
    (n, r) => n + finalAttemptJudgeResults(r).filter((s) => s.judge.judge_fallback === true && s.judge.verdict.pass === true).length,
    0,
  );
  // sumAttempts('scenarios') — the sum of scenario counts across every
  // attempt — is the true per-scenario denominator (a retried trial
  // contributes both its failed first attempt AND its retry). Exposed under
  // an unambiguous name distinct from attemptCount (attempts only, never
  // multiplied by scenarios-per-attempt): report THIS, not attemptCount,
  // next to scenarioPasses/scenarioFailures/criticalMisses.
  const scenarioAttemptSamples = sumAttempts('scenarios');
  // Task-accuracy's own denominator: scenarios the harness actually
  // EVALUATED. A replay error (`replayErrors`, status 'error' — the harness
  // itself broke on that scenario, e.g. a tool-schema mismatch, never
  // delivering a verdict either way) is missing data, not an evaluated
  // scenario that happened to fail — folding it into scenarioAttemptSamples
  // would understate a candidate's task accuracy for a harness problem that
  // has nothing to do with the model's behavior. Summed PER ATTEMPT (each
  // attempt's own scenarios minus its own replayErrors), the same way
  // scenarioPasses is summed above, rather than subtracting two
  // independently-computed totals. Report this, not scenarioAttemptSamples,
  // as task accuracy's denominator; replayErrors stays its own reported
  // figure (missing data), same as today.
  const scenarioEvaluatedSamples = attemptSummaries.reduce((n, s) => n + Math.max(0, (s.scenarios || 0) - (s.replayErrors || 0)), 0);

  return {
    condition: id,
    trials: runs.length,
    completedRuns: completed.length,
    inconclusiveRuns: inconclusiveRuns.length,
    crashedRuns: crashedRuns.length,
    modelMismatchRuns,
    // How many completed runs needed the eval CLI's own retry-once (a failed
    // first attempt), and how many of those retries flipped to a pass
    // (flaky — see voice-relay-replay.js's attemptWithRetry). Reported
    // separately from the pass/fail/miss sums below, never folded into them.
    retriedRuns,
    flakyRuns,
    // How many attempts ran in total (trials × 1, plus one more per retried
    // trial) — a COUNT of attempts, never itself a scenario-level
    // denominator (an attempt may carry more than one scenario). Renamed
    // from the old, misleading `attemptSamples` name: see
    // scenarioAttemptSamples below for the true per-scenario denominator.
    attemptCount: attemptSummaries.length,
    scenarioAttemptSamples,
    scenarioEvaluatedSamples,
    scenarioPasses: sumAttempts('passed'),
    scenarioFailures: sumAttempts('failed'),
    replayErrors: sumAttempts('replayErrors'),
    criticalMisses: sumAttempts('criticalMisses'),
    judgedCount,
    judgeFallbackCount,
    judgeErrorCount,
    judgedCountFinalAttemptOnly,
    judgePassCountFinalAttemptOnly,
    // The fallback-leg (advisory-only) verdict population, kept OUT of the
    // two figures above — see the comment where these are computed. Report
    // both when non-zero: a condition leaning on the fallback judge a lot is
    // a reliability signal about the judge call itself, not about Sandy.
    judgeFallbackVerdictCountFinalAttemptOnly,
    judgeFallbackPassCountFinalAttemptOnly,
    // durationMs here is the TEXT-REPLAY harness's own end-to-end wall clock
    // (real Anthropic API calls, no telephony) — see the file header and
    // docs/sandy-benchmark.md "Latency" for what this does and does not
    // measure, and which of the two figures below to compare across
    // conditions (first-attempt p50/p90 is the apples-to-apples one).
    durationMsFirstAttemptMedian: percentile(firstAttemptDurations, 50),
    durationMsFirstAttemptP90: firstAttemptDurations.length >= 3 ? percentile(firstAttemptDurations, 90) : null, // suppress a p90 the sample is too small to support
    durationMsFirstAttemptSampleCount: firstAttemptDurations.length,
    durationMsTotalRunMedian: percentile(totalRunDurations, 50),
    durationMsTotalRunP90: totalRunDurations.length >= 3 ? percentile(totalRunDurations, 90) : null,
    durationMsTotalRunSampleCount: totalRunDurations.length,
  };
}

/**
 * Runs every condition × trial and returns the combined report, without
 * touching stdout/the filesystem unless asked — the CLI entry point below
 * is the only caller that prints/writes by default, so tests can drive this
 * directly against a stubbed child process.
 */
/**
 * Where the combined report will be written, checked BEFORE the first paid
 * child runs: the write happens only after every condition and trial has
 * finished, so an unwritable destination discovered then would throw away
 * hours of runs and their provider spend.
 */
function resolveOutPath(ARGS, { fsImpl = fs } = {}) {
  const outPath = path.resolve(ARGS.out || path.join(__dirname, '..', '..', `voice-relay-benchmark-${Date.now()}.json`));
  const target = fsImpl.existsSync(outPath) ? outPath : path.dirname(outPath);
  try {
    fsImpl.accessSync(target, fs.constants.W_OK);
  } catch (err) {
    throw new Error(`--out destination is not writable: ${outPath} (${err.code || err.message})`);
  }
  return outPath;
}

async function runBenchmark({ argv = process.argv.slice(2), execFileImpl = execFile, scriptPath = SCRIPT_PATH, timeoutMs = CHILD_TIMEOUT_MS, log = () => {} } = {}) {
  const ARGS = parseArgs(argv);
  const unknownOptions = Object.keys(ARGS).filter((k) => !SUPPORTED_OPTIONS.has(k));
  if (unknownOptions.length) {
    throw new Error(
      `unknown option${unknownOptions.length > 1 ? 's' : ''}: ${unknownOptions.map((k) => `--${k}`).join(', ')} `
      + `(supported: ${[...SUPPORTED_OPTIONS].map((k) => `--${k}`).join(', ')})`,
    );
  }
  assertValueOptions(ARGS);
  assertOnlyHasIds(ARGS);
  const outPath = resolveOutPath(ARGS);
  if (!ARGS['candidate-model'] || ARGS['candidate-model'] === true) {
    throw new Error(
      "--candidate-model is required (e.g. --candidate-model=claude-haiku-4-5-20251001). "
      + 'There is no default: the model registry has no standing "candidate under test" '
      + 'tier a fallback could safely pin (see server/config/models.js and the file header above).',
    );
  }
  const candidateModel = ARGS['candidate-model'];
  // Reuse the relay's OWN allowlist (config/models.js MODEL_CATALOG, derived
  // — never a locally hand-typed list) BEFORE any child runs: an id this
  // repo does not recognize would otherwise run four full conditions only to
  // have the relay silently reject the override on every "candidate" call and
  // fall back to the current model, making two of the four conditions secretly
  // duplicate the other two. See relay-conversation.js's own file header for
  // why the allowlist is Anthropic text models excluding `requires: 'deep'`.
  // Required here, not at module top-level, so runOnce/summarizeCondition's
  // own unit tests never need this heavier module graph loaded.
  const { isAllowedOverrideModel, ALLOWED_OVERRIDE_MODEL_IDS } = require('../services/voice-agent/relay-conversation');
  if (!isAllowedOverrideModel(candidateModel)) {
    throw new Error(
      `--candidate-model="${candidateModel}" is not an allowlisted model id. `
      + 'Allowed (server/config/models.js MODEL_CATALOG, Anthropic text models, '
      + `excluding requires:"deep" ids): ${[...ALLOWED_OVERRIDE_MODEL_IDS].join(', ')}`,
    );
  }
  const trials = resolveTrials(ARGS);
  const CONDITIONS = buildConditions(candidateModel);

  const runs = [];
  // Interleaved order: one trial of every condition before the next trial of
  // any condition, per the brief — never all of condition A's trials, then
  // all of B's. WITHIN a trial, the four conditions' own order is rotated
  // Latin-square-style by trial index (rotateConditions below) rather than
  // fixed, so no one condition systematically runs first (and thus
  // systematically absorbs whatever a fixed first slot costs — a cold
  // provider-side cache, warm-up jitter, etc.) across every trial.
  for (let trial = 0; trial < trials; trial += 1) {
    const rotated = rotateConditions(CONDITIONS, trial);
    for (const condition of rotated) {
      // Deliberately sequential: this is a benchmark, not a load test —
      // concurrent children would contend for the same rate limit and
      // confound latency across conditions.
      const r = await runOnce(condition, trial, { cliArgs: ARGS, scriptPath, execFileImpl, timeoutMs });
      // Cache-state hypothesis: the eval JSON does not expose Anthropic's own
      // prompt-cache usage fields (cache_read_input_tokens /
      // cache_creation_input_tokens) anywhere today (see
      // docs/sandy-benchmark.md "Interleaving and warm/cold separation"), and
      // condition order is now rotated per trial rather than fixed, so
      // "trial 0 == cold" is no longer even a positional proxy. Always
      // 'unknown' until the harness threads real usage data through.
      r.cacheHypothesis = 'unknown';
      runs.push(r);
      log(`[benchmark] ${condition.id} trial=${trial} ranOk=${r.ranOk}${r.inconclusive ? ' inconclusive=true' : ''}${r.modelMismatch ? ' modelMismatch=true' : ''} wallMs=${r.wallMs}\n`);
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
    runs, // full per-trial detail, including any crash/inconclusive/model-mismatch error
  };

  // Missing data — a crash, an inconclusive eval run, OR a candidate
  // condition whose resolved model didn't match what was requested — makes
  // the whole benchmark exit non-zero: none of the three is a scenario-level
  // miss inside a completed run, so none is allowed to look like a clean pass.
  // A replay error is missing data too: those scenarios are excluded from
  // scenarioEvaluatedSamples, so without this a run could print 100% task
  // accuracy and exit 0 having never evaluated part of the fixture.
  const anyIncomplete = byCondition.some((c) => c.crashedRuns > 0 || c.inconclusiveRuns > 0 || c.modelMismatchRuns > 0 || c.replayErrors > 0);
  return { report, outPath, exitCode: anyIncomplete ? 1 : 0 };
}

module.exports = {
  parseArgs,
  buildConditions,
  rotateConditions,
  resolveTrials,
  assertOnlyHasIds,
  resolveOutPath,
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
      const { report, outPath, exitCode } = await runBenchmark({ log: (line) => process.stderr.write(line) });
      fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
      console.log(`\nWrote ${outPath}\n`);
      console.table(report.conditions.map((c) => ({
        condition: c.condition, trials: c.trials, completed: c.completedRuns,
        inconclusive: c.inconclusiveRuns, crashed: c.crashedRuns, modelMismatch: c.modelMismatchRuns, retried: c.retriedRuns,
        scenarios: c.scenarioAttemptSamples, evaluated: c.scenarioEvaluatedSamples, replayErrors: c.replayErrors,
        // Task accuracy's own denominator is scenarioEvaluatedSamples (replay
        // errors excluded — see the field's own comment and
        // docs/sandy-benchmark.md "Task accuracy"), never scenarioAttemptSamples.
        taskAccuracy: c.scenarioEvaluatedSamples ? `${c.scenarioPasses}/${c.scenarioEvaluatedSamples}` : 'n/a (0 evaluated)',
        critical: c.criticalMisses,
        judged: c.judgedCount, judgePass: `${c.judgePassCountFinalAttemptOnly}/${c.judgedCountFinalAttemptOnly} (final attempt only)`, judgeFallback: c.judgeFallbackCount,
        judgeFallbackPass: `${c.judgeFallbackPassCountFinalAttemptOnly}/${c.judgeFallbackVerdictCountFinalAttemptOnly} (advisory only)`,
        // first-attempt is the apples-to-apples figure across conditions — a
        // retry never inflates or deflates it; total-run is the real
        // wall-clock cost of the run as it happened (first + retry, when
        // retried). See docs/sandy-benchmark.md "Latency".
        'durationMs p50 (first attempt)': c.durationMsFirstAttemptMedian, 'durationMs p90 (first attempt)': c.durationMsFirstAttemptP90 ?? 'n/a (n<3)',
        'durationMs p50 (total run)': c.durationMsTotalRunMedian, 'durationMs p90 (total run)': c.durationMsTotalRunP90 ?? 'n/a (n<3)',
      })));
      process.exitCode = exitCode;
    } catch (err) {
      console.error(err.message);
      process.exitCode = 2;
    }
  })();
}
