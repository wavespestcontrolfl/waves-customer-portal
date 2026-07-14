# SMS Template Usage Matrix - 2026-05-25

## Summary

This matrix follows the SMS template audit and classifies runtime behavior when
a template is inactive, missing, or invalid. It is based on direct call sites for:

```text
smsTemplatesRouter.getTemplate(...)
renderSmsTemplate(...)
renderRequiredSmsTemplate(...)
smsTemplatesRouter.isTemplateActive(...)
```

Primary finding: most critical billing, appointment, report, request, and payment
flows either fail loudly or skip with an explicit log. The least-governed class
was older lead/estimate automation code that permitted fallback copy or nullable
render results. Follow-up fixes added explicit logging to the admin estimate send
and estimate follow-up cron helper paths, removed the public quote one-time SMS
inline fallback, stopped email automation SMS companions from falling back to
inline copy, and moved annual-prepay estimate acceptance SMS into a protected
template. The stale inline automation `smsTemplate` definitions were then removed
so automation SMS companions are declared only by `smsTemplateKey`. Variant CRUD
is now available in the V2 SMS Templates editor. SMS render issues now write
`notification_template.sms.render_issue` rows to `audit_log`, and the SMS
Templates tab surfaces recent issues. High-volume senders now include
workflow/entity context in those issue rows.

## Behavior Classes

| Class | Behavior | Operator impact |
|---|---|---|
| `required_fail` | Uses `renderRequiredSmsTemplate` or local required wrapper; throws/returns error if template cannot render. | Send fails visibly; workflow usually reports channel failure. |
| `skip_logged` | Uses nullable renderer, logs warning, and skips SMS. | Send is intentionally suppressed; logs identify template key and entity. |
| `pause_logged` | Missing template pauses a sequence. | Automation stops rather than silently advancing. |
| `fallback_logged` | Uses fallback copy or other channel and logs or otherwise records the condition. | Customer may still receive copy that is not DB-managed. |
| `fallback_quiet` | Uses fallback copy without a specific missing-template log. | Highest governance risk; copy can bypass template controls. |
| `kill_switch` | `TwilioService.sendSMS` checks `isTemplateActive(messageType)`. | Message is skipped with `[SMS DISABLED]`; only applies to legacy direct Twilio sends. |

## Matrix

| Area | File | Template keys | Renderer | Inactive/missing/invalid behavior | Class |
|---|---|---|---|---|---|
| Admin estimate delivery | `server/routes/admin-estimates.js` | `estimate_sent`, `estimate_followup_unviewed`, `estimate_followup_viewed`, `estimate_accepted_customer` | `getTemplate` helper | Returns 422/channel error when body is missing; now logs helper warning with template key. | `skip_logged` / `required_fail` |
| Estimate follow-up cron | `server/services/estimate-follow-up.js` | `estimate_followup_unviewed`, `estimate_followup_viewed`, `estimate_followup_final`, `estimate_followup_expiring` | `getTemplate` helper | Missing SMS body means SMS is not attempted; stage releases if no channel succeeds; now logs helper warning with template key. | `skip_logged` |
| Estimate acceptance public page | `server/routes/estimate-public.js` | `estimate_accepted_customer`, `estimate_accepted_onetime`, `estimate_accepted_annual_prepay`, `appointment_confirmation` | `getTemplate` helpers | Template-backed acceptance paths log and skip when missing. | `skip_logged` |
| Public quote | `server/routes/public-quote.js` | `estimate_accepted_onetime`, `estimate_onetime_followup` | `getTemplate` helper | Booking and one-time SMS log and skip when templates are missing. | `skip_logged` |
| Invoice send | `server/services/invoice.js` | `invoice_sent`, `invoice_receipt` | `getTemplate` | Logs and skips/restores send claim when missing. | `skip_logged` |
| Invoice follow-up sequence | `server/services/invoice-followups.js` | Configured in `server/config/invoice-followups.js` | `getTemplate` | Missing body pauses the sequence and logs warning. | `pause_logged` |
| Balance reminders | `server/services/workflows/balance-reminder.js` | `late_payment_7d`, `late_payment_14d`, `late_payment_30d`, `late_payment_60d`, `late_payment_90d`, `balance_*` | `renderSmsTemplate` | Logs and skips customer when template missing. | `skip_logged` |
| Billing cron/autopay | `server/services/billing-cron.js` | `autopay_charge_success`, `autopay_charge_failed`, `autopay_retry_*` | Required local wrapper | Throws on missing template; billing loop records failure. | `required_fail` |
| Autopay notifications | `server/services/autopay-notifications.js` | `autopay_pre_charge`, `autopay_card_expired`, `autopay_card_expiring` | `renderSmsTemplate` | Logs warning and skips when missing. | `skip_logged` |
| ACH/payment Stripe events | `server/routes/stripe-webhook.js` | `ach_retry_notice`, `ach_card_fallback`, `ach_suspended`, `ach_payment_processing`, `bank_verification_*` | `renderRequiredSmsTemplate` | Throws into webhook branch; logged as send failure. | `required_fail` |
| Appointment reminders | `server/services/appointment-reminders.js` | `appointment_confirmation`, `reminder_72h`, `reminder_24h`, reschedule/cancel notices | `getTemplate` helper and required helper | Routine reminders log/skip; required notices throw. | `skip_logged` / `required_fail` |
| Reschedule SMS | `server/services/reschedule-sms.js` | `reschedule_options_*`, `reschedule_confirmed_sms_reply`, `reschedule_call_requested` | `renderSmsTemplate` | Logs and returns structured `missing_template` for options; confirmations skip if missing. | `skip_logged` |
| Service completion / dispatch | `server/routes/admin-dispatch.js` | `service_complete`, `service_complete_with_invoice`, `service_complete_prepaid` | `getTemplate` helper and required helper | Required path throws; nullable helper returns no body for optional sends. | `required_fail` / `skip_logged` |
| Project report | `server/routes/admin-projects.js` | `project_report_ready` | `renderRequiredSmsTemplate` | SMS channel fails visibly; report send can still succeed via email. | `required_fail` |
| Service request confirmation | `server/routes/requests.js` | `service_request_confirmation` | `renderRequiredSmsTemplate` | Throws into request confirmation branch; route logs failure. | `required_fail` |
| Review requests | `server/routes/admin-reviews.js`, `server/routes/satisfaction.js`, `server/services/review-request.js` | `review_request`, `review_request_followup` | Required renderer or `getTemplate` | Admin/manual routes fail visibly; review engine has existing send/log handling. | `required_fail` / `skip_logged` |
| Referral flows | `server/routes/referrals*.js`, `server/routes/admin-referrals.js`, `server/services/referral-engine.js`, `server/services/workflows/referral-nudge.js` | `referral_invite`, `referral_enrollment`, `referral_reward`, `referral_milestone`, `referral_nudge` | Required renderer or nullable `getTemplate` | Invite/enrollment/reward paths fail visibly; nudge path skips when missing. | `required_fail` / `skip_logged` |
| Retention/customer intelligence | `server/services/customer-intelligence/retention-engine.js`, `server/services/health-alerts.js` | `health_*` | Required renderer or nullable `getTemplate` | Retention outreach fails visibly; health alerts skip when no body. | `required_fail` / `skip_logged` |
| Cancellation save | `server/services/workflows/cancellation-save.js` | `cancellation_save_*` | `renderRequiredSmsTemplate` | Throws; workflow logs/alerts around failed path. | `required_fail` |
| Lead webhook / lead response | `server/routes/lead-webhook.js`, `server/services/lead-response-agent.js` | `lead_auto_reply_biz`, `lead_safe_ack` | `renderRequiredSmsTemplate` | Throws and fails the reply path visibly. | `required_fail` |
| Lead intake branch replies | `server/services/lead-intake.js` | `lead_service_pest`, `lead_service_lawn`, `lead_service_one_time` | `getTemplate` helper | Logs and skips branch reply. | `skip_logged` |
| Email automation SMS companion | `server/services/email-automations.js` | `auto_*` | `getTemplate` | Missing DB SMS template logs a skipped SMS companion and records `template-missing` in `sms_result`; no inline fallback copy is sent. | `skip_logged` |
| New recurring welcome | `server/services/new-recurring-welcome-sms.js` | `auto_new_recurring` | `getTemplate` | Logs/sends according to service result; missing body records skipped template. | `skip_logged` |
| Onboarding | `server/routes/onboarding.js`, `server/services/onboarding-follow-up.js` | `onboarding_welcome`, `onboarding_followup_*` | `renderSmsTemplate` / `getTemplate` | Welcome path skips if missing; follow-up logs and skips SMS. | `skip_logged` |
| Renewal/reactivation/upsell | `server/services/workflows/renewal-reminder.js`, `seasonal-reactivation.js`, `upsell-trigger.js`, `routes/promotions.js`, `routes/admin-pricing-strategy.js` | `renewal_reminder`, `seasonal_reactivation`, `upsell_*` | Nullable or required renderer | Required/manual paths fail visibly; cron paths skip/log when missing. | `required_fail` / `skip_logged` |
| Lawn intelligence | `server/services/lawn-intelligence.js` | `lawn_health_report_ready` | `renderRequiredSmsTemplate` | Throws and fails SMS path visibly. | `required_fail` |
| Appointment prep tagging | `server/services/appointment-tagger.js` | `auto_cockroach`, `auto_bed_bug`, `auto_flea` (+ `auto_*_no_email` standalone variants) — the `pest_prep_*` keys were deleted in 20260602000002 | `renderSmsTemplate` | Logs and skips prep SMS when missing. | `skip_logged` |
| Call recording appointment confirmation | `server/services/call-recording-processor.js` | `appointment_call_confirmed` | `renderSmsTemplate` | Optional SMS path; logs around send failures. | `skip_logged` |
| Legacy direct Twilio helpers | `server/services/twilio.js` and callers passing `messageType` | message type mapped in `admin-sms-templates.js` | `isTemplateActive` | Logs `[SMS DISABLED]` and returns `templateDisabled`. | `kill_switch` |

## Fixes Applied In This Pass

- Added explicit missing/disabled/invalid template warnings to
  `server/services/estimate-follow-up.js`.
- Added explicit missing/disabled/invalid template warnings to
  `server/routes/admin-estimates.js`.
- Removed the inline fallback one-time SMS body from `server/routes/public-quote.js`.
- Removed inline SMS companion fallback copy from `server/services/email-automations.js`.
- Moved annual-prepay estimate acceptance SMS into protected template
  `estimate_accepted_annual_prepay`.
- Removed stale inline `smsTemplate` functions from
  `server/services/email-automations.js`.
- Added V2 SMS variant create/edit/delete controls backed by the existing
  variant routes.
- Added audit-log-backed recent template issue visibility in the V2 SMS
  Templates tab.
- Added workflow/entity context for estimate follow-ups, admin estimate sends,
  invoice sends, invoice follow-ups, public quote SMS, and email automation SMS
  companions.

These were the main paths where missing SMS copy could look like a simple
non-attempt or bypass the editable SMS template table.

## Remaining Risks

### 1. `TwilioService.sendSMS` kill switch is message-type based

Legacy callers that pass `messageType` can be suppressed by
`isTemplateActive(messageType)`, but the mapping is partial and separate from
the rendered template key. Modern `sendCustomerMessage` paths depend on the
template renderer behavior instead.

### 2. Some issue rows still lack full workflow/entity context

Central `getTemplate` misses now create issue rows, and the highest-volume
senders pass context. Lower-volume callers may still call
`getTemplate(templateKey, vars)` without a context object. The issue panel can
always identify the template and reason, but may not identify the exact workflow,
customer, invoice, estimate, or lead for those remaining callers.

## Recommended Next Fix

Pass `{ workflow, entity_type, entity_id }` context into the remaining lower-volume
senders, then consider grouping/filtering the issue panel by workflow if event
volume gets noisy.
