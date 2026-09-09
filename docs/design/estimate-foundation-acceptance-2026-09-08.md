# Estimate foundation proof — September 8, 2026

## Scope and source

The owner accepted the rendered Customer 360 foundation and asked to continue the approved audit sequence. This proof applies the existing shared foundation to the actual estimate builder at `/admin/pipeline`; `/admin/estimates?tab=new` keeps its existing redirect.

- Branch: `codex/estimate-foundation-20260908`.
- Accepted foundation dependency: `3bf464ba4b6552a8a71a31f3255827892a15b94b` on `codex/customer360-design-system-20260908`. See [the foundation record published with #4171](https://github.com/wavespestcontrolfl/waves-customer-portal/blob/3b487be92969ba673c7e97f5df97b74a27d7cf3c/docs/design/admin-foundation-acceptance-2026-09-08.md).
- Separate state fix: `d331b202d` clears customer-specific notes and custom discounts when choosing **Next estimate (keep services)**. Selected services remain selected. The regression failed before this fix and passed after it.
- Shared-control implementation: `9047fc9f1`. Browser reports record the checked branch, commit, checkout stamp, and dirty status.
- This is a local implementation and synthetic browser proof. No PR, merge, deployment, migration, live pricing service, customer record, or provider send is exercised.

## PR preparation verification

The record above describes the original local acceptance. The reviewed sequence is now #4167 (state reset), #4173 (fields) and #4176 (review/send controls), based on current main and the shared components. The PR-preparation source `13a48ce13b190805027e845bdebf9988ee338174` passed 40 focused tests, the production build and the full actual-route browser checks below. The original full-suite count remains evidence for its original source, not the newer PR head. Final-head CI is tracked on each PR.

## Shared presentation and workflow ownership

The builder opts into comfortable density: 44px controls, 14px labels/actions, and 16px field text. Its 129 locally rendered fields now use `Field`; the existing estimate bindings use shared `Input`, `Select`, and `Checkbox`. Raw text fields, customer search, address autocomplete, discount presets, and notes also use the shared controls. Address autocomplete retains its native ref. The obsolete field wrapper, checkbox drawing, input class string, custom select caret, and broad font repair are removed.

Section navigation uses the shared scrolling navigation presentation and moves keyboard focus to its existing section. Sections remain in the document, so navigating does not discard form state. Estimate pricing, property lookup, discount rules, draft UUIDs, revision preflight, provider confirmation, and request payloads retain their existing owners. This does not turn the customer record layout into a universal page component.

Save/generate actions retain their labels and geometry while pending. Errors and save status use `ActionFeedback`. The shared send-review dialog uses the same controls, portal click containment, and explicit opener focus. Choosing a channel and closing the dialog do not send. Its retry key, revision checks, acknowledgment gates, Eastern-time parsing, and channel outcome handling are unchanged.

## Verification

| Check | Result |
| --- | --- |
| Client tests | **305 files / 2,864 tests passed**. Includes estimate pricing/configuration, property ownership, draft UUID/revision, and send confirmation/retry/suppression tests. `.tmp/estimate-client-tests.log`. |
| Build | `npm run build` passed, including prebuild domain, brand, affiliate, and blog checks. `.tmp/estimate-build.log`. |
| Actual route flows | Chromium desktop and touch WebKit phone: create; retain notes across section navigation; generate; block duplicate save; preserve pending button size; fail and retry with the same UUID; reopen the saved URL; revise the same estimate; open/choose/close send review; retain edits after a revision conflict; open another saved estimate; clear customer-specific fields for the next estimate. |
| Geometry | **12 cases passed**: 390, 700, 820, 1024, 1440, and 844px landscape in both browser/pointer configurations. No horizontal overflow, unlabeled visible fields, short actions/choice rows, or small field text in the exercised pest/lawn form. |
| Keyboard and dialogs | Chromium Tab order and keyboard section activation passed. WebKit section activation and Escape/focus return passed. WebKit's default Tab preference skips native buttons; physical keyboard settings remain a device check. |
| Errors and requests | No page errors or unmatched API requests. Console errors correspond only to the deliberately fulfilled 503 save failure and 409 conflict. No `/send` request is made by the browser proof. |
| Review hygiene | ESLint reports 0 errors; existing large-component complexity/unused warnings remain. `git diff --check` passes. |

## Reproduce and inspect

Use Node 20 with the existing dependencies and frontend-only managed startup from this worktree:

```sh
node scripts/qa/estimate-foundation.cjs
cd client
npm test -- --run
cd ..
npm run build
```

The browser script can also take `http://127.0.0.1:<worktree-client-port>`. It verifies the checkout stamp, blocks external/socket requests, and fulfills API requests locally. Its synthetic in-memory records test the UI's persistence protocol, not the database implementation. The `--baseline` option changes only the output directory; it runs the same workflow, font checks, request/error checks and geometry assertions as the current mode. It requires a checkout supporting the exercised controls. The original local baseline captured from `d331b202d` used the earlier, limited capture mode and is historical evidence, not a pass of this complete runner.

Reports and screenshots live in `.tmp/estimate-foundation/current/` and `baseline/`. Desktop and phone creation, service, pricing, review, conflict, reopened-estimate, and send-review renders were visually inspected. The original local `.tmp/estimate-foundation/review.html` gallery was a separate inspection aid; this runner produces the report and screenshots, and does not regenerate that gallery.

Physical iPhone installation, safe areas, software keyboards, dictation, native camera use, and tablet keyboard preferences are not established by browser emulation. Unsaved edits are retained across section navigation and save failures; only saved drafts are verified after refresh. No new offline persistence promise is introduced.
