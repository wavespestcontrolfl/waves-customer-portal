# Communications SMS reliability

The communications reliability lane covers conversation-specific drafts, recoverable inbox refresh, and delivery-aware unanswered filtering. Draft storage is PR #4643; unanswered filtering is independently reviewed in PR #4645; this integration connects draft recovery and inbox refresh.

## Resulting behavior

- Inbox drafts are scoped to the authenticated staff account and normalized contact phone. A fixed customer-profile composer has an additional customer-record scope so another record sharing a phone cannot override its identity. Text, attachments, sender, customer context, approval context, reply target, scheduling choices, and minted-link metadata travel together.
- Drafts recover within the same browser tab through session storage. Live previews remain available while switching conversations; recovered attachments use their stored URLs. Sending refuses uploads older than the 24-hour URL lifetime, preserves the draft, and asks the user to remove and reattach expired media. Storage failures retain in-memory edits and show a warning. Approval recovery preserves staff edits and uses the existing approve/revise endpoints.
- A thread or saved draft supplies its sending line. A new message without a saved line requires an explicit sender selection; the draft store never guesses a location number. Malformed recovery JSON is repaired on the next edit.
- Subscribers sharing a draft see the same state. Accepted-send cleanup checks the submitted revision, preserves newer edits, and retains sender/customer identity. Failed cleanup of recovery storage is reported separately from send success. No send endpoint or provider contract changes.
- The active, visible SMS inbox refreshes every 30 seconds and when the browser tab becomes visible. Inactive channels pause new reads. Superseded searches are cancelled, failed reads retain existing messages with a retry action, and updated receipts replace existing messages even when the message count is unchanged.
- Unanswered filtering checks actionable inbound messages per business line against subsequent human replies with queued/sent/delivered status. Reminders, other automation, failed or delayed sends do not answer a waiting customer. Control/recruiting inbound types are excluded and later opt-outs retire older requests when that metadata is present in the log response. Some provider control events currently retain their type only in legacy storage, so those events still appear unanswered.

## Verification

- 179 targeted tests across nine suites passed, including draft storage, account/conversation isolation, approval restoration, contract metadata, attachments, fixed customer identity, consecutive profile sends, sender selection, polling, retry, search ordering, delivery receipts, existing spam/link behavior, and Email draft preservation.
- `npm run build` passed, including its schema/registry, portal-brand, and domain-rule prerequisites.
- `npm run check:ib-coverage` passed with no new/changed unmapped sites. The three existing GET sites record their added cancellation signal and retained read-only scope; no new Intelligence Bar parity is claimed.
- Targeted ESLint passed with no errors. The existing large `SmsTab` and send handler still produce complexity warnings.
- `node scripts/qa/communications-sms-reliability.cjs` passed at 1440px and 390px, using intercepted synthetic APIs. Draft switching/reload recovery, retained content on failure, retry success, and horizontal overflow were checked. No unmatched API requests or page errors occurred. Ready/retry screenshots were inspected in-session; local artifacts are under `.tmp/communications-sms/`.
- A focused independent review checked recipient, approval, sender, and cleanup safety. Its findings were corrected and the bounded recheck was clear.

No backend or migrations were changed. No live customer records or provider delivery were exercised. This is frontend fixture evidence, not end-to-end database verification.

## Scope boundaries

The inbox still derives conversation/filter counts from loaded history. An actionable inbound outside the loaded global page can therefore be missed; complete per-conversation history and control-event metadata need API work (PR #4645, deferred P2s). Its unanswered helper does not claim full parity with watcher-only metadata such as courtesy classification, spam verdicts, or proactive marketing attribution. Complete conversation loading/counts, the inline reply workspace, navigation grouping, and the broader accessibility/readability pass remain separate follow-up work.

If session storage rejects accepted-send cleanup, the composer warns the operator to check history before resending after reload. Removing the shared recovery container would delete unrelated saved drafts, so per-draft durable invalidation remains a separate storage change (draft-store PR #4643, deferred P2).
