---
title: AI Call Triage — Discovery + Strategy v2
status: implementation contract (post-ChatGPT review)
date: 2026-04-29
author: Claude Code (Opus 4.7) + Adam + ChatGPT review
---

# AI Call Triage — Discovery + Strategy v2

> **Read this if you have 60 seconds.**
> The naive prompt asks Claude Code to "build a call-triage pipeline." ~80% of that pipeline is already shipping (Twilio webhooks → Gemini extraction → routing into customers/estimates/appointments + SMS confirmations). The actual gap is **silent hallucinations writing to canonical customer/appointment data with no audit and no second-source check**. Strategy v2 inserts a deterministic enrichment layer (Google **Address Validation** API, behind a provider abstraction) and an evidence-based Anthropic validation layer between the existing Gemini extraction and the existing routing branches, plus an outbox for SMS, a `route_decisions` immutable record, a `customer_field_candidates` staging table, a `triage_items` review queue (decoupled from `scheduled_services.status`), Twilio signature validation across all 5 webhooks, and an FL-consent recording disclosure fix in the inbound greeting. Phased across 4 reversible PRs.

---

## Part A — Discovery (evidence)

### 1. Existing pipeline (DO NOT rebuild)

| Layer | File | Notes |
|---|---|---|
| Inbound voice webhook | `server/routes/twilio-voice-webhook.js:51` | Answers, enables `<Dial record>`, logs to `call_log`. Greeting at line 153 has **no recording/AI disclosure** — fix in PR1. |
| Recording-status callback | same file:212 | Updates `call_log.recording_url/sid`, schedules processor 10 min later (CDN propagation). ParentCallSid handling for forwarded legs. |
| Transcription callback | same file:302 | Twilio's built-in transcription → `call_log.transcription`. ParentCallSid handling. |
| Call-status callback | same file:460 | Outbound + Studio fallback. Advisory-lock per CallSid for retry serialization. |
| Call-complete callback | same file:169 | Voicemail fork at line 192 plays `WAVES_VOICEMAIL_URL` (opaque content) + `<Record transcribe="true">` — **no inline disclosure**. |
| Extraction | `server/services/call-recording-processor.js:103` | `gemini-2.5-flash`, temp 0.2, `response_mime_type: 'application/json'`. Output → `call_log.ai_extraction` (jsonb). Prompt at line 108–149 (verbatim in original §3 audit). |
| Synopsis | same file:184+ | Anthropic `MODELS.FLAGSHIP` → `call_log.lead_synopsis`. |
| Routing — estimate | same file:619 | Gates on `customerId && wants_estimate && !spam && !voicemail`. Always `status='draft'`. 24h dedupe. Low-risk path. |
| Routing — appointment | same file:685 | Gates on `appointment_confirmed && preferred_date_time && customerId && hasSpecificTime` (regex at line 687). **High-risk path: real `scheduled_services` row + SMS confirmation.** |
| Routing — customer upsert | same file:400+ | Phone-keyed match (last 10 digits). Updates only-null fields on existing rows. **No audit log.** |
| Concurrency fence | `call_log.processing_token` (varchar 32) | Prevents double-processing. |
| Admin UI | `client/src/pages/admin/CommunicationsPageV2.jsx` (tab) → `CallLogTabV2.jsx` + `CallRecordingsPanel.jsx` | Transcript, sentiment, manual disposition, audio JWT-proxy, bulk reprocess. |

### 2. Existing Anthropic SDK pattern (mirror)

`server/services/lawn-assessment.js` is the canonical wrapper template. 45 files use `@anthropic-ai/sdk`; pattern is direct `new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })`, model from `server/config/models.js` (`MODELS.FLAGSHIP` etc — **never hardcode model IDs** per CLAUDE.md), errors → `logger.error()` → return null/fallback, never throw. **No prompt caching, no tool use, no retry loops, no token logging in current code.** Strategy v2 upgrades the validator to use **structured outputs / strict tool use** (Anthropic native), not the markdown-fence-strip hack.

### 3. Production data audit (n = 422 call_log rows; 117 `processing_status='processed'`)

**Field null rates on processed rows:**

| Field | Null count / 117 | Null rate |
|---|---|---|
| `first_name` | 33 | 28% |
| `last_name` | 55 | 47% |
| `email` | 81 | 69% |
| `phone` | 0 | 0% (prompt forces fallback to caller phone) |
| `address_line1` | 75 | 64% |
| `city` | 72 | 62% |
| `zip` | 95 | 81% |
| `requested_service` | 21 | 18% |
| `matched_service` | 37 | 32% |

`appointment_confirmed=true`: 21/117 (18%). `wants_estimate=true`: 6/117 (5%). Lead quality: 43 hot / 42 warm / 29 cold.

**Hallucination signals on processed rows:**

| Signal | Count | Rate | Verdict |
|---|---|---|---|
| `appointment_confirmed=true` AND `preferred_date_time IS NULL` | 2 | 1.7% | Definitive prompt-rule violation (existing `hasSpecificTime` regex catches it before routing) |
| Last name extracted but absent from transcript | 4 | 3.4% | Confirmed hallucinations: `Sperrydas`, `Mueller`, +2 |
| Address present but city NULL | 9 | 7.7% | Likely partial hallucination |
| First name absent from transcript | 0 | 0% | Strong grounding |
| ZIP malformed | 0 | 0% | Format always clean |
| Address first-token absent from transcript | 1 | 0.85% | Strong grounding |
| Email user-part absent from transcript | 27 | 23% | False positive — most are spelled-out emails ("R-I-C-J-U-D-I-T") |

**Blast radius:** 27 distinct appointments auto-created within 2h of a `processed` call. 1 estimate auto-queued in same window (rare path). Customer-row writes: 55 of 117 processed calls touched `customers` (47%) — this is the silent-pollution surface.

### 4. Phone normalization

Two divergent functions today: `server/services/lead-attribution.js:normalizePhone` and `server/routes/twilio-voice-webhook.js:toE164` (file:33). Consolidating into `server/utils/phone.js` in PR1.

---

## Part B — Strategy v2

### 5. Pipeline order (load-bearing)

```
Gemini extract  →  Deterministic enrich  →  Anthropic validate  →  Routing gate  →  Side effects (via outbox)
```

Order is non-negotiable. If enrichment runs after validation, the validator green-lights `"Greendale Dr, null, null, null"` → enrichment "fixes" it to a Sarasota address the caller never said → silent hallucinated city in the customer table. Validator must see the enriched record so it can flag enrichment-induced **changes** (mishearing/hallucination signal) vs. completing **nulls** (acceptable).

**No LLM in the enrichment layer.** Adding one re-introduces the hallucination class the validator exists to catch.

### 6. Address validation (Google Address Validation API behind a provider abstraction)

Places Text Search is the wrong tool for residential service addresses. `partialMatch` is a Geocoding-era field that does not exist on Places v1, and Places is optimized for "find a place from text" — a different problem from "validate that this is a real, deliverable, in-service-area address with confidence." Switching to Google **Address Validation API** because it exposes exactly the signals routing needs:

`addressComplete`, `validationGranularity`, `hasInferredComponents`, `hasReplacedComponents`, `hasUnconfirmedComponents`, `missingComponentTypes`, `unresolvedTokens`, plus per-component flags `inferred / spellCorrected / replaced / unexpected`.

**Provider abstraction (mandatory):**

```js
// server/services/address-validation/index.js
class AddressValidationProvider {
  validate({ raw_address_text, region_code='US' }) -> ValidationResult
}
```

`ValidationResult` exposes provider-neutral fields. Routing code never imports Google-specific shape. Swap to Smarty/Melissa/Loqate later by writing a second provider.

**Persistence on every result:**

```
provider                  -- 'google_av' for v1
provider_response_id      -- AV `responseId`
validation_version        -- our schema version (bump on routing-rule changes)
validated_at              -- timestamp
expires_at                -- validated_at + 30 days
```

**Cost note (corrected from the prior draft):** Google Address Validation Pro is **$17/1k calls** after the first 5,000 free monthly; Enterprise is **$25/1k** after 1,000 free monthly. (The earlier "~$5/1k" figure was a stale Geocoding/Places Essentials number — wrong tier.) At Waves' current ~5–7 inbound/day volume, the free tier covers all production use; cost only matters if we backfill historical transcripts (one-time ~117 calls).

**CASS:** disabled by default, behind feature flag.

```
ADDRESS_VALIDATION_ENABLE_CASS=false
```

For pest/lawn service the operative question is "can a tech pull up to this property" not "USPS-deliverable mail." Reserve CASS for future billing/mailing/manual-recheck workflows. Never gate auto-create on CASS.

**Service-area enforcement (post-process, deterministic):**

If `address_components.administrative_area_level_2` ∉ {Manatee, Sarasota, Charlotte, DeSoto} → `address_status='out_of_service_area'`. Veto-class.

**Routing-relevant address statuses (replaces the simple `enrichment.status`):**

```
not_provided
caller_complete_unvalidated_existing_customer_match
validated_accept                          -- AV granularity ≥ PREMISE, no inferred/replaced material components
validated_confirm_needed                  -- AV granularity = SUB_PREMISE/ROUTE, or unconfirmed components
missing_required_component                -- missingComponentTypes contains street_number/route/postal_code
inferred_material_component               -- AV inferred a street_number/route/locality/postal_code
replaced_material_component               -- AV replaced a caller-stated material component (mishearing/hallucination)
ambiguous                                 -- multiple plausible matches OR unresolvedTokens present
out_of_service_area                       -- county not in service set
api_unavailable                           -- AV unreachable, AV quota, or transient error
```

**Routing rule:** auto-create paths require `address_status ∈ {validated_accept, caller_complete_unvalidated_existing_customer_match}` AND no material caller-stated component was replaced. All others → `triage_items`.

**What we do NOT route on:** `possibleNextAction`. Google flags it preview/pre-GA and explicitly says it is not a guarantee of accuracy or deliverability. Use only the concrete fields enumerated above.

**Boot check (fail loudly, not at 6am):**

At process start, fire a known-good Address Validation lookup against the Lakewood Ranch office (`9040 Town Center Pkwy, Lakewood Ranch, FL 34202`). On `PERMISSION_DENIED` / `REQUEST_DENIED` / 403, log clearly and exit non-zero. Geocoding-API-working does NOT prove Address-Validation-API-enabled — separate Cloud Console toggle, separate billing SKU, separate per-tier free quota.

**Caching (compliance-aware):**

NO global address cache keyed by MD5(normalized_address). Google's Service Specific Terms scope Address Validation cached content to "downstream use… associated with a particular end user's account," with a 30-day cap and replacement on customer-confirmed/corrected data. Storage model:

| What | Where | TTL |
|---|---|---|
| Caller-stated raw address text from transcript | `call_log.ai_extraction.address_*` (existing) | Permanent |
| Google-derived `formattedAddress`, `addressComponents`, AV component flags, `placeId`, lat/lng | `call_log.ai_extraction_enriched` (new jsonb) AND `customer_field_candidates` rows | Logical TTL via `expires_at`; row stays for audit but routing code refuses to use Google-derived values where `now() > expires_at` |
| Customer-confirmed final address | `customers.address_*` (existing canonical) | Permanent |
| Place ID | Permitted indefinitely per Maps T&C | Permanent |

A nightly cleanup job soft-purges expired Google-derived values from candidates not yet promoted (sets the field to `null` while keeping the row's audit metadata). Tested with a fixture that proves expired values are not consumable by the routing path.

**Tech debt (tracked):** existing `server/services/geocoder.js` is on the legacy Geocoding API. Migrate to AV in a follow-up PR. Both call the same Cloud project; quotas are independent.

### 7. Names, email, phone (deterministic, no LLM)

| Transform | File | Notes |
|---|---|---|
| `properCase(name)` | `server/utils/name-case.js` (new) | Title-case + Mc/Mac/O'/D'/hyphen/particles (van, de, del, di, la). Unit-tested. |
| `lowercase(email)` | inline | RFC says local-part is technically case-sensitive; in practice no provider treats it that way → prevents `Bob@x.com` vs `bob@x.com` duplicates. |
| `toE164(phone)` | `server/utils/phone.js` (new) | Consolidates `lead-attribution.js:normalizePhone` + `twilio-voice-webhook.js:toE164`. Existing call sites updated in PR1. |

### 8. Validator (Anthropic, evidence-based, structured outputs)

LLM self-confidence is not calibrated. A "0.87" looks scientific but is a model-generated number. Strategy v2 produces **booleans + evidence quotes** as primary; numeric `field_confidence` is retained only as secondary telemetry.

**Schema (validated server-side via Zod):**

```ts
{
  fields: {
    [field_name]: {
      gemini_value: any,
      enriched_value: any | null,
      supported_by_transcript: boolean,
      contradicted_by_transcript: boolean,
      evidence_quote: string | null,        // verbatim transcript span
      reason_code: 'present' | 'spelled_out' | 'partial_match' | 'inferred_from_caller_id'
                 | 'not_present_in_transcript' | 'contradicted'
                 | 'enrichment_completed_null' | 'enrichment_replaced_caller_value',
      recommended_action: 'eligible' | 'do_not_write' | 'review' | 'overwrite_with_existing',
      field_confidence: number,             // 0..1 — telemetry only, NOT a routing input
    }
  },
  global_vetoes: [
    { code: 'address_replaced_material_component'
         | 'address_inferred_material_component'
         | 'address_out_of_service_area'
         | 'address_ambiguous'
         | 'name_likely_misheard'
         | 'duplicate_call_group'
         | 'past_or_unresolved_datetime'
         | 'service_unknown'
         | 'customer_field_conflict',
      severity: 'block_auto_create' | 'block_field_write',
      explanation: string }
  ],
  routing_recommendation: 'auto_create_appointment' | 'auto_queue_draft_estimate'
                        | 'upsert_customer_only' | 'needs_review',
  prompt_version: string,                    // 'call-validation.v1'
  schema_version: string                     // bumped on shape change
}
```

**Implementation:** Anthropic native structured outputs / strict tool use (not prompt-only JSON + markdown-fence-strip). Server-side Zod parse on top. Prompt lives at `server/services/prompts/call-validation.v1.txt` — versioned filename so we can bump without overwriting. Reuse the `lawn-assessment.js` wrapper structure (errors → `logger.error()` → null fallback).

**Routing consumes deterministic booleans, never raw confidence:**

```js
if (!field.supported_by_transcript) { /* do not write field */ }
if (field.reason_code === 'not_present_in_transcript') { /* do not write field */ }
if (global_veto.severity === 'block_auto_create') { /* needs_review */ }
```

### 9. Routing gates (per route, post-validator)

```text
AUTO_CREATE_APPOINTMENT — all of the following:
  appointment_confirmed = true
  preferred_date_time   supported_by_transcript=true
  preferred_date_time   is specific (existing hasSpecificTime regex)
  preferred_date_time   is future, timezone-resolved to America/New_York
  matched_service       supported_by_transcript=true
  phone                 trusted (Twilio From OR explicit caller-stated callback)
  address_status        IN ('validated_accept', 'caller_complete_unvalidated_existing_customer_match')
  no global veto with severity 'block_auto_create'
  no name_likely_misheard
  no duplicate source_call_group_id

AUTO_QUEUE_DRAFT_ESTIMATE — unchanged (drafts already require human send):
  wants_estimate=true AND !spam AND !voicemail
  validation issues attached as notes, not blockers

UPSERT_CUSTOMER_ONLY (per-field, via candidates):
  field is supported_by_transcript=true
  AND existing canonical value is NULL  (never overwrite without conflict resolution)
  AND no field-level veto

NEEDS_REVIEW — any of:
  address inferred/replaced/ambiguous/out-of-area
  name_likely_misheard
  preferred_date_time ambiguous/past/unresolved
  service unknown
  customer field conflict (extracted ≠ existing non-null)
  validator API failure
  duplicate source_call_group_id
```

**First-name auto-write guardrails (data-justified — 0% hallucination across 117 rows, but not a blank check):**

```text
first_name auto-writes ONLY when:
  supported_by_transcript = true
  AND existing customer first_name IS NULL
  AND no customer conflict
  AND no name_likely_misheard veto
  AND no global veto

Even auto-applied first names create a customer_field_candidates row
with status='auto_applied' for full audit trail.
```

`first_name` never silently overwrites a non-null existing value, even with high confidence. Existing-value conflicts always go to triage.

### 10. Customer write staging

Add `customer_field_candidates`. All extraction-derived field writes go here first; canonical `customers` mutations are **promotions** from candidates.

```sql
customer_field_candidates (
  id                     uuid PK,
  call_log_id            uuid FK,
  customer_id            uuid FK NULL,        -- NULL until first promotion
  field_name             varchar,             -- 'first_name', 'address_line1', ...
  extracted_value        text,                -- raw Gemini value
  enriched_value         text NULL,           -- post-deterministic-enrichment
  final_recommended_value text NULL,          -- what the validator+rules say to write
  evidence_quote         text NULL,
  source                 varchar,             -- 'gemini' | 'enrichment' | 'validator' | 'human'
  confidence             numeric NULL,
  reason_code            varchar NULL,
  status                 varchar,             -- 'pending' | 'auto_applied' | 'rejected' | 'human_applied'
  created_at             timestamptz,
  reviewed_at            timestamptz NULL,
  reviewed_by            varchar NULL,        -- admin user
  expires_at             timestamptz NULL     -- for Google-derived values; null for caller-stated
);
```

Promotion rules:

```text
NULL existing field + supported_by_transcript=true + no veto → auto_applied
Existing value matches normalized candidate                  → auto_applied (no-op)
Existing value differs                                       → pending + triage_item
Validator says do_not_write                                  → rejected
```

Single hallucinated call cannot poison a customer profile because every write passes through here.

### 11. Triage workflow (decoupled from `scheduled_services.status`)

DO NOT widen the appointment-status enum. Status describes lifecycle (tentative/confirmed/completed/cancelled/no_show/rescheduled), not workflow state.

```sql
triage_items (
  id                          uuid PK,
  call_log_id                 uuid FK,
  related_customer_id         uuid FK NULL,
  related_estimate_id         uuid FK NULL,
  related_scheduled_service_id uuid FK NULL,
  category                    varchar,    -- 'address_review' | 'name_review' | 'time_ambiguous' | ...
  severity                    varchar,    -- 'blocking' | 'advisory'
  reason_code                 varchar,
  status                      varchar,    -- 'open' | 'in_progress' | 'resolved' | 'dismissed'
  assigned_to                 varchar NULL,
  created_at                  timestamptz,
  resolved_at                 timestamptz NULL,
  UNIQUE (call_log_id, reason_code) WHERE status IN ('open', 'in_progress')
);
```

UI tab on `/admin/communications` (already the calls home). Decision-oriented surface, not raw JSON:

```
For each triage item:
  Caller, call time, audio playback (existing JWT proxy)
  Transcript excerpt + AI synopsis (existing)
  Field diff: transcript → Gemini → enrichment → proposed write
  Evidence quote for each field claim
  Existing customer conflict (if any)
  For address issues: caller-stated vs. AV-suggested, which components
    were inferred/replaced/missing, service-area result, reason auto-create blocked
  Buttons: accept field / reject field / edit value
           create appointment / create draft estimate
           mark spam / mark resolved
```

### 12. Route decisions (immutable audit)

```sql
route_decisions (
  id                              uuid PK,
  call_log_id                     uuid FK,
  source_call_group_id            varchar,            -- ParentCallSid (or CallSid for unforked)
  decision_version                varchar,            -- e.g. 'v1.0', bumped on routing-rule change
  mode                            varchar,            -- 'shadow' | 'enforce'
  validator_recommendation        varchar,
  final_action_taken              varchar,            -- 'auto_create_appointment' | 'needs_review' | 'no_op' | ...
  blocked_reasons                 jsonb,              -- list of veto codes
  allowed_reasons                 jsonb,
  field_write_plan                jsonb,              -- candidates intended to be written
  appointment_write_plan          jsonb NULL,
  estimate_write_plan             jsonb NULL,
  created_customer_id             uuid NULL,
  created_estimate_id             uuid NULL,
  created_scheduled_service_id    uuid NULL,
  sms_enqueued                    boolean DEFAULT false,
  ai_validation_model             varchar,
  ai_validation_prompt_version    varchar,
  ai_validation_schema_version    varchar,
  enrichment_version              varchar,
  created_at                      timestamptz,
  UNIQUE (call_log_id, decision_version, mode)
);
```

Single object answering "why did this happen?" Shadow vs. enforce comparison is a SQL query against this table.

### 13. SMS via outbox (never inside the route transaction)

```sql
outbox_messages (
  id              uuid PK,
  channel         varchar,      -- 'sms' | 'email'
  payload         jsonb,
  status          varchar,      -- 'pending' | 'sent' | 'failed'
  related_*       FK NULLs,
  created_at      timestamptz,
  sent_at         timestamptz NULL,
  attempts        int DEFAULT 0
);
```

The route transaction:
1. Acquires advisory lock on `call_log_id`
2. Inserts `route_decision`, `customer_field_candidates`, optional `estimates`/`scheduled_services` rows
3. Inserts `outbox_messages` row for the SMS confirmation
4. Commits

A worker pulls `outbox_messages` and calls Twilio. Crash between step 2 and Twilio = SMS retried; rollback = no SMS sent (the row never existed). Solves the "DB rolled back but customer already got the text" failure mode.

### 14. Twilio signature validation (all 5 webhooks)

Endpoints requiring validation (currently zero):
- `/api/webhooks/twilio/voice`
- `/api/webhooks/twilio/call-status`
- `/api/webhooks/twilio/call-complete`
- `/api/webhooks/twilio/recording-status`
- `/api/webhooks/twilio/transcription`

Use the official `twilio` npm package's `validateRequest` (already in deps). Reconstruct the public URL using `X-Forwarded-Proto` + host (Railway terminates TLS upstream; `req.protocol` will be `http` and break signature math otherwise). Validate against ALL received parameters, not a hardcoded subset (Twilio rotates fields).

**Mode flag:**

```
TWILIO_SIGNATURE_VALIDATION=log    # log failures, do not reject (default in production for soft launch)
TWILIO_SIGNATURE_VALIDATION=enforce # reject invalid with 403 (staging always; prod after one signed webhook per endpoint is verified in logs)
```

This is a meaningful behavior change — PR1 ships it in `log` mode in production until each endpoint has at least one verified signed webhook in logs, then flips to `enforce` via env var change (no redeploy).

Tests:
- valid signature → pass
- forged signature → reject in enforce, log in log-mode
- missing signature → reject in enforce
- proxied HTTPS request (req.protocol='http' but X-Forwarded-Proto='https') → reconstruct correctly, pass
- new unknown Twilio parameter (forward-compatibility) → still validates

### 15. Recording / transcription / AI disclosure (FL two-party consent)

**Audit findings (2026-04-29, `twilio-voice-webhook.js`):**

| Endpoint | Line | Disclosure status |
|---|---|---|
| `/voice` greeting | 153 | ❌ "Thank you for calling Waves Pest Control. Please hold while we connect you." — no recording/transcription/AI disclosure before `<Dial record>` |
| `/call-complete` voicemail fork | 192–198 | ⚠️ Plays `WAVES_VOICEMAIL_URL` (content not in repo) → `<Record transcribe="true">`. Disclosure status unverifiable from code; must be verified by listening to the audio |
| `/outbound-connect` | 437–442 | ❌ Records customer leg with no disclosure |

**PR1 fix:** add disclosure to inbound `/voice` greeting before the `<Dial>`. Suggested language (have legal bless final wording before merge):

> "Thanks for calling Waves Pest Control. This call may be recorded, transcribed, and processed with AI to help schedule and improve service. By continuing, you consent to this recording and processing."

For `/call-complete` voicemail: confirm the contents of `WAVES_VOICEMAIL_URL`. If disclosure is missing, replace the audio asset OR prepend a `<Say>` disclosure before `<Record>`.

For `/outbound-connect`: prepend a `<Say>` disclosure to the connecting leg before the dial bridges.

Florida statute §934.03 (2025): interception lawful when **all parties** have given prior consent, subject to statutory exceptions. Soft-launching the disclosure pays for itself the first time it matters.

### 16. Calibration & enforcement gating (replaces "15th-percentile of 50 calls")

Numeric percentile cutoffs are too thin for low-frequency, high-cost errors. Process v2:

**Phase 0 — Backfill** (before PR4 merge):
- Re-run validator (shadow mode, populated by PR2) against all 117 historical processed transcripts.
- Output goes to `route_decisions` rows with `mode='shadow'`.

**Phase 1 — Stratified labeling** (before PR4 merge):
- Developer prepares the labeling sheet: pre-fill transcript, Gemini output, enriched output, validator output, highlights fields needing judgment.
- Human (Adam or Virginia) labels business-critical truth: appointment intent, service type, usable address, time ambiguity, customer conflict.
- Required coverage:
  - All known hallucinated last-name cases (4)
  - All partial-address cases (~9)
  - All 27 historical auto-created appointments
  - All weak/ambiguous-time cases
  - Random clean sample (~10)

**Phase 2 — Per-field precision targets** (gating PR4 enforcement):

```
appointment_auto_create:    zero critical false positives across labeled backfill
                            AND zero critical false positives across PR2 shadow
                            AND every actual auto-create has validated address/time/service/contact
first_name auto-write:      ≥99% precision (the data shows 100%; we accept zero regression)
last_name auto-write:       ≥98% precision in labeled set
address_line1 auto-write:   only when address_status='validated_accept' AND no replaced material component
email auto-write:           normalized + supported_by_transcript=true; spelled-out emails accepted via reason_code='spelled_out'
```

PR4 ships only when these are met. If precision misses the bar on any field, that field stays in candidates-only mode and a follow-up PR raises the bar.

---

## Part C — PR plan

Each PR is reversible (single revert restores prior behavior).

### PR1 — Foundation + security/compliance hardening

**No new AI routing behavior** (Twilio signature validation defaults to `log` mode in prod).

Files:
- `server/utils/name-case.js` + `__tests__/name-case.test.js`
- `server/utils/phone.js` (consolidates `lead-attribution.js:normalizePhone` + `twilio-voice-webhook.js:toE164`); update existing call sites
- `server/middleware/twilio-signature.js` (X-Forwarded-Proto-aware, env-flagged log/enforce mode) + tests including proxy mismatch fixture
- Wire signature middleware into all 5 webhook endpoints
- `server/routes/twilio-voice-webhook.js`: add disclosure to `/voice` greeting; verify and fix `/call-complete` voicemail and `/outbound-connect` (PR1 deliverable: disclosure on `/voice` definitely; voicemail and outbound either fixed in PR1 or split out as a follow-up depending on `WAVES_VOICEMAIL_URL` content audit — PR1 ships an audit log entry either way)

Migrations (all reversible — `down()` implemented):
- `<>_call_log_enrichment_validation_columns.js`: add `ai_extraction_enriched` jsonb, `ai_validation` jsonb, `ai_extraction_model` varchar, `ai_extraction_prompt_version` varchar, `ai_validation_model` varchar, `ai_validation_prompt_version` varchar, `ai_validation_schema_version` varchar, `enrichment_version` varchar, `enrichment_status` varchar, `address_status` varchar, `review_status` varchar
- `<>_customer_field_candidates.js`: new table per §10
- `<>_route_decisions.js`: new table per §12 with the unique constraint
- `<>_triage_items.js`: new table per §11 with partial unique on open status
- `<>_outbox_messages.js`: new table per §13

Tests: name-case unit, phone consolidation, signature validation (5 endpoints + 4 fixture variants).

Accept criteria: existing pipeline behavior unchanged; signature failures logged; no rejected webhooks in prod for 24h before flipping to `enforce`.

### PR2 — Address validation + validator (shadow mode)

Files:
- `server/services/address-validation/index.js` — `AddressValidationProvider` interface
- `server/services/address-validation/google-av-provider.js` — Google AV API client + boot check + cache writer + `expires_at` enforcement
- `server/services/call-extraction-enrichment.js` — orchestrates address validation + properCase + email lowercase + phone normalization; writes to `call_log.ai_extraction_enriched`
- `server/services/call-validation.js` — Anthropic structured-output call; writes to `call_log.ai_validation` + `route_decisions` row with `mode='shadow'`
- `server/services/prompts/call-validation.v1.txt`
- Pipeline integration in `server/services/call-recording-processor.js`: after extract, call enrich → validate → write `route_decisions` row in `mode='shadow'`. Existing routing branches unchanged.
- Nightly cleanup job for expired Google-derived candidate values

Tests: 15-fixture suite (§17 below), Google AV mocked; validator catches Sperrydas/Mueller-class hallucinations; `address_replaced_material_component` veto fires; out-of-county routes to review; idempotency on CallSid; expired cache values not consumed.

Accept criteria: every new processed call gets a `route_decisions` shadow row; no behavior change for actual customer/estimate/appointment writes; `ADDRESS_VALIDATION_ENABLE_CASS=false`; boot check exits non-zero on misconfig in staging.

### PR3 — Triage Inbox UI

Files:
- `client/src/components/admin/TriageInbox.jsx` — list + per-item review panel per §11 spec (decision-oriented, not raw JSON)
- Tab on `/admin/communications` (`CommunicationsPageV2.jsx`)
- Address-issue subview showing AV-component flags
- Field-diff component (transcript → Gemini → enrichment → proposed write) reusable for non-address fields

Accept criteria: every `triage_items.status='open'` row is actionable in ≤3 clicks; field-level edits write to `customer_field_candidates` with `status='human_applied'`.

### PR4 — Enforcement

**Gated on Phase 0/1/2 of §16 being complete.**

Changes:
- Pipeline writes `route_decisions.mode='enforce'` instead of `'shadow'`
- Existing routing branches at `call-recording-processor.js:619` (estimate) and `:685` (appointment) consult the validator output:
  - Appointment branch: ALL the §9 `AUTO_CREATE_APPOINTMENT` conditions must pass
  - Estimate branch: unchanged (already low-risk)
  - Customer upsert: replaced with promotion-from-candidates
- SMS send moves to outbox worker

Accept criteria: backfill labeling shows zero critical false-positive auto-creates; no regression on the 27 historical labeled appointments.

---

## Part D — Open assumptions

1. Google Address Validation API enabled in the Cloud project. Boot check confirms.
2. `administrative_area_level_2` reliably populated in FL AV responses (true in spot checks; test fixture covers the unincorporated-area edge case).
3. Service area = {Manatee, Sarasota, Charlotte, DeSoto}. Confirmed 2026-04-29.
4. `expires_at = validated_at + 30d` aligns with Google T&C downstream-use scope (validated against Google Maps Platform Service-Specific Terms; last checked 2026-04-29). Re-verify if T&C change.
5. Anthropic native structured outputs available on `MODELS.FLAGSHIP` (currently `claude-opus-4-7`). Confirmed in API docs.
6. Twilio `X-Forwarded-Proto` header survives Railway's edge (it does for all current endpoints — verified during PR1 fixture work).
7. `WAVES_VOICEMAIL_URL` audio content unknown from repo; audit happens during PR1.
8. Labeling effort: ~40 stratified transcripts, ~1.5–2h. Adam or Virginia executes pre-PR4.

---

## Part E — Out of scope (this initiative)

- Replacing Gemini extraction
- Parallel pipeline next to existing
- Migrating `server/services/geocoder.js` to AV (separate PR)
- Real-time voice agent (separate ConversationRelay project)
- Multi-language transcription
- LLM-driven enrichment of any kind
- CASS / USPS deliverability gating (feature-flagged, off, available for future workflows)
- Multi-vendor address validation (provider abstraction allows it later)

---

## Part F — Test fixtures (required pre-merge for PR2 / PR4)

1. **Hallucinated last name** — transcript lacks last name; Gemini invents one; validator emits `name_likely_misheard`; candidate `status='rejected'`; canonical customer untouched.
2. **Spelled-out email** — transcript "j-d-o-e at gmail dot com"; validator accepts normalized email with `reason_code='spelled_out'`; evidence quote preserves spelled form.
3. **Partial address (street only)** — caller says "Greendale Drive"; AV completes to a full address; `address_status='inferred_material_component'`; appointment auto-create blocked; address candidate `status='pending'` → triage.
4. **Caller-stated city replaced by enrichment** — caller says "Sarasota"; AV returns "Bradenton"; `address_status='replaced_material_component'`; veto fires.
5. **Existing customer address match** — caller gives no address; phone matches customer with verified address; `address_status='caller_complete_unvalidated_existing_customer_match'`; appointment proceeds if intent/time/service clean.
6. **Time ambiguity** — "Friday afternoon"; existing `hasSpecificTime` regex catches it; `routing_recommendation='needs_review'`.
7. **Relative date resolution** — "tomorrow at 10"; resolved from `call_log.created_at` in America/New_York to ISO; appointment proceeds.
8. **Past datetime** — extractor returns past timestamp; `past_or_unresolved_datetime` veto.
9. **Reschedule/cancel ambiguity** — "I might need to cancel Friday"; no new appointment; triage item created.
10. **Duplicate Twilio callbacks** — recording-status + transcription both arrive; exactly one `route_decision`, one set of side effects, idempotent on `(call_log_id, decision_version, mode)`.
11. **ParentCallSid forwarded call** — parent/child group dedupes via `source_call_group_id`.
12. **Invalid Twilio signature** — `enforce` mode rejects with 403; `log` mode logs and processes.
13. **Proxy HTTPS mismatch** — `req.protocol='http'` + `X-Forwarded-Proto='https'`; signature validates against reconstructed URL.
14. **AV API unavailable** — Google AV returns 503; extraction stored, address_status='api_unavailable', no auto-create, triage item created.
15. **Cache expiry** — Google-derived address value past `expires_at`; routing path refuses to consume it; falls back to customer-confirmed value or triage.
16. **Out-of-service-area** — address validates to Hillsborough County; veto fires; triage item created.
17. **First-name overwrite attempt** — extracted first_name differs from existing non-null customer first_name; auto-apply blocked; triage item.

---

**Status:** v2 strategy complete. Ready to start PR1 on confirmation.
