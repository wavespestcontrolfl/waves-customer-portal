# Call recording & call intelligence — audit and expansion (2026-09-01)

Scope: the inbound/outbound call pipeline from the Twilio webhooks to the
admin Calls tab, on `origin/main` at `f84bc2a55`. This document is the
current-state map, the ranked findings, what this change set fixed, the new
commitments slice, and what was deliberately left.

Everything below was verified by reading the code on that commit and by the
tests named in each section. Where something could not be verified (prod
data, live providers) it says so.

## 1. Current-state map

### Lifecycle, with the file that owns each step

| # | Step | Where |
|---|---|---|
| 1 | Inbound call → TwiML | `server/routes/twilio-voice-webhook.js` `POST /voice` (`:665`). Inserts the `call_log` row under `pg_advisory_xact_lock(hashtext(CallSid))`; the only webhook with an idempotency claim (`inbound_webhook_events`). |
| 2 | Signature validation | `server/middleware/twilio-signature.js` — every Twilio mount in `server/index.js` (`:652-684`) is wrapped; default mode `enforce`. `/api/webhooks/voice-agent` uses its own bearer auth by design. |
| 3 | Call status | `POST /call-status` (`:1835`) — updates `status`/`duration_seconds`; inbound fallback insert when Studio bypassed `/voice`; schedules `recoverRecordingForCall` + the missed-call bell. |
| 4 | Recording available | `POST /recording-status` (`:1327`) — attaches `recording_url/sid/duration`, schedules the 2-minute early attempt and the 10-minute fallback (in-memory timers; the 5-minute cron is the restart-safe backstop). |
| 5 | Twilio built-in transcription (voicemail `<Record transcribe>`) | `POST /transcription` (`:1595`) — fallback text + PAN scrub/quarantine. |
| 6 | Sweep | `services/scheduler.js:5546` every 5 min: `recoverMissingRecentRecordings()` then `processAllPending()` (`call-recording-processor.js:15270`, eligibility predicate + `LIMIT 20`, newest first). |
| 7 | Claim | `processRecording` (`call-recording-processor.js:6248`): one conditional `UPDATE` sets `processing_status='processing'`, a random `processing_token`, `processing_generation+1`, `processing_started_at`, `processing_heartbeat_at`. Reclaim predicate `reclaimableClaim()` (`:2006`): a beat older than the claim is a previous pass's; quiet 10 min (automatic) / 3 min (operator or force). Heartbeat every 60 s, token-fenced. |
| 8 | Download + verify | `downloadRecording` (`:4847`), `verifyRecordingBuffer` (`:4818`): 120 s timeout, 404 inside the 60-min propagation window → `recording_not_ready` release with the pre-claim status restored; MP3 frame-header duration must cover ≥90 % of the known duration. Whole file held in memory (no temp files). |
| 9 | Transcription | OpenAI `gpt-4o-transcribe-diarize` → Gemini fallback → Twilio built-in text; speaker relabel pass; contact-dictation second pass; PAN scrub + quarantine; hallucination guard (`isImplausibleTranscript`). Persisted: `transcription`, `transcript_structured` (segments with `index/speaker/start_ms/end_ms/text`), provenance columns. |
| 10 | Extraction | V1 legacy flat (`extractCallData`, Gemini, no schema) → `ai_extraction`; V2 (`extractCallDataV2`, gpt-5.6-sol primary, Claude fallback, ajv-validated against `server/schemas/call-extraction.*.schema.json`, `SCHEMA_VERSION 1.10.0`) → `ai_extraction_enriched`, `v2_extraction_status`. V2 drives routing in prod (`CALL_EXTRACTION_V2_DRIVES_ROUTING=true`). |
| 11 | Resolution | customer (phone + name rules), lead mint/reuse (`findReusableCallLead`), property lookup, address validation/recovery, appointment (`findExistingCallAppointment`, catalog-anchored), consent-gated SMS. |
| 12 | Synopsis, CSR score, disposition | `generateLeadSynopsis` (Claude FLAGSHIP), `csr-coach.scoreCall` (ownership re-checked before its insert), `decideDisposition` → `call_log.disposition`. |
| 13 | Finalization | token-fenced write of `processing_status` (`processed` / `customer_creation_failed` / `lead_creation_failed`), `review_status`, attribution markers, and (new) `metadata.processing_timings`. |
| 14 | Admin | `server/routes/admin-call-recordings.js` (list, process, process-all, synopsis, disposition, audio proxy with Bearer auth and no query strings) + `server/routes/ai-assistant.js` `GET /admin/calls` (the Calls tab list). UI: `client/src/pages/admin/CallLogTabV2.jsx` at `/admin/communications#tab=calls`. `CallRecordingsPanel.jsx` is unrouted dead code. |
| 15 | Monitoring | `call-ingest-watchdog` (Twilio ledger vs call_log, 30 min), `call-processing-stall-watchdog` (7 min, heartbeat-aware, per-day dedupe, ceiling from `utils/claim-ceiling.js`), `unrecorded-call-watchdog` (rides the recovery sweep), `call-booking-miss-watchdog`, `call-log-relink` (hourly retro-link). All gates ON in prod. |

### Status values (`call_log.processing_status`, free-form varchar, no CHECK)

`NULL`/`pending` → `processing` → one of: `processed`, `voicemail`, `spam`
(completed; `processed` is the only one a non-force pass refuses to re-enter),
`no_transcription` and `extraction_failed` (retry lanes: the sweep re-enters
them, `extraction_failed` up to `CALL_EXTRACTION_MAX_ATTEMPTS`=3 within 7
days, then a blocking triage card), `customer_creation_failed` and
`lead_creation_failed` (terminal failures, no automatic re-entry; both now
open `review_status` and file a card — before this change only the lead one
did).

### Tables

`call_log` (partial unique on `twilio_call_sid`; no uniqueness on
`recording_sid`; `processing_*` claim columns; no `lead_id` column — the
lead link is `metadata->>'lead_id'`), `triage_items` (partial unique on open
`(call_log_id, reason_code)`), `route_decisions`, `customer_field_candidates`,
`csr_call_scores`, `ai_follow_up_tasks`, `call_spam_verdicts`,
`bridge_ambiguous_calls`, `ad_service_attribution.source_call_id`, and (new)
`call_commitments`.

## 2. Findings

Severity: **C** critical, **H** high, **M** medium, **L** low. "Fixed" means
in this change set with the named test.

| ID | Sev | Finding | Evidence / failure sequence | Impact | Fixed |
|---|---|---|---|---|---|
| F1 | H | `/recording-status` applied every delivery as a blind overwrite of `recording_url/sid/duration` and reset `transcription_status='pending'`. | `twilio-voice-webhook.js:1332-1376` (pre-change). Twilio retries after a webhook timeout (the 2026-08-29 pool-exhaustion 502s); the ring-first flow emits a second recording for the same CallSid. A second RecordingSid after `processed` swapped the audio out from under the transcript/extraction; `processRecording` then skipped the row as `already_processed`, so nothing reconciled it. A same-SID retry left a processed row reading "transcription pending". | Transcript, extraction and evidence quotes no longer match the audio the office plays; misleading status. | Yes — `decideRecordingAttach`: same SID = no-op, different SID on an unprocessed row = replace (superseded recording kept in metadata), different SID on a `processing`/`processed` row = parked in `metadata.additional_recordings` + advisory `additional_recording` review card + one-click adopt. `twilio-voice-recording-callback-idempotency.test.js` |
| F2 | H | Ownership fences missing on the V2 extraction persist, its failure stamp, the voicemail channel stamp, both Twilio-fallback transcript writes, the enriched-blob re-persist, the `ai_extraction` backfill and `ai_validation`. | `call-recording-processor.js` (pre-change `:7052, :7060, :7413, :6744, :6782, :7826, :11657, :14933`) — all `UPDATE … WHERE id` after a provider await. Sequence: pool exhaustion → heartbeat writes fail → after 10 quiet minutes the sweep reclaims → the original worker resumes and overwrites the owner's V2 output/provenance. | Results of one attempt mixed with another's; route decisions made on an extraction the row no longer holds. | Yes — every write fenced on `processing_token`; the stage writes abandon the pass on zero rows; a source contract test keeps it that way. `call-processor-ownership-fences.test.js`, `call-processing-claim-concurrency.test.js` (live PG) |
| F3 | H | Twilio built-in transcription could overwrite the diarized provider transcript. | `/transcription` (`:1649` pre-change) wrote `transcription`/provider/status unconditionally; the voicemail `<Record transcribe>` callback usually lands after the 2-minute early pass has written the OpenAI text. | Displayed transcript ≠ the text extraction ran on; evidence quotes fail to match. | Yes — `builtinTranscriptMayReplace`: fills empty rows, replaces its own text, never displaces a provider transcript; PAN detection still stamps and quarantines. Same test file. |
| F4 | M | `/call-status` rolled a completed call back on a late/retried non-terminal event. | `:1848` wrote `status: CallStatus` with no guard; outbound calls register 4 events in no guaranteed order. `recoverMissingRecentRecordings` and the unrecorded-call watchdog only look at `status='completed'`. | A downgraded row silently leaves the missing-recording sweep. | Yes — `nextCallStatus` monotonic guard. Same test file. |
| F5 | M | `customer_creation_failed` was a terminal state with a log line and nothing else. | `:14961-14967, :15163-15167` pre-change; `lead_creation_failed` opened review + a card, its twin did not; `processAllPending` and the stall watchdog both ignore it. | A real prospect whose customer record failed to save was invisible. | Yes — opens `review_status`, files a `customer_creation_failed` card (`call-routing-gates.js`), label in the Triage inbox. |
| F6 | M | `customer_interactions` timeline insert was per-pass, not per-call. | `:14505` pre-change; every deliberate Reprocess added another "Inbound call" row to the customer timeline. | Duplicate timeline entries. | Yes — keyed on `metadata.call_log_id`, existing entry left alone. |
| F7 | M | No stage timings, no failure/stall counts in `getStats`. | `getStats` (`:15677`) reported pending/processed/voicemail/spam only. | Cannot answer "which stage is slow", "how many are failed vs retrying", "how old is the oldest unfinished call". | Yes — `metadata.processing_timings` stamped at finalization; `getStats` adds processing, stalled_claims, failed, retrying, review_open, parked_recordings, oldest_unfinished_minutes, p50 pass/transcription ms (7d). |
| F8 | M | Human corrections of the customer link did not survive reprocessing. | The pass re-resolves `customer_id` from the transcript and writes it at the Step-4 checkpoint (`:9406`); the phantom guard (`:6550`) can clear it; there was no relink endpoint at all. | The office could not correct a wrong link; a reprocess would undo one. | Yes — `PUT /calls/:id/customer` stamps `metadata.customer_link_override`; the processor seeds the pre-linked customer from it, skips the phantom unlink and the name-mismatch re-resolution, and the checkpoint writes the override back. Limitation: an explicit UNLINK pins the row's link; the pass may still associate side effects with the phone-matched customer (documented, not silently hidden). |
| F9 | L | Unmasked CallSid/RecordingSid and the customer's first name in webhook logs. | `:849, :1082, :1388` pre-change. | Recording identifiers in plaintext logs. | Yes — masked. |
| F10 | M | No unified model of what was promised on a call; four disconnected watchers. | `promised-estimate-watcher.js` (estimate only), `csr-coach` `ai_follow_up_tasks`, the `callback_task_created` disposition label that nothing read, relay crash markers. Nothing represented customer commitments or transcript evidence. | Promises fall through; the office replays recordings. | Yes — §4. |
| F11 | M | The Calls list ships the full `call_log` row (transcripts, V2 blobs, validation payloads) for up to 200–1000 rows. | `ai-assistant.js:362` `SELECT cl.*`. | Payload size and memory on the Calls tab. | No (deferred — the list UI reads `transcription` and `ai_extraction`; trimming needs a UI pass). |
| F12 | L | `processing_status` and `triage_items.reason_code/status` have no CHECK constraint. | migrations `20260401000059`, `20260429000013`. | A typo'd status can ship. | No (deferred — adding a CHECK to a live table needs the prod value set verified first; the credential fetch for a read-only prod query was denied by the permission classifier in this session). |
| F13 | L | The whole MP3 is held in memory across transcription + labeling + the dictation pass; no size cap; no content-type check. | `:4864, :5308`. `verifyRecordingBuffer` rejects non-MP3 bodies via the frame-header check, so an HTML error page cannot pass as audio. | Memory pressure on long calls. | No (deferred; measurable only under load). |
| F14 | L | `generateSynopsis` (manual button) writes `lead_synopsis` with no claim. | `:15662`. Races a live pass's fenced synopsis write. | Last writer wins on a diagnostic column. | No. |
| F15 | L | The reachable Calls tab had no correction UI, no honest processing state (inferred from "has transcript"), no error state on load failure, and no polling. | `CallLogTabV2.jsx:1246-1302, :342`. | Excess manual review; a 500 looks like "no calls". | Partly — the new panel shows the honest state, corrections and evidence; the list's own load error handling is unchanged. |

Not bugs (verified, left alone): the stall watchdog's SLA anchor and
heartbeat/ceiling logic (`utils/call-timeline.js`, `claim-ceiling.js`) hold up
under the scenarios in `call-processing-stall-watchdog.test.js`; the claim is a
correct mutex on live Postgres (F2's test proves two concurrent attempts
resolve to one claim and one refusal); the audio proxy refuses query strings
and never exposes the Twilio URL; PAN quarantine survives every ordering.

## 3. Changes implemented

Per file, with the proving test.

- `server/routes/twilio-voice-webhook.js` — F1, F3, F4, F9. New pure helpers
  `decideRecordingAttach`, `nextCallStatus`, `builtinTranscriptMayReplace`,
  `isPanQuarantinedRow`, `parkAdditionalRecording`. Test:
  `server/tests/twilio-voice-recording-callback-idempotency.test.js` (drives
  the real handlers with an in-memory call_log).
- `server/services/call-recording-processor.js` — F2, F5, F6, F7, F8, plus the
  commitments step (7c) and stage timings. Tests:
  `call-processor-ownership-fences.test.js` (source contract),
  `call-processing-claim-concurrency.test.js` (live Postgres: two concurrent
  attempts, stale-heartbeat reclaim + superseded worker's write matches no
  rows, operator vs automatic quiet windows),
  `admin-call-recordings-process-conflict.test.js` (claim-ceiling mirror).
- `server/services/call-routing-gates.js` — `additional_recording` and
  `customer_creation_failed` flags; `client/src/pages/admin/TriageInboxTabV2.jsx`
  labels for both plus `lead_creation_failed`.
- `server/utils/claim-ceiling.js` — counts the commitments leg (7 extraction
  legs).
- `server/services/call-commitments.js`, `server/services/call-intelligence.js`,
  `server/models/migrations/20260901000010_call_commitments.js`,
  `server/config/feature-gates.js` (`callCommitments`), `server/routes/admin-call-recordings.js`
  (5 endpoints) — §4. Tests: `call-commitments.test.js` (pure),
  `call-commitments-db.test.js` (live Postgres), `call-intelligence.test.js`,
  `admin-call-recordings-intelligence.test.js`.
- `client/src/components/admin/CallIntelligencePanel.jsx` + mount and
  evidence highlight in `CallLogTabV2.jsx`. Test:
  `CallIntelligencePanel.test.jsx` (vitest).
- `CLAUDE.md` — `GATE_CALL_COMMITMENTS` documented.
- Pre-push Codex round (3 P1s, all fixed in the same PR): the recording
  `replace` write re-checks that no pass claimed the row since the read and
  parks the recording if one did (race test in the webhook suite); office-
  entered due times are parsed as Eastern (`parseDueAt`, and the panel sends
  instants via the client ET helper); adopting a parked recording sets the
  row back to NULL status and resolves its review card only when the
  reprocess actually completes (a deferred pass leaves the card open and the
  row queued for the sweep).
- Pre-push Codex rounds 2–3 (5 P1s, all fixed): a first attach refused by a
  competing callback is re-decided (two-round loop, park on the second
  refusal) so no RecordingSid is dropped; fulfillment marks a promise kept
  only from a record directly linked to the call and stores same-customer
  matches (14-day window) as hints; a replace resets `processing_status` to
  NULL in the same write so the sweep re-runs voicemail/spam rows on the new
  audio; `completed` is absorbing against late busy/failed/no-answer leg
  callbacks; the commitments prompt names the company as "Waves Pest Control".
- Pre-push Codex round 4 (3 P1s, all fixed): the Step-4 customer checkpoint
  reads the operator link INSIDE the write (a jsonb CASE, proven on live
  Postgres) so a relink made mid-pass is honoured, and the phantom unlink
  never clears one; adopting a parked recording is fenced to the recording
  it read and to the parked entry itself; commitments are recorded after
  finalization, fenced on the pass generation, so the deterministic callback
  seed sees the settled disposition.
- Pre-push Codex round 5 (1 P1, fixed): the direct estimate proof requires
  `sent_at` after the call (a reused lead can carry an older estimate).
- Pre-push Codex round 6 (1 P1, fixed): the kinds a call can carry more than
  once (send_report, send_paperwork, provide_info, other) key on a
  description slug as well, so two distinct promises keep their own rows.

## 4. The vertical slice: evidence-backed commitments and next actions

**Data.** `call_commitments` — one row per (call, commitment identity — party:kind, plus a description slug for the repeatable kinds):
`party` (waves|customer), `kind` (13 CHECK-constrained kinds), `description`,
`channel`, `due_at` + `due_basis` (stated|suggested), `confidence`,
`evidence` (verbatim quotes with speaker, pinned to a diarized segment index
and timestamps when the OpenAI segments exist, or to a character offset,
or marked unmatched — never relocated), `source` (ai|human),
`processing_generation` / `last_seen_generation` / `extractor_version`,
`status` (open|fulfilled|dismissed), `fulfillment` (kind, record type/id,
basis, matched_at), `human_state` (confirmed|dismissed|edited), `human_note`,
`reviewed_by/at`. Unique on `(call_log_id, commitment_key)`.

**Extraction** (`services/call-commitments.js`, step 7c of the pass, gated by
`GATE_CALL_COMMITMENTS`):
1. Deterministic seeds from the V2 extraction the pipeline already has:
   `quote_promised` → send_estimate; a confirmed slot → send_appointment_confirmation;
   a callback window or disposition → callback (due = the stated window);
   `follow_up_mentioned` → technician_follow_up. Evidence = the V2 quotes
   already pinned to those fields. No new prompt hash, no cohort reset.
2. One bounded Claude FLAGSHIP pass over the labeled transcript for the kinds
   V2 cannot express (send report/paperwork, customer sends photos / confirms
   a date / calls back / provides info / pays). Output is ajv-validated;
   every quote is re-grounded against the transcript text and a commitment
   with no verbatim evidence is dropped, never stored; confidence < 0.5 is
   dropped. Timeout = `CALL_PROC_EXTRACT_TIMEOUT_MS`, `maxRetries: 0`,
   counted in the claim ceiling.
3. Upsert under the claim: the write takes a SHARE lock on the call_log row
   with the token fence, so a superseded pass writes nothing and a claim
   cannot move mid-write. `ON CONFLICT DO UPDATE` rewrites a row only while
   `human_state IS NULL AND source='ai'`; every seen row gets
   `last_seen_generation` so the UI can say "not detected on the latest pass"
   instead of deleting it.

**Fulfillment** (`refreshFulfillment`, run on read): two strengths of proof.
*Direct* — a later record linked to this call (a `scheduled_services` row
with `source_call_log_id` = this call, the estimate on the lead this call
minted, the invoice for that visit) — marks the open AI row fulfilled.
*Association* — a record that merely belongs to the same customer or phone
within 14 days (a `confirmation` text to the caller, a completed outbound
call ≥20 s, an inbound message with media, a customer estimate/visit/invoice)
— is stored as a hint (`fulfillment.strength = association`) with the status
left open; the panel shows "Possibly kept … confirm with Mark done". Each
match carries its `basis` string. Human verdicts are never overridden.

**Admin API** (`admin-call-recordings.js`): `GET /calls/:id/intelligence`
(staff), `POST /calls/:id/commitments`, `PATCH /commitments/:id`
(confirm|dismiss|fulfill|reopen|edit), `PUT /calls/:id/customer`,
`POST /calls/:id/adopt-recording` (admin). IDs are validated before any query.

**Office workflow.** In Communications → Calls, expand "Call intelligence"
under a call: read the summary and the honest state (queued / processing /
complete / failed and why), see the next action with its owner and due time,
check each commitment against the words ("Jump" opens and highlights the
quote in the transcript), Confirm / Mark done / Dismiss / Edit, add one the AI
missed, see whether it was kept and by which record, repoint the customer
(shown as "set by office" from then on), and adopt a recording that arrived
late. Nothing on the panel sends a customer message.

**Normalized intelligence object** (`services/call-intelligence.js`):
outcome, intent, caller, property, appointment, prices (with
`quote_type`: price mentioned / estimate to follow / recurring plan price),
objections, buying signals, triage flags, confidence, anchored evidence,
commitments, next_action, later outcomes (lead, estimates, visits, invoices,
paid revenue — each with a `basis` naming direct linkage vs association),
links (customer link with source generated|human, who, when, previous),
recordings (current / parked / superseded), processing (phase, detail,
retryable, generation, prompt/model versions, timings, schema errors), and
the transcript segments for jumps.

## 5. Database changes

- `20260901000010_call_commitments.js` — creates `call_commitments` with the
  CHECK constraints above, the `(call_log_id, commitment_key)` unique, a
  `call_log_id` index and a partial open-queue index. `down` drops the table.
  No backfill; no existing rows change. Applied, rolled back and re-applied
  on the local `waves_portal` copy (batch 5). Deployment ordering: the
  migration runs pre-deploy on Railway; the gate is off, so the table sits
  empty until `GATE_CALL_COMMITMENTS=true`.
- No changes to existing columns or constraints. `metadata` jsonb gains
  keys: `processing_timings`, `superseded_recordings`, `additional_recordings`,
  `adopted_recording`, `customer_link_override`.

## 6. Verification

See the PR body for the command list and results at the final commit.
Locally: the 9 voice-webhook suites (150 tests), the 58 processor-scoped
suites (1,976 tests), the new suites above, the two live-Postgres suites
against the migrated local database, vitest for the panel and the Calls tab,
eslint on every touched file, `check:portal-brand`, `check:domain-rules`.
Not verified: live Twilio, live providers (all provider legs are stubbed),
prod data (read-only prod access was denied by the session's permission
classifier; F12 stays deferred for that reason).

## 7. Remaining work

Confirmed, lower priority: F11 (list payload), F12 (CHECK constraints — needs
the prod value set), F13 (streaming download / size cap), F14 (synopsis
button claim), the `voicemail_callback_alerted_at` CAS is its own fence by
design. Product: a queue view of open commitments across calls (the partial
index exists), commitment rows for relay (Sandy) calls (they bypass
`processRecording` by design), an explicit-unlink that also suppresses
phone-based re-association during a pass. Blocked: prod read-only evidence
for status distributions and duplicate `recording_sid` rows. Policy: none.
