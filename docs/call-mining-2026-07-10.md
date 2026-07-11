# Call Mining 2026-07-10 — 1,000-call variance audit, spam ground truth, zero-triage foundation

Mission: mine the 1,000 most recent inbound calls, find every miss, determine spam
definitively, and rebuild the pipeline so every call reaches a correct automated
terminal disposition with no human triage. This report covers Phases 0–3 (evidence);
the Phase 4–6 implementation ships in the same PR series as this document.

## Current-state map (Phase 0, code-verified)

Inbound webhook (`server/routes/twilio-voice-webhook.js`) → spam-block middleware
(`blocked_numbers` + Marchex AddOns, enforcement gate off) → §934.03 greeting →
simul-ring with press-1 screen (30s) → Waves voicemail (`<Record>` 120s) →
recording-status → `CallRecordingProcessor.processRecording`: OpenAI diarized
transcription (Gemini/Twilio fallback) → V1 + V2 (schema 1.4.0, enforce mode)
Gemini extraction → `canAutoRoute` gates → route_decisions + triage_items →
`processAllPending` cron (*/5) sweeps stragglers; extraction failures retry ×3
then card (#2555).

Corrections to the mission brief discovered in Phase 0: ConversationRelay + Claude
voice agent is merged dark (`VOICE_RELAY_ENABLED` off) — the live pipeline is the
webhook/recording/Gemini path above; "ToolLogger" exists only in the astro content
engine — the observability hook for voice is `tool_health_events` +
`server/routes/tool-health.js`; the extraction contract is
`server/schemas/call-extraction.model-output.schema.json` (+persisted) at
SCHEMA_VERSION 1.4.0.

## Dataset (Phase 1)

1,000 most recent inbound calls (2026-04-14 → 2026-07-09), joined with route
decisions, triage items, leads, customers, appointments, paid invoices, and 90-day
repeat-call counts. 625 have usable transcripts; 78 recordings lack transcripts
(short/failed transcriptions — gap reported, not backfilled in this pass); 297 are
no-recording rings. All 1,000 predate the 2026-07-09 model-pin/retry fixes, so this
is a single-regime analysis of the pre-fix pipeline; the fixes' effect shows up in
the Phase 5 validation, not here.

## Variance audit (Phase 2) — two-pass blind re-extraction

Pass 1: all 625 transcripts re-analyzed blind by a fast model (638k in / 144k out
tokens, 0 errors). Field-diff against production output (after removing one
definitional non-variance: production deliberately over-fills `matched_service`,
so service presence/absence is excluded). Pass 2: every disagreement (336 calls)
plus a 10% random slice of agreements (29 calls) arbitrated by the strongest
available model against the transcript (524k in / 234k out tokens, 0 errors).

**Dispute resolution (590 disputed fields):** production right 95 (16%), blind
right 434 (74%), both wrong 19, unknowable 42. The production extractor loses
three-quarters of the fields it disagrees with a careful reader about.

**Random-audit shared-error rate:** 1/29 (3.4%) — when both models agreed, a real
finding hid beneath the agreement about 3% of the time. Reported, not extrapolated.

**Findings ledger: 279 findings** (backfill artifact → `call_audit_findings` via
`server/scripts/backfill-call-audit-findings.js` once migration 20260710000003
deploys). By category: missed_lead 167, other 45, contact_extraction_error 32,
spam_false_positive 19, booking_failure 7, voicemail_mishandled 5,
spam_false_negative 3, wrong_urgency 1. By severity: lost_revenue 153,
data_quality 115, customer_harm 8, cosmetic 3.

**Revenue at stake — stated honestly in two tiers:**
- Upper bound (extraction-level lead-flag misses): 153 × $227.62 real average paid
  ticket = **$34,826** initial-ticket basis. Many of these calls still produced a
  lead row through other reconciliation paths, so this is the extraction-quality
  ceiling, not confirmed loss.
- Confirmed-loss floor (calls with ZERO downstream footprint, verified
  individually in the precursor audit): 34 calls ≈ **$7,700** initial-ticket
  basis — before recurring-plan lifetime value, which multiplies both figures.

## Spam ground truth (Phase 3) — layered classifier, validated

Layers: (1) vendor risk (Nomorobo / TrueSpam via installed Twilio add-ons) and
line-type+CNAM (472 numbers scored via Lookup); (2) content classification from
the blind transcript pass; (3) caller-history override (existing customer/lead,
appointment, or paid invoice → never spam). Verdict `spam` requires the CONTENT
signal plus at least one independent non-content signal, and no history override —
never transcript alone, never risk score alone. Ground truth = production/blind
consensus, strong-model arbitration on every disagreement, with downstream reality
overriding all labels.

**Confusion matrix (1,000 calls):**

| | verdict: spam | verdict: not_spam | verdict: insufficient_signals |
|---|---|---|---|
| **truth: spam (34)** | 17 | 11 | 6 |
| **truth: not_spam (661)** | **0** | 660 | — |
| **truth: unknown/no-transcript (305)** | 0 | 22 | 284 |

**Spam precision: 17/17 = 100%** (gate: ≥99% — PASSED; auto-discard permitted).
**Spam recall: 50%**, reported honestly: the classifier refuses to discard the 17
misses because they lack a second independent signal or carry history — they simply
ring through, which is today's behavior. Zero real leads were classified spam.
Verdicts backfill to `call_spam_verdicts` (resumable, keyed on
call_log_id + classifier_version).

Production's own spam labels, for contrast: 19 spam FALSE POSITIVES found among
arbitrated disputes (real callers marked spam — the catastrophic class), 3 false
negatives.

## Use-case taxonomy (owner-directed expansion)

Six families, ~60 canonical use cases mined from all 625 transcripts by four
independent readers, merged with prior-session history (full document:
USE-CASE-TAXONOMY.md, shipped alongside):
- **A. Revenue acquisition** (quotes, WDO closings w/ hard deadlines, pre-pour
  certificates, HOA/commercial bids, urgent dispatch, competitor switches)
- **B. Existing-customer ops** — headline: **"promised quote/callback never
  arrived" ≈29 calls**, the largest self-inflicted leak; no-show complaints ~32.
- **C. Money** (portal payment failures force 12+ calls; surcharge objections;
  prepay; third-party payers; W9/COI paperwork)
- **D. Data the pipeline must WRITE** (owner directive): gate codes ~19, pets ~29,
  contact preferences ~10, secondary contacts ~30, availability windows ~11,
  third-party report delivery 10, photo/video SMS intake 13. Extraction 1.4.0
  already captures most of this (`access_notes`, `pets_on_property`,
  `secondary_contacts`) — **no writer connects it** to `property_preferences`,
  notification enrollment, or `customers.internal_notes`.
- **E. Non-revenue terminal** (vendors ~31, robocalls ~20, wrong-number/brand
  confusion 13, applicants 12, out-of-scope/area ~39)
- **F. Trust/edge** (Spanish ~7+, migration comms errors 9, dead-air voicemails
  22, fill-in receptionist callback queue 10). Zero legal/safety emergencies in
  625 calls — the human-escalation path is correctly rare.

## What ships (Phases 4–6, same PR series)

1. Migration 20260710000003: `call_audit_findings` + `call_spam_verdicts`.
2. Resumable backfills for both tables from this run's artifacts.
3. Extraction schema **1.5.0** (additive): `call_nature`, `recommended_disposition`,
   `spam_verdict` object, per-field confidence — contract tests updated.
4. Upgraded extraction prompt with the worst arbitrated failures as few-shots and
   tightened voicemail/spam definitions (two-party ≠ voicemail; service request ≠ spam).
5. `call-disposition.js`: fixed terminal enum (booked, callback_task_created,
   lead_response_flow_triggered, existing_customer_routed, estimate_send,
   cancellation_processed, complaint_escalated, vendor_logged, voicemail_processed,
   spam_discarded, wrong_number_closed, no_action_needed) — every call maps to
   exactly one; ambiguity → lead_response_flow_triggered; `needs_human_review`
   does not exist. Dark behind `GATE_CALL_DISPOSITION_V1`.
6. `call-spam-classifier.js`: the validated layered classifier, dark behind
   `GATE_CALL_SPAM_CLASSIFIER` (records verdicts; discard action gated separately).
7. Profile-enrichment writers (gate codes → property_preferences, internal notes,
   secondary-contact enrollment) — the D-family owner directive.
8. Self-audit cron: nightly 25-call sample, strong-model re-extraction, diff to
   `call_audit_findings`, alert ONLY on threshold breach (any spam FP; field
   accuracy −3pts; disposition mismatch >5%). Silence = healthy.

## Token spend
Pass 1 (fast): 638k in / 144k out. Pass 2 (strong): 524k in / 234k out.
Discovery agents: ~560k subagent tokens. Vendor lookups: 472 numbers × 2 calls.
