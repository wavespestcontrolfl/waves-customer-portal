# Sandy benchmark — reproducible instructions

How to compare the current model/renderer against a candidate, using the
existing voice-relay eval harness. This is instructions and a runner script,
not a run: **no live model or phone call was made while writing this
document**, and the runner script below has not been executed. See
`docs/sandy-voice-agent.md` for the capability/permission summary these
results would inform, and `docs/voice-quality-rubric.md` for the underlying
harness's own contract.

## The four conditions

| # | Model | Renderer | `VOICE_RELAY_INBOUND_MODEL` | `VOICE_RELAY_RENDERER` |
|---|---|---|---|---|
| 1 | current (Sonnet 5) | block (buffered) | unset | unset |
| 2 | current (Sonnet 5) | stream (incremental) | unset | `stream` |
| 3 | candidate (e.g. Haiku 4.5) | block | `--candidate-model`'s value | unset |
| 4 | candidate | stream | `--candidate-model`'s value | `stream` |

`--candidate-model` is **required** — the runner has no default and never
did pick one on its own after this fix. There is no "candidate under test"
tier in the model registry (`server/config/models.js`'s `DEEP` / `FLAGSHIP` /
`WORKHORSE` / `FAST` / `VOICE` / `VISION` / `EXTREME`) a fallback could safely
resolve to: a benchmark candidate is a deliberate, one-off comparison choice
for whoever runs it, not a standing production tier, so a hardcoded
`'claude-…'` default in the script would be exactly the literal AGENTS.md's
"Hardcoded Anthropic model IDs" rule forbids (it would pin a tier and defeat
the env-var swap the registry exists for). Running it with no
`--candidate-model` is a usage error (exit 2), the same as a runner crash,
because no condition ran at all.

`claude-haiku-4-5-20251001` is a valid, current, allowlisted id in
`MODEL_CATALOG` as of this writing (`node -e "console.log(require('./server/config/models').MODEL_CATALOG['claude-haiku-4-5-20251001'])"`)
— this is an example for the command below, not a default; pass whichever
allowlisted id you actually want to compare with `--candidate-model=`.

**Important — these are the text-replay harness's own override variables,
not the sandbox ones.** `server/services/eval/voice-relay-replay.js`'s
`newConversation()` never constructs `RelayConversation` with
`sandbox: true`, so `VOICE_RELAY_SANDBOX_MODEL` and
`VOICE_RELAY_SANDBOX_RENDERER` are silently inert here — only
`VOICE_RELAY_INBOUND_MODEL` / `VOICE_RELAY_RENDERER` take effect in
`npm run eval:voice-relay` (or the runner below). A REAL sandbox phone call
is the only path that sets `sandbox: true`
(`server/services/voice-agent/relay-server.js`'s
`sandbox: authenticatedSandboxCall`), so the `_SANDBOX_*` variables only
matter when actually dialing (941) 241-2993.

## Running it

Each condition needs `ANTHROPIC_API_KEY` (Sandy's own model calls are real
API calls even in the text-replay harness — only the database, tools, and
Twilio audio are faked). The exact commands, run by the owner or primary
(not run while producing this document):

```sh
# One condition by hand, matching npm run eval:voice-relay's own usage:
VOICE_RELAY_INBOUND_MODEL=claude-haiku-4-5-20251001 VOICE_RELAY_RENDERER=stream \
  node server/scripts/run-voice-relay-eval.js --json

# All four conditions, interleaved trials, one combined report
# (--candidate-model is required — see "The four conditions" above):
node server/scripts/run-voice-relay-benchmark.js --candidate-model=claude-haiku-4-5-20251001 --trials=5

# Narrow to the five new interruption/mechanics families only:
node server/scripts/run-voice-relay-benchmark.js --candidate-model=claude-haiku-4-5-20251001 --trials=5 \
  --only=mid-thought-pause,backchannel-vs-explicit-correction,interruption-inside-amount-or-date,delayed-tool-response-changed-instructions,mid-stream-disconnect-recovery

# Add the optional transcript judge (extra API spend):
node server/scripts/run-voice-relay-benchmark.js --candidate-model=claude-haiku-4-5-20251001 --trials=5 --judge
```

`server/scripts/run-voice-relay-benchmark.js` (new, this PR) is a thin
wrapper: for each condition × trial it shells out to the existing
`run-voice-relay-eval.js --json` as its own child process with that
condition's env vars set (never mutating the parent process's env, and
explicitly clearing `VOICE_RELAY_INBOUND_MODEL`/`VOICE_RELAY_RENDERER` for
conditions that don't set them, so a value left over in the invoking shell
can never leak into the "current" baseline). It is not wired into any npm
script, cron job, or CI check — nothing runs it automatically. It writes one
combined JSON report (`voice-relay-benchmark-<timestamp>.json` by default,
or `--out=<path>`) and prints a summary table.

### Interleaving, rotation, and why there is no cold/warm label

The runner's outer loop is trial index, inner loop is condition — one trial
of every condition before the next trial of any condition — matching the
brief's "interleave repeated trials" instruction rather than blocking all of
condition A's trials before condition B's (which would confound any
time-of-day or provider-load drift with the model/renderer comparison).
WITHIN a trial, the four conditions' own order is rotated Latin-square-style
by trial index (`rotateConditions`): trial 0 runs them in their natural
order, trial 1 starts from the second condition and wraps, and so on, so no
one condition systematically runs first across every trial (and thus
systematically absorbs whatever a fixed first-run slot costs).

Every run's `cacheHypothesis` field is always `"unknown"` — never a
cold/warm label by trial position. Two reasons: rotation above already
removes "trial 0 == first" as even a positional proxy, and the eval JSON
does not surface Anthropic's own prompt-cache read/write token counts
anywhere today — a real warm/cold split needs reading
`usage.cache_read_input_tokens` / `cache_creation_input_tokens` off the raw
API response, which `runVoiceRelayEval` does not expose. If a future PR
threads real per-scenario usage data through the eval harness, this label
should read those fields directly instead of guessing from trial index.

### Inconclusive runs are missing data, never a completed run

The eval CLI (`run-voice-relay-eval.js`) has two exit codes that both carry
valid JSON on stdout: `0`/`1` (`status: 'pass'`/`'fail'` — the eval evaluated
the fixture, one way or the other) and `3` (`status: 'inconclusive'` — it
could not evaluate anything at all, e.g. no scenario completed a model
round). The runner treats ONLY `'pass'`/`'fail'` as a completed run
(`ranOk`) — and only when the child also exited normally: a completed run
additionally requires exit code 0/1/3 with no timeout or signal
(`runOnce` mirrors `runVoiceRelayEvalProcess()` in voice-relay-replay.js
exactly for this — `execFile`'s own `err.code` is never a number for a
killed/timed-out child, so a stray, stale write that happens to look like
valid JSON on stdout can never be read as a trustworthy result). An
inconclusive run — however well-formed its JSON — is counted in
`inconclusiveRuns`, its `error` is carried into `crashError` in the per-run
detail, and it makes the whole benchmark's exit code non-zero, exactly like a
real crash (`crashedRuns`, no JSON / exit 2 / a timeout/signal). A candidate
that merely could not be evaluated must never look like a clean pass, and its
sample count must never be silently padded into `scenarioAttemptSamples`.

### Model-stamp verification (candidate conditions only)

`--candidate-model` is checked against the relay's OWN allowlist
(`relay-conversation.js`'s `ALLOWED_OVERRIDE_MODEL_IDS`, derived from
`config/models.js` `MODEL_CATALOG`) before any condition runs at all — an
unrecognized id is a usage error (exit 2), not four wasted API-billed
conditions. That check alone does not prove the candidate model actually ran,
though: each condition's run is also checked AFTER it completes. Every
scenario record in a completed run's `results[]` carries the resolved
session model it actually pinned (`record.model`, from
`relay-conversation.js`'s `resolveSessionModel`) — for the two `candidate-*`
conditions, the runner compares every scenario's `results[].model` against
the requested `--candidate-model` value and flags the run `modelMismatch:
true` if any of them differ (an unknown/rejected override id falls back down
the chain to the current model with one logged warning, which would
otherwise let a "candidate" condition silently re-run the CURRENT model
without anyone noticing). A condition with any `modelMismatchRuns > 0` — see
`summarizeCondition`'s per-condition field — makes the whole benchmark's exit
code non-zero, the same as a crash or an inconclusive run: a candidate
comparison that silently tested the wrong model is missing data, not a
result.

### Retry accounting

`runVoiceRelayEval` retries a failed first attempt once
(`voice-relay-replay.js`'s `attemptWithRetry`) and a pass-on-retry is
"flaky", not a failure — but `result.summary` and `result.results` reflect
only the SELECTED `finalAttempt` (the retry, when there was one and it
wasn't itself inconclusive). Reading only `result.summary` would silently
drop a first attempt's critical miss the moment the retry happened to pass.
The runner instead sums every entry of `result.attempts` (the eval CLI's own
compact `{status, summary, error}` list — one entry, or two when the first
attempt failed) into `scenarioAttemptSamples` / `scenarioPasses` /
`scenarioFailures` / `replayErrors` / `criticalMisses`, and reports
`retriedRuns` (how many completed runs needed the retry) and `flakyRuns`
(how many of those retries flipped to a pass) as their own fields, never
folded into the pass/fail sums. This runner has no single-attempt mode to
fall back to instead: neither the eval CLI nor `runVoiceRelayEval` exposes a
flag to disable the retry-once wrapper, so aggregating every attempt is the
only way to keep a first-attempt miss visible.

**Consequence for the sample-size denominator**: `scenarioAttemptSamples`
(the sum of every attempt's own scenario count — attempts × scenarios, not
just trials × scenarios) is the true sample size behind `scenarioPasses` /
`scenarioFailures` / `criticalMisses` once any run in the condition retried —
it can be larger than `completedRuns × scenarios`. Report
`scenarioAttemptSamples` next to any rate computed from these fields — NOT
`attemptCount`, which only counts how many attempts ran (1 per trial, plus
one more per retried trial) and is never itself multiplied by
scenarios-per-attempt; `attemptCount` was named `attemptSamples` before this
PR, which invited exactly that confusion (reading it as if it already were
the scenario-level denominator it never was). `scenarioSamples` is kept as an
alias of `scenarioAttemptSamples`, identical value, for anything still
reading the pre-existing name.

**Judge aggregates, and the one figure that is final-attempt-only**: with
`--judge`, `judgedCount` / `judgeFallbackCount` / `judgeErrorCount` sum
across every attempt of every trial, same as the scenario counts above
(`voice-relay-replay.js`'s `summarize()` output survives unstripped into each
attempt's compact summary). A judge PASS count does not: no attempt summary
carries a pass/fail split, only the FINAL (selected) attempt's full
`results[].judge.verdict.pass` does, so `judgePassCountFinalAttemptOnly` is
computed from the final attempt only, across trials — never summed with the
others, and labeled by name as such. Report it next to `judgedCount` from the
final attempt's trials, not as a rate over the full `judgedCount` sum, since
the two draw from different sample sizes.

## What text replay measures vs. what needs a sandbox call

| | Text replay (`eval:voice-relay` / the runner above) | Real sandbox call |
|---|---|---|
| Model behavior: tool correctness, unauthorized actions, false completion, duplicate effects, sandbox suppression | **Yes** — every deterministic `expect` check | Only observable after the fact, from the stored transcript |
| Task accuracy / naturalness | Yes, via the deterministic checks plus the optional judge | Yes, and closer to what a caller experiences |
| Cost | Yes — real Anthropic token usage per scenario | Yes, plus the ConversationRelay/Twilio per-minute cost |
| Model-side latency (time to first token, total model round time) | Yes, real — `run-voice-relay-eval.js` makes genuine API calls; `record.durationMs` (whole-scenario wall clock) and `modelRounds` are the only fields the harness currently surfaces (see "Metrics to report" below) | Yes, with full per-turn breakdown (`relay-transcript.js`'s `summarizeTurnStats`) |
| **Telephony/audio latency** (STT arrival, TTS speaking start, caller-perceived delay) | **No** — the harness never touches Twilio, ConversationRelay, or audio; `end()` is never called so no `call_log` row or latency summary is ever written for a replay run | **Yes — the only source.** Dial the sandbox number, read back `call_log.transcription_metadata.latency` (see `docs/sandy-voice-agent.md` §"Confirming a change on a call row") |
| Interruption/barge-in mechanics at the byte level (hold policy, race conditions, tool-not-run pairing) | Partially, via the conversation-level eval scenarios (spoken content, tool calls) | The renderer/race mechanics themselves are unit-tested directly against the code, not through either replay path — see `server/tests/voice-relay-stream-renderer.test.js` |

**Do not certify caller-perceived timing from a text-replay run.** Sandbox
phone-call audio evidence for any of this slice is pending — no call was
placed while producing this document.

## Metrics to report

For each condition, report all of the following — never a favorable average
alone:

- **Sample counts**: `scenarioAttemptSamples` (the sum of every attempt's own
  scenario count, including a first-attempt retry — see "Retry accounting"
  above) is the true denominator behind `scenarioPasses` / `criticalMisses`;
  report it alongside `trials` requested — a crashed, inconclusive, OR
  model-mismatched trial must show as missing data, not vanish from the
  denominator or get folded into a "completed" count. `attemptCount` (how
  many attempts ran, never multiplied by scenarios-per-attempt) is a
  different, smaller number — report both, never one standing in for the
  other.
- **Failures**: `scenarioFailures` (a scenario's own checks failed) and
  `replayErrors` (the harness itself could not run the scenario) — these are
  different failure modes and must not be summed into one number.
- **Retries**: `retriedRuns` (how many completed runs needed the eval CLI's
  own retry-once) and `flakyRuns` (how many of those retries flipped a fail to
  a pass) — report both; a condition with a high `flakyRuns` rate is a
  reliability signal even when every run ultimately "passed".
- **Missing-data rate**: the fraction of runs where `ranOk` is false —
  broken down into `crashedRuns` / `trials` (the harness itself never
  produced a result, including a timeout/signal — see "Inconclusive runs"
  above), `inconclusiveRuns` / `trials` (it produced a result, but the result
  says it could not evaluate the fixture), and `modelMismatchRuns` / `trials`
  for the two `candidate-*` conditions (it produced a result, but the
  resolved session model was not the one requested — see "Model-stamp
  verification" above) — and, within completed runs, the fraction of turns
  with a null audio-latency field and its `audio_metrics_reason` (only
  meaningful on a real sandbox call — see the table above; the text-replay
  harness never writes this field at all).
- **Latency**: median and p90 of `durationMsMedian` / `durationMsP90` per
  condition, **with the sample-size caveat already built into the runner**
  (`durationMsP90` is `null`/"n/a" below 3 completed runs — a p90 over 1-2
  points is not a percentile). This is whole-scenario wall clock from real
  API calls, not a per-turn first-token breakdown; get that from a real
  sandbox call.
- **Task accuracy**: `scenarioPasses` / `scenarioAttemptSamples`, and
  separately `criticalMisses` (an unauthorized action, a false completion, a
  duplicate effect, or a sandbox-suppression breach — see the five new
  scenario families' `expect` blocks for exactly what is checked).
- **Naturalness**: the optional judge's verdict (`--judge`) — `judgedCount` /
  `judgeFallbackCount` / `judgeErrorCount` sum across every attempt, but
  `judgePassCountFinalAttemptOnly` is drawn from the final attempt only (see
  "Judge aggregates" above); report a judge pass RATE over the final
  attempt's own `judgedCount` for that trial, never over the full summed
  `judgedCount` — advisory either way, never used to override a critical
  deterministic miss.
- **Cost**: sum of Anthropic token usage across the run (not currently
  aggregated by the runner or the harness — read it from
  `llm_dispatch_log` if `GATE_LLM_CALL_LEDGER` is on in the environment the
  run used, or from the Anthropic console for a manual run).

**Zero observed failures in a small sample is not proof of zero risk.**
Report the sample size next to every rate.

## Decision rule

A candidate (model, renderer, or the combination) wins **only if** it:

1. Preserves every required capability and policy behavior the current
   configuration passes today — no new critical miss, no regression on any
   scenario the baseline currently passes, including the five new families'
   unauthorized-action / false-completion / duplicate-effect / sandbox-
   suppression checks.
2. Is not slower in a way that matters for the actual bottleneck — per the
   original snapshot's own finding, model think-time (~1.9s to first token),
   not the render/transport step, was the dominant latency cost before the
   streaming renderer existed; compare accordingly rather than chasing the
   renderer's smaller (~0.4s) share alone.

If a candidate regresses capability or policy behavior, **keep the
baseline** — do not build a router or fallback chain to rescue a losing
candidate (brief §4). Do not treat a real dollar/time cost saving as
sufficient justification on its own to accept a capability regression.

## External-provider feasibility note

No second media path, new voice provider, or classifier integration is
proposed or built in this slice, per the brief's explicit scope limit. This
is a short, source-backed note for later reference, not new provider work.

Waves' current stack already uses Twilio ConversationRelay for both STT and
TTS on the provider side (`<Connect><ConversationRelay>` — see
`docs/conversationrelay-booking-plan.md` "Architecture"), with our server
running only a text WebSocket loop against it — never raw audio. The two
Twilio references named in the owner's brief:

- ConversationRelay WebSocket message protocol (setup/prompt/text/interrupt
  frames, the `events` attribute this repo's latency instrumentation depends
  on): <https://www.twilio.com/docs/voice/conversationrelay/websocket-messages>
- `<ConversationRelay>` TwiML configuration (STT provider/model selection,
  TTS voice, DTMF, transcription events):
  <https://www.twilio.com/docs/voice/twiml/connect/conversationrelay>

Twilio's own ConversationRelay documentation already exposes STT-provider
and turn-detection tuning (Deepgram Nova/Flux, the profile knobs
`relay-profiles.js` wraps) and a documented `events` attribute for
speaker/playback timing — the same mechanism PR A's instrumentation reads.
Nothing observed while producing this document suggests a documented
ConversationRelay capability this repo is failing to use for the measured
latency gap; the dominant cost the original snapshot identified was model
think-time, not the Twilio leg. Reopening a second media path or a different
voice provider is explicitly deferred until a measured latency,
conversational-behavior, reliability, or task-quality gap — not latency
alone — justifies it (brief §4).
