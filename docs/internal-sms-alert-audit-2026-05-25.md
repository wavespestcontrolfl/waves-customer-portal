# Internal SMS Alert Audit - 2026-05-25

## Scope

Reviewed internal/admin SMS alert routing after the customer SMS and notification guardrail batches.

## Finding

`TwilioService.sendSMS()` already redirects owner/admin `internal_alert` and `admin_alert` messages into Waves admin notifications before Twilio. However, the SMS guard blocked-send path still created a best-effort owner SMS directly with `c.messages.create(...)`.

That direct call bypassed the central internal alert redirect, the owner SMS kill switch semantics, and normal send logging.

## Fix

- Replaced the SMS guard direct owner SMS with an `internal_admin_alert` notification.
- Kept the alert best-effort and non-blocking so the original outbound SMS remains blocked even if notification delivery fails.
- Added regression coverage that verifies a guard-blocked SMS creates an admin notification and does not call Twilio.

## Verification

- `server/tests/twilio-internal-alert-redirect.test.js`
- `git diff --check`

No customer SMS or email sends were performed.
