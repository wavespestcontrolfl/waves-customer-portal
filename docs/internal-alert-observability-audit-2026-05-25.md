# Internal Alert Observability Audit - 2026-05-25

## Scope

Follow-up after suppressing owner/admin SMS fallback for internal/admin alert
redirect failures.

Reviewed what happens when an `internal_alert` or `admin_alert` SMS aimed at an
owner/admin phone is intentionally suppressed because the Waves notification
redirect is unavailable or undelivered.

## Finding

The fallback suppression returned structured metadata and wrote server logs, but
it did not create a durable admin-visible audit record. If bell/push delivery was
unavailable, the suppressed alert could be missed unless someone inspected logs.

## Fix

- Added `auditInternalAdminAlertDeliveryIssue()` as a typed audit-log helper.
- Wrote `notification.internal_admin_alert.delivery_issue` rows when:
  - the notification redirect returns no delivered bell/push target
  - the notification redirect throws
- Stored only operational metadata:
  - outcome
  - message type
  - masked owner/admin recipient
  - body length
  - alert title/link
  - delivery stats or error reason

The audit row does not persist the original alert body.

## Verification

- `server/tests/twilio-internal-alert-redirect.test.js`
- `git diff --check`

No customer SMS or email sends were performed.
