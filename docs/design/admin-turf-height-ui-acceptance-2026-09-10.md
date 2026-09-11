# Turf height review UI migration — September 10, 2026

Scope: `/admin/turf-height`, in `client/src/pages/admin/TurfHeightReviewPage.jsx`. Base: `d97492b34` on `codex/admin-turf-height-ui-20260910`. This is one legacy page migration under the admin UI consistency contract; other legacy pages remain out of scope.

## Existing workflow inventory

- Direct route `/admin/turf-height`; the page does not consume or modify query parameters. App routing and navigation remain unchanged.
- Initial load and Refresh: `GET /api/admin/turf-height/review`, bearer token from `waves_admin_token`; configured `VITE_API_URL` remains supported.
- Confirm: `PATCH /api/admin/turf-height/:id/resolve`, body exactly `{ "status": "verified" }`, using the same token and headers. A successful response removes only that row. Failure retains the row and its own error. Manual height is never edited.
- Data: customer identity, Eastern measurement date, grass type, target band, gauge photo or missing-photo placeholder, manual reading, OCR reading/unread state, and confidence. Missing readings remain different from numeric zero.
- Server authorization remains `adminAuthenticate` plus `requireTechOrAdmin`. This migration changes neither client access rules nor the server. The browser fixture uses an admin account; live staff authorization is not re-proved by this client-only check.
- Existing loading, failed read, empty queue, refresh, and row-specific failure states remain. Refresh is the existing read retry. No new mutation, confirmation dialog, or customer communication is added.

## Presentation changes

The page now uses a comfortable `UiSurface`, workspace `AdminCommandHeader`, shared `Card`/`CardBody`, `Button`, and `ActionFeedback`. The local palette, font stack, duplicate page padding, pill buttons, small labels, and bold numeric styling are replaced with the shared admin presentation. Reading values use tabular numerals; cards wrap on narrow viewports and confirmation buttons fill the phone card width. The discrepancy border and OCR alert remain red; unread OCR remains neutral.

Pending buttons retain the accessible name “Confirm reading” and use the shared spinner. A per-reading in-flight guard prevents duplicate confirmation while allowing different readings to finish independently. This is the only action-control change; request payloads and success/failure semantics remain unchanged.

## Verification

- Focused client suite: 5 tests pass. Corrected historical fixtures to use the actual API field names and corrected the cross-row test to select the second customer. Coverage includes server/network failures, retained row errors, concurrent pending confirmations, request payload/token preservation, read retry, and missing versus zero.
- Browser proof: `node scripts/qa/turf-height-ui.cjs`. Actual app route with synthetic API fixtures; external requests and WebSockets blocked, usage tracking fulfilled locally. Checks Chromium/fine pointer and WebKit/touch at 390, 700, 820, 1024, and 1440px, each at 900px and 390px height (20 cases). Checks minimum 44px buttons, 14px button text, no document overflow, discrepancy border, keyboard confirmation, failed-save retention, retry, successful removal, empty state, read failure/recovery, refresh, and retained query string.
- Shared catalog: `node scripts/qa/design-system.cjs` printed successful results for all 63 geometry cases and desktop, mobile, and contracted WebKit interaction scenarios. It then stalled during cleanup before updating its final report and was stopped. This is not a clean runner exit; `/tmp/turf-height-ui-catalog.log` records the completed assertions. The stale report from the earlier font setup failure is not final evidence. The page-specific browser runner completed and saved its successful report.
- Production build: `npm run build` passed, including blog-schema, affiliate-registry, portal-brand, and domain-rule prebuild gates.
- Scoped ESLint and `git diff --check` pass.

Browser artifacts: `.tmp/turf-height-ui/report.json`, `desktop.png`, `mobile.png`, `desktop-error.png`, and `mobile-error.png`. Desktop and mobile screenshots were inspected for layout, typography, action reachability, and error presentation. The initial screenshot inspection caught a shared-card border precedence issue; the final source explicitly preserves the discrepancy border and the browser proof checks its computed color.

Local Node 20 is used. Dependencies were copied into this checkout after dependency symlinks caused Vite to deny local font assets. No dependency manifest changed.

## Limits

This record describes local implementation evidence before PR publication. No database migration, provider request, or real-record mutation was performed during verification. PR review, CI, merge, and deployment status must be checked separately. Browser fixtures do not prove server/database behavior. Physical iPhone/PWA safe areas and software keyboards remain unverified; contracted browser viewports do not replace a device check. No inputs or overlays were added to this page.
