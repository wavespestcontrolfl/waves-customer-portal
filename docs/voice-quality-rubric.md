# Voice quality — manual conversation replay

`npm run eval:voice-relay` runs 28 synthetic-caller scenarios through the live
`RelayConversation` loop: Sandy's prompt, model, registered tools and turn handling.
It evaluates deterministic checks and prints the recorded conversation for review.
By default only deterministic checks run. Select `--judge` for the optional transcript
judge. The weekly schedule is opt-in; manual runs do not notify unless `--notify` is given.

## Run it

Run the CLI in a dedicated process with `ANTHROPIC_API_KEY` for Sandy's model:

```sh
npm run eval:voice-relay
npm run eval:voice-relay -- --only=booking-happy-path,slot-gone
npm run eval:voice-relay -- --judge
npm run eval:voice-relay -- --fixture=path/to/scenarios.json
```

The npm command prints JSON. Running `node server/scripts/run-voice-relay-eval.js`
without `--json` prints a compact report. Exit codes: 0 for passing checks, 1 for
repeated failed checks or replay errors, 3 when the eval is inconclusive, and 2
when the runner crashes before producing a result. A provider outage
that prevents every scenario from completing a model round is inconclusive and
exits 3. Manual execution calls Sandy's model and incurs normal provider usage.

## Fixture contracts

`server/fixtures/voice-relay-eval/scenarios.json` supplies caller context, office
hours, tool results, gates, interruptions, reconnect context and model failures.
All callers are synthetic. The scenario `spec` contains the hand-authored grading contract and notes for review.

The harness validates tool arguments against the live registered schemas without
coercion. A fixture response can match inputs with `when`; strings are case-insensitive
substrings, arrays are alternatives, and numbers and booleans require equality.
An unmatched request receives no price, account or slot reference. One-shot responses
are consumed only by matching calls. Booking and account references must first have
appeared in a tool result on the same call. Both ordinary (`S1`, `C1`) and
generation-scoped recovery handles (`S2-1`, `C2-1`) match as complete references.
An `ok: false` response stands in for a thrown tool failure: it performs no fixture
side effects, earns no receipt, and counts toward the relay's provider-failure handoff.
A refusal the live tool returns as text (a redacted schedule, missing sizing) stays `ok`.
Every scripted turn is `{ caller }` with an optional `interrupt` (`true`, `{ words }`
or `{ heard }`); any other key is a lint error.

Scheduling fixtures match the requested next-week timeframe as well as the city.
The stale-slot scenario exposes its replacement reference only after a fresh lookup.
Pricing fixtures require their positive numeric home size. Redacted initial caller
context matches the live builder; initial context and account overviews withhold
appointment existence, dates and windows. Wrong-number and robocall captures may
only classify the call as spam; spam suppression earns no follow-up receipt.

Office hours accept `open`, `closed`, `unknown`, or the live hours object. Objects
require integer minute bounds (`0 <= startMin < endMin <= 1440`), boolean closure
flags and an optional ISO calendar date. Strings are never coerced to booleans.
Resume fixtures are objects with required string `segmentsText`, optional positive
integer `reconnects`, and optional nonnegative integer `priorCallerTurns`. Unknown
fields and coercible scalar values fail fixture lint before replay.
The transcript preserves the exact clock block Sandy saw and any earlier call
segment. Earlier speech is context and is excluded from grading new speech.

## Grading

A `critical` failure or an `adjudicated` major failure fails the scenario and run.
Other major and quality misses lower the quality score. The available checks cover
required, forbidden and allowed tools; required and forbidden spoken patterns;
captured fields; session termination; and speech in the same model round before a
write tool. Agent/tool events carry their model-call index, so earlier read-tool
filler is not treated as speech before a later write. The shipped spoken checks are
format-level: invented prices and dollar figures, clock times and windows, month-day
dates, "on the way", and outcome words such as "saved" or "booked" behind a negation
guard. Timeout date checks cover all months.

Six scenarios whose prohibitions are natural-language phrasings — pet-safety-bait,
injection-in-tool-result, eta-third-party, third-party-neighbor, card-number-spoken
and eta-recognised-redacted (affirmative safety guarantees, free-visit promises,
another customer's schedule, spoken card data) — are NOT in this fixture. They
return in a follow-up stage after the transcript judge, which grades those
prohibitions semantically; until then this run makes no claim about them.

Every scenario also runs two mandatory critical checks: tool calls stay within its
allowlist, and a detected callback promise has a successful write receipt **before**
it is spoken. Optional `allowedToolInputs` restricts every attempt's arguments.
Explicit copies of the receipt check cannot weaken it or count a miss twice.
Receipt detection includes direct and indirect commitments such as “I'll call you back” and “I'll ask the
office to call you”; a refusal, a suppressed spam capture, a read, or a later write
cannot support that promise. Spanish future forms such as "le llamaremos" and
"le enviaremos" also require a preceding receipt. Conditional callback offers do not promise an action.
Indirect verbs such as "note" and "make sure" need an office handoff or callback
construction; ordinary phrases such as "I'll note that correction" earn no miss.

## Isolation and verification

The harness replaces tool execution and refuses database access during a conversation.
It never calls `end()`, writes a lead or booking, reconciles a call log, saves a
transcript, writes business records. Manual runs suppress every notification channel unless
`--notify` is present. The scheduler runs the harness in a child process. Capture-floor and callback writers
are stubbed to refuse. Each scenario restores its gate environment after running.
An unfixtured tool, database attempt or real provider error is a replay error.

Local tests use an SDK double and exercise the live conversation loop without model
or database calls. They cover fixture validation, privacy, receipt ordering, fresh-slot
recovery, interrupts, reconnection, bounded tool results and provider failures.
The historical calibration of the earlier combined PR predates these contracts and
does not establish a baseline for this split implementation.

## Optional transcript judge

`--judge` runs after every conversation finishes, with at most four verdicts in flight.
It uses the registered `TEXT_POLICIES.voiceJudge` policy on the `voice_relay_judge`
lane. `MODEL_VOICE_JUDGE` pins the primary independently of the moving quality tiers;
the registered OpenAI fallback keeps results available but marks every check advisory.
A fallback verdict cannot change pass/fail. Each verdict records the served provider,
model, fallback status and a SHA of the complete prompt template and output schema.

The judge receives the caller context Sandy saw, the exact per-turn clock blocks,
earlier call segments and bounded tool results. Hidden grading notes cannot ground
an agent claim. Only new agent speech is graded after a reconnect. The pinned judge's
forbidden claims are critical failures; action/fact checks use the scenario's major
severity and adjudication setting, while empathy, brevity and tone affect quality.

If no scenario receives a verdict, the run is inconclusive (exit 3). If some verdicts
are unavailable, the run fails verification (exit 1), even when deterministic checks
pass. Running without `--judge` makes no judge calls. Judge calls use the ordinary
LLM dispatcher and may write ledger/trace rows when those gates are enabled; the
conversation still refuses database access. No live judge calibration was run for
this split. Tests inject verdicts and exercise dispatch, fallback, grounding and
aggregation without calling model providers or a database.

## Scheduled runs and notification delivery

`GATE_VOICE_RELAY_EVAL=true` opts in to Monday at 03:50 America/New_York. It is
off by default in every environment. The scheduler uses the existing `runExclusive`
lock and launches `--json --judge --notify` in a child process, keeping the scenario
gates and relay-module patches out of the server handling calls. Unset the gate or
set it to `false` to stop future runs. No gate was enabled for this implementation.

The wrapper retries a failed run once. A pass on retry is marked flaky and emits
no alert. Repeated failure preserves the result and produces one admin
`eval_regression` bell plus the existing ops digest/email channel. An inconclusive
retry retains the first observed failure; an initial inconclusive attempt is reported
without a retry. The same notification path reports a crashed or timed-out child.
The eight-hour child ceiling covers every allowed model round (up to six
20-second streams per caller turn), judge budgets and one retry, with time
left for fixture-tool timeouts; a hung child is killed before releasing its exclusive lock.

Operational delivery reuses the call-extraction eval helpers and `deliverOpsDigest`.
`EVAL_REGRESSION_EMAIL=off` disables the email/digest channel. A failed bell insert
is recorded as `notificationError` after the other channel is attempted; it does
not turn a finished evaluation into a crash. `--notify` gates the bell, email and
in-app digest together. The call-extraction manual CLI now uses that same explicit
notification suppression, including when in-app digest delivery is enabled.

Tests inject the child runner, replay outcomes and notification senders; no live
cron, provider call, notification or database write was used for verification.
