# Tech visit foundation proof — September 8, 2026

## Scope and source

The accepted audit sequence continued from Customer 360 and [Estimates](https://github.com/wavespestcontrolfl/waves-customer-portal/pull/4180) to the actual `/tech` route, a pest visit recap, visit photos and optional photo marking. Tech retains its Today / Visit / Complete workflow, palette, Montserrat headings and Nunito Sans body face. The bounded shared-control migration is defined in [the Tech foundation contract](tech-foundation-contract.md).

The original local acceptance was recorded on `codex/tech-foundation-20260908`, with product source `8fc9d9761` and subsequent photo-read correction `d15bf7c71`. Its full client run passed 307 files / 2,874 tests. Those are historical results, separate from the later PR preparation below.

The reviewed product stack is #4169 (recovery), #4183 (recap controls), #4185 (photo-list truth) and #4190 (photo controls). Product head `b23e89e56aabdfa8c07914ff3b177b8a0e1c7805` passed nine focused photo/marking tests, the production build, and both complete browser workflows. Reports always include their actual checked HEAD, branch, checkout stamp and dirty state. These PRs are drafts with explicit dependencies; release requires retargeting to main and repeating the final release checks.

The proof uses synthetic API responses. It does not start a database, migrate, operate on a real visit, send a message or call a provider.

## Behavior and presentation

The recap and photo compositions use shared field association, pending actions, choices, feedback and touch density. Named `tech-visit-*` classes own Tech presentation; migrated local palette branches and duplicate control styling are removed. Existing request payloads, actual-rate resolution, permissions, notification choices and optional marking retain their owners. Photo CSS arrives with its consumer. The legacy Intelligence Bar is unchanged and excluded from this geometry scope pending its separate UX pass.

Dialogs are named and portaled, lock background scrolling and preserve keyboard focus. The nested marking dialog owns Escape and returns focus to its opener. Pending completion disables edits and closing, suppresses repeated taps, and retains its button dimensions. Explicit checkbox strokes remain visible without Tailwind preflight.

Recap storage remains keyed by visit, operator and role. Restore/discard is explicit; a baseline fingerprint prevents an older local draft from replacing a changed server record. Missing restored products block completion until reviewed. Failure retains the draft; successful completion clears it. Storage failure does not claim persistence and warns before unloading a dirty form.

A failed photo upload retains the selected File, type, capture time and caption for in-dialog retry. A failed photo-list read has its own retry and never asserts an empty list. Upload success stays distinct from refresh failure. Pending files exist only while their dialog remains mounted: browser Back, refresh or OS termination can discard them. This scope has no durable offline upload queue; route-navigation recovery is explicitly deferred in #4169.

## Browser acceptance

| Check | Required result |
| --- | --- |
| Actual route | Active stop, access and approved quote, actual treatment, photo upload/read failures and retry, recap reopening and refresh recovery, visit isolation, failed completion/retry, completed status and attached photos. |
| Geometry | 48 cases: Today, Photos, Recap and marking at 390, 700, 820, 1024, 1440 and 844px landscape in Chromium and touch WebKit. No horizontal overflow; migrated targets at least 48px and fields at least 16px. |
| Focus and pending | Nested Escape/focus return, disabled-fieldset containment, stable pending completion geometry, duplicate suppression and retained form values. Marking saves a normalized point and reloads it through the same visit's endpoint. |
| Manual completion | The synthetic AI 503 keeps the technician's manual notes and actual rates; completion explicitly sends `sendSms: false`. A failed completion and retry carry the same actual-rate payload. |
| Requests | No page errors or unmatched requests. Console errors are limited to the deliberately fulfilled 503 failures. External/socket traffic is blocked; no SMS, call or send request is made. |
| Evidence | Remove stale output before each mode; require fonts; mark failures explicitly; close each browser and the preview server; write the current report even after startup or finalization failures. |

The product-head run recorded 36 screenshot entries for 35 distinct images across the two browser workflows. The current runner keeps a unique-file inventory when recapturing Today after dismissing the install hint. Desktop and phone photo, treatment and nested marking renders were visually inspected. A gallery is written only after a successful current run. Stale output is removed before another run begins, and a report-write failure deletes both the gallery and any partially written report. The fixture dispatcher uses exact method/path handlers and separate photo and mark state per visit; reads, uploads and marking writes must match the active visit. Console errors must match both the exact browser resource-error message and a deliberately failed request URL. The new runner participates in changed-file ESLint coverage without expanding the scope to older CommonJS fixtures.

The fixture tests the real UI's request and recovery behavior. It does not verify database transactions, S3, billing or provider delivery. Physical iPhone camera capture, keyboard/dictation, notch geometry, home-screen installation and background/OS termination remain device checks.

## Reproduce and inspect

Use Node 20 and the repository's frontend-only worktree setup. Provision both required engines, then run the same workflows against the selected checkout:

```sh
npx playwright install --with-deps chromium webkit
npm run dev:doctor -- --frontend
node scripts/qa/tech-foundation.cjs
node scripts/qa/tech-foundation.cjs --baseline
```

An optional local managed-client URL must have the matching checkout stamp. `--baseline` only chooses the output directory; it runs the same full workflows and assertions. Reports and images are under `.tmp/tech-foundation/current/` and `baseline/`; the successful current gallery is `.tmp/tech-foundation/review.html`. It links to the published estimate proof. The historical pre-migration baseline was captured at `0683985a2`; running baseline mode today does not recreate that source.
