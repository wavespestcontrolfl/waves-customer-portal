# Internal/Admin Email Notification Audit - 2026-05-25

## Scope

Reviewed the email notification surface with emphasis on admin/internal observability and older direct email paths.

## Findings

- The primary customer email path uses `EmailTemplateLibrary.sendTemplate`, which writes `email_messages` audit rows and provider snapshots.
- Admin notifications are mostly in-app `notifications` rows or internal SMS alerts, not email.
- Email template render/send failures were not visible in the same recent-issues workflow added for SMS templates.
- Missing templates, inactive templates, missing active versions, missing payload variables, production placeholder guards, and provider send errors could fail callers without a structured admin issue feed.

## Fixes

- Added structured `notification_template.email.render_issue` audit events from `EmailTemplateLibrary.sendTemplate`.
- Added `/api/admin/email-templates/issues` to return recent email template issues.
- Added an Email Templates UI `Issues` view for recent failures with workflow/entity context.
- Added focused tests for email issue audit writes and the admin issues endpoint.

## Notes

- No live email sends were triggered during this audit.
- Legacy SMTP wrappers remain in place for existing fallback behavior, but the audited path now covers the canonical template library.
