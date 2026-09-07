# Voice quality — manual conversation replay

`npm run eval:voice-relay` runs 34 synthetic-caller scenarios through the live
`RelayConversation` loop: Sandy's prompt, model, registered tools and turn handling.
It evaluates deterministic checks and prints the recorded conversation for review.
This stage has no judge, scheduler or notification channel. A passing result means
its deterministic checks passed; review conversational quality from the transcript.

## Run it

Run the CLI in a dedicated process with `ANTHROPIC_API_KEY` for Sandy's model:

```sh
npm run eval:voice-relay
npm run eval:voice-relay -- --only=booking-happy-path,slot-gone
npm run eval:voice-relay -- --fixture=path/to/scenarios.json
```

The npm command prints JSON. Running `node server/scripts/run-voice-relay-eval.js`
without `--json` prints a compact report. Exit codes: 0 for passing checks, 1 for
failed checks or replay errors, 2 when the replay cannot run. A provider outage
that prevents every scenario from completing a model round is inconclusive and
exits 2. Manual execution calls Sandy's model and incurs normal provider usage.

## Fixture contracts

`server/fixtures/voice-relay-eval/scenarios.json` supplies caller context, office
hours, tool results, gates, interruptions, reconnect context and model failures.
All callers are synthetic. The scenario `spec` contains notes for manual review.

The harness validates tool arguments against the live registered schemas without
coercion. A fixture response can match inputs with `when`; strings are case-insensitive
substrings, arrays are alternatives, and numbers and booleans require equality.
An unmatched request receives no price, account or slot reference. One-shot responses
are consumed only by matching calls. Booking and account references must first have
appeared in a tool result on the same call.

Scheduling fixtures match the requested next-week timeframe as well as the city.
The stale-slot scenario exposes its replacement reference only after a fresh lookup.
Pricing fixtures require their positive numeric home size. Redacted initial caller
context matches the live builder; initial context and account overviews withhold
appointment existence, dates and windows. Wrong-number and robocall captures may
only classify the call as spam; spam suppression earns no follow-up receipt.

Office hours accept `open`, `closed`, `unknown`, or the live hours object. Objects
require integer minute bounds (`0 <= startMin < endMin <= 1440`), boolean closure
flags and an optional ISO calendar date. Strings are never coerced to booleans.
The transcript preserves the exact clock block Sandy saw and any earlier call
segment. Earlier speech is context and is excluded from grading new speech.

## Grading

A `critical` failure or an `adjudicated` major failure fails the scenario and run.
Other major and quality misses lower the quality score. The available checks cover
required, forbidden and allowed tools; required and forbidden spoken patterns;
captured fields; session termination; and speech before a write tool.

Every scenario also runs two mandatory critical checks: tool calls stay within its
allowlist, and a detected callback promise has a successful write receipt **before**
it is spoken. Optional `allowedToolInputs` restricts every attempt's arguments.
Explicit copies of the receipt check cannot weaken it or count a miss twice.
Receipt detection includes direct and indirect commitments such as “I'll ask the
office to call you”; a refusal, a suppressed spam capture, a read, or a later write
cannot support that promise. Conditional callback offers do not promise an action.

## Isolation and verification

The harness replaces tool execution and refuses database access during a conversation.
It never calls `end()`, writes a lead or booking, reconciles a call log, saves a
transcript, sends a notification or starts a cron. Capture-floor and callback writers
are stubbed to refuse. Each scenario restores its gate environment after running.
An unfixtured tool, database attempt or real provider error is a replay error.

Local tests use an SDK double and exercise the live conversation loop without model
or database calls. They cover fixture validation, privacy, receipt ordering, fresh-slot
recovery, interrupts, reconnection, bounded tool results and provider failures.
The historical calibration of the earlier combined PR predates these contracts and
does not establish a baseline for this manual-only stage.
