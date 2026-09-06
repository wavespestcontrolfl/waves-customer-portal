# SMS operational actions

The existing SMS intake now has an operational extension alongside its voice-trained reply drafter. The drafter retains its existing delivery policy. Operational processing does not send customer messages.

## Implemented scope

- Ground customer requests, staff promises and customer-owned next steps in the actual source SMS. One message can carry multiple deliverables.
- Extract private property information beyond access codes: communication preferences, irrigation/controller reports, parking/pet/access notes and service instructions. Clear durable values can fill empty fields for a uniquely resolved primary sender and single property. Preserve existing conflicts, ambiguous property targeting and temporary instructions for owner review through the existing admin bell.
- Extend `call_commitments` with an exclusive SMS source. Existing call readers still join `call_log`, so SMS rows do not enter the Owed/Agent Ops queues.
- Reuse extraction receipts for retries; persist profile changes, critical audits, obligations and the processed receipt atomically. The existing commitment watcher recovers interrupted intake processing every five minutes; the call lane retains its daily cadence.
- For explicitly timed overdue SMS obligations, inspect SMS, call transcripts, synchronized email, email delivery records, sent estimates and invoices. A source failure or truncated evidence is unverified, not proof of non-response. Fulfillment requires a grounded, admissible outcome; an acknowledgment, automatic reminder or unrelated invoice cannot complete the work. A text cannot fulfill a promised call.
- Link admin notifications directly to `/admin/customers?customerId=<customerId>`. Private codes and source quotes stay out of bell previews. Reading a notification does not complete an obligation; still-open work re-alerts after a rolling 24-hour window through the existing admin dedupe mechanism.
- Obligation descriptions quote the customer's/staff's actual words and must name the typed deliverable. Unsupported specifics become review exceptions. SMS/email answers require confirmed delivery; a provider's initial sent status or a Gmail SENT label is context only.

## Activation

Ships off. Owner activation requires both `GATE_SMS_OPERATIONAL_ACTIONS=true` and `GATE_SMS_OPERATIONAL_ACTIONS_SINCE=<ISO instant with offset>`. Choose the activation instant deliberately: this is not permission to bulk-apply the historical training corpus. Unset the gate to revoke. Database migration rollback refuses to discard recorded SMS evidence; revoke through the gate after activation.

## Decisions still needed before expanding automatic actions

- Recurring service moves: occurrence only versus re-anchoring later dates, and conflicts at the requested time.
- A callback promised for tomorrow without a clock time: the reminder time.
- New actionable inquiries with no stated deadline: response interval and business-hour boundaries.
- Family properties: same managed account versus linked separate accounts.

Undated obligations are recorded without a guessed due time; they do not yet generate timed overdue bells. Report/paperwork promises require a document/revision/recipient delivery link before automatic closure; prose claims of sending them remain verification exceptions. This change does not automatically reschedule, cancel, change account relationships, overwrite existing profile values, alter consent, charge or refund. Temporary instructions are retained with their duration classification for review rather than written as permanent facts. Unknown/unlinked sender identities remain outside automatic record changes.

## Verification

`server/tests/sms-operational-actions.test.js` covers evidence grounding, party ownership, multiple requests, code fidelity, property ambiguity, concurrent-edit protection, activation and fulfillment witness rules. `server/tests/sms-operations-postgres.test.js` uses only `SMS_OPERATIONS_TEST_DATABASE_URL` and a private schema cloned from a migrated synthetic QA database to check atomicity, replay, query shapes and isolation from call queues. CI supplies its ephemeral PostgreSQL database. Local execution requires a verified dedicated dev/preview database; never use production credentials.

Access-code writes require the quoted code type and literal value to match the selected field; generic gate/code wording remains an exception. Fulfillment uses email send/delivery activity even when a retry keeps an older row. The existing SMS commitment context stores a hash of the checked evidence, obligation, model and contract plus its verdict: unchanged evidence reuses the result, while provider/schema failures retry after one hour. Archived customers retain their obligations without processing or new bells until restoration; the owner is checked again under the write lock.

Prompt evidence uses the existing PAN/CVV scrubber, including card readbacks split across adjacent messages; unavailable scrubbing stops processing. Model output containing detected payment data is rejected before operational persistence. Controller-location values retain their full quoted sentence, and negated/mixed action requests become review exceptions. The existing call watchdog keeps its own daily 7:20 ET timer so delayed SMS ticks cannot suppress it.

Automatic reprocessing of analyzed messages is deferred. The marker deliberately keeps committed source actions one-shot: replay requires reconciling old obligations and audited profile writes, not simply removing the marker. A corrected body with a terminal extraction receipt may also remain skipped within that extractor version; review and replay tooling must address receipt identity together with that reconciliation.
