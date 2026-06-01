# Email Deliverability Audit - 2026-06-01

Scope: production email delivery status, local outbound suppressions, SendGrid provider state, newsletter/automation delivery rows, and inbound Gmail spam-block behavior.

No live customer emails were sent during this audit. Queries were read-only.

## Production Configuration

Railway production has the core SendGrid pieces configured:

- `SENDGRID_API_KEY`: set
- `SENDGRID_ASM_GROUP_NEWSLETTER`: set
- `SENDGRID_ASM_GROUP_SERVICE`: set
- `SENDGRID_WEBHOOK_PUBLIC_KEY`: set
- `GOOGLE_SMTP_PASSWORD`: set
- `CLIENT_URL`: set, used by the portal URL fallback chain

Not set:

- `PUBLIC_PORTAL_URL`: missing, but `server/utils/portal-url.js` falls back through `CLIENT_URL` and then `https://portal.wavespestcontrol.com`.
- `SENDGRID_SERVICE_FROM_EMAIL`: missing, but all active service/transactional templates are explicitly using `contact@wavespestcontrol.com`.
- Internal test-email allowlist vars are missing, but `server/utils/internal-email-recipients.js` defaults to `wavespestcontrol.com` and the known Waves sender inboxes.

SendGrid API status:

- Account type: free
- Sender reputation: 96
- Authenticated domain: `wavespestcontrol.com`, subdomain `em5287`, valid `true`
- Verified sender identities endpoint returned no rows. Domain authentication is the active sender validation mechanism.

## Outbound Customer Email Ledger

`email_messages` production counts for the last 30 days:

| Status | Count |
| --- | ---: |
| delivered | 198 |
| dropped | 15 |
| bounced | 6 |
| sent | 4 |
| failed | 2 |
| blocked | 1 |

There are no stale queued/sending/retry email messages older than 15 minutes.

All 53 email templates are active and all have an active version.

Recent active sender usage:

| From address | Suppression group | Messages | Delivered | Problem count |
| --- | --- | ---: | ---: | ---: |
| `contact@wavespestcontrol.com` | `service_operational` | 117 | 103 | 13 |
| `contact@wavespestcontrol.com` | `transactional_required` | 109 | 95 | 11 |

The only internally blocked outbound customer email in the last 30 days was:

| Template | Group | Reason | Count |
| --- | --- | --- | ---: |
| `invoice.receipt` | `transactional_required` | `Suppressed: bounce` | 1 |

The only failed template-library send was last seen on 2026-05-21:

| Template | Error | Count |
| --- | --- | ---: |
| `membership.started` | SendGrid rejected duplicate categories | 2 |

Remediation check:

- Added regression coverage proving the template library deduplicates provider categories before calling SendGrid, including the `membership.started` category shape.

There were no `notification_template.email.render_issue` audit events in the last 30 days.

## Local Suppressions

Active `email_suppressions`:

| Type | Group | Source | Count |
| --- | --- | --- | ---: |
| bounce | GLOBAL | sendgrid_event_webhook | 2 |

No active local `unsubscribe`, `spam_complaint`, or `do_not_email` suppressions were found.

Interpretation: the app is not broadly blocking customer outbound email internally. It is blocking only recipients with active global bounce suppressions.

## SendGrid Provider Events

SendGrid global stats for 2026-05-02 through 2026-06-01:

| Metric | Count |
| --- | ---: |
| requests | 419 |
| processed | 394 |
| delivered | 362 |
| bounces | 14 |
| blocks | 12 |
| invalid_emails | 16 |
| bounce_drops | 9 |
| deferred | 932 |
| spam_reports | 0 |
| spam_report_drops | 0 |
| unsubscribes | 0 |
| unsubscribe_drops | 0 |
| opens | 505 |
| clicks | 86 |

Provider suppression endpoints returned:

- Bounces in last 30 days: 10 returned, mostly mailbox-not-found / invalid-recipient responses.
- Blocks in last 30 days: 11 returned, including SenderScore IP blocks, Yahoo temporary deferrals, Comcast DNSBL, Apple local policy, mailbox quota, and remote timeout cases.
- Invalid emails in last 30 days: 13 returned.
- Spam reports in last 30 days: 0.

Read-only provider refresh after remediation:

- Account reputation remained 96.
- Domain authentication for `wavespestcontrol.com` remained valid.
- Spam reports remained 0.
- Deferred events increased from 932 to 944 while no live emails were sent by this audit.

DNSBL spot-checks for IPs seen in SendGrid block responses:

| IP | Observed provider issue | DNSBL result |
| --- | --- | --- |
| `149.72.126.143` | SenderScore access denied | Listed by SpamCop (`127.0.0.2`); not listed in Spamhaus/Barracuda/SORBS spot checks |
| `149.72.123.24` | Yahoo TSS04 deferral / timeout | Listed by SpamCop (`127.0.0.2`); not listed in Spamhaus/Barracuda/SORBS spot checks |
| `149.72.154.232` | SenderScore access denied / timeout | Listed by SpamCop (`127.0.0.2`); not listed in Spamhaus/Barracuda/SORBS spot checks |
| `159.183.224.105` | Yahoo TSS04 deferral | Not listed in Spamhaus/SpamCop/Barracuda/SORBS spot checks |
| `159.183.224.104` | Comcast DNSBL response | Not listed in Spamhaus/SpamCop/Barracuda/SORBS spot checks |

App-level `email_message_events` in the last 30 days:

| Event | Count |
| --- | ---: |
| deferred | 419 |
| open | 245 |
| processed | 208 |
| delivered | 198 |
| click | 58 |
| dropped | 15 |
| bounce | 6 |

Webhook ingestion is current: `sendgrid_webhook_events` has processed events through 2026-06-01 02:37 UTC.

## Drop/Bounce Reasons

The dropped/bounced `email_messages` rows in the last 30 days are explained by provider-side recipient or reputation responses:

- `Bounced Address`: 6 dropped rows across invoices/project report.
- `Invalid`: 8 dropped rows across estimate follow-ups/delivery.
- `Group Unsubscribe`: 2 dropped rows, one `project.report_ready` and one `service.report_ready`.
- Sender/IP reputation or receiver-policy blocks: SenderScore blocks, Yahoo TSS04 temporary deferral, mailbox quota, and nonexistent mailbox responses.

Finding: SendGrid `dropped` events with reason `Group Unsubscribe` were not mirrored into local `email_suppressions` unless a `group_unsubscribe` webhook event was also received. That meant future sends to those recipients could be attempted by the app and dropped by SendGrid again instead of being blocked locally first.

Remediation applied:

- Updated `server/routes/webhooks-sendgrid.js` so future SendGrid `dropped` events with reasons `Group Unsubscribe`, `Unsubscribed Address`, `Spam Reporting Address`, `Bounced Address`, and `Invalid` create local suppressions before the next attempted send.
- Backfilled production `email_suppressions` from historical `email_messages` dropped events. Inserted 4 global bounce suppressions and 1 `service_operational` unsubscribe. Remaining backfill candidates after insert: 0.

## Newsletter

`newsletter_sends` aggregate status:

| Status | Sends | Recipients | Delivered | Bounced | Complained |
| --- | ---: | ---: | ---: | ---: | ---: |
| sent | 31 | 1904 | 1868 | 3 | 0 |
| draft | 9 | 0 | 0 | 0 | 0 |

`newsletter_send_deliveries` row-level data only contains 2 delivered rows. A follow-up check showed these are the two 2026-05-26 sends, while older rows are imported/historical newsletter sends with 2025 `sent_at` timestamps and no row-level delivery ledger. Current send code pre-seeds `newsletter_send_deliveries`; historical newsletter deliverability should continue to be read from `newsletter_sends` aggregate counters and SendGrid global stats unless those old sends are intentionally backfilled.

No stale retryable newsletter delivery rows were found.

Newsletter subscriber state:

| Status | Count |
| --- | ---: |
| active | 602 |
| unsubscribed | 39 |
| pending | 31 |

## Automation Runner

`automation_step_sends` in the last 30 days:

| Status | Count |
| --- | ---: |
| delivered | 128 |
| bounced | 23 |
| failed | 1 |

Failure/bounce reasons are mostly invalid/missing recipient mailboxes. One failed row was a SendGrid 400 for an invalid recipient address. There are no active/past-due automation enrollments; enrollment status is 177 completed and 1 failed.

## Inbound Gmail / Internal Spam Blocking

The inbound email sync is current:

- Last sync: 2026-06-01 02:56 UTC
- Synced emails: 7,082
- Errors: blank

Inbound internal blocklist:

| Scope | Rows | Total blocked count |
| --- | ---: | ---: |
| domain | 119 | 554 |
| single address | 182 | 532 |

Inbound actions in the last 30 days:

- `blocked_sender_trashed`: 475
- `spam_blocked`: 221

Finding: `blocked_email_senders` has 301 rows and 0 have a stored `gmail_filter_id`. The app still blocks/trashes these messages during sync, but Gmail filter creation is not represented in the DB. If pre-inbox Gmail-level blocking is expected, this needs follow-up.

Follow-up detail:

- All 301 blocklist rows are `reason='spam_auto'`.
- 119 are domain-scoped and 182 are single-address-scoped.
- Total blocked count on those rows is 1,086.
- Last 7 days: 129 `blocked_sender_trashed` and 80 `spam_blocked` actions.
- The app-side sync block is working; the missing piece is Gmail-level filter persistence/creation observability.

## Overall Assessment

Customer outbound email is functioning and not broadly blocked internally. The main problems are small-volume provider-side bounces/drops caused by bad recipient addresses, SendGrid suppression state, and some receiver/IP reputation blocks. SendGrid domain authentication is valid and spam complaints are zero, which is a healthy signal.

Follow-up items:

1. Investigate SendGrid IP/reputation block responses, especially SenderScore, Yahoo TSS04, Comcast DNSBL, Apple local policy, and current SpamCop listings for the observed `149.72.*` SendGrid IPs. Reputation is currently 96, but these are real deliverability signals.
2. Add Gmail-filter creation observability or a guarded backfill path before creating filters for the existing 301 `spam_auto` blocklist rows.
3. Decide whether old imported newsletter sends should be backfilled into `newsletter_send_deliveries`; current sends are creating row-level delivery rows.
