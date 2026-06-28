# ConversationRelay → Autonomous Booking — Integration Plan

Status: **Phase 0 built (dark, gated off)** + **no-answer backstop wired into `/voice` (gated, fail-closed)** · Owner: Waves · Lane started 2026-06-27

## Why this lane exists (the data that justified it)

Pulled from `call_log` (prod, real window Apr–Jun 2026; pre-2026 rows are backfill noise):

- ~320 inbound calls/month and growing.
- **~160 calls/month during business hours reach no live human** (single-tech capacity gap — Adam is on a property and can't answer). This is the dominant miss.
- ~42 calls/month after-hours reach no human.
- So the missed-demand problem is **daytime overflow**, not after-hours. The right deployment is the **no-answer backstop** (`decideVoiceRoute`, `voice-route-decision.js:96`) — answer when a human can't, regardless of hour — which targets the ~160/mo bucket plus the ~42/mo after-hours one.

**Build-vs-buy line:** an always-on AI that answers overflow and captures a lead is a commodity (off-the-shelf AI receptionists do this). The custom delta is **on-the-spot booking that honors the Waves drive-time/zone/capacity engine** (`findAvailableSlots`) — only the custom build can call that engine; a generic calendar would double-book or misroute a single drive-time-bound tech. Phase 0 exists to test whether Claude-over-the-phone books cleanly and quickly enough that on-the-spot beats capture-and-callback.

## Architecture

Twilio ConversationRelay does STT **and** TTS on Twilio's side ($0.07/min, incl. STT+TTS; bring-your-own-LLM). Our server runs only a **WebSocket text loop** — no raw audio.

```
Inbound call (Phase 0: dead GA# +19412691697 sandbox)
  └─ Twilio TwiML Bin: <Connect><ConversationRelay url="wss://<host>/ws/voice-agent">
        │  Twilio: transcribes caller, speaks our text back
        ▼
   wss /ws/voice-agent   (relay-server.js — raw `ws`, path-scoped upgrade,
        │                 coexists with Socket.io dispatch)
        │  setup → prompt ⇄ text → (ws close)
        ▼
   RelayConversation (relay-conversation.js — Claude streaming tool-use loop,
        │             MODELS.VOICE tier, thinking disabled)
        ▼
   tools (relay-tools.js): Phase 0 = capture_lead → createLeadFromExtraction
        ▼
   Existing Leads pipeline (unchanged) — every call leaves a lead (the floor)
```

## What Phase 0 ships (this PR)

New, self-contained module `server/services/voice-agent/`:

- `relay-protocol.js` — single source of truth for the ConversationRelay wire format (inbound `prompt` parse, outbound `text`/`end` frames) + `buildRelayTwiML()`. **All wire-format risk is isolated here.**
- `relay-tools.js` — Phase 0 `capture_lead` tool → existing `createLeadFromExtraction`.
- `relay-conversation.js` — the Claude streaming tool-use loop; capture-floor on hangup.
- `relay-server.js` — `attachVoiceRelay(httpServer)`: gated raw-`ws` endpoint, path-scoped upgrade.

One hook in `server/index.js` (gated try/catch after `attachSockets`). The original Phase 0 PR made **no changes** to the live `/voice` webhook; the backstop graduation below adds a gated, fail-closed change to it.

### Locks (all fail-closed)

- `VOICE_RELAY_ENABLED` (default off) — independent of `GATE_VOICE_AI_AGENT` so Phase 0 doesn't disturb the ElevenLabs capture path. With it off, `index.js` attaches **nothing** (no ws server, no upgrade listener).
- `ANTHROPIC_API_KEY` required or it refuses to attach.
- Sandbox-only: owner wires the TwiML Bin to the **dead GA# number only**.

## Coexistence safety (the only live-path-sensitive bit)

Socket.io registers its own `upgrade` handler and only acts on `/socket.io/`. We add a second `upgrade` listener that handles **only** `/ws/voice-agent` and returns without touching the socket for every other path. Node fires all listeners; the two don't interfere.

**Phase 0 exit gate (verify before merge, not after):** with `VOICE_RELAY_ENABLED=true` on a test boot, confirm (a) a dispatch Socket.io client still connects and receives a `dispatch:admins` event, and (b) a `wss://…/ws/voice-agent` client completes the relay handshake. If (a) regresses, do not merge.

## Owner steps to test Phase 0 on the sandbox

1. Deploy this branch (or run locally) with `VOICE_RELAY_ENABLED=true`, `ANTHROPIC_API_KEY`, and **`VOICE_RELAY_WS_SECRET`** (a long random string) set. Without the secret the ws endpoint **refuses to attach** (fail-closed) — it is otherwise public and can spend tokens / write leads.
2. In Twilio, create a TwiML Bin with this XML (swap `<host>` for the deployed host and `<secret>` for `VOICE_RELAY_WS_SECRET`) and set it as the **Voice webhook for +19412691697 only**:

   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <Response><Connect>
     <ConversationRelay url="wss://<host>/ws/voice-agent?key=<secret>"
       welcomeGreeting="Thanks for calling Waves Pest Control. Just so you know, this call may be recorded, and you're speaking with our automated assistant. How can I help you today?"
       welcomeGreetingInterruptible="none"
       ttsProvider="ElevenLabs" language="en-US" />
   </Connect></Response>
   ```
   (`relay-protocol.buildRelayTwiML()` renders this exact string, auto-appending `?key=` from `VOICE_RELAY_WS_SECRET`.) The `/ws/voice-agent` upgrade is rejected (socket destroyed) unless the `key` matches — so only Twilio, carrying the secret you configured, can connect.
3. Call the GA# and confirm: it answers, sounds natural, latency feels OK, and a lead lands in the Leads UI. **This call answers the build-vs-buy question.**

⚠️ On the first live call, verify the inbound `prompt` text field and outbound `text` frame against the deployed ConversationRelay version — `relay-protocol.parsePrompt()` already tolerates `voicePrompt`/`payload.text`; adjust there if needed.

## Graduating to the production no-answer backstop (`/voice`)

The TwiML-Bin sandbox proves the relay works on one number. To make the agent the
**real no-answer backstop** — answering daytime/after-hours overflow on *every*
Waves number — the relay is now wired into the existing routing seam instead of a
standalone bin. This is what lets a number serve double duty: e.g. the Google Ads
tracking number `+19412691697` can be a normal tracked line **and** have the agent
pick up when no human does (see the DNI lane — it resolves the number-ownership
conflict between the two lanes).

**How it's wired (already built on this branch):** the backstop machinery already
existed on main — `decideVoiceRoute('after_dial')` (`voice-route-decision.js`) is
called from `/call-complete` when a dial goes unanswered, and `/voice` shortens
the staff ring when a backstop is reachable. It was dormant only because
`call_routing.agentEndpoint` defaults to empty, and its handoff emitted `<Dial>`
(for a PSTN/SIP agent), not ConversationRelay. The change:

- `agentHandoffKind(config)` classifies the configured `agentEndpoint`:
  `relay` (a `wss://` URL **and** the relay ws server *actually attached* —
  `isRelayAttached()`, which reflects every prerequisite: enabled flag +
  `ANTHROPIC_API_KEY` + `VOICE_RELAY_WS_SECRET` + deps loaded), `relay_disabled`
  (a `wss://` URL but the server did not attach), `dial` (PSTN/SIP), or `none`.
  Basing this on the *attach state* rather than the raw env flag means a
  half-configured relay falls through to voicemail instead of a dead endpoint.
- When `relay`, `/voice` (answers-first) and `/call-complete` (backstop) return
  `buildRelayTwiML()` (`<Connect><ConversationRelay url="wss://…/ws/voice-agent?key=…">`)
  — the same wire format the TwiML Bin used, now served from the app, with the
  shared-secret `key` that authenticates the upgrade.
- `appendAgentHandoff()` refuses a `wss://` endpoint, so a misconfig can never
  `<Dial>` a WebSocket URL as a phone number. `relay_disabled`/`none` fall through
  to the existing human/voicemail flow **byte-for-byte**.
- On relay session close, `relay-conversation.end()` stamps
  `call_outcome='ai_handled'` / `answered_by='ai_agent'` (keyed by CallSid) and
  resyncs the message row, so backstop-answered calls don't linger as
  `no-answer`/null in reporting.

**Fail-closed posture (all must hold, or it's the exact voicemail flow as today):**
1. `isEnabled('voiceAiAgent')` — the feature gate; off (default) short-circuits
   before any config read, so the staff simul-ring + voicemail are unchanged.
2. `call_routing.agentEndpoint = wss://<host>/ws/voice-agent` — names the relay
   as the agent (set via the admin call-routing settings API).
3. `VOICE_RELAY_ENABLED=true` + `ANTHROPIC_API_KEY` + `VOICE_RELAY_WS_SECRET` —
   all required for the `/ws/voice-agent` server to actually attach; otherwise
   `agentHandoffKind` returns `relay_disabled` and the call stays on voicemail
   (never stranded). The secret also authenticates the ws upgrade — connections
   without the matching `?key=` are rejected before handshake.

**Owner steps to activate the backstop (after Phase 0 sandbox passes):**
1. Re-point `+19412691697` (and any other number) **back to `/api/webhooks/twilio/voice`** — remove the standalone TwiML Bin.
2. Set `VOICE_RELAY_ENABLED=true` + `ANTHROPIC_API_KEY` + `VOICE_RELAY_WS_SECRET` (long random string) on the deploy.
3. Set `call_routing.agentEndpoint = wss://<deployed-host>/ws/voice-agent` (admin call-routing settings). Leave `noAnswerBackstopEnabled` at its default `true`.
4. Enable the `voiceAiAgent` feature gate.
5. Place a test call, let it ring out (don't answer) → the agent should pick up
   as the backstop and a lead should land. `call_outcome` flips off `voicemail`
   and `answered_by='ai_agent'` on backstop-answered calls.

To pause it instantly without a deploy: clear `agentEndpoint` (or turn off the
`voiceAiAgent` gate) → every call returns to the normal voicemail flow.

## Roadmap (not in this PR)

- **Phase 1** — add read-only `get_availability` / `find_slots` tools → agent quotes real openings, still writes a lead. Zero mutation risk.
- **`createSelfBooking` refactor** — extract the body of `POST /api/booking/confirm` (`booking.js:684–1125`) into a reusable service. Load-bearing prerequisite for any booking tool. Slot it here, when the first mutating tool needs it.
- **Phase 2** — `confirm_booking` tool on the **no-answer backstop path** (daytime overflow). Guardrails already exist: `max_self_books_per_day`, advisory-lock race guard, double-submit idempotency; plus a read-back-and-verbal-confirm gate in the system prompt.
- **Phase 3** — `aiAnswersFirst` / scheduled answer-first via existing `call_routing` config.

## Cost
~$0.40–0.55 per ~5-min booking call: ConversationRelay $0.07/min + inbound voice (~$0.04) + a few cents of Claude tokens. Trivial vs one booked job.
