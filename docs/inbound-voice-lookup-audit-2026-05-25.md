# Inbound Voice and Lookup Audit - 2026-05-25

## Scope

- Inbound Twilio voice webhook diagnostics.
- Twilio Lookup failure diagnostics used by appointment reminder landline checks.
- Call recording processor lead/source matching diagnostics.

## Guardrail

No customer SMS, customer email, or live voice calls were sent during this audit. Verification was limited to unit tests, static diff checks, and read-only health endpoints.

## Findings

- Several inbound voice webhook logs emitted raw caller/callee phone numbers or full Twilio SIDs while handling normal webhook callbacks.
- Twilio Lookup failure logs in appointment reminders could include the looked-up phone number in the provider URL or error message.
- Call recording lead/source matching logs emitted raw caller or Waves-owned phone number variants when matching existing leads or lead sources.

## Remediation

- Masked phone numbers in voice webhook, appointment reminder, and call recording processor diagnostics.
- Masked Twilio CallSid, ParentCallSid, and RecordingSid values in webhook logs that previously emitted full identifiers.
- Added provider-error sanitizers for Twilio Lookup error text before logging.
- Added focused helper coverage to keep lookup diagnostics from regressing.
