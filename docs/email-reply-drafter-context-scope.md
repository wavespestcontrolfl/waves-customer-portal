# Email reply drafter: context, voice, and length

Scope only, September 9, 2026. No production code, prompts, gates, or data
were changed. Numbers below are read-only prod queries taken that day.

## Why

The owner's read: auto-drafted email replies are "not very relevant, long
winded". The code confirms it. Both email drafters see almost none of what
the business knows about the customer, and neither has ever seen how Waves
actually writes.

## What exists today

| Drafter | Entry point | Model input | Length rule | Voice |
| --- | --- | --- | --- | --- |
| Automatic Gmail draft (`email-actions.js draftReplyForEmail`, lane `email_reply`, `GATE_EMAIL_AUTO_DRAFTS=true`) | Inbound mail classified `customer_request`, `scheduling`, or `complaint` | Customer first name + the inbound message text only. No thread, no SMS, no calls, no estimates, no invoices, no visits. | "under 150 words" | Two adjectives in the system prompt ("warm, professional") |
| "✨ AI Draft" button and IB `draft_email_reply` (`intelligence-bar/email-tools.js draftEmailReply`) | Operator click in the Email page, or an IB ask | Email thread + name, tier, last visit, next visit, vendor flag. Same gaps otherwise. Direct Anthropic call, not the dispatcher. | "2-3 short paragraphs" | Hardcoded rules, signs "The Waves Pest Control Team" |

Meanwhile the SMS lane already has the pieces the email lane lacks:

- `context-aggregator.getContextForCustomer` assembles SMS history, completed
  visits, upcoming visits, property preferences, payments, interactions,
  complaints, reschedules, pending estimate, cancel-save state, compliance,
  recent calls (spam-filtered, access codes redacted), invoices, lawn
  assessments, and card on file.
- `voice_corpus_examples` holds 403 redacted real SMS replies by Adam and
  Virginia (paired with the inbound they answered, tagged by intent) and 684
  diarized call transcripts. `sms-shadow-drafter` uses the SMS pairs as
  few-shot exemplars with an injection filter.
- `voice_profiles` has one approved style-only house-voice profile (weekly
  distiller, owner-approved, consumed by the phone agent).

None of that is read by either email drafter.

## Prod numbers (last 30 or 90 days)

| Measure | Value | Meaning |
| --- | --- | --- |
| Auto drafts created, 30d | 8 | Low volume. The lane is not busy, so quality is the whole game. |
| Of those, thread later got a reply from us | 2 | Most drafts are discarded or the thread goes unanswered. |
| Inbound mail eligible for drafting, 30d | 19 customer_request, 11 scheduling, 4 complaint | Small, human-scale. |
| `lead_inquiry`, 30d | 80 (25 matched to a customer) | Currently routed to estimate drafting, never to a reply draft. Biggest untouched pool. |
| Our real sent replies, 90d | 361 (326 with a body) | Enough to mine email exemplars. |
| Average words in our real sent replies | 25 | The drafter targets 150. That is the "long winded" complaint in one number. |
| Matched-customer calls with transcripts, 90d | 808 of 1060 (801 enriched) | Call context is available for most customers. |

## Target behaviour

A reply draft should read like a 25-to-60-word note from Adam or Virginia
that answers the specific question using what Waves already knows, with a
placeholder only when the fact genuinely does not exist.

## Proposed design

### 1. One email context assembler (new: `server/services/email/email-reply-context.js`)

Reused by both drafters. Given an `emails` row:

1. Resolve the customer (existing `customer_id`, else address match, else
   phone/name match via the same helpers `context-aggregator` uses).
2. Call `context-aggregator.getContextForCustomer` and take its facts as-is.
   Do not re-query the tables; the SMS lane's redaction, spam-call exclusion,
   and status allow-lists come for free.
3. Add the email-specific slice:
   - full thread (`emails` by `gmail_thread_id`, both directions, quoted
     history stripped, last 8 messages).
   - last 10 SMS in either direction with timestamps, so a reply never
     re-asks what was settled by text.
   - last 3 call summaries (`ai_extraction_enriched` summary, not raw
     transcript) with dates and outcomes.
   - open estimates (sent or viewed, not archived) with total and sent date;
     open invoices with amount, due date, pay-link presence; last payment.
   - next visit with window; last completed visit with service type.
4. Emit a facts block in the same shape `sms-shadow-drafter.buildFactsBlock`
   emits, plus a short "what happened recently" timeline (merged SMS, call,
   email, visit, estimate, invoice events, newest last, capped at 12 lines).

Everything in the facts block is data, never instructions. Inbound email
text, thread bodies, and SMS bodies stay in the user channel and are
labelled untrusted, exactly as the SMS drafter does.

### 2. Voice: exemplars plus the approved profile

- Extend `sms-voice-corpus-miner` with a third source, `email_human_reply`:
  Waves-authored `SENT` rows to a non-Waves address, paired with the inbound
  they answered in the same thread, redacted with the existing redactor,
  quoted history stripped, ops mail excluded. Expected pool: roughly 300
  pairs from the last 90 days, growing nightly.
- Drafters fetch up to 4 `email_human_reply` exemplars by intent (reuse the
  SMS intent classifier on the inbound email; fall back to the nearest
  intent, then to SMS pairs), through the same `exemplarLooksClean` gate.
- Append the approved `voice_profiles.profile_text` to the system prompt.
  This is the first consumer outside the phone agent, so it needs its own
  gate (below).

### 3. Length and shape rules

- Target length is derived, not fixed: `min(60, max(25, 1.5 x inbound
  words))`, stated in the prompt as a word budget.
- One question answered per sentence. No preamble ("Thank you for reaching
  out"), no closing offer, no bullet lists in email bodies.
- Greeting from the customer record; sign-off from the voice profile (the
  real replies sign as a person, not "The Team").
- Placeholders allowed only for facts the assembler marks absent. A draft
  that uses a placeholder for a fact present in the block fails the
  deterministic post-check and is regenerated once.

### 4. Post-check (deterministic, reuse `sms-draft-verifier` patterns)

- Word budget respected.
- No prices, dates, or amounts that do not appear in the facts block.
- No exemplar fact leakage (same `few_shot_leak` check the SMS pathology
  ledger uses).
- No links except ones present in the facts (pay link, estimate link).

### 5. Wire both drafters to the assembler

- `draftReplyForEmail`: replace the two-line system prompt and bare inbound
  text with assembler output + exemplars + profile. Keep every existing
  claim, dedupe, and Gmail-thread guard untouched. Bump the lane prompt
  version.
- `draftEmailReply` (IB and button): route through `dispatchWithFallback`
  on the `customerCopy` policy instead of a direct Anthropic call, and use
  the same assembler. Operator `instructions` stay as a user-channel line.

### 6. Widen the trigger

Add `lead_inquiry` with a matched customer to the auto-draft set (a prospect
who emailed asking for a quote gets a short reply that names the next step,
alongside the existing estimate-draft path). Unmatched leads stay out of
scope for phase 1 because the assembler has nothing to ground on.

## Gates and rollout

| Gate | Default | Purpose |
| --- | --- | --- |
| `GATE_EMAIL_REPLY_CONTEXT` | off | New assembler feeds both drafters. Off = today's behaviour. |
| `GATE_EMAIL_VOICE_PROFILE` | off | Approved profile appended to the email system prompt. Separate because it is the first non-phone consumer. |
| `GATE_VOICE_CORPUS_EMAIL_SOURCE` | off | Miner ingests `email_human_reply` rows. |

Order: miner source first (data only, no customer-facing effect), then the
assembler in shadow (draft stored, compared against the current draft in the
Agents Activity feed for a week), then live.

## Measurement

- Draft word count vs. sent word count, per draft (target: median within 10
  words of the human reply).
- Edit distance between draft and what was actually sent (the existing
  `reconciled_replied` path already knows when we replied; store the sent
  body next to the draft).
- Draft-used rate: threads where the sent reply shares more than 60 percent
  of its tokens with the draft. Today's baseline is 2 of 8.
- Placeholder count per draft (target: zero when the fact exists).

## Out of scope

- Auto-sending email. Drafts stay drafts.
- Vendor and invoice mail. The vendor context stays as it is.
- Unmatched lead replies without a customer record.
- Distilling a separate email-only voice profile. Phase 2 if the shared
  profile reads wrong in email.

## Estimated size

Assembler and miner source: one PR each, mostly reuse. Drafter rewiring and
post-check: one PR. Shadow comparison and measurement: one PR. Four PRs, the
usual Codex loop on each, roughly a week of lane time.
