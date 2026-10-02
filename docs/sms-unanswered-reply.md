# Unanswered-text reply

Owner ruling 2026-10-02: when a customer's text has waited **two open hours** (8 AM–8 PM ET,
closed days skipped) with no reply from a person, the house-voice reply already drafted and
shown to staff as a suggestion goes out on its own. Ordinary questions only. Dark behind
`GATE_SMS_UNANSWERED_REPLY` (strict `'true'`, read at call time).

Code: `server/services/sms-unanswered-reply.js`, swept every 5 minutes from `scheduler.js`.
The send itself goes through the Phase E executor (`sms-auto-send.js`): same thread-lock claim,
same send-once key per inbound, same send-time rechecks and policy-checked provider path.

## What earns the send

- The suggestion is still `pending_review` after 120 open minutes, and it is the same ET day the
  reply's facts were read (so "today"/"tomorrow" still mean what they said).
- Intent is `general_customer_sms_needs_review` or `customer_nudge_needs_reply`. Money,
  cancellations, complaints, photos, lookups and unclassified texts stay with staff.
- The customer's words AND the reply pass a deliberately broad topic screen (`SENSITIVE_TOPICS`):
  legal, health/chemical safety (spraying, treatment, re-entry, kids, pets), complaints, money
  (any billing or payment talk; invoice state has no reliable change stamp) and cancellations stay
  with staff even when the intent label is the general one. A reply grounded in product-label
  facts stays with staff too. A false match only means a person answers.
- No photo on the text, and nothing the drafter recorded as missing information.
- The draft was stamped at draft time **while the gate was on** as verified, action-free,
  lint-clean and not owed a review. Drafts from before the flip are never candidates.
- No price, no redaction placeholder, no unowned follow-up promise; the draft's voice profile is
  the effective one; the judge backstop (enough scored judgments, no recent unsafe) is clear.
- Nothing moved on the thread: no staff reply or reply in flight, no newer customer text, no
  call either way, no visit changed after the facts were read. The newer-text and call checks
  run again at the provider boundary; a miss there returns the card to staff.

## Bookkeeping

The answered card becomes `auto_answered` with `human_verdict = NULL` and `reviewed_by = 'auto'`,
so it never counts as a staff decision or a graduation outcome. The draft becomes `auto_sent`
and leaves the judge pool. The claim's `input_snapshot.unanswered_reply.suggestion_id` names the
card; a crash between send and label is repaired by the next sweep.

## Staff replies always win

While the variable is present (`true` or `false`), staff sends (admin composer, scheduled sends,
tech line, and every operator REPLY route through `sendManualCustomerSms`, pinned by
`staff-reply-surfaces-interlock.test.js`; notifications such as receipts and delivered documents
stay on the direct sender and are covered by the provider-handoff reservation) take the same
thread interlock as Phase E auto-send: a staff
reply backs off while an AI claim is mid-send, and a staff reply in flight keeps the AI from
claiming. After an enable, the sweep claims nothing for the first 15 minutes of a process's
life, so every instance reads the gate before any claim exists.

## Rollback

Set `GATE_SMS_UNANSWERED_REPLY=false` (do not delete it yet). The sweep stops, no new drafts are
stamped, any claim in flight refuses at its next check, and the staff-reply interlock stays on
through the deploy overlap. Delete the variable later, once nothing is in flight.

## Expect a modest send rate

The freshness check is deliberately conservative: any write to the customer's records after the
draft (including automated ones such as reminder logs) keeps the text with staff. Watch the
`refused` counts in the sweep log after the flip before judging the lane's reach.
