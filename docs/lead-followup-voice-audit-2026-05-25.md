# Lead Follow-Up Voice Audit - 2026-05-25

## Scope

Reviewed lead webhook and admin follow-up voice paths that call Twilio directly for admin/operator calls.

## Findings

- `admin-followup-call` already scrubs provider errors, marks precreated auto-bridge call logs failed, and falls back through `TwilioService.sendSMS(..., { messageType: 'internal_alert' })`.
- `lead-webhook` had the same auto-bridge pattern, but if `calls.create()` failed after the `call_log` row was inserted, the row stayed `initiated`.
- `lead-webhook` also sent the raw provider error into diagnostics, which could contain full phone numbers embedded in Twilio messages/URLs.

## Fix

- Scrub phone numbers from lead alert provider errors before logging and `twilio_failure` notification payloads.
- Mark precreated lead auto-bridge `call_log` rows as `failed` when Twilio rejects the call.
- Added focused unit coverage for error scrubbing and failed call-log marking.

## Verification

- `server/tests/lead-service-interest-labels.test.js`
- `server/tests/admin-followup-call.test.js`
- `git diff --check`

No customer SMS, customer email, or live Twilio calls were performed.
