# Notification Delivery Safety Audit - 2026-05-25

## Scope

Reviewed delivery guardrails around internal/admin alerts and the canonical customer-message wrapper.

## Fixes

- Legacy `TwilioService.sendSMS` now blocks `internal_alert` and `admin_alert` messages when the destination is not a known owner/admin phone, unless a caller explicitly opts into `allowUnknownInternalAlertRecipient`.
- `sendCustomerMessage` now rejects mixed audience/purpose contracts:
  - `internal_briefing` requires `internal` or `admin` audience.
  - `internal`/`admin` audience requires `internal_briefing` purpose.
- Added focused tests for the Twilio fail-closed path and the canonical message contract guard.

## Notes

- No live SMS or email sends were triggered.
- Existing owner/admin alert redirects to in-app admin notifications remain intact.
