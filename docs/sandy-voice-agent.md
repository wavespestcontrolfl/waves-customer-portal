# Sandy — the Waves Pest Control voice agent

Canonical reference for Sandy: what she can do today, what she is and is not
allowed to do, the env/config switches that change her behavior, and what is
proposed but not built. Engineering detail (architecture, latency-field
semantics, the streaming chunking policy) lives in
`docs/conversationrelay-booking-plan.md`; this page is the short, current
summary and the place to check before changing a permission or a gate.

**Not production-ready.** `GATE_VOICE_AI_AGENT` is off in every environment
this document was written against; Sandy answers only the sandbox test line.
No section below should be read as a production readiness claim, and this
document does not activate anything.

Last verified against code: 2026-09-25 (Sandy slice 1, PRs #4817/#4818/#4831
— measurement, model isolation, streaming — plus this PR's benchmark/eval
work). Verify env defaults against `server/config/feature-gates.js` and the
"Voice relay (Sandy) tuning" paragraph of `CLAUDE.md` before relying on this
page for an activation decision; those are the enforced source of truth.

## 1. Current capabilities

- **Sandbox-only voice conversation.** `POST /api/webhooks/twilio/relay-sandbox`
  (`server/routes/twilio-voice-webhook.js`) is the only path a real phone call
  reaches Sandy through today; production inbound (`/voice`) does not hand off
  to her while `GATE_VOICE_AI_AGENT` is unset. See §7 of
  `~/Downloads/sandy-ai-voice-lane-2026-09-25.md` for the dial-in steps (a
  dated snapshot to verify, not proof of the current state — this document is
  the verification).
- **Open-ended intake** (PR #4795, preserved): Sandy asks what is going on
  rather than offering a menu, and still reads out tool-returned appointment
  choices (`server/services/voice-agent/relay-conversation.js`, the "How to
  talk" system-prompt section; `relay-reservice.js` for the re-service path).
- **Read tools**: account overview, service/report history, today's ETA,
  invoices, open estimates, services catalog, call/message history, pricing —
  gated behind `VOICE_RELAY_CONTEXT_ENABLED` and the live authorization
  boundaries in `relay-tools.js` (ANI match, attestation, tier).
- **Write tools**: `capture_lead`, `request_booking` (behind
  `GATE_VOICE_AI_BOOKING`), `request_reservice`, `transfer_to_office` (behind
  `GATE_VOICE_RELAY_TRANSFER`, office-hours gated) — every write still goes
  through the same matched-caller/third-party rules a human agent would.
- **Interruption handling**: barge-in aborts the in-flight generation;
  `GATE_VOICE_RELAY_INTERRUPT_CONTEXT` additionally rewrites the model's own
  history to what was actually played and tells the next turn what the
  caller heard (`relay-conversation.js` `interrupt()`).
- **Reconnect recovery**: one automatic resume on a dropped socket behind
  `GATE_VOICE_RELAY_RECOVERY` (`relay-recovery.js`, `/relay-complete`).
- **Trustworthy latency measurement** (PR A, #4817): every relay call's close
  writes a reason-coded latency summary — `summarizeTurnStats`
  (`server/services/voice-agent/relay-transcript.js:455`) distinguishes
  application clocks (prompt received → first model token → first text sent,
  timestamped on our own server) from provider-reported spans built from
  Twilio's `caller_speaking_end`/`agent_speaking_start` events, which arrive
  only when the session's relay profile renders `events="speaker-events
  tokens-played"` (`EVENTS_ALL`, `relay-profiles.js:65`). An untuned call (no
  `VOICE_RELAY_PROFILE`) renders no `events` attribute, so every
  provider-derived field is null with an honest reason
  (`events_not_subscribed`, `no_events_received`,
  `partial_events_received`, `insufficient_turns`, or
  `instrumentation_unknown` — `relay-transcript.js:405`), never a guessed
  zero. **First text sent is not first audio heard** — no server-only metric
  in this system claims otherwise.
- **Sandy-only model override** (PR B, #4818): `VOICE_RELAY_INBOUND_MODEL`
  lets an inbound Sandy session use a different Anthropic model than the
  shared `VOICE_RELAY_MODEL` collections outbound calls read, resolved once
  per session and pinned for its lifetime
  (`relay-conversation.js:192` `resolveSessionModel`).
- **Opt-in incremental (streaming) renderer** (PR C, #4831):
  `VOICE_RELAY_RENDERER=stream` sends allowlisted-safe sentence chunks (an
  acknowledgment, at most one read-only clause, or a question) as they
  complete, holding anything with an amount, a date/time, a negation, or a
  commitment/success claim until the round finalizes and the existing
  write-tool suppression check has cleared it
  (`server/services/voice-agent/relay-stream-renderer.js`, full policy in
  the file header and in `docs/conversationrelay-booking-plan.md`
  "Streaming renderer (PR C)"). Default (unset) is `block` — byte-identical
  to the original one-utterance-per-frame behavior.
- **Evaluation harness**: 36 synthetic-caller scenarios (`npm run
  eval:voice-relay`, `server/fixtures/voice-relay-eval/scenarios.json`) replay
  through the live conversation loop with deterministic checks plus an
  optional judge. See §2 of `docs/voice-quality-rubric.md` and
  `docs/sandy-benchmark.md` for what this harness does and does not measure.

## 2. Current permissions

Sandy has **no permissions of her own** — voice inherits the same
action-and-channel-specific autonomy policy every other channel already
answers to (AGENTS.md/CLAUDE.md rule 12; tool access never confers
permission to execute, per the slice 1 brief §2). Concretely, unchanged by
this or the prior three PRs:

- **No new agent-initiated customer SMS/email or auto-sends.** Sandy captures
  leads and files re-service tickets; a Waves team member calls, texts or
  emails the customer back — she never sends anything herself, and nothing in
  PRs A/B/C/D adds a send path.
- **Sandy never promises a message was already sent** — the fixture-level
  `commitment_requires_receipt` check (`voice-relay-replay.js`) and its
  extensive promise-detection regex bank fail the eval the instant a spoken
  line claims a follow-up happened without a receipt (a performed write, a
  timed-out write, or a ticket already on file).
- **Sandbox write suppression at the execution/provider boundary**: every
  sandbox call's write tools (`capture_lead`, `request_booking`,
  `request_reservice`) are answered but never executed
  (`SANDBOX_DRY_RUN_TOOLS`, `relay-tools.js:46`; `RelayConversation.sandbox`,
  `relay-conversation.js:699`) — no lead, ticket, booking or dispatch work is
  created from a sandbox call, whatever the caller says.
- **Sandbox never rings staff.** A transfer request on the sandbox hangs up
  instead of ringing the office simul-ring (`twilio-voice-webhook.js:836-842`,
  `?sandbox=1`).
- **Sandbox records are excluded from production reporting and learning**:
  `source = 'voice_relay_sandbox'` rows are excluded from the Calls tab,
  unified inbox, KPIs, corpus mining and self-audits.
- **Collections outbound calls are untouched.** `VOICE_RELAY_INBOUND_MODEL`
  and `VOICE_RELAY_SANDBOX_MODEL` are read only by
  `relay-conversation.js`'s `resolveSessionModel`;
  `server/services/collections/outbound-voice/collections-conversation.js:68`
  keeps reading `VOICE_RELAY_MODEL` directly and never sees either override
  (comment pinned at `relay-conversation.js:141-142`; regression coverage in
  `server/tests/voice-relay-model-override.test.js`).
- **Identity, scoping and confirmation checks are unchanged**: ANI matching,
  attestation gates on sensitive reads (`ATTESTATION_ONLY_TOOLS`), the
  matched-caller-only rule on writes (`allowsThirdPartyWrites`), and
  secure-link-only payment handling — Sandy has no payment-collection tool at
  all, and nothing in this lane adds raw sensitive-payload logging.
- **No production routing, activation-lock, collections, or permission
  expansion** shipped in PRs A/B/C or this PR. `GATE_VOICE_AI_AGENT` and the
  agent-endpoint routing config are untouched.

## 3. Env / config switches (PRs A, B, C)

| Variable | Default (unset) | Effect when set | Sandbox-only variant |
|---|---|---|---|
| `VOICE_RELAY_INBOUND_MODEL` | falls back to `VOICE_RELAY_MODEL`, then `MODELS.VOICE` (`claude-sonnet-5`) | pins a different Anthropic model for **inbound, non-sandbox** Sandy sessions only; validated once at construction against `MODEL_CATALOG` (Anthropic, `text` cap, not `requires: 'deep'`) | — |
| `VOICE_RELAY_SANDBOX_MODEL` | none (falls through the same chain) | outranks `VOICE_RELAY_INBOUND_MODEL`, but **only for a session the relay server marks `sandbox: true`** (an authenticated sandbox call) | itself is the sandbox variant |
| `VOICE_RELAY_RENDERER` | `block` | `block` \| `stream`; `stream` enables PR C's incremental sentence renderer for **non-sandbox** sessions | — |
| `VOICE_RELAY_SANDBOX_RENDERER` | none | outranks `VOICE_RELAY_RENDERER` for sandbox sessions only | itself is the sandbox variant |
| `GATE_VOICE_RELAY_INTERRUPT_CONTEXT` | off | barge-in rewrites history to played text + tells the next turn what was heard | applies on the sandbox too |
| `GATE_VOICE_RELAY_RECOVERY` | off | one automatic reconnect on a dropped socket | applies on the sandbox too |
| `GATE_VOICE_RELAY_TRANSFER` | off | `transfer_to_office` tool available while the office is open | sandbox: hangs up instead of ringing staff |
| `GATE_VOICE_AI_BOOKING` | off | `request_booking` tool available | sandbox: dry-run |
| `VOICE_RELAY_PROFILE` | none (untuned relay) | selects a code-reviewed Deepgram/TTS tuning profile (`relay-profiles.js`) — needed for the provider-derived latency fields in §1 to ever be non-null | `SANDBOX_CELLS` DTMF codes select one per call |
| `GATE_VOICE_AI_AGENT` | off | **master** — lets production inbound hand a call to Sandy at all | not read on the sandbox path |

An unrecognized model or renderer override falls back down the chain with one
logged warning and a `model_fallback_reason` / renderer-fallback stamp in the
session's version record — **never** a silent substitution (verified:
`resolveSessionModel`/`resolveSessionRenderer`, `relay-conversation.js`, and
their regression tests). `VOICE_RELAY_SANDBOX_MODEL` / `_RENDERER` have no
effect on the **text-replay eval harness** (`npm run eval:voice-relay`) — see
`docs/sandy-benchmark.md` for why.

## 4. Proposed capabilities (not implemented)

Preserved as a linked roadmap, not built here, per the slice 1 brief §6 and
the owner's original, broader program brief
(`Fable_5_1_Sandy_Voice_Agent_Upgrade_Prompt.md` — an owner-held planning
document, not checked into this repo; the slice 1 brief's corrections
supersede it where they conflict):

- **Slice 2** — an estimator-backed quote carried through a tool-returned
  slot to a correctly persisted appointment, with lead/customer linkage,
  proved in an isolated test database. A captured lead or a slot hold is not
  a booking.
- **Later slices** — billing assistance, difficult answers grounded in
  approved recordings/SMS/email, cross-channel commitments, and broader
  shared admin tools, preserving the existing arrival-window vs
  work-duration, billing vs visit-cadence, annual-prepay/termite, and
  autopay-vs-cancellation distinctions.
- Existing engineering roadmap notes in
  `docs/conversationrelay-booking-plan.md` "Roadmap (not in this PR)":
  read-only `find_slots`/`get_availability` (already shipped since that note
  was written), a `createSelfBooking` refactor, `confirm_booking` on the
  no-answer backstop, and `aiAnswersFirst`/answer-first scheduling.
- **External-provider feasibility**: see the short note at the end of
  `docs/sandy-benchmark.md` — no second media path, new voice provider, or
  classifier integration is proposed for this slice.

None of the above is wired up, gated, or scheduled. Building any of it is a
separate, future assignment.

## 5. Owner-pending decisions

Nothing below is activated by this document or by PRs A/B/C/D. Each needs an
explicit owner call before it changes production behavior:

1. **Turning on the streaming renderer** (`VOICE_RELAY_RENDERER=stream`) for
   real sandbox calls, or eventually production inbound.
2. **Choosing a candidate model** for latency — Haiku 4.5
   (`claude-haiku-4-5-20251001`) is a valid, current, allowlisted catalog id
   as of this writing (verified against `MODEL_CATALOG`), but no live
   comparison run against it has been executed in this session (see the
   benchmark doc's status table) and actual account access/cost at scale is
   unverified.
3. Flipping the four "safe to flip now" sandbox-scoped relay gates
   (`GATE_VOICE_AI_BOOKING`, `GATE_VOICE_RELAY_INTERRUPT_CONTEXT`,
   `GATE_VOICE_RELAY_RECOVERY`, `GATE_VOICE_RELAY_TRANSFER`) for a fuller
   sandbox test — see §5 of the dated snapshot for the exact command; this
   document does not run it.
4. **Overflow (no-answer backstop) answering** — explicitly not activated by
   this slice (brief §5: "Do not... activate overflow answering").
5. **Go-live sequence** for `GATE_VOICE_AI_AGENT` itself, whenever the owner
   is satisfied — a separate, later decision from anything in this document.

## 6. Rollback instructions

Every switch below reverts to its documented default the instant it is
unset/removed (or, for a gate, set to anything other than the exact
"on" string that gate reads) — none require a code change:

| To revert | Unset / restore |
|---|---|
| Sandy-only model override | unset `VOICE_RELAY_INBOUND_MODEL` (and `VOICE_RELAY_SANDBOX_MODEL` for the sandbox) → falls back to `VOICE_RELAY_MODEL`/`MODELS.VOICE`, same as before PR B |
| Streaming renderer | unset `VOICE_RELAY_RENDERER` (and `VOICE_RELAY_SANDBOX_RENDERER`) → `block`, byte-identical to before PR C |
| Interrupt-context rewrite | unset `GATE_VOICE_RELAY_INTERRUPT_CONTEXT` |
| Reconnect recovery | unset `GATE_VOICE_RELAY_RECOVERY` |
| Transfer tool | unset `GATE_VOICE_RELAY_TRANSFER` |
| Booking tool | unset `GATE_VOICE_AI_BOOKING` |
| Tuning profile | unset `VOICE_RELAY_PROFILE` → untuned relay, no `events` attribute, no provider-derived latency fields (expected, not a bug) |
| Sandbox line entirely | unset `VOICE_RELAY_SANDBOX_NUMBER`; optionally release the Twilio number |
| Everything above at once | unset `GATE_VOICE_AI_AGENT` (already off) — production inbound was never touched |

**Confirming a change on a call row** (no admin UI needed): read the row's
`call_log.transcription_metadata.versions` / `.latency`. It carries the
resolved model id and `model_fallback_reason` (if any), `renderer` /
`renderer_version` (`'block'`/`'block-v1'` or `'stream-v1'` per turn and for
the session), the relay profile id, and — for latency — `boundaries_version`
and the `observability` block explaining any null. A stamp that still reads
`block`/`block-v1` and the pre-PR-B model after an override was set means the
override was rejected (check the logged warning) or the row predates the
change — never a silently different, unstamped behavior.

## 7. Factual status table

| Item | Status |
|---|---|
| PR A measurement (reason-coded nulls, event-shape stamps, correlation ids) | **Implemented / tested** — `server/tests/voice-relay-transcript.test.js` and the other 51 voice-relay suites (10,152 tests) pass |
| PR B model isolation (inbound-only override, collections untouched, allowlist, fallback stamp) | **Implemented / tested** — `voice-relay-model-override.test.js` |
| PR C streaming renderer (hold policy, interrupt/failure races) | **Implemented / tested** — `voice-relay-stream-renderer.test.js`, 169/169 passing |
| 5 new eval scenario families (this PR) | **Implemented / untested against the live model** — fixture lints clean and the shipped-fixture regression suite passes; no live Anthropic call was made in this session to actually run them (see `docs/sandy-benchmark.md`) |
| Queued-turn race test (delayed tool response + changed instructions) | **Implemented / tested** — new test in `voice-relay-stream-renderer.test.js` |
| Redacted sandbox-call event fixtures (brief §3A) | **Access-blocked** — no authorized sandbox call was placed in this session; no such fixture exists in the repo today |
| Four-condition benchmark comparison run | **Owner-approval-pending** — the runner script (`server/scripts/run-voice-relay-benchmark.js`) is implemented and untested-by-execution; running it spends real Anthropic API cost and needs `ANTHROPIC_API_KEY` |
| Candidate model (Haiku 4.5) live-call access/cost at scale | **Owner-approval-pending / untested** |
| Sandbox phone-call audio evidence for any of PRs A/B/C/D | **Access-blocked / pending** — no phone call to the sandbox line was placed while producing this document; do not read anything above as telephony-latency proof |
| Streaming renderer / candidate model activation | **Owner-approval-pending** (§5) |
| Overflow answering, production go-live | **Owner-approval-pending**, explicitly not activated by this slice |

## See also

- `docs/conversationrelay-booking-plan.md` — architecture, the streaming
  chunking policy in full, latency field semantics, roadmap.
- `docs/voice-quality-rubric.md` — how to run the eval harness, fixture
  contracts.
- `docs/sandy-benchmark.md` — the four-condition benchmark: exact commands,
  what text replay measures vs what needs a real sandbox call, metrics, the
  decision rule, and the external-provider feasibility note.
