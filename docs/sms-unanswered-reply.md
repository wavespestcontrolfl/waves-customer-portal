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

## Rollback

Unset `GATE_SMS_UNANSWERED_REPLY`. The sweep stops, no new drafts are stamped, and any claim in
flight refuses at its next check.
