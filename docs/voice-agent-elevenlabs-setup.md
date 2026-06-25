# Bilingual AI Voice Agent — ElevenLabs setup

Setup guide for the bilingual (EN/ES auto-detect) AI voice agent that backstops
**unanswered** inbound calls (see PR #2073). The portal side ships behind
`GATE_VOICE_AI_AGENT` (off in every env). This doc covers the vendor-side
ElevenLabs Conversational AI agent and how it connects to the portal.

**Phase 1 scope:** capture + qualify the lead only. No appointment booking, no
pricing — the agent tells the caller a team member will follow up.

---

## 1. Agent settings

- **Name:** Waves Pest Control — Reception (After-Hours / Overflow)
- **Language:** Multilingual / **auto-detect** (English + Spanish). The agent
  switches to the caller's language from their first utterance.
- **Voice:** a warm multilingual voice that speaks natural neutral-Latin-American
  Spanish *and* English (test both before go-live).
- **LLM:** strongest conversational tier; temperature ~0.5.
- **Turn-taking:** default; allow interruptions; ~6s max silence before a gentle
  re-prompt.
- **Max call length:** ~5 min, then wrap up and submit the lead.

## 2. First message (bilingual — then adapt to the caller)

> "Thank you for calling Waves Pest Control — you've reached our after-hours
> line. Gracias por llamar a Waves Pest Control. How can I help you today? ¿En
> qué le puedo ayudar?"

After the caller responds, continue **entirely** in their language.

## 3. System prompt

```
You are the friendly after-hours / overflow receptionist for Waves Pest Control
& Lawn Care, a family-owned company serving Manatee, Sarasota, and Charlotte
counties in Southwest Florida.

LANGUAGE: Detect whether the caller speaks English or Spanish from their first
words and conduct the ENTIRE rest of the call in that language. Use natural,
warm, everyday Spanish (neutral Latin-American) when they speak Spanish. Don't
mix languages once you've detected theirs, except to confirm a spelling.

YOUR JOB: You cannot see schedules or prices. Your ONLY job is to understand
what the caller needs and collect their details so a Waves team member can call
them back. You are NOT able to book appointments or quote prices — if asked,
say a team member will follow up shortly to confirm timing and pricing.

COLLECT (ask naturally, one question at a time — don't interrogate):
- First and last name
- Best callback phone number (confirm it back to them)
- Service address: street, city, ZIP
- What they need help with (pest type / lawn / rodent / mosquito / termite, etc.)
- How urgent it is (just looking vs. active problem vs. emergency)
- Best time for a callback
- Email (optional — only if they offer it)

STYLE: Warm, concise, reassuring. Confirm the phone number and address back.
Don't over-promise. Don't guarantee outcomes.

WHEN YOU HAVE name + phone + address + the problem: call the `capture_lead`
tool with everything you gathered. Then reassure them ("Someone from our team
will call you back shortly" / "Un miembro de nuestro equipo le devolverá la
llamada pronto"), thank them, and end warmly.

If the caller is rude, a wrong number, or a solicitor: be polite, do NOT submit
a lead, and end the call.
```

## 4. `capture_lead` tool (server/webhook tool)

Matches the portal contract in `server/routes/webhooks-voice-agent.js`.

- **Type:** Webhook / server tool
- **Method:** POST
- **URL:** `https://<PORTAL_DOMAIN>/api/webhooks/voice-agent/lead`
- **Headers:**
  - `Authorization: Bearer <VOICE_AGENT_WEBHOOK_SECRET>` — same secret set on Railway
  - `Content-Type: application/json`
- **When to call:** once name + phone + address + problem are known (once per call).

**Body parameters (LLM-filled unless noted):**

| field | notes |
|---|---|
| `first_name`, `last_name` | |
| `phone` | caller's callback number, E.164 if possible |
| `email` | optional |
| `address_line1` | street |
| `city`, `zip` | |
| `requested_service` | what they asked for (their words or normalized) |
| `preferred_date_time` | free text, e.g. "tomorrow morning" |
| `pain_points` | brief description of the problem |
| `summary` | 1–2 sentence call summary |
| `lead_quality` | one of `hot` \| `warm` \| `cold` |
| `language` | `en` or `es` (detected) |
| `call_sid` | Twilio CallSid (system/dynamic variable) |
| `to_phone` | the Waves number they called (dynamic variable) |

Server returns `{ ok, leadId, customerId, created }`. The agent doesn't need to
read the response — just confirm to the caller and end the call. The lead lands
in the Leads pipeline with an `ai_triage` activity, source `voice_agent`, and
sets the non-routing `preferred_language` hint when `language=es`.

> **Auth is fail-closed:** 403 if the gate is off, 503 if
> `VOICE_AGENT_WEBHOOK_SECRET` is unset, 401 on a bad token. Set the secret on
> Railway **and** in the tool header before testing.

## 5. Twilio wiring (how the portal reaches the agent)

The portal hands the call off with `<Dial>` to the value in **Communications →
Call Routing → "Agent endpoint"**:

- **Phone number:** assign a number to this ElevenLabs agent (native Twilio
  integration or imported number) and put `+1XXXXXXXXXX` in the endpoint.
- **SIP:** if ElevenLabs gives you a SIP URI, put `sip:...` — the portal calls
  `dial.sip()` automatically.

**Caller-ID passthrough:** the portal sets the Dial `callerId` to the original
caller's number, so the agent (and the captured lead's `phone`) see the real
customer rather than the Waves line that dialed out. The agent still confirms
the callback number verbally as a backstop.

## 6. Go-live checklist (canary)

1. Build the agent + `capture_lead` tool above; test EN and ES in the ElevenLabs
   simulator.
2. Railway: set `VOICE_AGENT_WEBHOOK_SECRET` (same value in the tool header).
3. Portal: Communications → Call Routing → paste the agent endpoint; leave
   **AI answers first OFF**; keep backstop ON @ 30s.
4. Point ONE throwaway Twilio number at the webhook — dry-run first, then
   `--apply` (the `--` is required so npm passes the flags to the script):
   `npm run twilio:inbound:set-url -- --mode=app --number=+1XXXXXXXXXX` then re-run
   with `--apply` appended. Then flip `GATE_VOICE_AI_AGENT=true`.
5. Run the fail-open matrix: human answers (unchanged); no answer → agent picks
   up, EN/ES, lead lands in Leads; force the agent endpoint to fail → caller
   drops to voicemail (no dead air); gate off → routes exactly as today.
6. Promote one real number, watch, then the rest. Rollback any time:
   `GATE_VOICE_AI_AGENT=false`, or point the number back with
   `npm run twilio:inbound:set-url -- --mode=studio --number=+1XXXXXXXXXX --apply`.
