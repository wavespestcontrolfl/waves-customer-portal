# SMS operational actions

## Profile capture

The existing SMS intake extracts private property facts from the current message, using prior messages only for context. Clear durable values can fill empty fields for a uniquely resolved primary sender and one active property. Existing values, temporary instructions and ambiguous property or sender authority produce an existing admin exception bell linked to the customer profile.

Profile changes, critical audit records and extraction receipts commit atomically. The existing preference advisory lock precedes customer and SMS row locks to preserve concurrent edits and account merges. Archived accounts are skipped. Affirmative irrigation edits share the portal’s active-system companion write; negated or uncertain reports stay review exceptions. Explicit temporary language in the source requires review even if the model labels a fact durable. Full quoted sentences retain negations and conditions; access codes require the explicit code type and exact symbols. Current and historical prompt evidence uses the existing PAN/CVV scrubber, including split readbacks. Detected payment data cannot be persisted as profile facts. If split-readback redaction consumes the current message boundary, it becomes an explicit review exception instead of a silent no-fields result.

Intake recovers interrupted processing every five minutes, including mixed-content reschedule replies. Only inbound customer messages reach the extractor, which uses the central high-stakes cross-provider policy. Audit metadata contains ids and field provenance, never raw values or their guessable hashes. This part does not record commitments or run fulfillment checks. The original call watchdog remains independent. The existing drafter and customer delivery policy are unchanged; profile processing sends no customer messages.

## Activation and rollback

Disabled unless `GATE_SMS_OPERATIONAL_ACTIONS=true` and `GATE_SMS_OPERATIONAL_ACTIONS_SINCE=<ISO instant with offset>` are both set. Choose the activation timestamp deliberately; historical training messages are not imported. Unset the gate to revoke.

Migration `20260906000001_sms_operational_actions.js` is preserved byte-for-byte from PR #3970 because its preview already ran it. It adds the analysis marker and prepares the existing commitment ledger for the separately reviewed follow-up. This part never writes SMS commitments. Rollback refuses to discard recorded analysis or commitments; use the gate after activation.

## Follow-up part

Commitment extraction, explicit deadlines, guarded delivery witnesses and staff completion controls are a separate change. Pending owner policies remain: recurring-date moves, callback reminder times without a clock time, deadlines for undated inquiries, and family-property account relationships. No automatic scheduling, account changes, consent changes or money movement is included.

## Verification

`server/tests/sms-operational-actions.test.js` covers grounding, code fidelity, profile authority, concurrent-edit decisions and gate behavior. `server/tests/sms-operations-postgres.test.js` checks atomicity, replay, profile-fact ordering, source relinks, unavailable customers and evidence-preserving rollback in a private schema cloned from a migrated synthetic database. CI supplies its ephemeral PostgreSQL database. Local database execution requires a verified dedicated dev/preview database.

## Deferred P2

Automatic replay of analyzed messages needs reconciliation of previously audited writes and terminal extraction receipts. Changing a model version or correcting a body does not authorize replay. Keep the one-shot marker until receipt-aware reconciliation is implemented.
