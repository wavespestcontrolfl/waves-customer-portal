# Customer Email Delivery Audit - 2026-05-25

Scope: customer-facing email delivery paths only. No customer SMS or email sends were executed during this audit.

## Audited Paths

| Area | Primary sender | Template/audit behavior | Status |
| --- | --- | --- | --- |
| Estimate delivery | `server/routes/admin-estimates.js` | `EmailTemplateLibrary.sendTemplate('estimate.delivery')` with `email_messages`, suppression checks, idempotency | Hardened in this batch |
| Invoice sent / receipt | `server/services/invoice-email.js` | `EmailTemplateLibrary.sendTemplate(...)`, production SMTP fallback already disabled | OK |
| Service report ready | `server/services/service-report/email-delivery.js` | `EmailTemplateLibrary.sendTemplate('service.report_ready')` with per-recipient idempotency | Hardened in this batch |
| Estimate follow-ups | `server/services/estimate-follow-up.js` | Template library path with suppression and audit rows | OK |
| Estimate auto-renew | `server/services/estimate-auto-renew.js` | Template automation/library path; production SMTP fallback already disabled | OK |
| Onboarding follow-ups | `server/services/onboarding-follow-up.js` | Template library path; production SMTP fallback already disabled | OK |
| Project/customer account emails | `server/services/project-email.js`, account membership services | Template library wrappers with explicit suppression groups | OK |
| Newsletter and marketing broadcasts | newsletter sender/admin newsletter | SendGrid marketing flow with ASM/unsubscribe handling | Out of customer service-email scope |

## Fixes Applied

1. Disabled production SMTP fallback for estimate delivery.
   - Before: if `estimate.delivery` was missing/unavailable, production could send direct SMTP and bypass `email_messages`, suppression checks, and template render issue visibility.
   - After: production returns a failed send result and logs the required template path failure.

2. Disabled production legacy renderer fallback for service reports.
   - Before: if `service.report_ready` was missing/unavailable, production could fall back to the legacy SendGrid renderer.
   - After: production returns a failed send result instead of bypassing the template library suppression guard.

## Follow-Up Area

The legacy local automation runner (`server/services/automation-runner.js`) still sends through its own `automation_templates` / `automation_steps` tables rather than the newer `email_templates` library. It uses SendGrid ASM groups and webhook cancellation, but it does not share the same `email_messages` snapshots and render issue audit path. Treat that as the next customer email hardening area before expanding any automation sends.
