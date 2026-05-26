# Direct Customer SMS Call Site Audit - 2026-05-25

## Scope

Reviewed direct `TwilioService.sendSMS()` call sites after the SMS template,
internal alert, and admin notification payload guardrail batches.

This pass focused on customer-facing legacy helper methods in
`server/services/twilio.js` that already rendered editable SMS templates but
still called `sendSMS()` directly instead of the canonical
`sendCustomerMessage()` policy/audit wrapper.

## Finding

The legacy helpers below rendered template copy and checked local
`notification_prefs`, but bypassed the centralized customer SMS policy chain:

- `sendServiceReminder`
- `sendServiceCompletedSummary`
- `sendBillingReminder`
- `sendSeasonalAlert`

That meant successful sends skipped the newer wrapper-level audit metadata,
identity-trust checks, suppression checks, quiet-hours handling where
applicable, and policy-purpose classification.

## Fix

- Added the `service_completion` customer SMS purpose.
- Routed the legacy helper sends through `sendCustomerMessage()`.
- Preserved existing template keys through `metadata.original_message_type` so
  the SMS template kill switch still uses the same operational keys.
- Kept the existing template rendering and local preference gates intact.

## Verification

- `server/tests/twilio-tech-en-route.test.js`
- `server/tests/send-customer-message-contract.test.js`
- `server/tests/sms-quiet-hours.test.js`
- `git diff --check`

No customer SMS or email sends were performed.
