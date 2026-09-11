# Admin billing UI migration — September 9, 2026

## Scope and source

First bounded expansion of the approved [Admin UI contract](admin-ui-consistency-contract.md) beyond Customer 360, Estimates and Tech. The [Tech contract](tech-foundation-contract.md) and the three foundation acceptance records were reviewed; their workflow ownership and verification limits remain applicable.

- Checkout: `wt-admin-ui-contract-billing-20260909`.
- Branch: `codex/admin-ui-contract-billing-20260909`.
- Foundation base: `0c6337adc683d14ce046a3b391dafa7e248dd2fe` from the referenced device-preview checkout.
- Declared scope: `BillingRecoveryPage`, `PayersPage`, `PayerDetailSheet`, `PayerArAgingDialog`.
- Two shared presentation corrections are included: `AdminCommandHeader` uses 22px phone titles for its workspace variant; `ui-section-tab` supplies its 54px control token so the global touch rule cannot shrink tabs inside a dialog. Legacy headers retain their scale. Shell layout, navigation registry, Customer 360, estimate and Tech workflow files stay with their existing workstreams. No repository-wide style replacement.
- Non-UI discoveries live in the separate [bug register](../audits/admin-ui-non-ui-bugs.md).

## Inventory recorded before implementation

| Surface | Existing route and state | Reads | Actions and payload ownership |
| --- | --- | --- | --- |
| Billing recovery | `/admin/billing-recovery`; no page query parameters; local 30/60/90/365-day filter, default 90 | `GET /admin/billing-recovery/leaks?days=…`, `/aging`, `/at-risk-mrr` | `POST /:scheduledServiceId/bill` with `{}`; `/dismiss` with `{reason}`. Existing recurring-billing confirmation, free-reason taxonomy, date/money formatters and classification stay authoritative. Completion links retain `/admin/dispatch?tab=schedule&date=…&completeService=…`; account links retain `/admin/customers?customerId=…`. |
| Payers directory and editor | `/admin/payers`; search and inactive filter are local, with a 200ms search delay; selection/editor are local | `GET /admin/payers?search=…&includeInactive=true`, optional `GET /admin/payers/:id` from aging selection | Create `POST /admin/payers`; edit `PUT /admin/payers/:id`; same full snake-case form body, terms and boolean values. New/edit reset the form; failed saves retain it; closing or reloading does not promise recovery. |
| Payer statements and aging sheet | Directory-owned payer selection; local Statements / AR tabs and one expanded statement | `GET /admin/payers/:id/statements`, `/:id/ar`, `/:id/statements/:statementId`, and `/followups` | Same statement routes: `/close` with `{send:true}` or `{}`; `/send` with `{force:true}` only for finalized statements, otherwise `{}`; `/reconcile` with `{method,amount}`; `/followups/send-now`, `/pause`, `/resume`, `/stop` with `{}`. Status predicates and server authorization remain authoritative. |
| Cross-payer AR dialog | Opened by AR aging; choosing a payer hands selection back to the directory | `GET /admin/payers/ar-aging` | No mutation; existing payer-selection handoff. |

Both routes are admin-only in `client/src/config/adminNavigation.js` and both server routers apply `adminAuthenticate` plus `requireAdmin`. `AdminLayoutV2` checks its server-returned role before mounting restricted content; CSR and technician access must stay denied. No role or route changes are included.

Before migration these pages use legacy-density primitives, 11–13px captions, unassociated/local form labels, horizontally scrolling tables and fixed two-column editor rows. The statement sheet uses unmounting tabs. Failures in payer reads can be shown as empty lists/balances; recovery metrics render missing data as zero. These presentation and feedback states are part of this migration.

## Implemented presentation and state behavior

Both pages opt into `UiSurface density="comfortable"` and the workspace command header. Shared fields/choices replace local labels and native control styling. Readable text is at least 14px, fields are 16px, actions are at least 44px, and payer section tabs are 54px. Record tables keep their semantic headers and add mobile captions. Money/dates/counts use tabular numerals. The editor stacks its fields on phones; row actions wrap. Status chips stay intrinsic-width inside mobile record cells.

Read failures render `ActionFeedback` with safe read retries. Loading and unavailable metrics render placeholders rather than zero; successful zeros remain visible. Payer reads distinguish empty results, filtered no-results and errors. Directory rows remain mounted while refreshing so a saved editor can return focus to its opener. AR-to-sheet navigation explicitly remembers the persistent AR button rather than the worklist row that is being removed.

Mutation endpoints, payload construction and status eligibility stay in their existing controllers. Pending writes have a synchronous caller guard, disabled form controls and stable button labels/spinner space. No automatic mutation retry is added. Failed payer saves, free-visit dispositions and offline-payment saves keep their input. Opening a free-visit form starts a new visit-owned draft; cancelling discards it. The statement panel explicitly stays mounted across AR tab navigation, hidden/inert while inactive. Closing the sheet, selecting another statement or changing the payer clears its payment form. The sheet is keyed by payer; server-verified role removal still unmounts restricted content. No refresh/offline draft persistence is promised.

The two non-UI defects in the linked register remain open, including the existing full-string amount-validation gap. This UI proof does not certify backend billing correctness.

## Verification

Final billing product and runner source: **`009378c9e40f10a26b5cb170fefa10473969ee58`**, following the initial migration commit `416710ec91c4b63886f7303d84d8e0d8eee0851a`. The final browser report records the clean product commit. A subsequent documentation-only commit records these results.

| Check | Result and evidence |
| --- | --- |
| Focused client tests | **11 files / 77 tests passed**, covering billing helpers, read errors versus zero/empty results, save payloads, pending duplicate suppression, failed-save retention, visit/payer draft isolation, shared primitives, navigation and the admin shell. Includes explicit CSR and technician denial for both migrated routes. `.tmp/admin-billing-tests.log`. |
| Production build | **Passed**, including brand/domain and vendor prebuild checks. `.tmp/admin-billing-build.log`. |
| Actual billing routes | Chromium desktop and touch WebKit phone passed filtering, empty search/clear, payer edit failure/retry with identical payload, free-visit failure/retry, offline-payment failure/retry, section draft retention, read failures and safe retries, partial at-risk data, direct loads, refresh and Back/Forward. Existing completion/customer link destinations and query parameters were checked without entering those separate workflows. |
| Billing geometry | **92 cases passed**: six migrated compositions at 390, 700, 820, 1024 and 1440px, 844×390 landscape and a 390×420 contracted viewport, plus the four workflow compositions, in each browser/pointer configuration. All measured actions at least 44px; section tabs at least 54px; fields at least 16px; readable text at least 14px; Roboto; no document overflow, unlabeled fields or wrapped currency amounts. `.tmp/admin-billing-foundation/report.json`. |
| Pending/focus | Stable pending button width/height and accessible names; repeated invocation suppressed; Escape/opener return; editor focus survives directory refresh; AR-to-sheet handoff returns to the persistent AR opener. Payment draft fields retain their values after failure and across the hidden/inert statement panel. |
| Shared Admin catalog | **63 size cases / 3 interaction scenarios passed** at `416710ec9`, including desktop, phone and contracted WebKit keyboard viewport. `.tmp/design-system/browser/report.json`. The later currency-cell change does not modify the shared header, tabs or catalog. |
| Tech foundation | **Both workflows / 48 geometry cases passed** at `416710ec9`; 35 screenshot files. `.tmp/tech-foundation/current/report.json`. The later currency-cell change does not modify Tech or shared primitives. |
| Review hygiene | `git diff --check` passed; ESLint has zero errors and reports complexity warnings for the two page render functions (Billing recovery: 44; Payers: 26). No new dependency, backend, route, role, or provider change. |

The reproducible runner is `node scripts/qa/admin-billing-foundation.js`; evidence is written under `.tmp/admin-billing-foundation/`. It removes stale evidence at startup, records source identity, verifies fonts and the real routes, blocks external/socket traffic and fulfills exact API methods/paths with synthetic data. Usage keepalive pings are fulfilled in-page so navigation cannot escape Playwright interception. Deliberate 503s are distinguished from unexpected console errors. The passing run has no page errors or unmatched requests, and no delivery action is invoked.

Twelve billing screenshots were captured and desktop/phone renders visually reviewed. The session's local review gallery is `.tmp/admin-billing-foundation/review.html`. The runner itself writes the report and screenshots; another run removes that one-off gallery along with older evidence. Screenshot pairs use `desktop-` and `touch-webkit-` prefixes with these suffixes: `recovery.png`, `free-visit.png`, `payers.png`, `payer-editor.png`, `statement.png`, `payer-aging.png`. The desktop aging review caught a split currency value; the final change keeps those numeric cells on one line, and the runner now rejects wrapped amounts.

Reproduce from this checkout with Node 20:

```sh
npm run dev:doctor -- --frontend
npm test --workspace client -- --run src/pages/admin/AdminBillingFoundation.test.jsx src/pages/admin/BillingRecoveryPage.test.jsx src/components/AdminLayoutV2.test.jsx src/components/AdminLayoutV2.badge.test.jsx src/components/admin/AdminCommandHeader.test.jsx src/config/adminNavigation.test.js src/components/ui
npm run build
node scripts/qa/admin-billing-foundation.js
node scripts/qa/design-system.cjs
node scripts/qa/tech-foundation.cjs
```

Local setup completed with Node 20.20.2, checkout-local dependencies, `worktree:setup` and frontend `dev:doctor`. No database/migration, real account, provider delivery, deployment or CI run was exercised. Native 200% browser zoom/text-resize settings and physical iPhone installation, notch/safe areas, software keyboards and attached-keyboard behavior remain manual checks. A contracted emulated viewport is not an installed-device keyboard test. This record covers the first billing slice, not acceptance of every admin page.

## Integration against current main — September 9, 2026

The financial integration checkout starts at `8ec8aae2e`. It carries only the
Billing Recovery/Payers slice from the original local stack. The shared command
header stays at current main because its title sizing has already landed and
Equipment has active work in that file. Current payer read-error handling is
retained with the foundation feedback and stale-request protection. The existing
payer failure regressions now use the shared retry label and the server-shaped
empty aging response.

Fresh verification: 89 focused tests passed, production build passed, and both
Chromium desktop and touch WebKit workflows passed all 92 geometry cases with
zero unmatched requests or page errors. Desktop and phone directory, recovery,
editor, statement/payment, and aging screenshots were inspected. Lint has zero
errors and two existing page complexity warnings (44 and 26). Evidence is local
under `.tmp/admin-billing-foundation/`; this is synthetic frontend verification,
not production, provider, database, or physical-device acceptance.

## Integration review corrections

Restored the existing payer empty-state content and search behavior, plus existing
read-error/loading copy. The shared ActionFeedback retry label comes from the
existing UI foundation. Reminder-status read failures now show retry feedback
alongside the statement-authorized controls. A synthetic regression confirms a
sent statement can still submit its unchanged reminder endpoint/payload after
the read fails; it failed before the correction and passes afterward.

## Separate functional precursor

PR #4325 now owns unavailable-versus-zero billing metric semantics and malformed
payer read handling. The visual PR is stacked on that functional correction.
The visual integration also clears an old Bill failure when the visit window
changes or another recovery action begins. Both regression scenarios fail before
the correction and pass afterward; reminder and metric regressions remain covered.
