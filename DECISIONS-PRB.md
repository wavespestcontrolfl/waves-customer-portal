# DECISIONS-PRB — fail-closed defaults taken during the PR B build

Genuinely-new policy calls the ruled v2 scope did not settle. Each one was
implemented with the conservative/fail-closed default; all are adjustable at
review.

1. **Balance drift between dial and disclosure.** The relay leg re-reads the
   live `openBalanceSummary` at session init. If the live balance is ZERO by
   the time the verified customer asks, the assistant says the account looks
   settled and apologizes for the call (never states a stale figure). A
   non-zero live figure is spoken as-is (truth over snapshot); the pre-dial
   revalidation already cancels the case when the balance changed before the
   dial, so drift here can only come from a payment landing mid-call.

2. **Dial failure returns the case to the review queue.** `calls.create`
   throwing puts the case back to `proposed` (approval cleared, hold_reason
   `dial_failed`) rather than retrying — never auto-redial, a human re-approves.

3. **Vestibule no-input and invalid digits.** An unrecognized digit replays
   the fixed script ONCE, then falls to the generic-callback-voicemail path
   (which itself is 1/30d ledger-capped and can fall to a silent hangup).
   No-input goes straight to that path, per the scope.

4. **Supersession fences not carried onto the collections leg.** The inbound
   relay's claim/generation fencing (#3373) guards ANI-derived account
   context across reconnects. The collections leg instead relies on: the
   per-call token burn (one session per mint), the authenticated-CallSid
   check, and the server-side re-proof that the CallSid belongs to a
   collections-originated call_log row. A reconnect needs a fresh Twilio
   retry of OUR OWN signed TwiML to mint a new token. Documented here because
   it is a deliberate divergence, not an omission.

5. **Wrong-party review artifact.** A wrong-party answer always files an
   admin card; the durable `wrong_number` collections_flag (blocks ALL
   channels) is written only when the answerer says the customer is unknown
   at the number (`number_unknown` capture). A spouse answering should not
   permanently block every dunning channel.

6. **"All calls" opt-out mapping.** `record_do_not_call(scope='all_calls')`
   writes `automated_voice_consent_revoked` AND `do_not_call` (blocks
   voice + manual_call in PR A's policy). Spoken opt-outs on this leg are
   captured via a structured tool with the verbatim words scrubbed and kept
   in the flag reason — the #3373 free-text consent classifier is not run
   over collections turns (the tool is the capture surface here); flag
   vocabulary is PR A's.

7. **Retention default 90 days** (`COLLECTIONS_RETENTION_DAYS`), floor 1 day.
   The sweep is deliberately UNGATED: with the lane dark there are zero
   `collections_voice` rows (no-op, pinned), and once rows exist, purging
   must not stop when the lane's gate is turned off. Only conversational
   content expires (transcript/recording columns, Twilio recording); the
   call_log row, ledger row, and case history remain as compliance data.

8. **Verification factors.** Street number = leading digit run of
   `customers.address_line1`; billing ZIP = first 5 digits of
   `customers.zip`. Two failed attempts end the call with a fixed close and
   zero account detail. Expected values never appear in prompts, tool
   results, or logs. Customers with neither factor on file can never verify
   (the call ends politely) — treated as correct fail-closed behavior, not a
   bug.

9. **Transfer target.** The warm transfer dials `ADAM_PHONE` (the same
   default the admin click-to-call bridge uses). No-answer on the transfer
   leg files a callback card and speaks the fixed callback promise.

10. **Outcome vocabulary.** `writeCallOutcome` treats
    `conversation_*`/`wrong_party` as live conversations (7d suppression;
    stated-date+1bd when later). Vestibule-only contacts (`vestibule_*`,
    voicemail, no-answer) return the case to the review queue without the 7d
    stamp — the dial's own ledger row already denies voice for 7d via the
    policy's `voice_contact_within_7d` window.

11. **Relay-leg failure never reaches the inbound voicemail flow.** The
    collections `<Connect action>` route hangs up on failure (outcome
    `relay_failed`, case back to review) — falling into the inbound
    voicemail/recording path would start recording a call whose consent
    stage may not have completed.

12. **Pay-link "sent" contract.** `send_pay_link` reports success only on
    `sent || ok` from `InvoiceService.sendViaSMS`; `covered_by_credit`
    counts as ok (the model is told the link was handled — the invoice is
    settled by credit and nothing further is owed on it). Ledger row is
    written BEFORE the send (record-then-send); a send failure stamps
    `send_failed` and the model is told to offer the office number instead.
