# Waves Inbound Call Workflow — Recording → Gemini Transcription → Customer/Estimate

**Repo:** `wavespestcontrolfl/waves-customer-portal`
**Snapshot:** main @ `6cc8461` (2026-04-30)
**Audit scope:** every step from a phone ringing to a customer/estimate row landing in the admin portal.

This is a complete trace through the production pipeline. Every step cites the exact file + line so you can jump straight in.

---

## 0. The 30,000-ft picture

```
Caller dials any Waves number
    │
    ▼
Twilio receives the call → Studio Flow "Waves Inbound — All Numbers" (FW5fdc2e44...)
    │   • Plays ElevenLabs disclosure greeting (FL §934.03 consent surface)
    │   • Simul-rings Adam (+19415993489) and Virginia (+17206334021) for 30s
    │   • record=true on the connect-call-to widget → Twilio captures both legs
    │
    ├──[answered]──► both legs recorded; on hangup Twilio fires:
    │                 recordingStatusCallback → /api/webhooks/twilio/recording-status
    │
    └──[no-answer / busy / failed]──► falls into voicemail
                                       Studio's record-voicemail (transcribe=true)
                                       OR portal fallback /call-complete (also Records)
                                       Both fire recordingStatusCallback to portal.
    │
    ▼
PORTAL — server/routes/twilio-voice-webhook.js  (signed by middleware/twilio-signature)
    1. /voice ............ logs call_log row, dual-writes to messages, replies TwiML (fallback only)
    2. /call-complete .... updates duration/answeredBy; if no-answer, plays voicemail + records
    3. /recording-status . attaches recording_url to call_log; schedules processor +10 min
    4. /transcription .... cheap Twilio fallback transcript (only used if Gemini fails)
    │
    ▼
PROCESSOR — server/services/call-recording-processor.js
    Step 1  Transcribe with Gemini 2.5 Pro (audio inline base64)   ← source of truth
    Step 2  Extract structured JSON with Gemini 2.5 Flash          ← caller name, address,
                                                                     service, appointment,
                                                                     wants_estimate, sentiment,
                                                                     lead_quality, voicemail/spam
    Step 3  Create or match customers row (phone-keyed)
    Step 4  Stamp call_log with extraction; mark processed/failed/voicemail/spam
    Step 4b Create or enrich a leads row (pipeline tracking)
    Step 4c If wants_estimate → enqueue draft estimates row
    Step 5  If appointment_confirmed + specific time → insert scheduled_services row
            then send SMS confirmation via TwilioService
    Step 6  Enroll customer in local "new_lead" automation (was Beehiiv)
    Step 7  Log customer_interactions timeline entry
    Step 7b Generate "Sales Strategist" lead synopsis with Claude FLAGSHIP
    Step 8  Score the call against the 15-point CSR rubric (Claude FLAGSHIP)
    │
    ▼
ADMIN UI — /admin/communications + CallRecordingsPanel.jsx
            renders recordings, transcripts, AI extraction, synopsis, CSR score,
            disposition tagging (spam → hard-block + delete row)
```

Two cron-style backstops keep the pipeline self-healing:

- `setInterval` in `server/index.js:577–587` runs `processAllPending()` every 10 min — catches anything the inline `setTimeout(... , 10*60*1000)` lost to a server restart.
- `processAllPending` itself age-gates fresh rows behind a 10-min CDN-settle window so neither path can race Twilio's MP3 propagation.

---

## 1. Production entry point — Twilio Studio Flow (NOT this repo)

**Critical:** every Waves Twilio number's `voiceUrl` is wired directly to a Twilio Studio Flow — **production calls do not hit `/voice` in the portal under normal operation.**

- Flow SID: `FW5fdc2e44700c6e786ed27de94e0cbace`
- Friendly name: `Waves Inbound — All Numbers`
- Snapshot: `ops/twilio/studio/waves-inbound-all-numbers.snapshot.json`
- Contract: `docs/twilio-studio-flow-contract.md`
- Verify drift: `npm run twilio:flow:verify`
- Re-export from Console: `npm run twilio:flow:export`

### Flow graph (from contract)

```
Trigger → say_play_2  ──────────────────────► [DISCLOSURE: ElevenLabs MP3]
                                              jet-wolverine-3713.twil.io/assets/
                                              ElevenLabs_2025-09-20T05_54_14_
                                              Veda%20Sky%20-%20Customer%20Care%20Agent_*.mp3

       → forward_call (connect-call-to, noun=number-multi)
            • to: +19415993489, +17206334021    (Adam, Virginia — strict-verified
                                                  via TWILIO_EXPECTED_FORWARD_NUMBERS)
            • timeout: 30
            • record: true                       ← fires the canonical
            • caller_id: {{contact.channel.address}}  recordingStatusCallback

       → on completion:
            post_recording_to_portal (make-http-request, redundant during PR1 burn-in)
              POST → https://waves-customer-portal-production.up.railway.app
                     /api/webhooks/twilio/recording-status

            say_play_1 (voicemail prompt MP3)
            record_voicemail_3
              transcribe: true
              transcription_callback_url: twimlets.com/voicemail?Email=contact@...
              recording_status_callback_url: portal /recording-status
              max_length: 3600
```

### Why the Flow matters

The first widget after Trigger MUST be a `say-play` playing the disclosure asset. No `connect-call-to`, `record-voicemail`, or any recording-capable widget can come before it. That's the FL §934.03 consent surface — and the verifier asserts on it.

---

## 2. Portal fallback — `/api/webhooks/twilio/voice`

**File:** `server/routes/twilio-voice-webhook.js:30–176`

Used when (a) Studio Flow is bypassed, (b) a number is provisioned but not yet wired into the Flow, or (c) contract tests run.

Key behaviors mirror the Studio Flow:

1. **Feature gate** (`twilioVoice`): if disabled, plays "call back during business hours."
2. **Spam middleware** (`middleware/spam-block.js → checkInboundBlock`): blocks known bad numbers before any logging.
3. **Customer match**: `db('customers').where({ phone: From }).first()`.
4. **Twilio Lookup enrichment** (line 51–92): for unknown callers, hits `lookups.twilio.com/v2/PhoneNumbers/...?Fields=caller_name`. If the carrier returns a CNAM, auto-creates a lightweight `customers` row with `lead_source='twilio_lookup'`, `pipeline_stage='new_lead'`.
5. **`call_log` insert** (line 95–107):
   - `direction: 'inbound'`
   - `from_phone: toE164(From)` / `to_phone: toE164(To)` (normalized via `server/utils/phone.js`)
   - `twilio_call_sid: CallSid`
   - `metadata: { location, numberType, domain }` resolved via `config/twilio-numbers.js`
6. **Dual-write** to unified `messages` table via `services/conversations.recordTouchpoint` (fire-and-forget).
7. **TwiML response** (line 163–169):

```xml
<Response>
  <Play>{WAVES_GREETING_URL}</Play>
  <Dial record="record-from-answer-dual"
        recordingStatusCallback="/api/webhooks/twilio/recording-status"
        recordingStatusCallbackEvent="completed"
        timeout="30"
        action="/api/webhooks/twilio/call-complete">
    <Number>+19415993489</Number>
    <Number>+17206334021</Number>
  </Dial>
</Response>
```

`record-from-answer-dual` = both legs recorded as one stereo track, started when the dial is answered (no ringing). This is why we get a single MP3 covering caller + agent.

Forwarding numbers come from `WAVES_FALLBACK_FORWARD_NUMBERS` env, default `+19415993489,+17206334021`.

---

## 3. Dial completion — `/api/webhooks/twilio/call-complete`

**File:** `server/routes/twilio-voice-webhook.js:181–229`

Fires when `<Dial>` finishes (answered or not).

- Computes `duration_seconds = parseInt(DialCallDuration || CallDuration)`.
- `answered_by`: `'human'` if completed + duration>0; `'missed'` for `no-answer`/`busy`; `'unknown'` otherwise.
- Updates `call_log.{status,duration_seconds,answered_by}` keyed on CallSid.

If `status ∈ ['no-answer','busy','failed']`, returns voicemail TwiML:

```xml
<Response>
  <Play>{WAVES_VOICEMAIL_URL}</Play>
  <Say>Your message will be recorded and transcribed.</Say>
  <Record maxLength="120" transcribe="true"
          transcribeCallback="/api/webhooks/twilio/transcription"
          recordingStatusCallback="/api/webhooks/twilio/recording-status"
          recordingStatusCallbackEvent="completed"
          playBeep="true" />
  <Say>Thank you. We'll get back to you soon. Goodbye.</Say>
</Response>
```

---

## 4. Recording landed — `/api/webhooks/twilio/recording-status`

**File:** `server/routes/twilio-voice-webhook.js:234–319`

Twilio POSTs `{CallSid, RecordingSid, RecordingUrl, RecordingDuration, RecordingStatus, ParentCallSid}`.

### Parent-vs-child SID gotcha

`<Dial record>` records on the **child leg**. The CallSid Twilio sends here is the child leg's SID, **not** the parent inbound CallSid that `/voice` wrote to `call_log`. Resolution order (line 254–269):

1. `UPDATE call_log WHERE twilio_call_sid = ParentCallSid` ← tries parent first
2. fallback: `UPDATE call_log WHERE twilio_call_sid = CallSid` ← single-leg/non-dial cases (voicemail recording on parent)

If neither matches, **log + skip — never synthesize an orphan row** (line 282–286). The previous fallback inserted from `req.body.To/From`, which on dial-leg callbacks were the forwarding leg (Twilio number ↔ Adam's cell) and polluted the dashboard with phantom "Unmapped — +19415993489" entries.

### Columns set

```js
{
  recording_url: RecordingUrl + '.mp3',
  recording_sid: RecordingSid,
  recording_duration_seconds: parseInt(RecordingDuration),
  transcription_status: 'pending',
  updated_at: new Date(),
}
```

### Auto-process scheduler (line 302–311)

```js
setTimeout(() => processor.processRecording(matchedSid), 10 * 60 * 1000);
```

**The 10-minute delay is load-bearing.** Twilio's `recording-status:completed` fires **before** the MP3 is reliably fetchable from their CDN. The auth'd download in `transcribeWithGemini` would otherwise 404 or return a partial buffer and Gemini would transcribe garbage. ~10 min is the empirical propagation window. The cron in `server/index.js` is the restart-safe backstop using the same age gate.

---

## 5. Twilio's built-in transcription (fallback only) — `/api/webhooks/twilio/transcription`

**File:** `server/routes/twilio-voice-webhook.js:324–363`

Same parent-vs-child SID resolution. Writes `transcription` + `transcription_status='completed'`. This is the cheap fallback the processor uses if Gemini fails — Twilio's native transcription is much lower quality than Gemini 2.5 Pro, so it's fallback-only.

---

## 6. The processor — `server/services/call-recording-processor.js`

This is the heart of the pipeline. Entry point:

```js
CallRecordingProcessor.processRecording(callSid, opts = {})
```

Triggered by:
- `setTimeout` from `/recording-status` (T+10min)
- `setInterval` cron in `server/index.js:577–587` (every 10 min)
- Admin "Reprocess" button → `POST /api/admin/call-recordings/process/:callSid?force=true`

### Concurrency & retry safety (line 250–325)

The ring-first flow can fire **two** `recording-status` webhooks for one call (outer `<Dial record>` + inner voicemail `<Record>` share the same CallSid), and each schedules `processRecording` on the 5s/10min delay. Without a guard both runs would race through extraction and both would send the confirmation SMS.

**Atomic claim with owner fence:**

```sql
UPDATE call_log
SET processing_status='processing',
    processing_token=<random hex>,
    updated_at=NOW()
WHERE twilio_call_sid=$1
  AND processing_status IS DISTINCT FROM 'processed'
  AND (processing_status IS DISTINCT FROM 'processing'
       OR updated_at < NOW() - INTERVAL '10 minutes')
```

- `IS DISTINCT FROM` (not `!=`): NULL `processing_status` rows must pass — `<>` returns NULL when either side is NULL, and WHERE treats NULL as falsy.
- **Stale reclaim**: if a peer crashed/hung mid-flight, after 10 min its claim is reclaimable.
- **Owner token**: written at claim, matched on release in the catch block. If the stale-reclaim path handed the lock to a peer, the peer's claim overwrote our token — our catch-block UPDATE matches 0 rows and we exit cleanly without disturbing the peer.
- `force=true` bypasses the "already processed" early-exit but **still** respects in-flight peer locks.

### Step 1 — Transcribe with Gemini 2.5 Pro

**Function:** `transcribeWithGemini(mp3Url)` (line 49–95)

1. **Download** the MP3 from Twilio with HTTP Basic auth (`TWILIO_ACCOUNT_SID:TWILIO_AUTH_TOKEN` base64). `redirect: 'follow'` for Twilio's S3 redirect.
2. **Inline base64** the audio into a Gemini `inlineData` part (`mimeType: 'audio/mpeg'`).
3. Call `gemini-2.5-pro:generateContent` with `temperature: 0`.

**Prompt (verbatim, line 68–74):**

```
Transcribe this phone call recording for Waves Pest Control (pest control + lawn care, SW Florida).

Rules:
- Label every turn "Agent:" or "Caller:" on its own line.
- Transcribe verbatim — preserve fillers ("um", "uh"), numbers, addresses, phone numbers, and proper nouns exactly as spoken.
- If audio is silent, unintelligible, or only voicemail tones, output exactly: [VOICEMAIL] or [NO SPEECH].
- Do NOT summarize, translate, or add commentary. Output the transcript only, nothing before or after.
```

**Response handling:** Gemini 2.5 may emit `thought` parts; we filter them out (line 88–90):

```js
const parts = data.candidates?.[0]?.content?.parts || [];
const textPart = parts.find(p => p.text && !p.thought);
return textPart?.text || parts[0]?.text || null;
```

On success: persist to `call_log.{transcription, transcription_status='completed'}`.
On failure: fall back to (a) fresh Twilio transcription if landed during our window, (b) cached Twilio transcription on the original row.
If still no transcription → mark `processing_status='no_transcription'`, return `{success: false}` (the cron will retry with no age gate).

### Step 2 — AI extraction with Gemini 2.5 Flash

**Function:** `extractCallData(transcription, callerPhone)` (line 103–182)

Calls `gemini-2.5-flash:generateContent` with `response_mime_type: 'application/json'` and `temperature: 0.2`.

**Schema returned:**

```jsonc
{
  "first_name": "string|null",
  "last_name": "string|null",
  "email": "string|null",
  "phone": "string (defaults to caller phone)",
  "address_line1": "string|null",
  "city": "Florida city|null",
  "state": "FL",
  "zip": "string|null",
  "requested_service": "free-text from caller",
  "appointment_confirmed": true/false,
  "preferred_date_time": "YYYY-MM-DDTHH:MM in ET, no offset (e.g. 2026-04-20T14:00)",
  "wants_estimate": true/false,
  "is_voicemail": true/false,
  "is_spam": true/false,
  "sentiment": "positive|neutral|negative|frustrated",
  "pain_points": "brief summary",
  "call_summary": "2-3 sentences",
  "lead_quality": "hot|warm|cold|spam",
  "matched_service": "General Pest Control|Lawn Care|Mosquito Control|Termite Inspection|Rodent Control|Bed Bug Treatment|WDO Inspection|Tree & Shrub Care|null"
}
```

**Strict appointment rules in the prompt:**
- `appointment_confirmed=true` requires BOTH a specific date AND a specific time.
- "Tomorrow", "next week", "noonish", "sometime Tuesday" → `false`.
- Agent saying "I'll text you" without caller confirming → `false`.

**Strict estimate rules:**
- Set `wants_estimate=true` for: "quote", "estimate", "price", "pricing", "how much", "what would it cost", "can you give me a number", or any signal of wanting a written/verbal price before committing.
- True even if they also booked an appointment (intent and service are not mutually exclusive).
- False for: existing-customer service questions, complaints, billing calls, rescheduling, voicemail, spam.

**Error handling:** if Gemini returns invalid JSON, fall back to a safe default (`{first_name: null, is_spam: false, is_voicemail: false, call_summary: 'AI extraction returned invalid JSON', lead_quality: 'cold'}`) so the row is written and admin can reprocess.

If extraction throws entirely → `processing_status='extraction_failed'`, return.

### Voicemail / spam early-exit (line 387–396)

If `is_voicemail` or `is_spam`:
```js
update call_log set
  ai_extraction = JSON.stringify(extracted),
  processing_status = is_spam ? 'spam' : 'voicemail',
  processing_token = null
```
No customer, no lead, no estimate, no SMS.

### Step 3 — Customer create-or-match (line 399–476)

Phone-keyed match first:

```js
const phone = extracted.phone || call.from_phone;
const existing = await db('customers').where({ phone }).first();
```

**If existing customer:** fill empty fields only (`email`, `address_line1`+`city`+`zip`) — never overwrite.

**If new + extracted name:**

1. Resolve `nearest_location_id` via `config/locations.resolveLocation(extracted.city)`.
2. Generate referral code `WAVES-XXXX` (4 chars, ambiguous chars excluded: no 0/1/I/O).
3. Determine `lead_source` from the inbound number via `TWILIO_NUMBERS.findByNumber(call.to_phone)` + `getLeadSourceFromNumber`.
4. **Address parsing fallback** (line 431–442): if AI returned a one-string address ("8224 Abalone Loop, Parrish 34219") and no city, split on comma and regex-extract city + ZIP.
5. Insert with `pipeline_stage='new_lead'`, `pipeline_stage_changed_at=now`.
6. `StripeService.ensureStripeCustomer(customerId)` — non-blocking, logs warnings (Stripe is the live processor; the legacy `square_*` columns are unused).

If `extracted.first_name` was set but no `customerId` materialized → `processing_status='customer_creation_failed'` (NOT 'processed') so admin can see + retry. This catch was added because silently marking 'processed' orphaned the call (no lead, no estimate, no SMS, no flag).

### Step 4 — Stamp call_log (line 486–498)

```js
update call_log set
  customer_id,
  ai_extraction = JSON.stringify(extracted),
  call_summary, sentiment, lead_quality,
  processing_status = customer_creation_failed ? 'customer_creation_failed' : 'processed',
  processing_token = null
```

### Step 4b — Lead pipeline (line 504–617)

Created **directly here** (not via `lead-attribution`) because Step 3 already materialized the customer; attribution would find it and skip lead creation (race).

**Lead source resolution** (line 522–541): the `lead_sources.twilio_phone_number` column has historically been hand-entered in 4 shapes: `+19413187612`, `19413187612`, `9413187612`, `(941) 318-7612`. Build all four variants from `call.to_phone` digits and `whereIn` to match — the previous bug computed `+1${digits}` from already-E.164 input (`+119413187612`, always invalid) and silently nulled `lead_source_id`.

**Insert:** `lead_type='inbound_call'`, `first_contact_channel='call'`, `twilio_call_sid`, `call_duration_seconds`, `call_recording_url`, `status='new'`.

**Enrichment policy (line 567–602):** for an existing lead, fill empty fields only — protects Virginia's manual edits when a follow-up call arrives. For brand-new leads everything is null so the empty-only rule is equivalent to "fill everything."

**Urgency** (line 585–589) is upgrade-only:
- `lead_quality='hot'` → `urgency='urgent'` (always promotes)
- otherwise fill `urgency='normal'` only if currently empty

**Always-refreshed** (rolling AI snapshot):
- `transcript_summary = call_summary`
- `extracted_data = JSON({pain_points, preferred_date_time, sentiment})`

**Qualified flag:** `is_qualified = ['hot','warm'].includes(lead_quality)` — `!= 'spam'` would mark cold leads qualified.

**Activity log:** insert `lead_activities` row with `activity_type='ai_triage'`.

### Step 4c — Estimate enqueue (line 624–681)

If `customerId && wants_estimate && !spam && !voicemail`:

**Dedup guard:** skip if an open `estimates` draft for this customer already exists in the last 24h (so reprocess + back-to-back calls don't stack duplicates).

Otherwise insert:

```js
{
  customer_id: customerId,
  status: 'draft',
  source: 'call_recording',                  // discriminator vs. hand-started drafts
  service_interest: matched_service || requested_service,
  is_priority: lead_quality === 'hot' || sentiment === 'frustrated',
  urgency: hot ? 3 : warm ? 2 : 1,
  customer_name, customer_phone, customer_email,
  address: address_line1,
  token: `${name-slug}-${4-byte-hex}`,       // public estimate URL token
  expires_at: now + 7 days,
  notes: call_summary,
  estimate_data: JSON({                       // text column, not jsonb
    callSid, leadId,
    requested_service, matched_service,
    pain_points, sentiment, lead_quality,
    city, zip,
  }),
}
```

`status='draft'` is the queue state — `EstimatesPageV2`'s Drafts tab surfaces them automatically.

### Step 5 — Appointment confirmation SMS (line 685–863)

**Gating:** `appointment_confirmed && preferred_date_time && customerId && hasSpecificTime`

`hasSpecificTime` regex (line 687):
```js
/\d{1,2}:\d{2}|\d{1,2}\s*(am|pm|a\.m|p\.m)|noon|midday/i
```

**Order of operations matters** — schedule row first, SMS second. Previous code sent the SMS first, and if the schedule insert threw the customer was told their appointment was booked when it wasn't.

#### 5a. Build SMS body

Tries `sms_templates.template_key='appointment_call_confirmed'`; falls back to inline:

```
Hello {firstName}! Your {serviceType} appointment has been scheduled.

Date/Time: {preferred_date_time}

We'll send you a reminder before your appointment. Reply to this text or call (941) 318-7612 with any questions.

— Waves Pest Control 🌊
```

Template tokens: `{first_name}`, `{service_type}`, `{date_time}`, `{date}`, `{time}` — `parsedDate`/`parsedTime` come from `parseETDateTime(extracted.preferred_date_time)` with regex fallback.

#### 5b. Content-level dedup (line 736–743)

Even if the concurrency guard misses (admin reprocess inside the same minute), don't send if an identical confirmation SMS to the same phone went out in the last 10 min:

```sql
SELECT 1 FROM sms_log
WHERE to_phone=? AND message_type='confirmation'
  AND message_body=? AND created_at > NOW() - 10 min
```

#### 5c. Insert scheduled_services (line 753–841)

ET timezone-correct date/time parsing — both the ISO `YYYY-MM-DDTHH:MM` ET path and the regex-string path. The regex path pins parse to `12:00` so a UTC server's `new Date('April 30 2026')` (which becomes UTC midnight) can't roll the calendar date back when re-rendered in ET.

```js
db('scheduled_services').insert({
  customer_id,
  scheduled_date,                  // YYYY-MM-DD in ET
  window_start, window_end,        // HH:MM (window_end = +1h)
  window_display,                  // "9:00 AM"
  service_type: matched_service || requested_service || 'General Pest Control',
  status: 'confirmed',
  customer_confirmed: true,
  confirmed_at: now,
  notes: `Booked via phone call. ${call_summary}`,
  booking_source: 'phone_call',
})
```

#### 5d. Stitch schedule back into estimate (line 821–837)

If the same call produced both a draft estimate AND a scheduled appointment, merge `{scheduled_service_id, scheduled_date, window_start}` into the estimate's `estimate_data` JSON. This lets `EstimatesPageV2` show "Already scheduled · Apr 30, 9:00 AM" pointing at exactly this appointment, vs. a vague "customer has SOME upcoming appointment" fallback. Read-merge-write because `estimate_data` is a JSON-stringified text column, not jsonb.

#### 5e. Send SMS

Only if the schedule row landed AND not a duplicate:

```js
TwilioService.sendSMS(customer.phone, smsBody, { messageType: 'confirmation' });
```

If the schedule insert threw → log + return without sending — customer is never told about an appointment that doesn't exist.

### Step 6 — Local automation enrollment (line 868–886)

**Note:** variable name kept as `beehiivResult` for log/schema continuity, but this is now the local `services/automation-runner` (Beehiiv was deprecated).

```js
AutomationRunner.enrollCustomer({
  templateKey: 'new_lead',
  customer: { email, first_name, last_name, id },
});
```

### Step 7 — Customer interaction timeline (line 889–896)

```js
db('customer_interactions').insert({
  customer_id,
  interaction_type: 'call',
  subject: `Inbound call — ${matched_service || requested_service || 'General inquiry'}`,
  body: call_summary || `Call from ${phone}. ${pain_points}`,
});
```

### Step 7b — Sales Strategist synopsis (line 899–914)

`generateLeadSynopsis(transcription)` calls Claude `MODELS.FLAGSHIP` (currently `claude-opus-4-7`). Persisted to `call_log.lead_synopsis` AND `leads.lead_synopsis` if a lead was created.

**Prompt structure** (line 195–231, full text in source):

- **Role:** "Sales Strategist and Customer Experience Analyst for Waves Pest Control & Lawn Care, family-owned, SW Florida (Manatee, Sarasota, Charlotte counties). Local-business-owner voice, no corporate fluff."
- **Step 0 — Gate:** if not a new inbound lead (existing customer billing/service question, vendor/spam, internal, callback on quoted job) → respond *exactly* `"Not a new lead — no analysis needed."` and stop.
- **Step 1 — Service Request Identification:** every service mentioned or implied; map problem descriptions to the Waves service catalog.
- **Step 2 — Lead Intelligence:** primary pain point (with quoted language), buying triggers, trust barriers, property context.
- **Step 3 — Actionable Strategy:**
  - **A. Immediate Close** — exact 2–4 sentence script for the callback, tone-matched.
  - **B. WaveGuard Positioning** — 2–3 sentence pitch positioning the membership as the answer to *their* pain point in *their* language. Not as upsell.
  - **C. Office Follow-Up Action** — one specific concrete step Virginia/the office should take in the next 2 hours. Not "follow up" — specific.
- **Format:** `##` headers, bullets, ≤400 words, "cheat sheet to a tech in the truck."

### Step 8 — CSR Coach scoring (line 921–943)

Triggers when `transcription.length > 50`. Calls `services/csr/csr-coach.scoreCall`.

**csrName='Unknown'** by default (line 925). The inbound `<Dial>` forwards to a single number that may ring multiple people — we don't actually know who answered. Better than booking everything to one CSR's record. Per-CSR routing is a future fix.

**Rubric** (15 points total):

- **Core 10 (1 pt each, must be clearly present):** greeting, empathy, problem_capture, address, time_options, fee_confirmation, name_confirmation, callback_number, set_expectations, strong_close.
- **Rescue 5 (1 pt each, only when applicable):** objection_save, upsell_attempt, urgency_creation, referral_mention, follow_up_offer.
- **Skill dimensions (1–5):** control, warmth, clarity, objection_handling, closing_strength.

Plus a **separate** lead-quality grade (1–10) — orthogonal to CSR performance.

Stored on its own table (CSR-coach-owned schema). Surfaces in admin dashboards.

### Step 9 — Final return (line 947–956)

```js
return {
  success: true,
  callSid, customerId, leadId,
  extracted,
  appointmentResult,    // { smsSent, scheduledServiceId, service, dateTime, scheduledDate, windowStart }
  estimateQueueResult,  // { created, estimateId, token } or { skipped, existingEstimateId } or { error }
  beehiivResult,        // { local: <enrollment result> }
};
```

### Outer catch — lock release on failure (line 957–979)

Any unhandled throw between claim and terminal-status writes → release the lock owner-fenced:

```sql
UPDATE call_log
SET processing_status='extraction_failed', processing_token=NULL
WHERE id=$1 AND processing_token=$2
```

If the stale-reclaim path handed the lock to a peer mid-flight, this UPDATE matches 0 rows — log + bail without touching the peer.

---

## 7. Backstop cron — `processAllPending()`

**File:** `server/services/call-recording-processor.js:986–1036`

Runs every 10 min from `server/index.js:577–587`. Picks up:

1. **Fresh / waiting** rows where `processing_status` is NULL/`'pending'` OR `transcription_status='pending'` AND `transcription IS NULL` — **gated behind the 10-min CDN-settle window** (`updated_at < NOW() - INTERVAL '10 minutes'`). Same age gate as the inline `setTimeout` so neither path beats Twilio's MP3 propagation.
2. **`processing_status='no_transcription'`** — known-failed retries, no age gate, run promptly.
3. **`processing_status='processing'` AND `updated_at < NOW() - INTERVAL '10 minutes'`** — orphaned claims from server crash/Gemini hang.

Filter: `COALESCE(recording_duration_seconds, duration_seconds, 0) > 10` (skip <10s). The COALESCE was added because the call-status webhook may not have populated `duration_seconds` yet — the earlier filter on `duration_seconds` alone excluded fresh recordings.

`limit(20)` per cron tick.

---

## 8. Outbound flow (Adam/Virginia clicks "Call" in the portal)

Mirror image of the inbound path; same recording → processing pipeline.

**File:** `server/routes/twilio-voice-webhook.js:391–476`

1. **`/outbound-admin-prompt`** — Twilio dials Adam's cell first, plays "Calling {firstName}. Press 1 to connect."
2. **`/outbound-connect`** — on `Digits='1'`, marks `call_log.status='bridged'` and dials the customer with:
   - `record: 'record-from-answer-dual'`
   - `recordingStatusCallback: '/api/webhooks/twilio/recording-status'`
   - Disclosure: `<Say>Connecting now. This call may be recorded, transcribed, and processed with A I to improve service.</Say>`
3. **`/call-status`** — async status callbacks; serializes per-CallSid via `pg_advisory_xact_lock(hashtext(CallSid))` so overlapping Twilio retries can't double-insert. Outbound-direction callbacks with no existing call_log row get logged-and-skipped (the originator at `admin-communications.js` is responsible for the insert).

Recording lands on the same `/recording-status` endpoint, processor runs the same 10-step pipeline. Inbound vs. outbound is just the `direction` column.

---

## 9. Admin endpoints — `/api/admin/call-recordings/*`

**Mounted:** `server/index.js:327` → **file:** `server/routes/admin-call-recordings.js`

| Method | Path | Purpose |
|---|---|---|
| GET | `/audio/:id` | Stream MP3 through portal (`<audio src>` can't send Authorization headers — accepts JWT via `?token=`). UUID vs. `RE…` SID auto-routed. Proxies Twilio with Basic auth. **Registered before global middleware.** |
| GET | `/stats` | Dashboard tile counts: total recordings, processed, pending, voicemail, spam, appointments, last 7d, leads extracted, source breakdown by `to_phone`. |
| GET | `/recordings` | Paginated list with `customers` left-joined. Filterable by `processing_status`. |
| POST | `/process/:callSid` | Manual reprocess. `?force=true` bypasses "already processed" guard but respects in-flight peer locks. |
| POST | `/process-all` | Run `processAllPending()` on demand. |
| POST | `/synopsis/:callSid` | Regenerate Sales Strategist synopsis only (no full reprocess). |
| GET | `/recording/:id` | Single-record detail. |
| PUT | `/calls/:id/disposition` | Tag call: `new_lead_booked`, `new_lead_no_booking`, `existing_service_q`, `existing_complaint`, `spam`. Spam tagging hard-blocks the number in `blocked_numbers` AND deletes the call_log row + associated SMS. Non-spam tags are logged to `customer_interactions`. |
| GET | `/blocked` | List blocked numbers (back-compat alias to `phone`/`reason`/`blocked_at`). |
| DELETE | `/blocked/:phone` | Unblock a number. |

**Auth:** `adminAuthenticate + requireTechOrAdmin` middleware on everything except `/audio/:id` (which has its own JWT check via header or `?token=`).

---

## 10. The schema

### `call_log` (created `20260401000039_ai_assistant.js`, augmented across 8+ migrations)

| Column | Type | Source / purpose |
|---|---|---|
| `id` | uuid PK | |
| `customer_id` | uuid FK customers | NULL allowed (unknown caller) |
| `direction` | string | `inbound` / `outbound` |
| `from_phone`, `to_phone` | string | `toE164()`-normalized |
| `twilio_call_sid` | string unique | parent leg SID |
| `status` | string | Twilio call status |
| `duration_seconds`, `recording_duration_seconds` | int | dial vs. recording duration |
| `recording_url`, `recording_sid` | string | from `/recording-status` |
| `transcription` | text | Gemini's output (or Twilio fallback) |
| `transcription_status` | string | `pending` / `completed` / `failed` |
| `processing_status` | string | `pending` (NULL) / `processing` / `processed` / `no_transcription` / `extraction_failed` / `voicemail` / `spam` / `customer_creation_failed` |
| `processing_token` | string | random hex; owner fence for catch-block lock release (`20260428000010`) |
| `ai_extraction` | jsonb | full JSON returned by `extractCallData` |
| `call_summary`, `sentiment`, `lead_quality` | string | flat-broken-out from `ai_extraction` for fast filtering |
| `lead_synopsis` | text | Sales Strategist markdown (`20260414000001`) |
| `disposition` | string | from `PUT /disposition` (auto-added if missing) |
| `answered_by` | string | `human` / `missed` / `unknown` |
| `bridged_at` | timestamptz | outbound bridging |
| `metadata` | jsonb | `{location, numberType, domain, source}` |
| `created_at`, `updated_at` | timestamptz | |

### Side-tables touched per call

| Table | When |
|---|---|
| `customers` | match-or-create in Step 3 |
| `messages` | `recordTouchpoint` dual-write at `/voice` |
| `customer_interactions` | Step 7 timeline |
| `leads` | Step 4b — pipeline tracking |
| `lead_activities` | Step 4b — `activity_type='ai_triage'` |
| `estimates` | Step 4c — `status='draft' source='call_recording'` |
| `scheduled_services` | Step 5c — confirmed appointment |
| `sms_log` | Step 5e — confirmation SMS write |
| `blocked_numbers` | spam disposition |
| `csr_coach_*` | Step 8 — score row |

---

## 11. Configuration & secrets (Railway env)

| Variable | Used by | Purpose |
|---|---|---|
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | downloadRecording, audio proxy, signature middleware | Basic auth + signed-webhook validation |
| `GEMINI_API_KEY` | `transcribeWithGemini`, `extractCallData` | both Gemini calls |
| `ANTHROPIC_API_KEY` | `generateLeadSynopsis`, `csr-coach.scoreCall` | Claude FLAGSHIP |
| `MODEL_FLAGSHIP` (optional) | `config/models.js` | swap synopsis/CSR-coach model without code change |
| `WAVES_GREETING_URL` | `/voice` fallback | disclosure MP3 (Studio Flow has its own copy) |
| `WAVES_VOICEMAIL_URL` | `/call-complete` voicemail | voicemail prompt MP3 |
| `WAVES_FALLBACK_FORWARD_NUMBERS` | `/voice` fallback | CSV E.164; default `+19415993489,+17206334021` |
| `TWILIO_EXPECTED_FORWARD_NUMBERS` | `npm run twilio:flow:verify` | strict drift check on Studio Flow `connect-call-to.to` |
| `DATABASE_URL` (+ `_PUBLIC_URL` for local) | knex | Postgres on Railway |

**Florida wiretap (FL §934.03):**
- Inbound: ElevenLabs disclosure asset plays via Studio Flow `say_play_2` BEFORE any `connect-call-to` / `record-voicemail` widget.
- Outbound: spoken disclosure on the customer leg in `/outbound-connect` BEFORE `<Dial>` bridges.
- If the disclosure asset URL is rotated, the new asset MUST contain recording/transcription/AI-processing language.

---

## 12. The 10-minute settle window — why it's everywhere

Three places enforce the same 10-min age gate, and they're all load-bearing:

1. **Inline `setTimeout` in `/recording-status`** (twilio-voice-webhook.js:305–309) — primary path.
2. **`processAllPending()` SQL `updated_at < NOW() - INTERVAL '10 minutes'`** (call-recording-processor.js:1014) — restart-safe backstop.
3. **Atomic claim's stale-reclaim window** (call-recording-processor.js:292–293, 318–319) — orphaned claims from a crashed/hung peer become reclaimable after 10 min.

All three exist because Twilio's `recording-status:completed` callback fires before the MP3 is reliably fetchable from their CDN. Hitting Gemini before propagation produces partial/404 audio, which transcribes as gibberish (or silently transcribes the prefix only). Empirically ~10 min is the tightest window where the auth'd Twilio download stabilizes.

---

## 13. Failure surfaces (what to look at when something's off)

| Symptom | Most likely cause | Where to look |
|---|---|---|
| Recording row stuck `processing_status='processing'` >10 min | Server crashed mid-flight OR Gemini hung past timeout | `processAllPending` will reclaim on next tick (10-min cron); manual: admin "Reprocess" |
| `processing_status='no_transcription'` | Gemini API down OR MP3 still propagating | Cron retries with no age gate; check `GEMINI_API_KEY` and Twilio recording URL is reachable |
| `processing_status='extraction_failed'` | Gemini returned malformed JSON OR threw | Outer catch released the lock; admin "Reprocess" |
| `processing_status='customer_creation_failed'` | AI extracted name but customer insert blew up (constraint, unique violation) | logger.warn line 497; check `customers` schema vs. extracted data |
| Confirmation SMS sent but no `scheduled_services` row | Was the order-of-ops bug (fixed) — should not occur on current main | grep `sms_log` for `message_type='confirmation'`; check call_log timeline |
| Two confirmation SMS to same customer | Concurrency guard bypass + content-dedup window (10 min) bypass | check `processing_token` ownership; admin Reprocess inside same minute? |
| Phantom "Unmapped — +19415993489" rows in dashboard | Old orphan-insert path from `/recording-status` (fixed); won't reproduce on main | clean via `server/scripts/cleanup-orphan-call-log-rows.js` |
| New lead missing `lead_source_id` | `lead_sources.twilio_phone_number` shape mismatch (fixed via 4-variant `whereIn`); legacy rows may persist | check `lead_sources.is_active=true` and number column exact value |
| Studio Flow drift suspected | Console edit without snapshot/contract update | `npm run twilio:flow:verify` — exits non-zero on any invariant break |

---

## 14. Operational quick-reference

### Reprocess a single call
```bash
curl -X POST 'https://waves-customer-portal-production.up.railway.app/api/admin/call-recordings/process/CA<sid>?force=true' \
  -H 'Authorization: Bearer <admin-jwt>'
```

### Reprocess all pending
```bash
curl -X POST 'https://waves-customer-portal-production.up.railway.app/api/admin/call-recordings/process-all' \
  -H 'Authorization: Bearer <admin-jwt>'
```

### Regenerate synopsis only
```bash
curl -X POST '.../api/admin/call-recordings/synopsis/CA<sid>' \
  -H 'Authorization: Bearer <admin-jwt>'
```

### Verify Studio Flow contract (drift check)
```bash
npm run twilio:flow:verify
```

### Re-export Studio Flow snapshot after Console edit
```bash
npm run twilio:flow:export
git add ops/twilio/ docs/twilio-studio-flow-contract.md
git commit -m "docs(twilio): update Studio Flow snapshot to revision N"
```

### Inspect recent call_log rows from local
```bash
DATABASE_URL=$DATABASE_PUBLIC_URL railway run -s Postgres psql -c "
  SELECT twilio_call_sid, processing_status, transcription_status,
         from_phone, to_phone, lead_quality,
         (ai_extraction->>'first_name') as first_name,
         (ai_extraction->>'wants_estimate')::boolean as wants_estimate,
         created_at
  FROM call_log
  WHERE recording_url IS NOT NULL
  ORDER BY created_at DESC LIMIT 20;
"
```

---

## 15. Files referenced in this audit

| Layer | File |
|---|---|
| Studio Flow contract | `docs/twilio-studio-flow-contract.md` |
| Studio Flow snapshot | `ops/twilio/studio/waves-inbound-all-numbers.snapshot.json` |
| Studio export/verify scripts | `scripts/twilio/export-studio-flow.js`, `scripts/twilio/verify-studio-flow-contract.js` |
| Webhook handler | `server/routes/twilio-voice-webhook.js` |
| Webhook signature middleware | `server/middleware/twilio-signature.js` |
| Spam middleware | `server/middleware/spam-block.js` (referenced) |
| Phone normalization | `server/utils/phone.js` |
| Number config | `server/config/twilio-numbers.js` |
| ET datetime utils | `server/utils/datetime-et.js` |
| Locations | `server/config/locations.js` |
| **Processor (heart)** | `server/services/call-recording-processor.js` |
| Twilio service (SMS) | `server/services/twilio.js` |
| Conversations dual-write | `server/services/conversations.js` |
| Stripe customer | `server/services/stripe.js` |
| Automation enroll | `server/services/automation-runner.js` |
| Logger | `server/services/logger.js` |
| CSR coach | `server/services/csr/csr-coach.js` |
| Model registry | `server/config/models.js` |
| Admin recordings route | `server/routes/admin-call-recordings.js` |
| Admin UI panel | `client/src/pages/admin/CallRecordingsPanel.jsx` |
| Call log tab UI | `client/src/pages/admin/CallLogTabV2.jsx` |
| Call bridge link | `client/src/components/admin/CallBridgeLink.jsx` |
| Cron (processAllPending) | `server/index.js:577–587` |
| Route mounts | `server/index.js:67, 82, 311, 327` |
| Schema (initial) | `server/models/migrations/20260401000039_ai_assistant.js` |
| Schema (recording proc) | `server/models/migrations/20260401000059_call_recording_processing.js` |
| Schema (call_log proc) | `server/models/migrations/20260401000090_call_log_processing.js` |
| Schema (lead synopsis) | `server/models/migrations/20260414000001_call_log_lead_synopsis.js` |
| Schema (disposition) | `server/models/migrations/20260413000001_call_log_disposition.js` |
| Schema (bridge tracking) | `server/models/migrations/20260420000001_call_log_bridge_tracking.js` |
| Schema (E.164 backfill) | `server/models/migrations/20260428000003_backfill_call_log_to_phone_e164.js` |
| Schema (processing_token) | `server/models/migrations/20260428000010_call_log_processing_token.js` |
| Schema (validation cols) | `server/models/migrations/20260429000010_call_log_enrichment_validation_columns.js` |
| Discovery doc | `docs/call-triage-discovery.md` |

---

*End of audit. Repo HEAD: `6cc8461 fix(admin): stop dashboard/customers/schedule HTTP 429 errors (#577)` on `main`, current working branch `feat/waveguard-equipment-systems-calibrations`.*
