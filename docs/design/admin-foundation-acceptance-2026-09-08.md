# Admin foundation acceptance record — September 8, 2026

## Scope and checked source

This is the acceptance record for the original local implementation. Release preparation splits that work into dependent PRs; the shared components are #4165, the directory content is #4166, and the catalog is #4168. The checks recorded below cover their named source snapshots, not a deployment or acceptance of every later PR. The catalog runner now ships with this record so its synthetic checks are reproducible.

Implements the owner-approved consolidation following the September 7 Waves design-system audit. The accepted direction remains the Customers directory and full-width Customer 360 workspace. This record distinguishes local implementation evidence from production acceptance.

- Task branch: `codex/customer360-design-system-20260908`.
- Base: `4bde2a08d92a8e2e0fbfb66a2753b7ca432ece81` from `main`, including the default workspace change in [#4136](https://github.com/wavespestcontrolfl/waves-customer-portal/pull/4136).
- Refactor dependency: `e536f971ba5b9d20defba4321d077b940a9011b9`, the existing [#4117](https://github.com/wavespestcontrolfl/waves-customer-portal/pull/4117) branch. Integrated in this task's isolated worktree; that PR/branch has not been changed by this task.
- Local integration base before foundation changes: `f764f8b56`.
- Foundation source commit: `7980f3457`; final verification results are recorded below.

The original [#4083](https://github.com/wavespestcontrolfl/waves-customer-portal/pull/4083) CI evidence remains historical. Its [final-head run](https://github.com/wavespestcontrolfl/waves-customer-portal/actions/runs/34119559179) was successful according to GitHub during the audit; it is not CI for this revision. No deployment or production acceptance is claimed here.

## Audit disposition

| Finding | Implementation and evidence |
| --- | --- |
| DS-01 | Updated the existing admin consistency contract and catalog; appended the new decision without editing historical decisions. Comfortable/sentence-case is the selected default for migrated work, with explicit compact/touch and legacy preservation rules. |
| DS-02 | Shared density, semantic type, field associations, action/link styles, header/menu actions, record tables, scrolling section tabs, and feedback replace the broad customer control/font/utility repairs. Customer layout and domain indicators remain local. Before/after screenshots and computed styles are retained in the local evidence directory. |
| DS-03 | DialogTitle registers its actual ID. Regression coverage includes custom/replaced/generated IDs, conditional titles, and explicit labels. |
| DS-04 | Sheet uses Dialog's click boundary. Tests cover both nesting orders, internal/backdrop clicks, Escape, and focus return. Browser coverage includes nested overlays; the actual customer drawer retains its existing composer. |
| DS-05 | Button/Input/Select/Textarea share explicit density sizing. Global touch minimums honor the density token. Browser geometry covers 390/700/820/1024/1440px, fine/coarse pointers, portrait/landscape, and a contracted WebKit viewport. Physical keyboards/notches remain a separate check. |
| DS-06 | The same catalog now renders labels/help/errors, stable loading with caller deduplication, failed-save drafts, disabled reasons, partial versus zero, no-results versus errors/retry, long strings, record composition, mobile navigation, and nested overlays. Expandable code is imported from the actual rendered sources. |
| DS-07 | TabPanel keeps the existing unmount default and adds explicit keepMounted with hidden/inert content. Tests cover state retention, customer changes, role removal, and failed saves. Refresh persistence remains the workflow's responsibility; no new recovery promise is made. |
| DS-08 | Incorporated the existing focused page/editor and profile state/presentation refactors from #4117. Shared state stays in the controllers; workspace and overlay presentations remain distinct. Customers is not a universal record component. Remaining imports of page-owned communications/schedule behavior are a separate extraction concern and are not copied into the catalog compositions. |

## Deliberate presentation changes

- Normalize previously inconsistent 36–43px actions/fields to comfortable 44px; touch is 48px. Captions, labels, and action text keep a 14px floor with sentence case. Input text is 16px.
- Directory, record identity, section order, historical values, permissions, endpoints, and payloads keep their existing ownership. The large record identity remains 29px desktop / 23px phone.
- The standalone overlay is a named legacy presentation. A default control on an unrelated unconverted page keeps its prior style. Legacy Button and field desktop transitions now share the `md` breakpoint, and coarse-pointer minimums remain in force.
- The message drawer uses shared field/outline action styles. Its recipient, thread line, attachments, drafting tools, scheduling, acceptance rules, and state lifetime stay in the existing SMS composer.
- WebKit trigger focus is explicit before opening nested overlays, so close returns to the opener rather than a previously focused field.
- Directory disclosures retain an in-progress pointer action when WebKit focuses the containing `main` before clicking its menu button. Outside pointer, keyboard, and Escape dismissal still work. Long native select options stay within the message drawer without horizontal scrolling.

## Reproduce the checks

Use Node 20 and the checkout's existing dependencies. Run frontend-only verification; no database or provider connection is needed.

```sh
cd client
npm test
cd ..
node scripts/qa/design-system.cjs
npm run build
```

The catalog browser script uses the existing local preview runner. It can also verify an already-running server from this checkout by appending `http://127.0.0.1:<port>`. It rejects non-local origins, blocks external/socket requests, and fulfills every allowed API call with synthetic responses. Results go to `.tmp/design-system/browser/`. Its report records the branch, SHA, dirty status, geometry, completed interaction scenarios, unmatched requests, and the overall pass/failure outcome; it does not inventory successful intercepted requests. The historical Customer360 evidence below comes from the original implementation checkout. That separate runner is published with the Customer360 integration proof, not this catalog slice.

## Final local evidence

The implementation is saved in three local commits: `89696c813` (shared primitives), `810a43247` (Customer360 adoption), and `7980f3457` (catalog, contract, and repeatable browser checks). Documentation of this evidence follows those source commits. No production source changes remain unstaged.

| Check | Result |
| --- | --- |
| Full client suite | **305 files / 2,863 tests passed**. Includes the added directory WebKit regression and the existing customer/editor/composer business-state tests. Log: `.tmp/design-system/client-tests.log`. |
| Catalog browser geometry | **63 density/viewport/pointer cases passed**: five widths × two pointer modes × two orientations × three densities, plus three contracted WebKit cases. |
| Catalog browser interactions | Chromium desktop, WebKit phone, and contracted WebKit drawer scenarios passed. Field associations, stable pending geometry, duplicate submit, failed-save retention, retry, missing versus zero, keyboard tabs, customer/role reset, nested overlay naming and focus all passed. No page/console errors or unmatched APIs. |
| Actual Customer360 route | Chromium at 1440×1000 and touch WebKit at 390×844 passed. Directory edit survives opening/returning from the workspace; message draft survives drawer reopen; Quick Links and drawer focus return pass; overlay rollback, billing status and payer draft work; message drawer has no horizontal overflow. No page errors or unmatched APIs. Only locally fulfilled message-read acknowledgments were emitted. |
| Build and prebuild gates | `npm run build` passed, including blog schema, affiliate registry, portal brand, and domain-rule checks. Log: `.tmp/design-system/build.log`. |
| Lint / whitespace | New and rewritten shared/catalog/page components pass ESLint. Existing complexity warnings remain in the large profile, property and SMS components; the commit hook reports 0 errors. `git diff --check` passes. |

The final browser reports reference source commit `7980f3457`. Their dirty flag includes this acceptance document and untracked local investigation files; application source matches that commit. The full unit suite preceded the last CSS-only long-option fix, which is covered by the final browser checks and build.

Desktop and phone screenshots were visually inspected for directory/record structure, readable controls, nested overlays, composer overflow, and the contracted drawer. Open the local gallery at `.tmp/design-system/review.html` to compare four rendered screens. Representative artifacts:

- `.tmp/design-system/customer360/desktop-workspace.png` and `mobile-workspace.png`.
- `.tmp/design-system/customer360/desktop-directory.png` and `mobile-directory.png`.
- `.tmp/design-system/customer360/desktop-message.png` and `mobile-message.png`.
- `.tmp/design-system/browser/desktop-catalog.png` and `mobile-catalog.png`.
- `.tmp/design-system/browser/desktop-nested-overlays.png`, `mobile-nested-overlays.png`, and `mobile-keyboard-drawer.png`.

These are real app renders with fictional customer data, not new mockups. Browser-emulated results do not establish physical-device acceptance.

## Remaining acceptance boundaries

- No new PR, CI review, merge, deploy, database migration, provider action, or customer communication has been performed for this foundation revision.
- Installed iPhone safe areas, actual software-keyboard behavior, dictation, and a touch tablet with an attached pointer/keyboard require physical devices. Browser emulation does not replace those checks.
- Estimate and technician catalog compositions demonstrate shared controls only. The subsequent real workflow proofs must cover estimate creation/editing and customer-keyed draft persistence, then active visit/access notes, approved versus actual treatment, photos, saved/pending/synced/error states, interruption recovery, and completion without AI. Their existing pricing, persistence, and completion workflows remain authoritative.
- `customer360=overlay` restores the prior profile presentation. It does not undo the already-merged directory health changes or additive read-side APIs. Removing `customer360=workspace` is no longer the rollback.
