# SMS operational actions

## Profile capture

The existing SMS intake extracts private property facts from the current message, using prior messages only for context. Clear durable values can fill empty fields for a uniquely resolved primary sender and one active property. Existing values, temporary instructions and ambiguous property or sender authority produce an existing admin exception bell linked to the customer profile.

Profile changes, critical audit records and extraction receipts commit atomically. The existing preference advisory lock precedes customer and SMS row locks to preserve concurrent edits and account merges. Archived accounts are skipped. Affirmative irrigation edits share the portal’s active-system companion write; negated or uncertain reports stay review exceptions. Explicit temporary language in the source requires review even if the model labels a fact durable. Every profile fact must retain the exact whole current message, so punctuation and later qualifications cannot be discarded. Questions and messages over 600 characters require staff review. Shortened excerpts and mixed-topic values need staff review; access codes require the explicit code type and exact symbols. Audit metadata contains ids and field provenance, never raw values or their guessable hashes.

Intake recovers interrupted processing every five minutes, including mixed-content reschedule replies. Profile-only capture skips outbound messages before extraction. Current and historical prompt evidence uses the existing PAN/CVV scrubber, including split readbacks; unavailable scrubbing stops processing. Detected payment data cannot be persisted as profile facts. If split-readback redaction consumes the current message boundary, it becomes an explicit review exception instead of a silent no-fields result. Extraction and fulfillment use the central high-stakes cross-provider policy.

## Commitment follow-up

The separately gated follow-up extends the existing `call_commitments` ledger with an exclusive SMS source. It captures customer requests, staff promises and customer-owned next steps from literal current-message evidence; one message may contain several deliverables. Human outbound messages become eligible only with this additional gate enabled. Intake refuses failed delivery; a promise captured before a later delivery failure remains eligible for follow-up and staff closure. Profile changes, obligations and extraction receipts share one transaction. Conditional requests require staff review.

Due times require an explicit quoted day and clock resolved by the existing Eastern date utility. Missing, ambiguous, unsupported and DST-invalid times remain undated; a clock-time statement omitted from the extraction becomes an exception. No response interval or callback reminder hour is invented.

The five-minute watcher checks explicitly timed overdue Waves obligations using scoped SMS, calls, email delivery, sent estimates and service records. Missing/truncated sources require review. Visit evidence is scoped to the requested property and post-request activity before applying the record cap. Before automatic closure, the transaction locks the cited source record and rechecks the evidence fingerprint and witness; cancellation, bounce or changed content retries on the next pass. A grounded witness must match the requested deliverable, property, service and recipient. SMS and email answers require delivery; an email witness additionally requires its recorded delivery address to match one explicit recipient address in the grounded request. Missing, different or multiple recipient addresses require staff review. Acknowledgments, automatic reminders and unrelated invoices cannot complete work. The normal delivered appointment confirmation is admissible only for a confirmation request. A promised call requires a completed call with substantive evidence. A scheduling request can close after a newly booked visit advances to en route, on site or completed; post-request creation or a confirmed/rescheduled transition must still prove the booking. Progress alone, cancellations and skips never prove it.

Commercial estimates reuse the call lane’s live lead ownership fence, including conflict vetoes; phone-only associations do not prove ownership. When an estimate lacks `property_id`, only a canonical address including unit and available locality that uniquely matches one active property supplies the property witness. Reports and paperwork still require an exact document/revision and recipient delivery link before automatic closure; until then staff verifies completion.

Customer 360’s Comms tab displays a paged SMS follow-up list with Mark done and Dismiss, using the existing commitment correction route. These controls re-check the active owner, source, gate and open status under customer → SMS → commitment locks. The human verdict, critical audit and clearing of the existing bell commit together. Staff identities use the canonical technician audit actor type, including staff with the admin role. A watcher that started earlier cannot replace a later human closure. SMS rows stay outside global Owed/call queues and never receive the call lane’s implicit deadline.

Admin bells link directly to `/admin/customers?customerId=<customerId>&tab=comms`. Private codes and source quotes stay out of bell previews. Reading a bell does not complete work; still-open obligations can re-alert after a rolling 24 hours through the existing admin dedupe mechanism. Fulfillment evidence strips duplicate raw-body fields and scrubs SMS records chronologically; a split payment readback that merges record boundaries requires review before any provider call. A cached verdict is keyed by the evidence, obligation, provider policy and extraction contract; changed evidence invalidates it, and provider/schema failures retry after one hour. The call watchdog retains its separate daily 7:20 ET cadence.

## Activation and rollback

Profile capture requires `GATE_SMS_OPERATIONAL_ACTIONS=true` and `GATE_SMS_OPERATIONAL_ACTIONS_SINCE=<ISO instant with offset>`. Commitment capture, checks and closure controls additionally require `GATE_SMS_COMMITMENT_FOLLOWUP=true`. All gates ship off. Choose the activation instant deliberately; no historical training corpus is imported. Turning on commitment capture later does not replay messages already analyzed by profile-only capture. Unset the corresponding gate to revoke writes and checks; recorded open work remains visible without action controls.

Migration `20260906000001_sms_operational_actions.js` is preserved byte-for-byte from PR #3970 because its preview already ran it. It adds the analysis marker and prepares the existing ledger. Rollback refuses to discard recorded analysis or commitments; use gates after activation.

The existing reply drafter and customer delivery policy are unchanged. Operational processing sends no customer messages and performs no scheduling, account, consent or money changes.

## Decisions before expanding automatic actions

- Recurring service moves: occurrence only versus re-anchoring later dates, including conflict rules.
- Callback requests without a clock time: reminder hour.
- Undated inquiries: response interval and business-hour boundaries.
- Family properties: one managed account versus linked accounts.

Undated obligations remain recorded without timed overdue bells. Temporary instructions remain review exceptions rather than permanent facts. Unknown/unlinked sender identities remain outside automatic record changes.

## Verification

`server/tests/sms-operational-actions.test.js` covers grounding, ownership, multiple requests, literal codes, deadline resolution, temporary language, fallback routing and fulfillment witnesses. `server/tests/sms-operations-postgres.test.js` checks atomicity, replay, merge lock ordering, commercial ownership, manual closure races and gate/owner/archive guards in a private schema cloned from a migrated synthetic database. CI supplies ephemeral PostgreSQL; local migrations were not run without a verified dev/preview database.

Client tests exercise both call and SMS lists, cross-customer stale responses, paging, Mark done, Dismiss, failed saves and gate-off visibility. The real Customers page was exercised at desktop and mobile sizes with synthetic intercepted API responses; screenshots are attached to the follow-up PR.

## Deferred P2

Automatic replay of analyzed messages needs reconciliation of previously audited writes, obligations and terminal extraction receipts. Changing a model version or correcting a body does not authorize replay. Keep the one-shot marker until receipt-aware reconciliation is implemented.
