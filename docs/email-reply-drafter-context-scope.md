# Email reply drafter: context, voice, and length

Scope only. Revised September 12, 2026 against `origin/main` at
`d246ac13ab`; the September 9 production snapshot below is historical and
was not re-queried. This PR changes no runtime code, prompts, gates, or data.

The implementation slices and rollout criteria below are proposals. Start
with the shared context contract; live activation and trigger expansion are
separate decisions after the evidence is available.

## Why

The owner's read: auto-drafted email replies are "not very relevant, long
winded". The code confirms it. Both email drafters see almost none of what
the business knows about the customer, and neither has ever seen how Waves
actually writes.

## Existing drafters

| Drafter | Entry point | Model input | Length rule | Voice |
| --- | --- | --- | --- | --- |
| Automatic Gmail draft (`server/services/email/email-actions.js draftReplyForEmail`, lane `email_reply`, `GATE_EMAIL_AUTO_DRAFTS=true`) | Inbound mail classified `customer_request`, `scheduling`, or `complaint` | Customer first name + the inbound message text only. No thread, no SMS, no calls, no estimates, no invoices, no visits. | "under 150 words" | Hardcoded warm/professional/concise rules, complaint handling, and no signature |
| "✨ AI Draft" button and IB `draft_email_reply` (`intelligence-bar/email-tools.js draftEmailReply`) | Operator click in the Email page, or an IB ask | Email thread + name, tier, address, last visit, next visit, vendor flag. Same gaps otherwise. Direct Anthropic call, not the dispatcher. | "2-3 short paragraphs" | Hardcoded rules, signs "The Waves Pest Control Team" |

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

Neither email drafter reads that shared context or corpus. The approved
profile already has an SMS consumer: `sms-shadow-drafter` resolves it through
`getApprovedVoiceProfile` and sanitizes it when composing the system prompt.
Email should reuse that composition pattern, not append raw profile text.

## Prod numbers (last 30 or 90 days)

| Measure | Value | Meaning |
| --- | --- | --- |
| Auto drafts created, 30d | 8 | Low volume. The lane is not busy, so quality is the whole game. |
| Of those, thread later got a reply from us | 2 | A later reply is observable; draft use, discard, and non-response reasons are not established. |
| Inbound mail eligible for drafting, 30d | 19 customer_request, 11 scheduling, 4 complaint | Small, human-scale. |
| `lead_inquiry`, 30d | 80 (25 matched to a customer) | Currently routed to estimate drafting, never to a reply draft. Biggest untouched pool. |
| Our real sent replies, 90d | 361 (326 with a body) | Enough to mine email exemplars. |
| Average words in our real sent replies | 25 | 25 words suggests a shorter budget; the current 150-word ceiling is not a measured draft average. |
| Matched-customer calls with transcripts, 90d | 808 of 1060 (801 enriched) | Call context is available for most customers. |

## Target behaviour

A reply draft should read like a 25-to-60-word note from Adam or Virginia
that answers the specific question using what Waves already knows, with a
placeholder only when the fact genuinely does not exist.

## Proposed design

### 1. One email context assembler (new: `server/services/email/email-reply-context.js`)

Reused by both drafters. Given an `emails` row:

1. Accept a server-resolved customer row only after validating the inbound
   sender against that active customer. Otherwise require a unique exact
   normalized email match. Shared addresses, deleted records, conflicting
   IDs, or ambiguous property ownership must withhold customer context.
   Never resolve from a name or a phone number supplied inside the message.
   `getContextForCustomer(customer)` accepts a row; it is not an identity
   resolver. Its phone lookup sibling uses `.first()` and is unsuitable
   for resolving ambiguous email senders.
2. Call `context-aggregator.getContextForCustomer(customer)` once and project
   an explicit allowlist into email facts. Preserve billing-lane authority,
   payer-billed exclusions, net collectible balances, completed-visit and
   pending-estimate rules, spam-call exclusion, and unavailable sentinels.
   Do not pass the entire aggregator object to the model: property
   preferences and other free text still need email-side redaction.
3. Add the email-specific slice:
   - latest 8 messages from the same mailbox/thread, both directions,
     chronologically ordered after selection; always include the triggering
     inbound, strip quoted history, exclude drafts and later messages in replay.
   - last 10 SMS from `smsHistory`, with timestamps.
   - last 3 call summaries from `recentCalls`, with dates and outcomes;
     omit raw transcripts and treat summaries as reported conversation,
     not authoritative proof of a payment or completed booking.
   - `pendingEstimate`, `billing.openInvoice`, recent payments, upcoming
     visits, and the last completed visit from the existing shaped context.
     The aggregator currently provides one pending estimate and one own open
     invoice, not arbitrary lists or customer-facing URLs. Broader lists or
     links require a separately tested extension to its canonical selectors;
     phase 1 omits unavailable links rather than constructing guessed URLs.
4. Emit a facts block in the same shape `sms-shadow-drafter.buildFactsBlock`
   emits, plus a short "what happened recently" timeline (merged SMS, call,
   email, visit, estimate, invoice events, newest last, capped at 12 lines).

Each selected fact needs a source reference and timestamp. A lookup failure
is `unavailable`, not `absent`; contradictions remain unresolved. Historical
replay must use captured context from before the human reply, never today's
billing/visit state. Bound each text field and the total prompt; truncation
must preserve the inbound question and mark any omitted context.

Everything in the facts block is data, never instructions. Inbound email
text, thread bodies, and SMS bodies stay in the user channel and are
labelled untrusted, exactly as the SMS drafter does.

### 2. Voice: exemplars plus the approved profile

- Extend `sms-voice-corpus-miner` with a third source, `email_human_reply`:
  Waves-authored `SENT` rows to a non-Waves address, paired with the inbound
  they answered in the same thread, redacted with the existing redactor,
  quoted history stripped, ops mail excluded. A SENT label alone does not
  prove human authorship: exclude automated/template replies and only admit
  pairs whose human provenance can be established. Pair with the preceding
  inbound, exclude held-out evaluation threads and customer identities,
  and retain the existing `(source, source_id)` idempotency key. The 326
  non-empty sent bodies are an upper bound, not 300 verified usable pairs.
  Review source selectors/readers so the new rows do not silently change
  SMS examples or the shared profile distillation input.
- Drafters fetch up to 4 `email_human_reply` exemplars by intent (reuse the
  SMS intent classifier on the inbound email; fall back to the nearest
  supported intent, then to SMS pairs), through the same `exemplarLooksClean`
  gate. If none pass, draft without examples; never borrow example facts.
- Read only `getApprovedVoiceProfile`, reuse the existing profile sanitation
  and composition rules, and record the applied profile version. Missing,
  revoked, rejected, or unreadable profiles use the base email style.
  The email-specific gate below controls this consumer independently of SMS.

### 3. Length and shape rules

- Target length is derived, not fixed: `min(60, max(25, 1.5 x inbound
  words))`, rounded up and stated as a maximum word budget for the full
  visible draft, including greeting and sign-off. Strip quoted history and
  signatures before counting inbound words; count whitespace-separated
  words consistently in prompting, checks, and metrics. Shorter complete
  answers are fine. Multi-part requests that cannot be answered within the
  budget go to operator review rather than silently dropping a question.
- One question answered per sentence. No preamble ("Thank you for reaching
  out"), no closing offer, no bullet lists in email bodies.
- Greeting from the validated customer record. A personal sign-off must
  come from the authenticated drafting operator or configured mailbox
  identity, never a name learned from an exemplar/profile. Omit a personal
  signature when authorship is unknown.
- Placeholders allowed only for facts the assembler marks absent. A draft
  that uses a placeholder for a fact present in the block fails the
  deterministic post-check and is regenerated once. Unavailable or
  conflicting facts require review, not a claim that the fact does not exist.

### 4. Post-check (deterministic, reuse `sms-draft-verifier` patterns)

- Word budget respected.
- No prices, dates, or amounts that do not appear in the facts block.
- No exemplar fact leakage (same `few_shot_leak` check the SMS pathology
  ledger uses).
- No links except customer-scoped, explicitly approved URLs in the facts.
- Amount/date matching must bind to the correct fact and meaning: an old
  invoice amount is not today's balance; a proposed visit is not booked.
  Apply existing customer-copy compliance rules even if unsafe wording
  occurs in a call, SMS, or example.

These checks catch known failures; token membership alone cannot establish
semantic correctness. Allow at most one regeneration for a failed check;
provider fallback is separately bounded by the dispatcher policy. If the
second candidate fails or context is unsafe, expose a review reason in the
existing operator workflow and create no Gmail draft. Automatic failures
must follow existing claim/reconciliation semantics, not clear a claim and
allow duplicate retries. Manual failures return a usable error to the UI.

### 5. Wire both drafters to the assembler

- `draftReplyForEmail`: replace the existing system prompt and bare inbound
  text with assembler output + exemplars + profile. Keep every existing
  claim, dedupe, and Gmail-thread guard untouched. Bump the lane prompt
  version.
- `draftEmailReply` (IB and button): route through `dispatchWithFallback`
  on the `customerCopy` policy instead of a direct Anthropic call, and use
  the same assembler. Operator `instructions` stay as a user-channel line.
  Preserve target-resolution and task-customer ownership checks, the tool
  write-confirmation boundary, and the successful response fields (`draft`,
  `email_id`, `thread_id`, `replying_to`, `subject`, `reply_draft`, `note`).
  Manual generation returns text for the operator; it must not create a
  Gmail draft as an added side effect.

### 6. Later decision: widen the trigger

After the existing categories pass evaluation, consider adding `lead_inquiry`
with a matched customer to the auto-draft set (a prospect who emailed asking
for a quote gets a short reply that names the next step,
alongside the existing estimate-draft path). Unmatched leads stay out of
scope for phase 1 because the assembler has nothing to ground on. This is
not part of the first live rollout. Before enabling, prove that quote and
reply paths cannot create duplicate or contradictory drafts and that the
reply never claims an estimate was created/sent without committed evidence.

## Gates and rollout

| Gate | Default | Purpose |
| --- | --- | --- |
| `GATE_EMAIL_REPLY_CONTEXT` | off | New assembler feeds both drafters. Off = today's behaviour. |
| `GATE_EMAIL_VOICE_PROFILE` | off | Sanitized approved profile used by the new email path; independent of existing SMS/phone consumers. |
| `GATE_VOICE_CORPUS_EMAIL_SOURCE` | off | Miner ingests `email_human_reply` rows. |

These are proposed controls, not existing configuration. Register them in
`server/config/feature-gates.js` during implementation. Context off must skip
new context/example/profile reads and preserve the existing callers' behavior;
profile on alone must not activate the new path. Corpus ingestion off stops
new rows; it does not delete examples already mined.

Order: miner source first, then an explicit bounded shadow evaluation, then
live drafting for the existing categories. Shadow must store redacted
candidates and versioned evidence only in internal evaluation storage; it
must never call Gmail `createDraft`, acquire or settle a live action claim,
change unread state, or emit customer notifications. Reuse the existing
Agents Activity surface for comparisons. Define the shadow entrypoint and
storage contract in its implementation PR; no extra unregistered env flag or
permanent parallel provider calls.

Proposed promotion bar: at least one week and 20 reviewed shadow cases
covering both entrypoints and all three current categories, supplemented by
held-out fixtures where traffic is sparse (report live and fixture counts
separately). Every case must pass deterministic checks; zero cross-customer
leaks, invented financial/booking claims, or shadow Gmail writes. The owner
must judge relevance/voice acceptable before live activation. Elapsed time
alone does not promote the lane. Rollback disables context/profile use and
restores the legacy path without deleting existing operator drafts.

## Measurement

- Keep automatic and manual cohorts separate; record eligible, attempted,
  generated, rejected, failed, and Gmail-created counts with denominators.
  Pin prompt/context versions, profile ID/version, example IDs, model,
  source-health flags, latency, and token usage to each candidate.
- Compare draft and human word counts for correctly paired replies
  (proposed target: median absolute difference at most 10 words). Report
  unmatched drafts separately rather than treating them as discarded.
- Measure normalized edit distance and token overlap only against the first
  actual outbound reply after the triggering inbound in the same mailbox
  and thread. Exclude signatures/quoted history; if another inbound arrives
  before the reply, mark the pairing ambiguous. Define overlap as multiset
  token intersection divided by the larger token count, after lowercasing
  and removing punctuation; over 0.60 is a similarity proxy, not proof of use.
- `reconciled_replied` prevents duplicate drafting when the thread already
  has a reply. It does not store the sent body or establish draft adoption.
  The historical 2 of 8 is a later-reply rate (25%); the draft-used baseline
  is unknown until candidate-to-sent pairing exists.
- Retain source IDs and aggregate metrics rather than duplicating raw sent
  bodies. Any stored comparison text must be redacted, access-controlled,
  and have a defined retention period in the measurement implementation PR.
- Count unnecessary placeholders (target zero), verifier failures, retries,
  and context omissions. Sparse traffic means report counts, not unsupported
  claims of statistical improvement.

## Implementation slices and acceptance criteria

| Slice | Deliverable | Required evidence before completion |
| --- | --- | --- |
| 1. Context contract | Shared assembler and fact projection, no live wiring | Fixtures for unique/shared/deleted sender matches; mailbox/thread isolation; absent vs unavailable; payer billing; archived estimates; cancelled visits; redacted access codes; bounded history and prompt injection. PostgreSQL verification of added/changed queries on a dedicated dev/preview database. |
| 2. Corpus source | Idempotent, gated human email pairs | Automated mail excluded; inbound pairing correct; redaction and injection rejection; replay holdouts excluded; repeated mining inserts no duplicates; SMS/profile readers unchanged unless explicitly scoped. |
| 3. Shared drafting | Both entrypoints use the context, dispatcher, style and verifier | Gate-off parity; profile revoke/failure fallback; manual instructions remain untrusted data; no exemplar facts or forged signatures; bounded retry; dispatcher failure; invalid drafts withheld; existing claim, dedupe, live-thread and recipient guards pass. |
| 4. Shadow and measurement | Internal comparison and correctly paired outcome metrics | Zero Gmail/send/claim side effects in shadow, including provider/storage failure; redacted evidence and retention contract; reply vs adoption distinction; reproducible cohort counts and reviewed promotion evidence. |

Slice 1 is the next implementation step. Slices 1 and 2 can proceed
independently; slice 3 depends on both, and slice 4 must provide evidence
before live activation. No runtime tests or migrations are implied by this
scope-only PR; each implementation PR supplies its relevant checks.

## Out of scope

- Auto-sending email. Drafts stay drafts.
- Vendor and invoice mail. The vendor context stays as it is.
- Unmatched lead replies without a customer record.
- Distilling a separate email-only voice profile. Phase 2 if the shared
  profile reads wrong in email.

## Estimated size

Assembler and miner source: one PR each, mostly reuse. Drafter rewiring and
post-check: one PR. Shadow comparison and measurement: one PR. Four PRs, the
repository review and checks on each. Duration depends on the context and
authorship gaps above; low live volume may make evaluation longer than a week.
