# Admin/Internal Notification Audit - 2026-05-25

## Scope

Reviewed admin/internal email notification surfaces after the customer template and automation guardrail work.

## Finding

Admin test-send endpoints accepted any recipient email:

- `POST /api/admin/email-templates/versions/:id/test`
- `POST /api/admin/newsletter/sends/:id/test`

These routes are admin-only and send test messages, but an accidental customer address could still receive a template/newsletter preview.

## Fix

Added a shared internal email recipient guard for admin test sends:

- Allows the logged-in admin's email.
- Allows Waves-owned domains by default.
- Allows explicit env allowlists for outside admin/test inboxes.
- Rejects malformed addresses and customer-looking recipients before provider calls.

## Verification

- `server/tests/internal-email-recipients.test.js`
- `server/tests/admin-email-templates-routes.test.js`
- `git diff --check`

No customer SMS or email sends were performed.
