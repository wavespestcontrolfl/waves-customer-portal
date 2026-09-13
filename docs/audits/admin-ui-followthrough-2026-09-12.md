# Admin UI audit followthrough — September 12, 2026

Worktree: `wt-admin-audit-followthrough-20260912`  
Branch: `codex/admin-audit-followthrough-20260912`  
Base: `86d67e9510fe9de03eb70e35621c7d291cb5842b`

## Implemented and split for review

- Inventory, SEO, PPC and Social selected sections now follow URL state and browser history, preserving unrelated query parameters and fragments. Invalid selections fall back safely, including inherited object-property names.
- Blog editors reopen from `?post=`, including uppercase UUID bookmarks. Failed list/post reads show retry and recovery instead of false empty results or endless loading.
- SEO dashboard shows failed reads distinctly from zero traffic, supports retry, and ignores stale responses.
- Compliance CSV export checks HTTP success, prevents duplicate in-flight exports, and shows recoverable failure instead of downloading error JSON.
- Schedule exposes Tech Match, CSR Booking, Job Scores and Insights on mobile. Reschedule uses shared labeled fields, dialog, buttons and feedback, preserving duration, series controls and notification choices.
- Services catalog/editor, Discounts and mobile service screens use shared comfortable controls. Existing service/discount payloads and fields are preserved.
- Agent Ops Decisions, Shadow Drafts and Data Hygiene now use shared comfortable UI for filters, evidence, voice profiles, exam history and proposed fixes. Existing Shadow approval confirmations and action guards remain intact. Hygiene revert failures remain visible inside the dialog.
- Field Assessment and its hub use shared controls for photo analysis, score correction, confirmation, history and turf profiles.
- Newsletter subscriber addition/import/unsubscribe and Staff deactivation have in-page dialogs, recoverable failures, cancellation and duplicate-submission guards.
- Retired three advertised but nonfunctional actions: pending-retention Edit, mobile contacts import, and mobile category creation. Their underlying features were **not implemented**.

## Validation

- Combined focused suite: 36 files / 367 tests passed, including all existing SchedulePage regression suites.
- Production build, including root prebuild checks: passed.
- Targeted ESLint across every changed JavaScript file: 0 errors, 121 warnings (primarily legacy complexity/formatting). `git diff --check`: clean.
- Independent integration review found two URL edge cases and a hidden dialog error; all corrected and regression-tested. Final Agent Ops review found no additional actionable issues.
- Browser fixtures intercept APIs with synthetic data; no real business writes or notifications.
- Desktop/mobile recovery evidence: `.tmp/admin-audit-recovery/report.json` and screenshots at 1440px and 390px. Covers Services editors, Discounts, mobile categories, Reschedule cancellation, all four Schedule secondary pages, Compliance failure/retry, Blog failure/retry, Staff deactivation cancellation, Agent Decisions, Hygiene revert cancellation and expanded Shadow profile/exam/pathology/draft states.
- Newsletter evidence: `.tmp/admin-newsletter-foundation/report.json` and dialog screenshots at 1440px, 820px and 390px.
- SEO evidence: `.tmp/admin-seo-foundation/report.json`, 39 screenshots across workspaces/views.
- Field Assessment evidence: `.tmp/admin-assessment-foundation/report.json`, passing select/profile/photo/scoring flows at 1440px, 390px and 320px. Score controls are checked for tile containment, overlap and 44px targets. Reproduce with `scripts/qa/admin-assessment-foundation.cjs`.
- Browser viewport emulation was used; physical-device keyboards and installed-app safe areas were not tested.

## Combined PR verification

The focused branches were combined in an isolated local integration checkout
(`e8b8f7137a8dea798a8b34a71775ada36e37bbf2`, based on main
`85c70fcb647b63351326b8a47bb8d28dd4def08f`). The combined run passed
379 tests across 38 files, the production build, and the capability census
with zero new or changed unmapped sites. Recovery, Assessment, and Newsletter
browser fixtures also passed with synthetic data and no page errors.
The local QA server allowed the installed dependency directory so fonts
could load through worktree symlinks; tracked application code was clean.
Individual PR review and CI remain the release gates.

## Remaining work and integration boundaries

- Schedule edit, protocol and completion overlay migrations remain coordinated with closeout continuation PR #4315; this branch migrates Reschedule only.
- Blog visual migration belongs to #4412. This branch adds record URLs/read recovery and will require deliberate reconciliation with that PR.
- Reports/ProjectDetail is already covered by #4413, and Referrals by #4420. Their existence was checked during the audit; this work does not certify or merge them.
- Shadow Drafts still uses existing native confirmations for consequential actions; replacing these remains a separate UI finishing item.
- Contact import, custom category authoring and retention-message editing still need complete product/backend workflows before exposing their entry points again.
- Recruiting Hired → Staff onboarding remains a separate product decision; no account provisioning was added.
- Mobile category loading still falls back to an empty list on read failure, and Discount statistics remain blank after a failed read. Explicit error/retry states for both were excluded from their visual migrations to preserve behavior and remain separate recovery follow-ups.
- Expanded secondary-page indexing in the page finder remains an optional enhancement.
- Follow the admin consistency contract when publishing: separate visual, information-architecture, content and endpoint PRs. The original implementation is preserved in local snapshot `b01c166fd919cf1ef5f5a6f9679784e87d43bf18`; the PRs below carry the reviewable changes. Validation of that snapshot is not a claim that every PR has shipped.


## Review map

| Scope | PR |
| --- | --- |
| URL state and Schedule secondary-page access | #4450 |
| SEO and Compliance recovery | #4451 |
| Blog bookmarks and recovery | #4452 |
| Explicit design promotions | #4453 |
| Remove three nonfunctional actions | #4454 |
| Data Hygiene | #4455 |
| Agent Decisions | #4456 |
| Shadow Drafts | #4457 |
| Reschedule dialog | #4458 |
| Staff deactivation | #4459 |
| Newsletter subscriber dialogs | #4460 |
| Desktop Service Library | #4462 |
| Discounts | #4463 |
| Mobile Service Library | #4464 |
| Field Assessment | #4465 |

The original handoff flagged #4412 (Blog), #4413 (Reports), and #4420
(Referrals) for exceeding token-only scope. During this followthrough,
their proposals were retitled as Tier-2 token passes, and Reports #4413
landed as `2daadf2114`. Their reviews and merges are managed separately
from this audit. Reports uses ProjectDetail shared with the tech app and
Dispatch. Blog visual changes must preserve the bookmark, history and
read-recovery behavior landed in #4452; none of these existing PRs should
be counted as missing implementations.

## Product backlog

1. Retention-message editing: define editable fields and approval behavior,
   then connect the editor to the existing retention workflow.
2. Contacts import: build source selection, validation, deduplication and
   a review step before exposing the removed mobile import action.
3. Custom service categories: define storage and category management,
   then connect mobile category creation to that workflow.
4. Recruiting Hired → Staff: decide the account, role and onboarding
   handoff before adding provisioning.
5. Finish secondary overlays: coordinate Schedule edit/protocol/completion
   with #4315 and replace Shadow native confirmations in a separate slice.
6. Optionally index more secondary pages in the page finder.
