# Direct Twilio Call Site Audit - 2026-05-25

## Scope

Reviewed Twilio SDK usage outside `TwilioService.sendSMS()`:

- Admin outbound voice calls
- Lead alert/admin follow-up voice calls
- Inbound voice webhooks
- Twilio lookup helpers

## Finding

The admin outbound call route already gates voice calls and emits `twilio_failure` notifications when `calls.create()` fails. The failure notification used raw request values for `from` and `to`, so default-caller-ID failures could omit the actual Waves caller ID and report the customer number instead of the admin leg that Twilio attempted first.

## Fix

- Track the actual attempted caller ID after route defaults are applied.
- Track the actual admin leg recipient for the first Twilio call.
- Use those values in the `twilio_failure` notification payload.
- Added regression coverage for the failure path without making a live Twilio call.

## Verification

- `server/tests/admin-communications-call.test.js`
- `git diff --check`

No customer SMS, customer email, or live Twilio calls were performed.
