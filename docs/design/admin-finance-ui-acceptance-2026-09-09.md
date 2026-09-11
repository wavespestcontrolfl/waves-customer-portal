# Banking and Taxes UI migration — September 9, 2026

Applies the approved [admin UI contract](admin-ui-consistency-contract.md) after the owner-reviewed invoice slice. Checkout `wt-admin-ui-contract-finance-20260909`, branch `codex/admin-ui-contract-finance-20260909`, base `9816ffc5abc473dff8bd211c59b61026ddcf4873`.

## Inventory before implementation

| Surface | Reads / state | Existing actions and ownership |
| --- | --- | --- |
| `/admin/banking` | Local Payouts, Cash Flow, Reconciliation and Exports tabs; no tab query parameter. `/admin/banking/balance`, `/stats`, payout pagination and lazy payout detail, cash-flow dates, reconciliation list and date-filtered export preview. | Standard/instant payout POSTs retain amount, method-specific available limit, fee display and existing idempotency key lifecycle. Reconciliation POST retains actual amount/notes. CSV/OFX exports retain authenticated blob download and filenames. Stripe dashboard link remains external. |
| `/admin/tax` | Local leaf selection grouped under Overview, Tax Setup, Expenses, Revenue, Assets, Reports, Exports & A/R. Bank Import leaf exists only when server `/admin/tax/bank-import/status` reports enabled; failed reads remain closed. Dashboard, rates, service taxability, equipment, expenses/categories, filing calendar, advisor reports/alerts, exemptions, mileage/stats, revenue/reconciliation, P&L, A/R and bank-import reads. | Preserve service taxability confirmation/update; equipment add/update; expense add/auto-categorization; filing update; advisor run and alert status; mileage add/sync/bulk classification; revenue settings confirmation/update; authenticated exports; A/R reminder confirmation and `/admin/sms/send` payload. Bank import retains existing POST owner, match/refund/payout/category/disposition actions, paging, confirmations and undo rules. |

Both destinations are admin-only in the shared navigation/route policy. Tab switching currently unmounts inactive content and resets its local drafts; this migration preserves that reset boundary and adds no persistence promise. The banking payout dialog owns amount, method and retry key; a failed attempt must keep the same key. Failed edits must retain form values. Back/Forward and refresh retain the existing route semantics, including the absence of tab URL persistence.

Before migration both pages use local palettes, undersized controls and 10–13px text. Banking has a custom portaled payout dialog. Taxes includes inline creation/edit forms, expanding rows, clickable summary cards and two navigation levels. Presentation, accessible controls, safe overlay behavior and explicit read/pending/error states are included; calculations, rates, financial rules, endpoints and server permissions are not changed. Functional/data findings belong in the separate [non-UI bug register](../audits/admin-ui-non-ui-bugs.md).

## Implemented

Both pages now start a comfortable `UiSurface` and use the shared header, buttons, fields, selects, badges, cards, tables and action feedback. Removed their page-local palettes, button/input/tab style helpers and the banking payout portal. The payout dialog now uses the shared focus, Escape, pending and safe-area owner. The four Banking tabs and seven Taxes groups retain the existing local state and leaf selection.

Form controls have visible labels, 16px input text and 44px minimum targets. Page titles are 22px; section headings are semantic 18px headings; other readable text stays at least 14px. Payout choices, equipment summaries and mileage fields wrap on phones. A/R dates and money stay together in horizontally scrollable tables. Bank-import file selection remains keyboard-accessible, and failure notices are announced. Red denotes errors or overdue values, rather than ordinary outflow or a zero aging bucket.

Read failures have explicit feedback and safe retry; failed balance reads keep payouts disabled. Failed drafts stay with their existing form controller. Mutations have synchronous duplicate guards and pending controls. Payout amount/method changes retain their existing retry-key lifecycle. Tab changes still unmount inactive forms. Bank import retains the original file-reselection behavior after a failed ordinary upload and preserves the existing duplicate-confirmation token workflow.

## Verification

Checked source: `779f991f2ed16e8a868caa6198db29bf5f5a31e1`, clean worktree at browser start. The later acceptance-only commit changes no product or QA code.

- `npm test --workspace client -- src/pages/admin/AdminFinanceFoundation.test.jsx src/components/AdminLayoutV2.test.jsx`: **33 passed**. Covers payout retry/idempotency and duplicate prevention, failed balance read, reconciliation payload/draft preservation, canceled/failed taxability changes, failed expense draft and read retry, the bank-import status gate, and admin route denial for CSR/technician roles.
- `node scripts/qa/admin-finance-foundation.js`: **322 layout cases** across Chromium and touch WebKit, with 70 desktop/phone screenshots. Covers all four Banking tabs, expanded payout transactions, standard/instant dialogs, all 14 Taxes leaves and expense/equipment creation forms at 390, 700, 820, 1024 and 1440px, plus 844×390 landscape and 390×420 contracted keyboard viewports.
- Both engines exercised direct load, refresh, Back/Forward, payout Escape/focus return, failed/same-payload retries for standard/instant payouts, reconciliation, expenses, equipment, mileage creation/classification, paid filing updates, bank-import upload/category override/create-expense/ignore, empty equipment, failed expense reads and failed balance reads. There were no unmatched API requests, page exceptions or unexpected console errors; 503 messages were the deliberately injected failures.
- `node scripts/qa/design-system.cjs`: **63 size checks and three scenarios passed**, including fine/coarse pointer, desktop/mobile and WebKit contracted keyboard viewport; nine catalog screenshots. Catalog source was clean `a6cc096f9e64e08e1ee1b2d49fe95a4d4a6bcef1`; the subsequent change only adjusts bank-import account wrapping and its synthetic fixture.
- Production `npm run build`: **passed**. ESLint: **zero errors**, with eight structural complexity warnings in the large finance functions; some counts increased with explicit pending/error branches. `git diff --check`: passed. No new dependencies or shared-shell presentation changes.
- Compared normalized AST expressions for all **16 direct `adminFetch` write calls** against the original pages: no endpoint, method or payload-expression changes. The generic bank-import action wrapper is included in that comparison. Server inspection confirmed `adminAuthenticate, requireAdmin` on both finance routers. Provider behavior, persistence and calculations were not changed or claimed as newly validated.

Screenshots were inspected in-session, including phone totals, payout choices, mileage entry, bank-import controls, long report sections and failed drafts. Local evidence:

- `.tmp/admin-finance-foundation/review.html` — paired review gallery.
- `.tmp/admin-finance-foundation/report.json` — source stamp, viewport measurements and intercepted requests.
- `.tmp/design-system/browser/report.json` — catalog evidence.
- `.tmp/finance-tests.log`, `.tmp/finance-build.log`, `.tmp/finance-api-writes.json` — focused checks and payload comparison.

All browser API responses and writes used synthetic local fixtures; external requests were blocked. No database, migrations, provider payout, customer reminder, real bank import or external AI generation was exercised. Physical iPhone/PWA keyboard and notch behavior remain unverified beyond viewport/WebKit emulation. No CI, PR, deployment or merge was initiated for this local review slice. No new non-UI defect was confirmed; the separate register retains its two open findings.

## Integration against current main — September 9, 2026

Branch `codex/admin-finance-integration-20260909` carries the existing accepted
Banking/Taxes slice after the isolated Billing/Payers and Invoice integrations.
It excludes unrelated Tech work from the original stack. Conflicts with the
new caption-floor changes resolve to shared readable controls; the superseded
local palette, badge and table-style helpers are removed.

Fresh verification: 34 focused tests and production build passed. The browser
runner passed 322 layout cases across Chromium desktop and touch WebKit, captured
70 screenshots, and reported no page errors or unmatched APIs. Representative
Banking/payout, Taxes overview, expense, bank-import and receivables renders were
inspected on desktop and phone. Lint has zero errors and eight existing structural
warnings. API AST comparison confirms all direct write expressions remain
identical; repeated tax reads now use the existing migration's read helper.

Evidence lives in `.tmp/admin-finance-foundation/` in the task-owned integration
checkout. This is synthetic frontend evidence; no live payout, reminder, bank
import, database or physical-device acceptance was exercised.

Pre-push review identified a bank-import pagination race during filter changes.
The integration clears stale rows/pagination and blocks overlapping page reads.
A deferred-response regression failed before the fix and passes afterward; the
production build and full finance browser runner also pass on the fixed code.

## Integration review corrections — September 9, 2026

- Routine cash-flow expenses and the tax-liability total use neutral zinc;
  genuine shortfalls, negative net, and error states retain alert red.
- Payout cells activate the existing disclosure, while its native date button
  supports Enter/Space and stops click bubbling to prevent double activation.
- The header Standard Payout action focuses its opener before mounting the
  shared dialog, matching the existing hero actions and restoring WebKit focus.
- Revenue browser fixtures now use the server's `totalRevenue`, `taxCollected`,
  and unknown-liability `taxOwed: null` fields. Request contracts are unchanged.

Verification: the header-focus regression and payout-cell browser check failed
before the fixes. All 35 finance/layout tests and the production build pass.
The expanded Chromium/WebKit suite passes 336 layout cases and its workflow
checks, with 72 screenshots and no page errors or unmatched requests. A final
focused visual run after the tax color/fixture correction passes 28 additional
layout cases across desktop and phone, with four inspected screenshots. The
coverage gate remains at zero source drift, and portal brand checks pass.
Evidence: `.tmp/admin-finance-foundation/report.json`,
`.tmp/admin-finance-review-colors/report.json`, and the integration PR's native
image attachments. All APIs are synthetic; no live financial actions occurred.

### Matched-count readiness follow-up

The Matched card now uses the same existing `countsReady` state as its adjacent
cards, while preserving the loaded sum of matched expenses and payouts. Two
regressions fail before the correction and pass afterward, covering pending,
failed, loaded-zero and loaded-nonzero results. All 37 finance/layout tests,
the production build, brand and request-census checks pass. A focused
Chromium/WebKit run verifies 42 layout cases over pending, failed and recovered
zero states, with six screenshots and no page errors or unmatched requests
(`.tmp/admin-finance-matched-states/report.json`).

### Width, numeric typography and credit label follow-up

Banking and Taxes retain the shared centered 1300px workspace cap and use
Roboto with tabular numerals through `u-nums`. Credit matching is labeled
“Match payout or refund”; the debit expense label is preserved. The current
request census validates all 63 present Banking/Taxes references; only 62
owned `ui.line` values changed in the manifest, with all other fields intact.

The production build, all 37 finance/layout tests, all eight census tests,
brand and zero-drift coverage checks pass. The expanded synthetic Chromium
and WebKit run passes 384 layout cases across eight widths (including
1920px), checking the width cap and numeric font rules. A focused credit
selector run passes 32 additional layout cases, enables the payout and refund
actions for their respective selections, and supplies four desktop/phone
screenshots. No page errors or unmatched API requests occurred. Evidence:
`.tmp/admin-finance-foundation/report.json` and
`.tmp/admin-finance-credit-picker/report.json`.
