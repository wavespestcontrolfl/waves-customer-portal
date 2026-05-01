# Inbound Call Workflow — As-Built Audit

**Date:** 2026-04-30
**Branch:** `feat/mobile-first-booking-surfaces`
**HEAD:** `a969c53` + local call-workflow edits
**Repo:** `wavespestcontrolfl/waves-customer-portal`

This document describes what the code **actually does today**. It is the corrected counterpart to `inbound-call-workflow-2026-04-30.md`, which described an aspirational/target pipeline that does not match the checked-out implementation.

---

## 1. Twilio Voice Entrypoint — `server/routes/twilio-voice-webhook.js`

Mounted at `/api/webhooks/twilio` in `server/index.js:242`. Companion file `twilio-webhook.js` (mounted same prefix at `server/index.js:225`) handles SMS and status callbacks.

**No Twilio signature validation is applied** to any webhook in this file. There is no `server/middleware/twilio-signature.js`.

### Live Twilio Studio Overlay

The live Twilio number configuration routes inbound calls to Studio Flow `Waves Inbound — All Numbers` (`FW5fdc2e44700c6e786ed27de94e0cbace`), not directly to repo endpoint `POST /api/webhooks/twilio/voice`.

The Studio flow currently duplicates part of the repo behavior:

- Incoming call trigger goes to a `say-play` widget before forwarding.
- The `say-play` widget plays `https://jet-wolverine-3713.twil.io/assets/ElevenLabs_2025-09-20T05_54_14_Veda%20Sky%20-%20Customer%20Care%20Agent_pvc_sp114_s58_sb72_se89_b_m2.mp3`. That MP3 is external/opaque to the repo; the exact spoken text must be verified in Twilio or replaced with a Studio Say widget containing the exact disclosure.
- Studio forwards to Adam `+19415993489` and Virginia `+17206334021` using `connect-call-to`, `noun: number-multi`, `record: true`.
- Studio timeout is currently `30`, not the repo `/voice` timeout of `15`.
- After the forward completes, Studio posts `CallSid`, `RecordingSid`, `RecordingUrl`, `RecordingDuration`, and `RecordingStatus=completed` to `/api/webhooks/twilio/recording-status`.

Important operational gap: because Studio bypasses `/voice`, no initial `call_log` row is inserted by this repo before `/recording-status`. The Studio HTTP request should include `From={{trigger.call.From}}` and `To={{trigger.call.To}}`; otherwise the fallback `call_log` row created by `/recording-status` has null caller/called numbers, which can prevent customer creation, lead attribution, and phone-based estimate dedup.

### `POST /voice` — Inbound TwiML

`server/routes/twilio-voice-webhook.js:104–113`

- Production is gated by `twilioVoice`: `server/routes/twilio-voice-webhook.js:29–33` calls `isEnabled('twilioVoice')`; `server/config/feature-gates.js:20–27` enables that gate in production only when `GATE_TWILIO_VOICE=true`. In development it is open by default.
- If the gate is closed, the webhook does **not** run the forwarding/recording pipeline. It returns a short fallback `<Say>` telling the caller to call back during business hours or text `941-318-7612`.
- Responds with `<Say voice="alice">`: "This call is being recorded for quality assurance."
- `<Dial timeout="15" record="record-from-answer-dual">` — records both legs.
- Forward targets are hardcoded fallback humans: Adam `+19415993489` and Virginia `+17206334021`. They are dialed together as two `<Number>` nouns, not routed back to the Waves Twilio number.
- Twilio Lookup may read caller ID, but it no longer creates a customer by itself (`:47–66`). New customer creation is deferred until extraction has at least first name and phone. Last name, email, and service address are preferred when available, but not required.
- Voicemail leg (when `Dial` ends without answer) at `:147–155`: plays `process.env.WAVES_VOICEMAIL_URL` (or `https://jet-wolverine-3713.twil.io/assets/waves-voicemail.mp3`), then `<Record transcribe="true" transcribeCallback="/api/webhooks/twilio/transcription">`.
- This only proves the repo webhook behavior. The live Studio flow described above bypasses this endpoint unless the Studio flow is changed to redirect call control to `/voice`.

### `POST /call-complete`

`server/routes/twilio-voice-webhook.js:125–163`

- Updates `call_log` with `status`, `duration_seconds`, `answered_by` (human/missed/unknown).
- For `no-answer`/`busy`/`failed` returns the voicemail TwiML.

### `POST /recording-status`

`server/routes/twilio-voice-webhook.js:168–219`

- Resolves call by `ParentCallSid` first, then `CallSid` (`:170–185`). This handles forwarded-call recording callbacks where Twilio reports the child leg SID.
- **Orphan inserts exist:** if no `call_log` row matches either SID, a new row is created from webhook fields under `ParentCallSid || CallSid` (`:186–196`).
- Schedules processing with a hardcoded **5-second** `setTimeout` (`:206–210`). There is no 10-minute CDN settle window.
- Webhook returns 200 immediately; processing is non-blocking.

### `POST /transcription`

`server/routes/twilio-voice-webhook.js:224–243`

- Receives Twilio's built-in STT result (`TranscriptionText`).
- Writes `transcription` and `transcription_status` to `call_log`, resolving by `ParentCallSid` first and then `CallSid`.
- Used as fallback only — the processor prefers Gemini (see §2).

---

## 2. Recording Processor — `server/services/call-recording-processor.js`

### Concurrency

The processor now uses a retry-safe processing claim:

- `server/services/call-recording-processor.js:33–75` defines a 30-minute stale window and atomically claims eligible rows by setting `processing_status='processing'`, `processing_token`, and `processing_started_at`.
- `server/services/call-recording-processor.js:341–348` claims the call before transcription/extraction/side effects. If a row is already `processed`, `processing`, `spam`, or `voicemail`, the invocation skips.
- Terminal non-success states clear the token: `no_transcription` (`:377–385`), `extraction_failed` (`:392–400`), `spam`/`voicemail` (`:403–413`).

Two concurrent invocations on the same `CallSid` should no longer both proceed. Stale `processing` rows older than 30 minutes are reclaimable.

### `processAllPending()`

`server/services/call-recording-processor.js:897–920`

Filters:
- `recording_url != ''` and not null (`:899–900`)
- `processing_status IS NULL` or `IN ('pending', 'no_transcription', 'extraction_failed')`, plus stale `processing` rows older than 30 minutes (`:901–913`)
- `duration_seconds > 10` (`:914`)
- Order: `created_at DESC`, limit 20

**No age gate.** Anything matching the above is fetched, regardless of how old/new the recording is.

### Transcription

`server/services/call-recording-processor.js:107–154`

- **Primary: Gemini 2.5 Pro** (`:119`) — when `GEMINI_API_KEY` is set. MP3 fetched, base64-encoded, posted inline to `generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent`.
- **Fallback:** Twilio's built-in transcription cached in `call_log.transcription`.

### AI Extraction

`server/services/call-recording-processor.js:156–222`

Model: `MODELS.FLAGSHIP` (currently Claude Opus 4.7) — **not** Gemini.

Extracted JSON fields (`:176–196`):
- `first_name`, `last_name`, `email`, `phone`
- `address_line1`, `city`, `state`, `zip`
- `requested_service`
- `appointment_confirmed` (must mention explicit DATE **and** TIME)
- `preferred_date_time` (ISO 8601 local ET)
- `wants_estimate`
- `is_voicemail`, `is_spam`, `sentiment`, `pain_points`, `call_summary`
- `lead_quality` (`hot|warm|cold|spam`)
- `matched_service` (enum: General Pest Control, Lawn Care, Mosquito Control, Termite Inspection, Rodent Control, Bed Bug Treatment, WDO Inspection, Tree & Shrub Care, or null)

`wants_estimate` is true when the caller asks for a quote, estimate, price, pricing, cost, "how much", or similar pricing intent. The processor also has a keyword fallback over the transcript/summary to catch quote intent if Claude omits the field.

### Customer and Lead Creation

New non-spam, non-voicemail callers are added to `customers` only when extraction has all minimum customer fields: first name and phone (`server/services/call-recording-processor.js:127–132`, `:418–494`). Last name, email, and service address are preferred and saved when available, but they do not block creation. If any required field is missing, customer creation is skipped.

Schema note: `server/models/migrations/20260501000001_relax_customer_name_address_requirements.js:1–13` makes `customers.last_name`, `address_line1`, `city`, and `zip` nullable so phone-booked appointments can be created before the office has a full service address. `customers.first_name` and `phone` remain required.

If the call is already associated with an existing customer, the processor enriches empty customer fields rather than creating a duplicate.

When a customer exists or is created, the processor then creates or enriches a `leads` row for pipeline tracking.

### Estimate Queue

`server/services/call-recording-processor.js:588–659`

If `wants_estimate` or the keyword fallback detects quote/estimate/pricing intent, the processor queues a draft `estimates` row even when the caller is not complete enough to create a customer:

- `status='draft'`
- `source='call_recording'`
- `service_interest` from `matched_service || requested_service`
- customer name/phone/email/address copied from the customer/extraction
- `estimate_data` stores `callSid`, `leadId`, service, pain points, sentiment, lead quality, and `wants_estimate=true`

Dedup: if the same customer already has a draft estimate from the last 24 hours, or the same phone already has a `call_recording` draft estimate from the last 24 hours, no duplicate draft is inserted.

### SMS Confirmation & Scheduled Service

`server/services/call-recording-processor.js:661–787`

Order of operations (note: SMS-first):
1. Claude is prompted to reject vague appointment language; the code then applies a time-presence regex guard (`:663–666`). The regex only verifies a concrete time token, so it is not an independent relative-date validator.
2. **Send confirmation SMS** via `TwilioService.sendSMS()` at `:710`. Template fetched from `sms_templates` where `template_key='appointment_call_confirmed'` (`:691–700`); inline fallback if missing.
3. **Insert `scheduled_services` row** at `:759–771` with `status='confirmed'`, `customer_confirmed=true`. If no service street address is present, notes include `ADDRESS NEEDED - confirm service street address before dispatch.` (`:742–748`)

There is no content-level SMS dedup. The dedup/retry guard is the processing claim at the top of the processor.

Important status behavior: extraction fields are written while the row remains claimed as `processing` (`:496–505`). `call_log.processing_status` is set to `'processed'` only after lead creation/enrichment, estimate queueing, appointment SMS/schedule insertion, Beehiiv enrollment, customer interaction logging, synopsis generation, and CSR scoring complete or log their non-blocking failures (`:866–873`).

### CSR Scoring

`server/services/call-recording-processor.js:841–864`

`csrName` is hardcoded to `'Adam'` (`:847`). It is not configurable per-call or per-CSR. `CSRCoach.scoreCall()` runs non-blocking.

---

## 3. Admin Call Recordings — `server/routes/admin-call-recordings.js`

`server/routes/admin-call-recordings.js:8`

```js
router.use(adminAuthenticate, requireTechOrAdmin);
```

This applies to **every route** in the file, including `GET /audio/:id`. There is **no** `?token=` JWT exemption for audio. Standard session/JWT header auth is required.

`GET /audio/:id` (`:86–112`) proxies the Twilio MP3 (Basic auth with account SID:token) and re-streams as `audio/mpeg`.

Other routes (all behind the same auth):
- `GET /stats` (`:11–16`)
- `GET /recordings` (`:19–45`)
- `POST /process/:callSid` (`:48–53`)
- `POST /process-all` (`:56–61`)
- `POST /synopsis/:callSid` (`:64–69`)
- `GET /recording/:id` (`:72–83`)
- `PUT /calls/:id/disposition` (`:128–191`) — tag + spam-block

---

## 4. Confirmed-Absent Pieces (referenced in old doc, not in code)

| Path | Status |
|---|---|
| `docs/twilio-studio-flow-contract.md` | absent |
| `ops/twilio/…` | directory absent |
| `scripts/twilio/…` | directory absent |
| `server/middleware/twilio-signature.js` | absent |
| `server/utils/phone.js` | absent |
| `server/services/automation-runner.js` | absent |
| Twilio signature validation | not implemented on any webhook |
| `force` processing override | not implemented |
| 10-minute CDN settle | not implemented (5s hardcoded) |
| Schedule-before-SMS | false; SMS-first |
| Old-doc `WAVES_GREETING_URL` voicemail variable | not used; voicemail uses `WAVES_VOICEMAIL_URL` fallback audio |
| `<Dial timeout="30">` | timeout is 15 |

---

## 5. Migrations Touching the Call Pipeline

Located in `server/models/migrations/`:

| File | Purpose |
|---|---|
| `20260401000039_ai_assistant.js` | Creates `call_log` with core Twilio call, recording, transcription, and metadata columns |
| `20260401000049_voice_agent.js` | Adds voice-agent classification/outcome columns to `call_log`; adds `agent_type` to CSR scores |
| `20260401000051_voice_agent_v2.js` | Adds `caller_city`, `caller_state`, and `call_sid` alias columns to `call_log` |
| `20260401000059_call_recording_processing.js` | Add `ai_extraction`, `call_summary`, `sentiment`, `lead_quality`, `processing_status` |
| `20260401000090_call_log_processing.js` | Idempotent add of `processing_status`, `ai_extraction` (jsonb), `ai_summary`, `classification`, `recording_sid` |
| `20260401000095_lead_attribution.js` | Creates `lead_sources`, `leads`, and `lead_activities`, which the processor writes during lead triage |
| `20260413000001_call_log_disposition.js` | Disposition column |
| `20260414000001_call_log_lead_synopsis.js` | Lead synopsis column |
| `20260414000016_appointment_call_sms_template.js` | Seed `appointment_call_confirmed` template row |
| `20260418000006_unified_comms_schema.js` | Creates `conversations`, `messages`, and `blocked_numbers`; `/voice` dual-writes touchpoints and disposition spam blocking writes here |
| `20260420000001_scheduled_services_prepaid.js` | `prepaid_amount`, `prepaid_method`, `prepaid_note`, `prepaid_at` |
| `20260420000002_invoices_scheduled_service_id.js` | FK from invoices to scheduled_services |
| `20260501000001_relax_customer_name_address_requirements.js` | Makes customer last name and service-address fields nullable; first name and phone remain required by app logic |
| `20260501000002_call_recording_processing_claim.js` | Adds `processing_token` and `processing_started_at` so call processing has an atomic claim and stale reclaim path |

---

## 6. Routes Mounted in `server/index.js`

| Mount path | File | Line |
|---|---|---|
| `/api/webhooks/twilio` | `twilio-webhook.js` (SMS + status callbacks) | `:225` |
| `/api/webhooks/twilio` | `twilio-voice-webhook.js` (voice + recording) | `:242` |
| `/api/admin/call-recordings` | `admin-call-recordings.js` | `:258` |

Both Twilio webhook files share the prefix; their route paths don't overlap.

`twilio-voice-webhook.js` handlers: `/voice`, `/call-complete`, `/recording-status`, `/transcription`, `/lead-alert-announce`, `/outbound-admin-prompt`, `/outbound-connect`, `/call-status`.

---

## End-to-End Summary (as-built)

1. Live inbound call currently hits Twilio Studio Flow `Waves Inbound — All Numbers`, which plays an external MP3, forwards to Adam and Virginia with recording enabled, then posts recording data to `/recording-status`. The repo `/voice` endpoint is available but is not the live phone-number entrypoint while Studio owns the incoming-call trigger.
2. Recording completes → Studio posts to `POST /recording-status`; the route resolves by `ParentCallSid` first and then `CallSid` (creates orphan row if neither matches), schedules `processRecording()` after **5 s**.
3. `processRecording()`:
   - Atomically claim eligible calls as `processing` with `processing_token`; skip if already final or actively processing.
   - Transcribe via **Gemini 2.5 Pro** (fallback: Twilio).
   - Extract 19 top-level fields via **Claude Opus 4.7**, including `wants_estimate`.
   - Match an existing customer by call row or phone and fill select empty fields, or create a new customer only when first name and phone are present. Last name, email, and service address are optional but preferred.
   - Create/enrich `leads` record before the appointment/SMS branch.
   - If quote/estimate/pricing intent is detected: queue a draft estimate in Waves Admin.
   - If a strict appointment is detected: **send SMS first**, then insert `scheduled_services` row.
   - Optionally tag/enroll in Beehiiv if email present.
   - Score CSR (hardcoded `'Adam'`) via `CSRCoach`, non-blocking.
   - Generate lead synopsis (Claude), non-blocking.
   - Mark `call_log.processing_status='processed'` and clear the processing token.
4. Admin UI accesses recordings under `/api/admin/call-recordings/*`, all behind `adminAuthenticate + requireTechOrAdmin`. Audio is proxied from Twilio.
