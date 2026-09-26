# Call-extraction hardening runbook

Context: an inbound call (human-answered by Adam) for a bed-bug job produced a
lead with **no last name** and an **unverified, wrong service address**
("7620 Charleston St, Sarasota"). Root cause: the live lead/customer write uses
the **legacy V1 extraction**, which persists whatever address/name the model
returns with **no validation**. The V2 stack (Google Address Validation +
structured triage flags) already runs on every call but in **shadow**
(`CALL_EXTRACTION_V2_ENABLED=true`, `CALL_EXTRACTION_V2_DRIVES_ROUTING=false`),
so none of it touched the live record.

This runbook covers the three hardening layers.

---

## 1. Address-validation bridge (shipped in this PR)

While V2 is in shadow, the live write now consumes **just** the already-computed
Google verdict (`v2AddressValidation`) — no appointment/routing changes:

- **Auto-correct** — when Google decisively accepts/corrects an in-area premise
  (`validated_accept` / `corrected`), the normalized address (e.g. the fixed
  ZIP/street) is written into both the customer and the lead.
- **Flag, don't silently persist** — when a street was given but Google can't
  resolve it (`missing_component` / `ambiguous` / `confirm_needed` /
  `out_of_service_area`), the raw address is kept **and** the call is flagged:
  - lead AI-triage activity gets a `⚠ CONFIRM BEFORE DISPATCH: …` line,
  - `leads.extracted_data.needs_confirmation` records the reasons,
  - `call_log.review_status = 'open'`.
- **Identity signals** on real (hot/warm) prospects — `caller_not_authorized`
  (caller arranging service for someone else, e.g. Elaine for her fiancé Martin)
  and a missing surname are added to the same `needs_confirmation` list.
- **Disclaimed caller ID** — `callback_number_needed` (schema 1.14.0, live miss
  2026-09-25, call 6fee5f34: "this is our office line... they don't pick up, I
  pick up, and then text"). The model sets `caller.caller_id_disclaimed = true`
  (with `caller.phone_note` carrying the caller's own words) when the caller
  explicitly says the incoming Twilio ANI is NOT their own number — a shared
  or office line. `computeDeterministicTriageFlags` (`call-triage-flags.js`)
  raises `callback_number_needed` when that's true AND no spoken callback
  number also covers it (`phone_source` not `spoken`/`both`). It's advisory
  to the APPOINTMENT (not in `BLOCKING_TRIAGE_FLAGS` — the visit still books
  off the ANI, which is the only key available) but hard-blocks the
  confirmation/reminder SMS leg for that call (`call-recording-processor.js`
  forces `v2SmsBlocked = true` when the flag is present, regardless of what
  TCPA consent decided — someone else answering that line never gave THIS
  caller's consent). The hold is keyed on the NUMBER, not the visit: the
  processor records the disclaimed number in `disclaimed_number_holds`
  (`disclaimed-number-holds.js`), and every SMS — `sendCustomerMessage`
  (step 6.45 + its provider-boundary recheck) and `twilio.js` `sendSMS`'s
  final dispatch, so legacy direct callers too — is refused
  (`CALLBACK_NUMBER_HOLD`, retryable; read errors fail closed) while an
  uncleared row exists for its destination. Visit notices with an email on
  file fall back to email. Only resolving the `callback_number_needed` card
  clears the row; a customer phone edit clears nothing (the new number just
  has no hold). Never auto-resolved (human verdict only, same as
  `missing_unit_number`) — the office gets a real cell number on the
  callback. The new customer this call creates also gets a `crm_notes` stamp
  (`callerIdDisclaimedNoteText` in `extraction-compat.js`) marking the phone
  unverified, since there is no dedicated phone-verification column for
  "not this caller's number" (distinct from `customers.line_type`, which is
  Twilio Lookup's physical mobile/landline/VOIP classification). CSR Coach
  also appends a deterministic coaching line ("Caller said this number isn't
  theirs — ask for a cell before ending the call") when the call ends with
  the flag set and no cell captured.
- **Multi-property / occupancy signals** (the customer model is one-address-per-
  profile, with no rental/primary field):
  - `rental_or_tenant_occupied` — a tenant / property-manager caller, or an owner
    calling about their tenants ("my tenants have ants"). Office plans property
    access and decides whether to tag it a rental.
  - `second_service_address` — a returning caller gave a service address that
    differs from the one on their customer record (e.g. a landlord's rental at
    12338 vs. their own home at 12398). The address is NOT overwritten — flagged
    so the office captures the second property instead of dropping it.

Spelled-out names/emails are now authoritative in both extraction prompts: when a
caller spells "B-I-V-O-N-A" / "V as in Victor", the spelled letters win over the
phonetic word ("Bavona"), and "first name dot last name" emails are built from the
spelled parts — so estimates stop bouncing on a misheard address.

Decision logic is the pure, unit-tested `deriveCallReviewBridge()` in
`server/services/call-triage-flags.js`. The bridge **auto-disables** the moment
routing is promoted (it is guarded on `!CALL_EXTRACTION_V2_DRIVES_ROUTING`), so it
never double-acts with the enforce-mode gate.

### 1b. Garbled-street recovery + email garble guard (2026-07-03)

Validation alone can't fix a phonetic mis-transcription — the caller said
"5039 **Seafoam** Trail" (Lakewood Ranch), the transcriber wrote "5039 **C
Phone** Trl", Google returned `missing_component`, and the raw garble persisted
onto the lead/customer with only an advisory flag. Two additions:

- **Address recovery** (`server/services/address-validation/recovery.js`) — on
  `missing_component` / `ambiguous` / `confirm_needed` with a house number, try
  Places Autocomplete on the street as heard, then Gemini phonetic re-hearings
  ("C Phone" → "Seafoam"), each candidate re-confirmed through Address
  Validation (premise-level, house number + caller ZIP/city must corroborate).
  Exactly ONE confirmed premise → adopted into the write with the advisory
  `address_recovered` read-back flag; anything weaker → candidates attached to
  the `address_unverified` triage payload ("did you mean …"). Fail-open; kill
  switch `ADDRESS_RECOVERY_ENABLED=false`; model override
  `GEMINI_RECOVERY_MODEL` (defaults to the extraction model).
- **Email garble guard** — a spelled "W, C-as-in-Charlie, W, 63" transcribed as
  "www.cw63 at gmail.com" is syntactically valid but not a mailbox (and may be
  a **stranger's**). URL-shaped local parts (`www.`/`http`) are demoted to
  `email_raw` (nothing stores or emails them) and flagged `email_invalid`; both
  prompts now decode ASR-concatenated phonetic tokens ("blikenboy" = "B like in
  boy") and trust decoded letters over the caller's transcribed read-back.
- `leads.extracted_data.needs_confirmation` is now **merged across calls** (a
  follow-up call no longer erases the earlier call's read-back warnings).

### 1c. Contact-field dictation decoder — transcript is evidence, not truth

**Fact that shapes this design:** the primary transcription model
(`gpt-4o-transcribe-diarize`) does **not** support the `prompt` parameter (or
logprobs/timestamp granularities) — only non-diarize models like
`gpt-4o-transcribe` do. So transcription prompting cannot fix dictation on the
primary path, and the transcript itself should never be forced to double as
the operational value ("six three" must stay "six three" in the literal
transcript, and become `63` only in a normalized field).

Pipeline (all fail-open, kill switch `CONTACT_DICTATION_ENABLED=false`):

1. **Diarized primary transcript** — unchanged, the literal record.
2. **Dictation signal detector** — regex gate for email/address dictation.
3. **Second full-call pass** on `gpt-4o-transcribe` (promptable;
   `OPENAI_CONTACT_PASS_MODEL` to override) with a dictation-focused literal
   prompt: keep every spoken token separate, never merge spelled sequences,
   never invent "www"/"http". Stored in
   `call_log.transcript_structured.contact_pass_transcript` for audit.
4. **Structured decoder** (`server/services/contact-dictation.js`, Gemini):
   both transcripts in → normalized email/address CANDIDATES out, each with
   confidence, basis, risks, and a ready-to-read `confirmation_question`.
   Number words → digits happens here; "oh" stays ambiguous (o and 0
   candidates) unless context resolves it.
5. **Deterministic validation** — candidates must pass email syntax + the
   URL-shape quarantine; street alternatives feed the address-recovery lookup
   (tried before recovery's own phonetic model call).
6. **Adoption policy** — exactly ONE candidate ≥ 0.75 confidence that doesn't
   contradict a clean extracted value → adopted (behind the cross-customer
   ownership gate). Anything else → review card with candidates + the
   confirmation question. Nothing ambiguous ever reaches a send.

### 1d. CSR read-back script (dictation-quality upstream fix)

The decoder is only as good as the dictation. On every new-lead call:

- **Email**: "Please spell the part before the at-sign; for numbers say
  'digit', like 'digit six'." Then read it back letter-by-letter and get an
  explicit yes. The read-back confirmation is what makes the value safe to
  send an estimate to.
- **Address**: "House number first, then street, city, ZIP." Read back the
  full address including ZIP and get an explicit yes.
- If the caller's audio is choppy or the spelling is unclear, offer to take it
  by text instead — a typed address/email beats fighting the audio (SMS
  fallback flow is a planned follow-up, owner-gated; per standing directive no
  automated customer message goes out without the owner enabling it).

---

## 2. CSR / field call-handling checklist (process, no code)

The defective call was human-answered. Cheapest possible hardening — confirm on
the call:

- [ ] **Account holder name, spelled** — and explicitly identify *who the account
      is for* when the caller ≠ the person being serviced ("Is this for you, or
      someone else?"). The caller's name is not always the customer's.
- [ ] **Full service address read back**, including ZIP. ("Let me read that back…")
- [ ] **Email confirmed letter-by-letter** when given.
- [ ] **Best callback number** if different from the line they're on.

Pair with the worklist below: leads with `needs_confirmation` / calls with
`review_status='open'` are what Virginia clears before dispatch.

---

## 3. Promotion decision — shadow → enforce

The real fix is promoting V2 to drive routing (`CALL_EXTRACTION_V2_DRIVES_ROUTING=true`),
which routes unverifiable-address / caller-not-authorized calls into the
`triage_items` review queue automatically. It's a money-path change, so verify
shadow agreement first. Run against prod (read-only):

```sql
-- a) Google address-validation verdict distribution (last 30d).
--    High share of validated_accept/corrected => promotion mostly auto-routes;
--    high confirm_needed/missing_component => more goes to human review.
SELECT (ai_address_validation::jsonb ->> 'status') AS av_status, COUNT(*)
FROM call_log
WHERE created_at > now() - interval '30 days'
  AND ai_address_validation IS NOT NULL
GROUP BY 1 ORDER BY 2 DESC;

-- b) Shadow routing outcome: how many calls WOULD auto-route vs need review.
-- The decision column is `final_action_taken` (values shadow_auto_route_candidate
-- / shadow_needs_review_candidate); scope to the V2 decision_version so legacy
-- `legacy-call-v1` shadow rows don't mix into the V2 readiness numbers.
SELECT final_action_taken, COUNT(*)
FROM route_decisions
WHERE mode = 'shadow' AND decision_version = 'v2-1.0.0'
  AND created_at > now() - interval '30 days'
GROUP BY 1 ORDER BY 2 DESC;

-- c) V2 schema-pass rate by prompt version (promotion readiness — want ~all 'valid').
SELECT ai_extraction_prompt_version, v2_extraction_status, COUNT(*)
FROM call_log
WHERE created_at > now() - interval '30 days' AND v2_extraction_status IS NOT NULL
GROUP BY 1, 2 ORDER BY 1, 3 DESC;
```

(`ai_address_validation` / `ai_validation` are JSON text — cast `::jsonb` as above.)

Promote when: (c) shows near-100% `valid` on the current prompt version, and
(b)'s `shadow_needs_review_candidate` rate is an acceptable manual-review volume.
Then set `CALL_EXTRACTION_V2_DRIVES_ROUTING=true` on Railway and redeploy. The
bridge in §1 goes inert automatically.
