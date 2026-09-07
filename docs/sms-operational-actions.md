# SMS operational actions

## Profile capture

The existing SMS intake extracts private property facts from the current message, using prior messages only for context. Two tiers apply to a clear durable value for a uniquely resolved primary sender and one active property (owner decision 2026-09-07). Bounded typed fields (contact preference and the four access codes) fill an empty field automatically, each behind its strict validator. Free-form fields (access, parking, pet, special instructions, irrigation location, schedule and issues) become pending sensitive proposals in the existing data-hygiene queue, with its vault, audit and one-click revert, and are applied only by a person; the deterministic filters below decide what may be proposed, so a missed phrase can at most propose, never write. Existing values, temporary instructions and ambiguous property or sender authority produce an existing admin exception bell linked to the customer profile.

Profile changes, critical audit records and extraction receipts commit atomically. The existing preference advisory lock precedes customer and SMS row locks to preserve concurrent edits and account merges. Archived accounts are skipped. Affirmative irrigation edits share the portal’s active-system companion write; negated or uncertain reports stay review exceptions. Explicit temporary language in the source requires review even if the model labels a fact durable. Every profile fact must retain the exact whole current message, so punctuation and later qualifications cannot be discarded. Questions and messages over 600 characters require staff review. Shortened excerpts need staff review, and a message that yields more than one free-form field is held as mixed topics rather than proposed twice; access codes require the explicit code type and exact symbols. Current and historical prompt evidence uses the existing PAN/CVV scrubber, including split readbacks, and carries only each message's text, direction and time plus opaque property ids: customer ids, phone numbers, SMS ids and street addresses never reach a provider. Detected payment data cannot be persisted as profile facts. If split-readback redaction consumes the current message boundary, it becomes an explicit review exception instead of a silent no-fields result.

Tapbacks are excluded by the webhook's own reaction detector even when they are stored as ordinary inbound rows. Any explicit time window in the source (relative windows, absences and travel, upcoming-service wording, weekdays, seasons or calendar dates) requires review regardless of the model's duration label. Negated or uncertain pet reports stay review exceptions, because any stored pet detail raises a technician pet alert. An access-code value that is a phrase rather than a credential (same as last time, the usual) is refused. Only the message columns the history query uses reach a provider prompt; media metadata never does.

Intake recovers interrupted processing every five minutes; a tick the lock machinery skips without a database connection is ledgered as a missed tick in job health. The webhook persists the shared SMS source before either the reschedule or lead-intake consumer runs. Consumed replies classify that existing row and use the same post-acknowledgment capture kick as ordinary messages. A classification or capture failure leaves the source available for the sweep. A failed source insert prevents both consumers and returns 503 after attempting to release the owned SID claim. Redelivery depends on Twilio's configured retry/fallback policy; [the default retry policy covers connection failure, and 5xx retries require configuration](https://www.twilio.com/docs/usage/webhooks/webhooks-connection-overrides). This does not repair the existing pre-source claim/crash window or a failed claim release during a database outage. Without the separate commitment gate, only inbound customer messages reach the extractor, which uses the central high-stakes cross-provider policy. Audit metadata contains ids and field provenance, never raw values or their guessable hashes. The original call watchdog remains independent. The existing drafter and customer delivery policy are unchanged; profile processing sends no customer messages.

## Relationship to data-hygiene extraction

The admin-triggered data-hygiene extraction phase keeps proposing regex matches from the unified inbox for human approval; it never auto-applies, so it cannot host an automatic empty-field write. This lane shares its compare-and-set writer and receipt store instead. Both writers check pending proposals under the customer preference lock and preserve a newer distinct message, even when it arrives seconds after the earlier one. A shared Twilio message id identifies the two records of one SMS; older proposals resolve that identity through their linked source row. The SMS lane may replace its inbox twin with whole-message evidence, while the extraction phase preserves an existing SMS twin. Older distinct proposals retire when a newer proposal is inserted. Applying either a typed fact or an approved proposal retires pending siblings whose before-value checks can no longer pass. For typed fields the reverse order needs nothing extra: the extraction phase already skips values the live profile contains. The call-profile enrichment writer takes the same customer preference lock and re-reads the row under it before appending, so a call processed while an SMS fact lands adds to that value instead of replacing it from a stale snapshot.

Irrigation approvals record the active-system companion flag, keyed hashes of existing inputs, and the row's irrigation revision after approval. Migration `20260907000020_property_irrigation_revision.js` increments that revision whenever a writer changes an irrigation input, the active-system flag, confirmation fields, or the home's address-change stamp. Revert preserves the active flag after a later irrigation edit even if the customer restores the original value; unrelated preferences and same-value saves do not count as edits. Private text stays out of proposal evidence and audit metadata. Older approvals without a saved revision keep their existing value and confirmation checks, including approvals made by the old release after the pre-deploy migration. Edit-then-restore history cannot be reconstructed for those approvals.

## Commitment follow-up

The separately gated follow-up extends the existing `call_commitments` ledger with an exclusive SMS source. It captures customer requests, staff promises and customer-owned next steps from literal current-message evidence; one message may contain several deliverables. Human outbound messages become eligible only with this additional gate enabled. Intake refuses failed delivery; a promise captured before a later delivery failure remains eligible for follow-up and staff closure. Profile changes, obligations and extraction receipts share one transaction. Conditional requests require staff review.

Due times require an explicit quoted day and clock resolved by the existing Eastern date utility. Missing, ambiguous, unsupported and DST-invalid times remain undated; a clock-time statement omitted from the extraction becomes an exception. No response interval or callback reminder hour is invented.

The five-minute watcher checks explicitly timed overdue Waves obligations using scoped SMS, calls, email delivery, sent estimates and service records. Missing/truncated sources require review. Visit evidence is scoped to the requested property and post-request activity before applying the record cap. Before automatic closure, the transaction locks the cited source record and rechecks the evidence fingerprint and witness; cancellation, bounce or changed content retries on the next pass. A grounded witness must match the requested deliverable, property, service and recipient. SMS and email answers require delivery; an email witness additionally requires its recorded delivery address to match one explicit recipient address in the grounded request. Missing, different or multiple recipient addresses require staff review. Acknowledgments, automatic reminders and unrelated invoices cannot complete work. The normal delivered appointment confirmation is admissible only for a confirmation request. A promised call requires a completed call with substantive evidence. A scheduling request can close after a newly booked visit advances to en route, on site or completed; post-request creation or a confirmed/rescheduled transition must still prove the booking. Progress alone, cancellations and skips never prove it.

Commercial estimates reuse the call lane’s live lead ownership fence, including conflict vetoes; phone-only associations do not prove ownership. When an estimate lacks `property_id`, only a canonical address including unit and available locality that uniquely matches one active property supplies the property witness. Reports and paperwork still require an exact document/revision and recipient delivery link before automatic closure; until then staff verifies completion.

Customer 360’s Comms tab displays a paged SMS follow-up list with Mark done and Dismiss, using the existing commitment correction route. These controls re-check the active owner, source, gate and open status under customer → SMS → commitment locks. The human verdict, critical audit and clearing of the existing bell commit together. Staff identities use the canonical technician audit actor type, including staff with the admin role. A watcher that started earlier cannot replace a later human closure. SMS rows stay outside global Owed/call queues and never receive the call lane’s implicit deadline.

Admin bells link directly to `/admin/customers?customerId=<customerId>&tab=comms`. Private codes and source quotes stay out of bell previews. Reading a bell does not complete work; still-open obligations can re-alert after a rolling 24 hours through the existing admin dedupe mechanism. Fulfillment evidence strips duplicate raw-body fields and scrubs SMS records chronologically; a split payment readback that merges record boundaries requires review before any provider call. A cached verdict is keyed by the evidence, obligation, provider policy and extraction contract; changed evidence invalidates it, and provider/schema failures retry after one hour. The call watchdog retains its separate daily 7:20 ET cadence.

## Activation and rollback

Disabled unless `GATE_SMS_OPERATIONAL_ACTIONS=true` and `GATE_SMS_OPERATIONAL_ACTIONS_SINCE=<ISO instant with offset>` are both set. Choose the activation timestamp deliberately; historical training messages are not imported. Commitment capture, overdue checks and profile closure controls additionally require `GATE_SMS_COMMITMENT_FOLLOWUP=true`. Unset either gate to stop follow-up; recorded work remains visible. Unset the profile gate to revoke all capture.

Migration `20260906000001_sms_operational_actions.js` is preserved byte-for-byte from PR #3970 because its preview already ran it. It adds the analysis marker and prepares the existing commitment ledger for the separately reviewed follow-up. Migration `20260907000001_sms_profile_proposal_fields.js` widens the proposals table's create-on-apply allowance (a NULL `resource_id`) to the four free-form fields the data-hygiene extraction phase did not already propose; the approve route's allowlist gains the same four. Approving an irrigation proposal records the companion active-system flip, together with the irrigation inputs and confirmations that already existed, on the proposal and in the apply audit; revert restores the flag only while it still holds the value apply set and no irrigation evidence was added after approval. Proposal evidence carries the SMS id and a placeholder, never the text: that stays in the vault and the customer conversation. Rollback refuses to discard recorded analysis or commitments; use the gate after activation.

## Policy limits

Recurring-date moves, callback reminder times without a clock time, deadlines
for undated inquiries, and family-property account relationships remain outside
this implementation. No automatic scheduling, account changes, consent changes
or money movement is included. Undated obligations stay visible for manual work
without timed overdue bells.

## Verification

`server/tests/sms-operational-actions.test.js` covers grounding, code fidelity, profile authority, concurrent-edit decisions and gate behavior. `server/tests/sms-operations-postgres.test.js` checks atomicity, replay, profile-fact ordering, source relinks, unavailable customers and evidence-preserving rollback in a private schema cloned from a migrated synthetic database. CI supplies its ephemeral PostgreSQL database. Local database execution requires a verified dedicated dev/preview database.

## Explicit replay

Changing a model version or correcting a source body never clears analysis markers or terminal receipts. An operator may request a replay of one already-analyzed inbound SMS with `node ops/agents/replay-sms-profile.js --sms-log-id=<uuid>`. The default runs the extractor and previews actual field dispositions through the shared writer in a transaction that is rolled back. It reports new proposals, preserved pending work, prior applied fields and validation exceptions without exposing private values. Add `--execute --preview-hash=<preview_hash>` to persist only the exact previewed results. The keyed hash binds the source, extractor version, private fact values and locked dispositions; any changed extraction or review state rolls back the transaction and requires a fresh preview. No preview payload is stored in a file. Both modes incur normal LLM usage; preview rolls back proposal, vault, receipt, analysis and capture-audit writes and suppresses exception bells. Both the SMS gate and activation timestamp still apply, and messages before activation remain excluded.

Replayed results always require staff review. Prior automatic-write audits and applied or reverted proposals for the same SMS identify fields that must remain untouched, including inbox twins linked by Twilio message id. An identical pending proposal stays pending; an identical terminal proposal keeps its disposition. New eligible facts use the existing vaulted proposal queue and its chronology, authority and before-value checks. The replay has its own extraction receipt per extractor version and source hash, plus a critical audit; it preserves the original analysis and receipts. A failed replay leaves prior work intact and records a bounded retry attempt. No obligations, customer communications, scheduling writes or automatic profile changes run during replay, even while commitment capture is enabled.

Replay reconciles the stable message identity, field and vault value hash, so
an extractor-version change or later creation of a preferences row cannot
reopen an identical rejected fact. Inbox twins use their linked Twilio identity.
Contact preferences join the existing sensitive approval/revert path through
migration `20260907000021_sms_replay_contact_preference.js`; replay itself
never writes the preference. The migration rollback refuses to remove the
allowance while a NULL-target contact-preference proposal still exists.

## Scheduled source identity

Scheduled outbound SMS has one capture identity: the original queue row.
The provider delivery row is excluded from capture when `metadata.scheduled_sms_log_id` identifies a scheduled outbound row for
the same customer. This holds before and after settlement and when the
provider log is missing. Distinct sends with identical text remain distinct;
orphan/malformed links never suppress a source. The relationship is used
only in database selection, outside model prompts. Conversation history keeps
its existing endpoint-based selection so the actual delivered message remains
available after a send-time phone or location-number refresh. Send/retry writers
are unchanged. Outbound commitment capture remains a separate gated follow-up.

Before new scheduled commitments are captured, the latest linked provider
status is checked and locked again in the capture transaction. A failed or
undelivered provider row cannot be treated as a sent promise merely because
the queue still says sent. Recorded promises remain available for follow-up
after a later failure. Missing provider logs retain the settled queue fallback.

Scheduled sources keep the queue id while using the provider delivery's actual
text, endpoints, send time and status. Recovery cannot shift a quoted relative
deadline or import a pre-activation send by re-stamping the queue's timestamp.
Both the capture transaction and follow-up re-read that same delivery source.
