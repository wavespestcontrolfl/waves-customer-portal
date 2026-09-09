# Equipment UI migration — September 9, 2026

Applies the approved admin UI contract to Equipment. The review series is indexed in [PR #4230](https://github.com/wavespestcontrolfl/waves-customer-portal/pull/4230), based on refreshed main `0738c95dd462bc7f3429e2eae7aeda314e8701b0`. Mechanical preparation, focused UI slices, and browser evidence have separate review diffs. Child PRs remain drafts. During integration, retarget each child to main before its parent is squash-merged, then run the normal final merge gate.

## Inventory before implementation

`/admin/equipment` retains four groups and six leaves: Assets; Maintenance/Calibrations; Tank Mixes; Job Costing/Analytics. `?tab=` aliases `equipment`→assets and `fleet`, `vehicles`, `mileage`→maintenance remain. Selecting a leaf replaces the URL entry and preserves other parameters. The existing role policy uses the shell's verified user; Job Costing and Analytics are owner-only. Embedded maintenance/calibration components have no other production callers.

| Surface | Reads | Writes and state ownership |
| --- | --- | --- |
| Assets | `/admin/equipment/equipment` | POST/PUT equipment with existing numeric/null coercion. Parent owns edit draft; tab unmount currently removes its dialog. |
| Maintenance | `/admin/equipment-maintenance`, `/analytics/overview`, `/alerts?status=new`; expanded equipment detail, vehicle mileage | Alert resolution; maintenance-record and mileage forms retain exact payloads and existing reset-after-save. Filters/sort and expanded record stay local. |
| Calibrations | `/admin/equipment-systems`, `/reconciliation`, selected system detail | Calibration POST and field-verification POST retain carrier-rate computation, timestamps, optional fields, confirmation/reset behavior. Selection and drafts stay in the panel. |
| Tank Mixes | `/admin/equipment/tank-mixes` supporting both response keys | Recalculate POST; preserve stale-request guard, retained rows on failed refresh and current recipe/cost calculations. |
| Job Costing / Analytics | Job-cost summary/list; fleet costs/reliability/mileage summary/due schedules/recent records | Read-only financial displays retain calculations, response aliases and owner UI restriction. |

Before migration these files use local palettes, small text/controls, an equipment edit portal and clickable card divs. This slice updates presentation, semantics, pending/error/retry states and focus behavior. It does not change calculations, financial/treatment rules, server authorization or endpoints. Non-UI findings belong in the separate bug register. All QA uses synthetic frontend fixtures with external requests blocked; no database, provider, live equipment, calibration or customer records will be written.

## Implementation

Completed the Equipment implementation and prepared the review series. Existing maintenance/fuel/book-value fields remain as requested. The separate authorization and date fixes are linked below.

- The page uses the comfortable shared surface, command header, cards, labeled fields, buttons, tables and equipment edit dialog. Secondary navigation uses the shared section-tab variant while retaining keyboard operation, existing group/leaf routes, and query replacement behavior. Shared command headers on migrated surfaces keep the contract’s 22px title and 1.3 line height on phones; legacy density and secondary heading behavior remain covered by existing tests.
- Save actions expose stable loading states, reject duplicate invocation, keep failed drafts, and display errors before a retry. Successful actions retain the existing payload coercion, toast, refresh and reset behavior. The equipment dialog keeps focus on return and stays open during a pending save.
- Read failures distinguish unavailable data from an empty result and offer a local retry, including equipment details and calibration details. Analytics loading and failure states are independent of Fleet equipment, overview and alert reads; an unrelated Fleet failure cannot suppress successfully loaded analytics. Job-cost missing metrics remain distinct from zero.
- Cost-chart text remains at 14px at its rendered size. The chart scrolls horizontally on narrow screens. Maintenance tables retain enough column width for dates and currency values, with scrolling contained inside the card. Long asset identifiers wrap without moving Edit off-screen.
- Corrected the unfinished toast condition, invalid table-footer whitespace and missing tank-mix pending indicator. No server routes, business calculations or provider integrations changed.

## Verification

The combined browser pass ran in the isolated `wt-equipment-acceptance-20260909` checkout based on preparation commit `6dc491c69ea1f77407a280b19f868e4757bb3e77`, with the final UI sources applied. It is a content-verified working-tree run, not a claim that the preparation commit alone contains the UI. The report records SHA-256 digests for the three Equipment modules, shared command header, and QA runner; those digests are checked when the combined sources are applied to the QA child. The final run started at `2026-09-09T10:40:30.557Z`.

| Check | Result |
| --- | --- |
| Frontend preflight | Passed on Node 20.20.2. Integration credentials excluded; background jobs disabled. |
| Focused ESLint | Zero errors. Five warnings: complexity in the three Equipment components and the shared command header, plus the unused legacy `MaintenanceTab`. The header’s density-aware title branch adds its complexity warning (21 versus the threshold of 20). |
| Existing tank-mix regression suite | All 8 tests passed, including failed refresh, retry, response aliases, stale StrictMode completion and unmount. |
| Existing command-header suite | All 4 tests passed, retaining legacy sizing, heading hierarchy, sticky behavior and navigation semantics. |
| Intelligence Bar coverage | Exact request fingerprints pass the census gate and remain counted as unsupported capability work. The existing 8-test coverage suite guards fresh/complete acknowledgments and the unsupported denominator. |
| Browser geometry | 214 cases passed: 107 in Chromium and 107 in touch WebKit. Covers all six leaves, add/edit dialogs, equipment details, both maintenance forms, calibration forms, error states and a long asset name. |
| Browser behavior | 66 recorded checks passed across both browsers. All eight writes passed duplicate-submit, stable pending geometry, failed-draft, retry and exact-payload checks. Read retries, empty states, missing versus zero metrics, URL aliases, refresh/history, keyboard tabs and verified-role restrictions passed. Analytics remains visible with each of the three Fleet reads failed or held pending (six checks per browser); the new regression failed against the prior Fleet source before the fix. A 30-row mileage fixture confirms that the header remains fixed while rows scroll; this assertion failed before the scroll-wrapper fix. Both maintenance forms prevent Cancel/collapse while pending, including in the standalone Details draft. |
| Request/calculation comparison | AST comparison against main `0738c95dd462bc7f3429e2eae7aeda314e8701b0` matched 27 request-path expressions, 8 serialized-body expressions, and 5 calculation/navigation helper functions. Browser writes also checked concrete numeric, string and null payload values. |
| Production build | Passed, including blog-schema and affiliate-registry verification, portal-brand checks, domain-rule checks and Vite compilation. |
| Diff whitespace | `git diff --check` passed. |

Geometry checks use 390, 700, 820, 1024 and 1440px widths, 844×390 landscape and a contracted 390×420 viewport. They enforce a 44px control floor, 16px field text, 14px readable text (including SVG scaling), accessible field labels, visible action bounds, and single-line date/currency cells. Deliberate table and navigation scrolling stays inside its own region.

Fixtures supplied server-verified admin, technician and synthetic CSR roles while cached browser identity remained admin. These are UI role checks; they do not establish backend authorization. Every API response was synthetic. Expected 503 failures were injected; there were no unexpected browser errors, unmatched API routes or requests forwarded to a backend. Navigation drops synthetic auth before unload usage beacons can outlive interception.

## Visual evidence and local artifacts

The combined local gallery in `wt-equipment-acceptance-20260909` is `.tmp/admin-equipment-foundation/review.html`, with 60 screenshots from the final main harness. Named targets are scrolled into view and their viewport bounds are asserted before capture. Separate fields/actions images cover maintenance, mileage, calibration and verification on desktop and phone; failure captures show the error and retained action/draft, and the analytics chart is captured after horizontal scrolling. Desktop and phone captures are native attachments on the relevant UI drafts and the acceptance drafts linked from #4230. Visual review covers the shared monochrome presentation, readable fields, edit dialog, horizontal table/chart access, and the long-name Edit action. The final phone tables keep dates and currency on one line instead of breaking them into narrow fragments.

- `.tmp/admin-equipment-foundation/report.json` — source hashes, geometry, requests, assertions and screenshot inventory.
- `.tmp/equipment-browser-regression.log` — full browser result, including the Fleet/Analytics independence regression.
- `.tmp/equipment-unit.log`, `.tmp/equipment-lint.log`, `.tmp/equipment-build.log` — focused checks and production build.
- `.tmp/equipment-contract-trace.json` — baseline request/body/helper comparison.

Repeat the main browser pass with `node scripts/qa/admin-equipment-foundation.js`; it starts and stops its own local Vite preview. Run the existing unit suite with `npm run test --workspace=client -- src/pages/admin/EquipmentPage.tank.test.jsx` and the production build with `npm run build` under Node 20.

Migrations and database/provider flows were not run. Installed-iPhone keyboard and notch/safe-area behavior still require a physical-device check. This task prepares review PRs; no merge or production deployment was performed. Draft children have not passed the repository’s main-based final merge gate. The financial API permission gap and date-only/UTC day-shift defects have separate fixes, [#4231](https://github.com/wavespestcontrolfl/waves-customer-portal/pull/4231) and [#4238](https://github.com/wavespestcontrolfl/waves-customer-portal/pull/4238), recorded as [ADMIN-BUG-003 and ADMIN-BUG-004](../audits/admin-ui-non-ui-bugs.md). Backend authorization and calendar-day behavior stay outside this presentation slice. Integration must retain the date corrections and update the combined QA verification timestamp expectation when #4238 is incorporated.
