# Email Automation Runner Audit - 2026-05-25

## Scope

Reviewed the legacy local automation runner in `server/services/automation-runner.js` and the SendGrid webhook path that handles `automation_step_sends` events.

## Findings

- Automation steps sent directly through SendGrid after creating an `automation_step_sends` row, but did not check local `email_suppressions` first.
- Automation webhook bounce, spam, unsubscribe, and group unsubscribe events cancelled active enrollments, but did not create local suppression records for future re-enrollments.

## Fixes

- Added local suppression checks before real automation sends.
- Mapped automation `asm_group` values to local preference groups:
  - `newsletter` -> `marketing_newsletter`
  - `service` -> `service_operational`
- Mark suppressed automation attempts as `blocked` in `automation_step_sends`.
- Cancel suppressed enrollments so the scheduler does not retry the same recipient.
- Recorded local suppression rows from automation SendGrid events using the same suppression event mapping as email template sends.

## Verification

- `server/tests/automation-runner.test.js` covers suppression group mapping, suppression matching, active suppression lookup, and blocked automation sends without calling SendGrid.
- `server/tests/newsletter.test.js` covers automation ASM group ID to local preference group mapping.
- No customer SMS or email sends were performed.
