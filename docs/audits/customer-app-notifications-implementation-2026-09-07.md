# Customer app notification preferences

Implementation of the preference and delivery packages approved on September 7,
2026. Weekly watering-plan availability is a separate work package; this change
does not establish email-independent watering guidance.

## Customer behavior

`GATE_CUSTOMER_APP_NOTIFICATIONS` defaults off. When enabled, the existing
Visits settings expose app connection status, an account push switch, and an
App shortcut. Billing settings expose App for payment receipts. The owner
extended the choice to 72-hour and 24-hour reminders on September 8 and
requested the shorter customer-facing label, App.
The shortcut changes delivery choices without enabling muted categories or
clearing text/email opt-outs.

| Family | Delivery |
| --- | --- |
| Appointment confirmations, reschedules, cancellations, no-shows | App first when selected; existing family fallback and recipient rules apply |
| Technician en-route and arrival | App first when selected; existing event freshness and visit guards apply |
| Completion/report notice | App first for supported automatic text notices; attachment and bundled review messages retain existing delivery |
| Payment receipts | App first when selected; emailed receipt copies and third-party payer ownership remain in force |
| 72-hour and 24-hour appointment reminders | App when selected; existing reminder timing, explicit-choice defaults, fallback and recipient rules apply |
| Important billing notices | Existing app/text policy; no replacement-push choice |
| Property/weather advisories | Existing bell/push lane, governed by the new account push switch |

App first permits an allowed backup after push failure or unavailable/stale
registration. APNs/FCM acceptance is the replacement decision; it is not proof
of an OS banner or a read. A pending provider attempt cannot authorize a racing
backup. Existing manual conversations, security, estimates/contracts,
promotions, review asks and media delivery remain outside the shortcut.

## Boundaries and persistence

- Migration `20260907000040` adds `notification_prefs.push_enabled`, default
  true to preserve existing device opt-ins. Existing varchar channel columns
  store `push`; no payment or receipt-token schema changes.
- Capability-aware clients use `?appPreferences=1`. Older clients receive their
  original channel vocabulary, and unrelated saves cannot overwrite a stored
  App first choice. Unsupported channel/category combinations are rejected.
- Service channel choices and the push switch belong to the account primary.
  Receipt choices remain on the charged property profile. Preference writes
  commit together in one PostgreSQL transaction.
- `/api/push/status` requires the existing customer JWT and returns connection
  booleans only. Native enrollment waits for a successful server registration.
  A native subscription must have a heartbeat within 72 hours for replacement.
- Shared customer push resolution uses active, non-deleted authorized account
  properties. Alert URLs carry `notificationProperty`; the portal checks its
  authorized list and completes the server-verified property switch before
  mounting the destination. Signed-out taps retain their destination through
  login. Existing logout token deactivation is preserved.
- The existing messaging pipeline selects explicit App first before SMS-only
  consent checks. Hard suppression, category preferences, template and owner
  controls, visit holds, ET windows and customer quiet hours still apply.
  SMS fallback re-enters that complete pipeline with fresh consent reads.
- The existing notification row stores the event's push attempt/acceptance
  state. Routed lifecycle notices share the bell emitter's business-event key;
  completion retries retain that key. Audits distinguish requested channel,
  accepted provider, and fallback reason. Bell persistence remains independent
  from native push, and the account push opt-out survives a gate rollback.

## Verification

- Full migrations applied to an empty, worktree-owned database in the verified
  Railway dev environment. No production database or customer records used.
- 184 backend tests passed across 16 files, including eight PostgreSQL tests
  using disposable schemas cloned from the migrated table definitions. These
  cover preference ownership, authenticated readiness, old clients, gate
  rollback, stale/expired devices, mixed platform outcomes and concurrent
  event claims. APNs/FCM/Twilio/email delivery was mocked.
- 42 client tests passed across seven files, including native enrollment and
  authenticated property navigation. Browser fixture checks exercised the
  shortcut, account switch, stale status and receipt choice at 1440px and 390px.
- Production build and its brand/domain checks passed during implementation.
  Screenshots use fictional preview records.
- Review regressions passed: 281 backend unit cases, 13 PostgreSQL cases and
  21 client cases. Added coverage verifies abandoned-claim recovery, current
  worker ownership, acceptance before fan-out, both legacy preference routes,
  attempt-scoped en-route keys, deferred deposit receipts, SMS-compatible
  fallback bodies, JWT refresh, and permission revocation on native foreground.

The September 8 release check verified registration, one owner-authorized push
and its Visits destination on an iPhone running 1.5 (6). The owner deferred
additional first-permission/Face ID cases. Android delivery remains unverified.
The customer App preference gate was enabled after the production deployment
succeeded. Version 1.5 (6) was submitted to Apple for review with automatic
release after approval. See the [coverage map](customer-notification-coverage-2026-09-08.md)
for the reminder extension and remaining notification families.
