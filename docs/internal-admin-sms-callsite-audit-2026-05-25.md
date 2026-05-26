# Internal/Admin SMS Call Site Audit - 2026-05-25

## Scope

Reviewed direct internal/admin `TwilioService.sendSMS()` call sites after the
customer SMS wrapper and admin notification payload guardrail batches.

Focus:

- Owner/admin recipients such as `ADAM_PHONE`, `OWNER_PHONE`,
  `WAVES_OFFICE_PHONE`, and hardcoded owner fallbacks.
- Calls using `messageType: 'internal_alert'` or `messageType: 'admin_alert'`.
- Whether these paths can still fall back to a real Twilio SMS when the admin
  notification redirect does not deliver.

## Finding

`TwilioService.sendSMS()` redirected owner/admin `internal_alert` and
`admin_alert` messages into the `internal_admin_alert` notification trigger
before Twilio. However, if the notification trigger returned no delivered bell
or push target, or if the trigger threw, the redirect returned `null` and the
original code continued into the Twilio SMS send path.

That meant internal/admin alert call sites could still send an owner/admin SMS
fallback containing customer context whenever the notification layer was
temporarily unavailable.

## Fix

- Suppressed owner/admin SMS fallback when an internal/admin notification
  redirect is undelivered.
- Suppressed owner/admin SMS fallback when the redirect throws.
- Kept structured return metadata so callers can tell whether the notification
  redirected, was undelivered, or errored.
- Added regression coverage proving neither failure path calls Twilio.

## Verification

- `server/tests/twilio-internal-alert-redirect.test.js`
- `git diff --check`

No customer SMS or email sends were performed.
