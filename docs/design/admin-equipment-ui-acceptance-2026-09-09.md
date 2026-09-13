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
- Read failures distinguish unavailable data from an empty result and offer a local retry at every tab-level read and at calibration details. The equivalent surface written for fleet-card details was removed during review: adding an error/retry state where main logs and renders nothing is a behavior change, not a presentation one. That read stays silent on failure and is registered as [ADMIN-BUG-006](../audits/admin-ui-non-ui-bugs.md). Analytics loading and failure states are independent of Fleet equipment, overview and alert reads; an unrelated Fleet failure cannot suppress successfully loaded analytics. Job-cost missing metrics remain distinct from zero.
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

Migrations and database/provider flows were not run. The September 10 physical-device follow-up below closes the installed-iPhone keyboard and notch/safe-area prerequisite. This task prepares review PRs; no merge or production deployment was performed. Draft children have not passed the repository’s main-based final merge gate. The financial API permission gap and date-only/UTC day-shift defects have separate fixes, [#4231](https://github.com/wavespestcontrolfl/waves-customer-portal/pull/4231) and [#4238](https://github.com/wavespestcontrolfl/waves-customer-portal/pull/4238), recorded as [ADMIN-BUG-003 and ADMIN-BUG-004](../audits/admin-ui-non-ui-bugs.md). Backend authorization and calendar-day behavior stay outside this presentation slice. Integration must retain the date corrections and update the combined QA verification timestamp expectation when #4238 is incorporated.

## Current-main combined verification — September 10, 2026

The final Equipment stack commit `24094ba946b6d03da66aea90203c2157b2e45ee0` was merged locally with refreshed prerequisite `556ee36c11f2efafbf2a316579bcc70adbcc076f` on the verification-only branch `codex/equipment-combined-verify-20260910`. The resulting clean merge commit is `4f9b3bd9ec629fffcff3bac166efe85c3ac47565`. Documentation conflicts retain the newer main non-Equipment records and the final-stack Equipment records. No product source was changed during verification.

The isolated worktree setup and frontend doctor passed on Node 20.20.2 with integration credentials excluded, background jobs disabled and migrations not checked. The clean-commit browser run started at `2026-09-10T22:07:57.768Z` and passed all 214 geometry cases (107 Chromium and 107 touch WebKit), all 66 recorded behavior checks and all 60 screenshot captures. There were no page errors, unmatched synthetic API routes, backend-forwarded requests or unexpected console errors; the recorded 503 responses were deliberate failure/retry fixtures. Desktop and phone screenshots were visually inspected, including Assets, Maintenance, the equipment edit dialog, mileage actions and calibration verification actions. The updated shared dialog and CSS keep the form and action regions visible in the captured responsive layouts.

The focused Equipment, command-header and shared-overlay run passed 35 tests across six files. The date-only/timestamp regression run passed 12 tests under UTC and the same 12 under `America/New_York` (24 executions). The production build passed its blog-schema, affiliate-registry, portal-brand and domain-rule checks, then compiled 2,776 Vite modules. No backend, database, provider or production environment was accessed.

The source hashes recorded by `.tmp/admin-equipment-foundation/report.json` are:

| Source | SHA-256 |
| --- | --- |
| `client/src/components/admin/AdminCommandHeader.jsx` | `6f8c2f349196321cacfeb1617355b2a092dbf97354c6c3df8ddeed014e12fe8f` |
| `client/src/pages/admin/EquipmentPage.jsx` | `acfc8a2e784af47f9e9498f3cca72c933f2d388011340895e0c60eb9e1bd6949` |
| `client/src/pages/admin/EquipmentMaintenancePage.jsx` | `5beb79a59f2a412c9ef39b0c32c0e6c6afcb826d649c61b41ac16f4fb1c385be` |
| `client/src/pages/admin/EquipmentCalibrationPanel.jsx` | `20690e4863751ba7d71986f95db1c251fd31bfae49c1b40998b0b992d8300129` |
| `scripts/qa/admin-equipment-foundation.js` | `29b546f8f83bf3ce5aef7837ee961f6e5bcb0791138bd2446107ad8fadee0664` |
| `client/src/components/ui/Dialog.jsx` | `aa408ac34c48b99b71982051cc37b0e3fbdc9937ed30a2ed6c3df91a46755f1a` |
| `client/src/index.css` | `b13e90499b82d23c7a50fc35091d2c006789ee7dc363b3c349a5393e7cb3c71d` |

Current local artifacts are `.tmp/admin-equipment-foundation/report.json`, `.tmp/admin-equipment-foundation/review.html` and the 60 report-listed PNG captures in that directory.

Three real-iPhone installed-PWA captures attached to [#4280](https://github.com/wavespestcontrolfl/waves-customer-portal/pull/4280) show the notch/safe area clear and Save/Cancel visible while scrolling. On September 10 the owner also confirmed in this session that the full physical iPhone software-keyboard check passed in the installed `Equipment QA` PWA. That owner confirmation closes the keyboard prerequisite; the automated browser run does not emulate a full native keyboard, and the verification agent did not capture that full-keyboard evidence.

### Assets toast pointer-behavior review fix — September 10, 2026

Final-head review found that the migrated success toast could participate in pointer hit testing even though the previous notification did not. Assets commit `549e597c0c3295d002265d73f6b22d22b4308a05` adds only `pointer-events-none` to the toast Card, restoring click-through behavior without changing its visual position, status semantics or message lifecycle. The integration owner separately verified desktop Chromium and touch WebKit hit testing by tapping through the visible toast into the Notes field.

That fix was merged into the local verification branch at clean commit `3f5c12cfa0963757ee8a5ef962d0c18b20272a83`. Node 20.20.2 worktree setup and the frontend doctor passed again with credentials excluded, background jobs disabled and migrations not checked. The clean-commit browser run started at `2026-09-10T22:51:18.590Z` and passed all 214 geometry cases (107 Chromium and 107 touch WebKit), all 66 behavior checks and all 60 screenshot captures. Both browser states recorded no page errors, unmatched synthetic API routes or unexpected console errors. The deliberate 503 failure/retry fixtures remained the only console errors. Refreshed desktop and phone Assets and equipment-edit captures were visually inspected and remained correct.

The refreshed report records these SHA-256 hashes:

| Source | SHA-256 |
| --- | --- |
| `client/src/components/admin/AdminCommandHeader.jsx` | `6f8c2f349196321cacfeb1617355b2a092dbf97354c6c3df8ddeed014e12fe8f` |
| `client/src/pages/admin/EquipmentPage.jsx` | `bb9047a8192810d06e5c31e6f15b2c4d284f4f623b9513fdf35f02620278a811` |
| `client/src/pages/admin/EquipmentMaintenancePage.jsx` | `5beb79a59f2a412c9ef39b0c32c0e6c6afcb826d649c61b41ac16f4fb1c385be` |
| `client/src/pages/admin/EquipmentCalibrationPanel.jsx` | `20690e4863751ba7d71986f95db1c251fd31bfae49c1b40998b0b992d8300129` |
| `scripts/qa/admin-equipment-foundation.js` | `29b546f8f83bf3ce5aef7837ee961f6e5bcb0791138bd2446107ad8fadee0664` |

The refreshed local artifacts remain `.tmp/admin-equipment-foundation/report.json`, `.tmp/admin-equipment-foundation/review.html` and the 60 report-listed PNG captures. The earlier focused suites, production build and physical iPhone acceptance above remain historical evidence; they were not repeated for this one-class pointer-behavior correction.

## Integration onto main — September 11, 2026

The series merged into main one slice at a time between September 10 and 11 (#4230 `456714313`, #4236 `56d86d015`, #4251 `d460c47e2`, #4257 `d8e19114a`, #4262 `1ec574e21`, #4266 `335d8d886`, #4271 `f48a9729c`), each with its own Codex rounds and green CI. The browser-evidence children followed: #4278 carries the fixture, #4279 its write coverage, and this slice the read-recovery and navigation coverage. The September 9 and 10 records above stand as the history of the pre-integration stack; this section records the run against merged main.

Review of the UI slices changed two things the evidence children had to follow:

- The fleet card's opener is named `Expand|Collapse <category> <name> …`, not `Open <name>`. Both the write-pending guard (#4279) and the detail-failure check here now match the real accessible name, so assertions that silently failed to bind are actually running.
- The fleet-card detail error/retry surface was removed in #4262 as a behavior change. The check that exercised it now asserts main's contract — a failed detail read renders no detail block and no alert, and recovers only when the card is collapsed and expanded again — and the defect is registered as [ADMIN-BUG-006](../audits/admin-ui-non-ui-bugs.md). Tab-level read failures and calibration-detail failures keep their retry surfaces and their checks.

Toast waits no longer race the on-screen lifetime. `showToast` starts a 3.5s timer per call without clearing the previous one, so a second toast inside that window is cleared early — at this head 284ms for `Mileage logged` in desktop Chromium and 322ms in touch WebKit, against the intended 3500ms. The fixture records every `role="status"` render through a MutationObserver and asserts against that timeline, which `report.json` keeps per browser; the defect is registered as [ADMIN-BUG-005](../audits/admin-ui-non-ui-bugs.md). Neither register entry is fixed here — both are behavior changes that do not belong in a presentation slice.

The run over merged main at head `19d8b544a`, from a clean working tree, started at `2026-09-11T07:49:02.210Z` and passed: 214 geometry cases (107 desktop Chromium and 107 touch WebKit), 66 recorded behavior checks (33 per browser), 60 screenshots, no page errors, no unmatched synthetic API routes and no unexpected console errors — the only console errors were the deliberate 503 failure fixtures. All eight writes passed duplicate-submit, stable pending geometry, failed-draft, retry and exact-payload checks; analytics stayed available under each of the three Fleet reads failed and held pending; empty states, URL aliases, keyboard leaf selection, query preservation, refresh and history, verified-role restrictions, missing-versus-zero job metrics and the long asset name all passed.

Alongside the browser pass: `npx vitest run src/pages/admin/Equipment` — 7 files, 32 tests; `npm run check:ib-coverage` — 0 new or changed unmapped sites; `npm run test:qa-workflow` — 33 tests; focused ESLint on the runner clean; `git diff --check` clean. No backend, database, provider or production environment was accessed, and no product source is touched by this slice — its diff is the QA runner and these records.

The integrated source hashes recorded by `.tmp/admin-equipment-foundation/report.json` are:

| Source | SHA-256 |
| --- | --- |
| `client/src/components/admin/AdminCommandHeader.jsx` | `6f8c2f349196321cacfeb1617355b2a092dbf97354c6c3df8ddeed014e12fe8f` |
| `client/src/pages/admin/EquipmentPage.jsx` | `50a308f3c7e3873f67f33715525be6dfc1c0d1eb4d0e13a60c1f6c1cdc322ced` |
| `client/src/pages/admin/EquipmentMaintenancePage.jsx` | `58b856ed99939fe7c243643727936be96defe84091e451733e7f419d89d7255e` |
| `client/src/pages/admin/EquipmentCalibrationPanel.jsx` | `20690e4863751ba7d71986f95db1c251fd31bfae49c1b40998b0b992d8300129` |
| `scripts/qa/admin-equipment-foundation.js` | `3061b67afbbfc134b47d2672e67d1c0617ba38857bf8603a718f7d78327ebcae` |
