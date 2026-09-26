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
| 3 | candidate (e.g. Haiku 4.5) | block | `claude-haiku-4-5-20251001` | unset |
| 4 | candidate | stream | `claude-haiku-4-5-20251001` | `stream` |

`claude-haiku-4-5-20251001` is a valid, current, allowlisted id in
`MODEL_CATALOG` as of this writing (`node -e "console.log(require('./server/config/models').MODEL_CATALOG['claude-haiku-4-5-20251001'])"`)
— substitute any other allowlisted id with `--candidate-model=`.

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

# All four conditions, interleaved trials, one combined report:
node server/scripts/run-voice-relay-benchmark.js --trials=5

# Narrow to the five new interruption/mechanics families only:
node server/scripts/run-voice-relay-benchmark.js --trials=5 \
  --only=mid-thought-pause,backchannel-vs-explicit-correction,interruption-inside-amount-or-date,delayed-tool-response-changed-instructions,mid-stream-disconnect-recovery

# Add the optional transcript judge (extra API spend):
node server/scripts/run-voice-relay-benchmark.js --trials=5 --judge
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

### Interleaving and warm/cold separation

The runner's outer loop is trial index, inner loop is condition — one trial
of every condition before the next trial of any condition — matching the
brief's "interleave repeated trials" instruction rather than blocking all of
condition A's trials before condition B's (which would confound any
time-of-day or provider-load drift with the model/renderer comparison).
**Trial 0 of each condition is the only one worth treating as a
cold/cache-miss observation**; trials 1..N-1 are `cacheHypothesis: "warm"` in
the report. This is a hypothesis label, not a measurement: the harness does
not currently surface Anthropic's own prompt-cache read/write token counts
per turn, so a real warm/cold split needs reading `usage.cache_read_input_tokens`
/ `cache_creation_input_tokens` off the raw API response — not exposed by
`runVoiceRelayEval` today. Treat the label as a rough proxy, not proof.

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

- **Sample counts**: `scenarios` × `trials` actually completed
  (`scenarioSamples` in the runner's report), separately from `trials`
  requested — a crashed trial must show as a crash, not vanish from the
  denominator.
- **Failures**: `scenarioFailures` (a scenario's own checks failed) and
  `replayErrors` (the harness itself could not run the scenario) — these are
  different failure modes and must not be summed into one number.
- **Missing-data rate**: the fraction of runs where `ranOk` is false
  (`crashedRuns` / `trials`), and, within completed runs, the fraction of
  turns with a null audio-latency field and its `audio_metrics_reason` (only
  meaningful on a real sandbox call — see the table above; the text-replay
  harness never writes this field at all).
- **Latency**: median and p90 of `durationMsMedian` / `durationMsP90` per
  condition, **with the sample-size caveat already built into the runner**
  (`durationMsP90` is `null`/"n/a" below 3 completed runs — a p90 over 1-2
  points is not a percentile). This is whole-scenario wall clock from real
  API calls, not a per-turn first-token breakdown; get that from a real
  sandbox call.
- **Task accuracy**: `scenarioPasses` / `scenarioSamples`, and separately
  `criticalMisses` (an unauthorized action, a false completion, a duplicate
  effect, or a sandbox-suppression breach — see the five new scenario
  families' `expect` blocks for exactly what is checked).
- **Naturalness**: the optional judge's verdict (`--judge`), reported as its
  own pass rate and fallback-leg rate — advisory, never used to override a
  critical deterministic miss.
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
