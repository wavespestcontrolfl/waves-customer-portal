# Admin invoices UI migration — September 9, 2026

## Scope and source

Applies the approved [Admin UI contract](admin-ui-consistency-contract.md) to the existing invoice directory, expanded invoice, creation/editing form, attachments, delivery, account-credit, payment-plan and annual-prepay dialogs. The saved-card sheet and dictation control retain their existing workflow owners and receive presentation appropriate to the migrated surface. No customer-facing invoice, payment, receipt or estimate presentation is included.

- Checkout: `wt-admin-ui-contract-invoices-20260909`.
- Branch: `codex/admin-ui-contract-invoices-20260909`.
- Base: `b7aabed2209346467724b838c3926d79ba9a0510`, including the owner-reviewed Recovery/Payers migration.
- Non-UI discoveries belong in the separate [bug register](../audits/admin-ui-non-ui-bugs.md).

## Inventory before implementation

| Surface | Existing reads and state | Existing writes and ownership |
| --- | --- | --- |
| Directory | `/admin/invoices`; `customer` and `customerId` query aliases; `invoice` expands a deep-linked record independently of pagination. Local status, date, sort and 300ms search; 100-row pages. `GET /admin/invoices` and `/stats`. | Existing selection eligibility, batch limits and `POST /admin/invoices/batch/send` or `/admin/invoices/batch/send-receipts`; invoice `/void`, `/unvoid`, `/reverse-prepaid`, `/archive`, `/unarchive`, `/payment-plan/cancel`. Existing confirmations remain required. |
| Payment notices | `GET /admin/invoices/payment-notices?status=parked&limit=100`; hidden when the server gate is off or the queue is empty. Candidate ordering and exact-amount eligibility remain authoritative. | Notice `/apply` and `/ignore`; applying can settle an invoice and send a receipt. |
| Expanded invoice | Existing status/date/deposit/annual-prepay classification and activity reconstruction; lazy attachments and `/followup` reads. Native `/pay/:token` copy and invoice/receipt PDF URLs remain unchanged. | Attachment multipart upload, signed URL read and delete; follow-up `/pause`, `/send-now`, `/stop`, `/resume`. Tap-to-pay uses the existing `launchTapToPay` owner. |
| Send invoice / receipt | `GET /admin/invoices/:id/recipients`; existing primary/billing recipient choices and override validation. | Invoice `/send` and `/send-receipt`, with unchanged override, save-default and delivery payloads. |
| Account credit / payment | Invoice `/credit-context`; recipient lookup; customer `/cards`. | Invoice `/apply-credit`, `/record-payment` and `/charge-card`; preserve full-coverage checks, waiver/note payloads, receipt choices, method IDs, and ambiguous-charge safeguards. |
| Annual prepay / payment plan | Invoice detail read populates existing coverage. Local coverage/cadence/visit-count validation and payment-plan fields. | Existing invoice `/annual-prepay` POST/DELETE and `/payment-plan` POST; dates, settlement, scheduling and delivery remain server-owned. |
| Create / edit | `/admin/discounts`, invoice customer search and service-record lookup, `/admin/services`; local customer, service, line-item, discount, notes, attachment, delivery and due-date state. Existing AI feature visibility and endpoint ownership. | `POST /admin/invoices`, `PUT /admin/invoices/:id`, attachments and `/send` or `/schedule-send`. Preserve edited-line-item omission, attachment sequencing, existing persisted-invoice recovery, and send-state verification before retry. |

The admin navigation/shell owns route access; the invoice page does not widen it. Saved-card charging, payment-plan cancellation and unvoid retain their explicit admin checks. Server guards and flags remain authoritative. Customer 360, estimate and dispatch files stay in their own workstreams.

Before migration the page uses local palette/style helpers, 10–13px readable text, undersized desktop actions, custom portaled overlays without the shared focus owner, unassociated fields, and an invoice checkbox nested in its expand button. These presentation/accessibility states are part of this migration.

## Verification

Implemented with `UiSurface` comfortable density and shared buttons, fields, inputs, selects, checkboxes, cards, badges, feedback and dialogs. The invoice checkbox is a sibling of the expansion button. Expanded-row state follows the URL effect; removing the duplicate immediate state write prevents fast Back navigation from retaining the wrong row during React's deferred route transition. The six invoice dialogs and opted-in saved-card sheet use the shared focus/safe-area owner. Invoice dictation and saved-card presentation require explicit `presentation="admin"`; existing Tech/Dispatch callers retain their presentation.

Read failures have explicit feedback and safe retries, including credit, annual prepay, recipients, attachments, follow-up and builder lookups. Customer/service searches ignore stale responses. Pending mutations retain button names and dimensions, disable conflicting inputs, and guard duplicate invocation. Failed form submissions retain their local draft. Browser-native confirmations and existing persisted-invoice/send recovery remain in their current owners.

- Focused tests: **67 passing** across invoice helpers, invoice workflows, saved-card safeguards and admin route permissions. Covers failed-send overrides, offline payment payloads, credit and annual-prepay read failures, payment plans, edit line-item omission, draft-only creation, saved-card decline/ambiguous-charge behavior, read retry and presentation opt-in.
- Production `npm run build`: passed, including repository prebuild checks; no dependency changes. Lint: zero errors; 16 structural complexity warnings remain in the large migrated controllers.
- API expression comparison: 48 calls before/after. All write expressions are identical; three read expressions use equivalent string concatenation and a renamed local service query. No server files, permission policies, feature-flag defaults or payment calculations changed. Server authorization remains `adminAuthenticate` + `requireTechOrAdmin`, followed by the existing owner-only invoice guard except the staff single-invoice read used for tendering.
- Invoice browser runner: `node scripts/qa/admin-invoices-foundation.js`. Actual React routes with synthetic local API responses and external requests blocked. Checks directory, expansion, builder, seven dialogs, direct links, refresh and Back/Forward, focus return, draft-only creation, failed mutations and same-payload retries, stable pending geometry, duplicate invocation, recipient overrides, credit read recovery, payment notices, list/stat failures and filtering.
- Required widths: 390, 700, 820, 1024 and 1440px; 844×390 landscape and 390×420 contracted keyboard viewport, in Chromium and touch WebKit. Checks readable text ≥14px, page title 22px, control heights ≥44px, labels and horizontal bounds.
- Shared catalog: `node scripts/qa/design-system.cjs` passed 63 size cases and desktop, mobile and WebKit contracted-keyboard scenarios. Tech: `node scripts/qa/tech-foundation.cjs` passed desktop and mobile workflows.
- Screenshots reviewed in-session: directory/expanded actions, builder and lower delivery/summary, invoice/receipt delivery, credit, payment, annual-prepay form/actions, saved cards and error states. Local gallery: `.tmp/admin-invoices-foundation/review.html`; exact browser source/evidence: `.tmp/admin-invoices-foundation/report.json`. Build/test/lint logs: `.tmp/invoice-{build,focused-tests,lint}.log`.

No database or migrations were run. No real customer, charge, provider delivery, AI generation or native payment handoff was exercised. Physical iPhone/PWA keyboard, notch/safe-area and installed-app behavior remain unverified; WebKit viewport checks are emulation. The existing two non-UI findings remain open in the separate bug register; no additional non-UI defect was confirmed in this slice.

Final browser source: `bc1787e8807bd8d0aa674e91b9e18049cf1f4d5a`, clean worktree (`dirty: false`). Both engines passed **192 geometry cases** and all workflow checks, including attachment removal/upload and failed batch-send retention/same-payload retry. The report records **38 screenshots**, zero page errors, zero unmatched API requests and no unexpected console errors. Expected synthetic 503 responses were checked separately. Production build and 67 focused tests passed on this implementation. This acceptance-only follow-up does not change product source.

Phone batch actions use their content width within the viewport cap. Phone feedback sits below the header so it does not cover the batch controls. The corrected phone batch screenshot was reviewed after the final browser run.

## Integration against current main — September 9, 2026

The integration branch `codex/admin-invoices-integration-20260909` builds on the
isolated Billing Recovery/Payers slice (`195f15804`, PR #4321), without importing
the original stack's unrelated Tech changes. It preserves the current invoice
status/error fixes. The newer caption-floor helper is removed with the rest of
the superseded page-local palette rather than restored into shared controls.

Fresh verification: 67 focused tests and the production build passed. The actual
invoice routes passed 192 geometry cases and both desktop Chromium/phone WebKit
workflows, including failure/retry and attachment/batch interactions; 38
screenshots were captured. Directory, builder, payment, delivery, saved-card,
and annual-prepay desktop/phone renders were inspected. There were no page errors
or unmatched APIs. Lint: zero errors, 16 existing structural warnings.

AST comparison against the integration parent found 46 `adminFetch` calls before
and after: all writes identical, three reads changed only in equivalent string
construction/local query naming. The earlier 48-call record refers to the older
local comparison method/source. No database, live charge, provider delivery, or
physical-device acceptance was exercised.
