# Review-request SMS improvements — scope v2 (2026-09-07)

> **Status (2026-09-07, later the same day): Release 1 authorized by the owner
> with amendments.** The decisions and corrections in the "Owner decisions"
> section at the end supersede anything above it that conflicts. The rest of
> this document is kept as the record of the analysis.

Trigger: an Aug 30 ask (customer A, ant treatment) — "Thanks for the ant treatment today [first name]! Review:
https://portal.wavespestcontrol.com/l/<short-code> Reply if the rain caused issues."
v1 proposed copy fixes plus a "detect a concern, park the ask, Adam decides" queue.
Adam's counter-proposal (2026-09-07) argued for less creative copy and a more
capable surrounding workflow. This v2 reconciles that critique against the code
and prod data. Proposal only; nothing changed in code. Prod reads were SELECT-only.

## What happened (ET, Sunday Aug 30)

| Time | Event |
| --- | --- |
| 1:24 / 1:43 PM | "on the way" / "arrived" texts |
| 4:38 PM | Customer A calls: it rained right after Adam left, will it still work? Office reassures him, promises a re-treat if activity persists |
| 4:50 PM | Receipt text (annual prepay) |
| 5:03 PM | Completion text. Panel: review timing **Now**, interaction "Customer home, spoke with them" |
| 5:14 PM | Review ask, first 15-minute cron tick |
| Sep 7 | Two calls: ants still active, wants a re-treat. No `call_commitments` row exists for either call or for Aug 30 (lane went live 2026-09-01; today's callback promise should have produced one — check separately) |

## Where the critique is right (adopted)

1. **A sentiment-triggered park with "Drop" is selective solicitation.** v1's P1 is
   withdrawn. Any deferral must be neutral: it triggers on *any* recent
   conversation or outbound message, positive or negative, is bounded (48 h past
   the planned send), and never waits for the customer to "become happy". Consent
   and opt-out stay the only hard blocks. Re-service (`is_callback`) visits already
   never enroll, which is the right shape: the service action, not the mood, is
   what changes the ask.
2. **Hands-off, not a queue.** CLAUDE.md rule 14 already says only exceptions park.
   v1 violated it.
3. **"Today" goes stale on a held draft — confirmed in prod.** customer B's Day-0 draft
   was written at 8:00 PM Aug 25 ("Thanks for having us out today, [first name]!"),
   deferred by quiet hours, and sent verbatim at 8:00 AM Aug 26. The persisted-body
   reuse on retry is the cause (`sendOutreachTouch`, prior custom_body reuse).
4. **Copy should come from verified fields, not from the customer's history.** The
   history-grounding rule is the source of every bad draft (street names as
   details, "ant treatment" over "Quarterly Pest Control", the rain echo).
5. **Sender identity from the record.** "{tech} with Waves" resolved from the
   technician on the service record, falling back to "Waves Pest Control". Matches
   the existing house voice and stays truthful with a second tech.
6. **Replay eval must use what was knowable at send time.** Call summaries are
   produced minutes after a call; the eval keys on the summary's `created_at`, not
   the call's.

## Where the critique is wrong or already built (pushed back, with evidence)

1. **"Reliability is the major missing workstream."** Most of §5 exists:
   `sendCustomerMessage` is already the single send path (consent, suppression,
   identity trust, segment policy, `messaging_audit_log`); review rows have a claim
   gate (`claimed_at`), one deterministic short link per row, `deferred_inflight` /
   `opener_in_flight` race handling, provider-timeout reconciliation against the
   outbound log after 10 minutes, and the quiet-hours deferral registry re-runs
   eligibility at replay. The genuine gaps are (a) no re-evaluation for a *new*
   inbound event between enrollment and the Day-0 tick, and (b) decision reasons
   are stored (`stop_reason`, `next_run_at`) but not explained on the Reviews page.
2. **"No automated ask on the service day, for anyone."** This reverses the
   2026-08-05 cadence ruling (Day-0 SMS at the smart window) and the data does not
   support it. Last 90 days, SMS asks by delay after completion:

   | Delay | Sent | Clicked through to Google |
   | --- | --- | --- |
   | under 30 min | 22 | 5 |
   | 30 min – 3 h | 30 | 4 |
   | next day | 1 | 1 |
   | 36 h+ (follow-ups) | 26 | 3 |

   Same-day is not worse; samples are small. customer A's problem was the 11-minute
   stack and the missing conversation check, not the calendar day. Recommendation:
   keep the smart window, add recipient-level spacing (below).
3. **"Remove 'Now' entirely."** "Now" was chosen on 29 of 154 completions in 45
   days, almost certainly when the customer agreed on site (the QR follow-up
   template exists for the same moment). Remove it as the *routine* option, keep an
   explicit "customer asked for the link" choice that still obeys spacing.
4. **"Replace generative drafting with templates."** Agreed on the outcome, but it
   reverses the owner's own 2026-07-30 spec (asks should read like someone who
   remembers the customer). Evidence for reversing: 79 personalized vs 3 template
   SMS asks in 90 days (12 vs 1 clicks, no usable comparison); most drafts converge
   on "Thanks for having us out today, Name! Mind leaving a review?"; every outlier
   is a failure. That's Adam's reversal to make (D1 below).
5. **"Reconsider the reply suffix."** "Reply if anything's off" goes to everyone,
   so it is not gating. Keeping or dropping it is taste (D4).
6. **"Don't optimize around 100 characters."** The real gate is already the
   rendered GSM-7 segment count on the preview; 100 is prompt guidance. The
   bare-link change recovers 8 characters inside that same gate.
7. **Service recovery "third release."** The durable-commitment layer the critique
   describes is `call_commitments` (GATE_CALL_COMMITMENTS is on in prod; 9 rows so
   far, evidence-linked, with a fulfilment linker and an open-obligations queue).
   Build on it; don't add an agent.

## Revised plan

### Release 1 — remove the avoidable mistakes (three small PRs, all gate-flippable)
- **R1a Controlled Day-0 composition.** Code assembles the ask from verified fields
  only: first name, sender from the record, optional service label from the
  completed service (the label the completion text used), review link, uniform
  reply invite. Day-agnostic wording (no "today"). Bare own-domain link through the
  shared `stripPortalUrlScheme`. If D1 = controlled, the SMS drafter path is
  deleted in the same PR (rule 19); the email intro drafter is out of scope.
- **R1b Completion panel timing.** Default "Automatic (recommended)" showing the
  computed send time from `calculateReviewSendTime`; "Now" becomes "Customer asked
  for the link now"; the false "[review link inserted]" preview goes away in
  cadence mode.
- **R1c Recipient-level spacing at Day-0 dispatch.** Before the send: any outbound
  SMS to the customer (any type, any source, including manual) or any inbound call
  or text in the last 120 minutes defers the ask to the next smart window, at most
  48 hours past the planned time, then it sends. Neutral by construction. Re-run
  the check at every tick, not once at enrollment.

### Release 2 — coordination
- Promote R1c into `send-customer-message` as a purpose class (`optional_outreach`)
  so every optional campaign shares one recipient budget (one optional touch per 24 h).
- Reviews page shows the stored decision: reason, next evaluation time, "owner
  action: none".

### Release 3 — service follow-through on `call_commitments`
- An open commitment for the customer counts as an active conversation for R1c.
- Link a later callback request (customer A, Sep 7) to the original commitment through
  the existing fulfilment linker instead of a fresh note.
- Only genuine exceptions reach the Needs Review inbox.

### Acceptance tests carried over from the critique
Customer A's timeline (no 5:14 PM ask; Aug 31 morning instead); "thanks again" creates
no deferral beyond the 120-min window; concern arrives after enrollment and before
the tick → re-evaluated; draft deferred overnight → no "today"; opt-out after
enqueue → blocked; dissatisfied customer → no permanent exclusion; provider
timeout → reconcile, never a second send.

## Decisions needed (revised)
1. **Composition:** controlled templates from verified fields (recommended), or
   keep the drafter under the tighter contract.
2. **"Now":** keep as an explicit "customer asked on site" option (recommended), or
   remove entirely.
3. **Same-day asks:** keep the smart window plus spacing (recommended), or
   next-day for everyone.
4. **Reply invite:** keep the uniform "Reply if anything's off." (recommended), or
   drop it.
5. **Spacing:** 120 minutes and a 48-hour maximum deferral — confirm.

## Owner decisions (2026-09-07) and corrections to this document

1. **Composition — controlled.** The cadence's Day-0 SMS is composed from
   verified fields only (`day0_ask` in `review-outreach-templates.js`): first
   name, the technician on the completed service ("<tech> with Waves", or
   "Waves Pest Control" when none resolves), the tokenized link, and the uniform
   "Reply if anything's off." Day-agnostic. This is a narrow revision of the
   2026-07-30 personalized-drafting spec for the Day-0 touch only — the Day-4
   reminder and the email intro keep the drafter; it is not a platform-wide ban
   on personalization. No service label: with the reply invite, no label
   variant fits one GSM segment (measured: 194–219 chars).
2. **"Now" stays** as an explicit "customer asked for the link" option. Do not
   read the 29 historical "Now" selections as evidence of a request — the panel
   never recorded why it was chosen.
3. **Same-day asks stay** with the smart window; "Automatic (recommended)" is
   the panel default. Correction to §"Where the critique is wrong" item 2: the
   click table does not show same-day asks perform *at least as well as*
   next-day asks — the next-day bucket has one send. The defensible statement
   is that the data does not justify changing the same-day policy.
4. **Reply invite stays**, uniform, on every Day-0 ask.
5. **No timing gate on the first ask — owner override.** "I do not want a gate
   on when we send the review, not 120 min, 1 second, 24 hrs." R1c (120-minute
   recipient spacing, 48-hour aging) and the Release 2 optional-outreach budget
   are withdrawn. The only spacing rule is the **3-day rule between review
   asks**: an ask sent Monday 8:00 AM means no follow-up before Thursday 8:00 AM,
   measured from the previous ask's actual send, re-checked at dispatch. With no
   prior ask the first one goes at its computed time. The existing 30-day
   cooldown between campaigns and the 3-ask/180-day cap are unchanged.

Other corrections:
- The bare-link change already landed in #4074: `stripSmsUrlScheme`
  (`messaging/sms-link-policy.js`) strips the scheme at the Twilio boundary.
  There is no `stripPortalUrlScheme`; §Release 1 R1a's mention of it is wrong.
- The completion panel's "Customer had specific concern" selection **does**
  exclude the review ask today: the client turns it into
  `reviewSuppression: 'customer_concern'`, the server freezes
  `requestReview: false` on the record, and the later paid-invoice trigger
  honours that opt-out. §"Verified facts" ("no concern/conversation check before
  a Day-0 ask") was wrong about enrollment. Whether that exclusion stays is the
  owner's open question (below); nothing in Release 1 changes it.
- The cadence cron runs every 30 minutes (`14,44 * * * *`), not 15; "Now" in
  cadence mode means the next cadence tick.

Open question for the owner — suppressing an ask after a bad experience:
Google's Maps user-contributed-content policy prohibits selectively soliciting
reviews from customers likely to be positive ("review gating"). A rule that
skips the ask when a bad review looks likely is exactly that. The existing
concern-selection exclusion is a human judgment per visit, which is the least
exposed form of it, but it is still selection by expected sentiment. The
compliant shapes are: (a) hold, not skip — defer the ask while an unresolved
service issue is open (a booked re-service, an open commitment) and send it once
the issue is closed; (b) the owner's manual Stop on a specific customer for a
stated non-sentiment reason. Not built; decision pending.
