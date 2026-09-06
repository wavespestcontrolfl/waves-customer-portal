# Verification and implementation evidence

Baseline `32de1dc5ccb5a2f9b6e5969db319df37b96a025d`; task-owned branch/worktree recorded in README. Commands ran with `/private/tmp/node-v20.20.2-darwin-arm64/bin` prepended to PATH. No production or dev database was connected. No migrations ran. Source inventory and risk/parity/deletion assessments were recorded before production edits.

## Baseline

| Check | Result | Evidence |
|---|---|---|
| `npm ci --ignore-scripts --no-audit --no-fund` | Passed; existing lockfile, 1,507 packages, no package changes | Separate node_modules in this worktree |
| `npm run worktree:setup`; `npm run dev:doctor -- --frontend` | Passed, Node 20.20.2, integration credentials excluded, background jobs disabled | `.tmp/dev/`; frontend only, migrations not checked |
| `npm run build` | Passed, 115 seconds; schema/vendor/brand/domain prebuild gates passed | `.tmp/simplification/baseline-build.log`; existing stale Browserslist-data advisory |
| `npm run test:coverage --workspace client` | **1 failed / 260 passed suites; 1 failed / 2,485 passed tests** | `.tmp/simplification/baseline-client.log`; `PortalPage.silent-failures.test.jsx` could not find visit-preferences error text |
| `npm test --workspace client -- src/pages/PortalPage.silent-failures.test.jsx` | 8/8 passed in isolation | `.tmp/simplification/baseline-client-retry.log`; baseline concurrency/timing sensitivity, not treated as a clean first run |
| `NODE_ENV=test JWT_SECRET=<synthetic> node node_modules/jest/bin/jest.js --rootDir server --ci --silent --maxWorkers=2` | **1,847 passed suites / 25 skipped; 40,418 passed tests / 194 skipped; 3 snapshots passed** | `.tmp/simplification/baseline-server.log`; external network blocked via test-only `NODE_OPTIONS` preload; no DB/integration credentials |
| Static inventory collector | 68 admin child routes + shell, 4 auth-related route entries, 695 relevant modules, 2,503 entry-point references; zero parse errors | CSV snapshots and ignored raw inventory; computed references remain explicitly unresolved |

Full DB-gated integration/contracts/native device flows require a dedicated verified development database/device setup. They are not represented by the no-DB test count. Live tool contract smoke can invoke providers, so it is not run as a substitute for mocked testing. No full-server startup or new production analytics occurred.

## Implementation and checks

All paths below are relative to the task-owned worktree. Raw logs, screenshots,
coverage and intermediate inventories remain ignored under `.tmp/simplification/`;
only synthetic fixture code and the audit are tracked. The full client run after
the initial four slices passed **264 suites / 2,513 tests**. Subsequent parity
review added three more tests and the small profile/auth fixes described below.

| Check | Result and checked scope | Local evidence |
|---|---|---|
| Navigation/label slice | 19 tests passed in three suites | `slice1-tests.log` |
| Alias transport and role routing | Actual `App.jsx` declarations parsed; nine aliases preserve forced leaf, ID, repeated filters and fragment, with replace-history Back/Forward | `AdminAliasRoutes.test.jsx`, `AdminTabRedirect.test.jsx`, `AdminLayoutV2.test.jsx` |
| Parity before UI retirement | Old Team and Account display the same identity for both roles; integration detail/check, runtime alerts/window/retry/poll cleanup preserved | `pre-retirement-tests.log` (16 tests, including 9 alias cases) |
| Parity before PPC deletion | All six live tabs and expected PPC data reads, with no action/provider execution | `pre-deletion-tests.log`; `AdsPage.parity.test.jsx` |
| Skeptical profile failure test | Initially failed when `/health` was offline; independent read settlement fixes it without restoring the duplicate profile fetch | `profile-health-regression-red.log`; retained regression in `AdminSimplification.parity.test.jsx` |
| Skeptical role test | Nine mount-spy assertions exposed the baseline one-frame child mount; same existing role predicate now gates the Outlet before effects can run | `AdminLayoutV2.test.jsx`; no assertion removed or weakened |
| Guest/expired-session return | Tests retain original path/query/hash; browser signs in through the real form using a mocked response and reaches the original digest filter | `AdminLayoutV2.test.jsx`; browser report |
| Final focused checks | 57 tests passed in seven relevant suites, including route declarations, role guards, profile failure and PPC | `final-focused-tests.log` |
| Build | Passed after the final application edits; schema/vendor/brand/domain prebuild gates passed | `final-build.log`; no migration or backend startup |
| Lint | Zero errors, 15 warnings in existing large components and legacy unused helpers | `final-lint.log`; the small Outlet guard adds to Layout's already-over-limit complexity; no broad refactor performed |
| Full client, final application edits | First run: 263 passed / 1 failed suites; 2,515 passed / 1 failed tests. Failure is the unchanged `CallLogTabV2.test.jsx` synced-transcript initial Speaker lookup under concurrent build/browser load. All 8 tests pass in isolation. Controlled two-worker full run: **264 suites / 2,516 tests passed**. | `final-client.log`, `final-client-retry.log`, `final-client-controlled.log` |
| Full server | Reused baseline: 1,847 passed suites, 25 skipped; 40,418 passed tests, 194 skipped. Server, dependency lockfile and test inputs are unchanged. | `baseline-server.log`; external network blocked; no DB |
| Browser | Nine synthetic scenarios, 13 screenshots at 1440/390; zero unhandled page exceptions or unmatched API fixtures | `browser/report.json`, `browser-run.log`; exact scenarios below |

The client timing failures are recorded, not erased by successful reruns. The
baseline Portal preference failure and the later CallLog initial-render failure
are different tests. Neither test nor the production CallLog implementation was
edited. No financial, communication or security assertion was relaxed.

## Rendered workflow evidence

Run `node scripts/qa/admin-simplification.cjs` with Node 20. It reuses
`scripts/qa/browser.js` and the managed frontend setup, starts no backend, blocks
external origins and service workers, and fulfills API requests with synthetic
data. Unmatched requests fail with 404. Only the explicitly requested credential
check and login POSTs are allowed; all other business mutations fail the audit.
Navigation telemetry resolves in-page before a keepalive request is created:
early fixture runs showed Chromium forwarding teardown beacons to the absent
loopback API after page handlers detached. The final fixture prevents that;
no backend was listening and no production endpoint was involved. The existing
adminUsage unit suite continues to test beacon contents and deduplication.

| Browser scenario | Verified result | Boundary |
|---|---|---|
| Old `?tab=team&source=bookmark#profile` | Account identity, current email/role, URL query/hash and refresh retained; Team Members copy absent | Synthetic current user only; real employee management unchanged |
| Tool Health → Settings Integrations | Critical runtime alert remains visible; link accepts keyboard focus/Enter; Back/Forward restore destinations; no catalog GET on Tool Health; one requested check POST | Cached synthetic credential data, not a live provider check |
| Failed catalog read | Explicit HTTP 503 error; no successful empty catalog | Intentional error produces expected browser console entries |
| Digest `/data-hygiene?status=auto_applied#evidence` | Redirect reaches Agent Ops Hygiene; actual proposals request consumes `auto_applied`; refresh retains selection/fragment | Empty synthetic proposal set; approve/revert/reveal not executed |
| PPC and SEO | Six PPC tabs mount with existing reads; live SEO dashboard chunk and Organic Rankings mount | Empty fixtures; saved recommendations/apply/provider integration not browser-exercised |
| Changed panel names | Retention & Upsells opens stable `view=intelligence` and survives refresh; Message Automations opens existing Events content; `#tab=events` and `#tab=owed` resolve to the same existing panels | No outreach, scan, send, or automation edit performed |
| Mobile Settings | One Integrations link, Account, Staff and Recruiting retained for owner; old Team link opens Account; appropriate bottom tab remains selected | Existing horizontal header scrolling retained |
| Technician | Recruiting/Integrations links absent; direct Integrations query falls back to verified Account without fetching credential catalog | Nine owner-only aliases also have zero-child-render unit assertions |
| Guest login return | Original alias passed to existing login `next`; one mocked login; same canonical tab, status and fragment after authentication | Technician login intentionally retains `/tech` policy; reset-required/native handoffs not browser-exercised |

Screenshots were visually inspected for Account, Integrations, Tool Health,
Customers and Communications at desktop and mobile widths, plus the mobile
Settings index and technician Account. All 13 report **no page-level horizontal
overflow**. The new diagnostic link has a visible keyboard focus ring and a
44px target. Existing header strips scroll and expose the active leaf on mobile.
Runtime alert red remains for the synthetic critical failure. Existing legacy
small text, colored health/tier indicators and the crowded General tier cards
were preserved, not presented as a completed visual refresh. The hidden mobile
sidebar remains in the DOM; browser selectors distinguish its duplicate DOM links
from the visible Settings list. Its broader keyboard accessibility is retained
baseline behavior, not claimed fixed.

The final browser report has no unexpected page exceptions, unmatched API
fixtures or unrequested mutations. Console errors are the deliberately failed
catalog requests and one blocked pre-existing Google Fonts request from the
unchanged SEO dashboard. No new broken lazy chunk was observed. Local fonts were
loaded and verified for screenshots.

## Broader workflow coverage and limits

The entire navigation and static capability inventory were audited. Browser QA
was concentrated on changed behavior; it does **not** claim every operational
workflow was exercised end to end. Existing suites provide supporting evidence:

| Workflow | Existing coverage run | What remains unverified interactively |
|---|---|---|
| Customer/property/history and next service | `Customer360ProfileV2.state.test.jsx`, `.address-neighbors`, `.billing-pause`, `.prepay-prefill`; full client/server suites | Selecting real-seeming multi-property fixtures and inspecting all history/next-service drawers through the complete app |
| Estimate edit, review, send, acceptance | `EstimatesPageV2.edit-prefill`, `.agent-review`, `.mobile-row`, `AgentEstimatePage.test.jsx`; server `estimate-public-accept-atomicity`, `admin-estimates-send-channel-links` | Full database-backed estimate lifecycle, attachments and cross-route draft recovery |
| SMS/email, unread, drafts and mocked replies | Communications leaf/link-prefill tests; server SMS draft, email automation/provider retry/suppression suites | Complete SMS/email reply and draft-recovery browser workflow; Email drafts remain component state, a reason to defer embedding |
| Triage, commitments and agent intervention | `TriageInboxTabV2.test.jsx`, `OwedTabV2.test.jsx`, `AgentsHubPage.test.jsx`; server `admin-triage-feedback`, `call-commitments`, `ops-queue` | Resolving/retrying a full call/agent record in-browser; no second queue was created |
| Invoice/payment/balance/financial detail | `AdminInvoicesPage.test.jsx`, Customer360 billing tests; server invoice/manual-payment/payment-plan/webhook suites | Actual settlement, reconciliation, refunds, saved financial drafts and native checkout; all financial implementation unchanged |
| Staff versus applicants | `TimeTrackingTeam.test.jsx`; source review of `admin-timetracking` and `admin-careers`; role/navigation fixtures | Full applicant attachments/hiring/employee transition; no automatic transition invented |
| Scheduling/completion/report/customer/tech portals | Existing full client/server coverage, including native-return helpers | No shared workflow implementation changed; no DB, real device, public token integration or production verification |

No dev database was available or used. Migrations, DB-gated contracts, live OAuth,
provider delivery, real financial operations, actual outages/notifications and
physical iPhone/PWA safe-area behavior remain unverified. Production usage/gates
and database-held links were not inspected. Preserved backend source is evidence
of scope control, not proof of live integration health.

## Before/after measures

Same metadata, same roles and same optional-flag state were compared. Counts are
navigation choices, not a claim that every choice is an independent workflow.

| Measure | Before → after | Meaning |
|---|---|---|
| Desktop headings / owner destinations with Agent Estimate on | 8 / 34 → 8 / 34 | Work grouped more clearly; no artificial shorter-sidebar claim |
| Owner destinations with Agent Estimate off / technician destinations | 33 / 10 → 33 / 10 | Individual permissions and flag metadata preserved |
| Desktop nesting | One link level → one | Headings add no clicks |
| Fixed mobile tabs | 5 owner / 4 technician → unchanged | Schedule, Customers and Messages remain direct |
| Mobile Settings metadata leaves | 14 → 12 | Removed Team self-copy and duplicate Tap to Pay target |
| Rendered inline Settings leaves after existing standalone dedupe | Owner 11 → 9; technician 3 → 2 | Account and Integrations retain supported capabilities |
| Desktop Schedule position | 2 → 2 | Kept near the top after browser review |
| Retired small duplicate UI views | 0 → 2 removed | Self-profile Team view and repeated integration catalog |
| Duplicate full business workflows, queues/state stores, business action pipelines eliminated | 0 / 0 / 0 | Larger merges remain deferred; no fabricated consolidation count |
| Query/hash-dropping selected aliases repaired | 9 | Includes a consumed Data Hygiene status filter, not just string transport |
| Additional compatibility safeguards | Initial login return preserved; restricted child mounts prevented | Existing login reader and role predicate reused |
| PPC source removed | 2,703 lines / 83,133 bytes | Nine private functions, one private role helper, seven Recharts imports; no dependency deleted |
| PPC production chunk | 32,976 → 32,976 bytes | Already tree-shaken; no claimed PPC download saving |
| SEO production chunk | 185,184 → 185,184 bytes | Live SEO implementation retained |
| Tool Health chunk | 11,385 → 11,350 bytes | Also no longer depends on the separate integration-catalog chunk |
| Settings chunk | 64,634 → 68,883 bytes | Catalog now inlined here; former shared catalog chunk was about 5.58 kB, so comparing only this file would misstate the result |
| Communications chunk / main index | 275,513 → 275,530 / 472,697 → 472,634 bytes | Labels and local guard/redirect edits; no latency claim |
| Catalog GETs per ordinary Tool Health mount | 1 → 0 | Runtime polling unchanged; catalog loads when its canonical Settings view opens |
| Page-level profile reads from old Team URL | 2 → 1 | Shell verification is additional and unchanged; development StrictMode repeats mount reads, so browser totals are not production counts |

Navigation steps, excluding scrolling and record-specific actions:

| Starting condition and intent | Before → after |
|---|---|
| Desktop: open Customers, Schedule, Communications, Pipeline, Invoices, Staff or Agent Ops from persistent sidebar | 1 → 1 each |
| Mobile: open Schedule, Customers or Messages from another bottom tab | 1 → 1 each |
| Mobile: open Email, Staff, Recruiting, Invoices or Account from another bottom tab via Settings | 2 → 2 each |
| Tool Health: read credential catalog | Already on page (0) → Settings link (1); deliberate tradeoff for one detail home |
| Tool Health: request a credential check | Settings → Integrations → Refresh checks (3) → canonical link → Refresh checks (2) |

These are entry steps, not measured completion times for a customer/estimate or
financial task. Other desktop leaves changed scroll position; owner field use
should inform future ordering. No time savings, traffic-based disuse or improved
live latency is inferred. Raw count/deletion/bundle evidence is in
`navigation-comparison.json`, `deletion-proof.json`, `bundle-comparison.json`.

## Review and rollback

The second deletion review challenged route/lazy roots, exports, string lookup,
feature flags, side-effect imports, CLI/jobs/providers and external consumers.
All 46 remaining top-level PPC bindings compare byte-for-byte against the
pre-deletion source ranges located by the AST. No API, migration, package,
shared V1 export, state machine, monetary calculation, obligation, schedule,
provider or job code changed. The UI parity review produced and fixed the two
failure cases above; it did not simply accept screenshots or a green build.

Revert only task commits in this review branch, in reverse order when reverting
multiple slices. No database rollback or provider operation is involved.

| Local commit | Slice and rollback consequence |
|---|---|
| `fcaf55e26` | Inventory/parity/deletion plan; documentation only |
| `9760d0f94` | Initial regrouping/labels and prevention rule; reverting restores old names/groups |
| `b7d914bf0` | Nine aliases and route tests; reverting restores prior query/hash loss |
| `223cd9c51` | Retire duplicate profile/catalog views and mobile links; reverting restores the copies and extra reads |
| `1f1a6bb29` | Verified PPC deletion and its test/ledger update; reverting restores private dead declarations only |
| `017f132d7` | Profile-health isolation, shell login return and pre-mount role guard; reverting reintroduces the documented parity defects |
| `b8bf97f2b` | Keep Schedule second and add reproducible synthetic browser QA; reverting moves the group down and removes the QA runner |

Keep this worktree and ignored evidence for local review. Nothing has been pushed; reconcile the separate unpublished consolidation
branch before any future proposal to merge. The remaining product decisions are
listed in README and the deferred parity matrix.

## Completion record

**Complete locally for review.** Final application source is represented by
`b8bf97f2b`; subsequent edits are audit text and one additional mobile screenshot
assertion in the QA runner. Final source hashes were compared after commit hooks
with zero mismatches. The final controlled client run passed 264 suites / 2,516
tests; focused coverage passed 57 tests; build and lint checks above completed.
The final synthetic browser run passed all nine scenarios and captured 13 images.
No required implementation work remains in the selected subset. Broader merges
remain explicitly deferred for the parity/decision gaps above.
# PR review follow-up

PR #3980 reviewed commit `205f7b5ec6f3d7dc97d190b3e898fed958b30ab3`.
Review found that the real shared `adminFetch` hard redirect could race the
shell's contextual login navigation. The helper now preserves the document's
full path, repeated query parameters and fragment; an existing login return
target is retained. Both new helper tests failed before the fix and passed
after it. Browser QA now drives both guest and expired-token login through
the actual helper, with only HTTP responses mocked.

The browser startup path now acquires both Vite and Chromium inside its
cleanup scope. A missing-Chromium regression test proves the preview server
is closed even when launch fails. Server cleanup also runs if browser cleanup
throws. No broad cleanup or process-by-port termination is used.

After these source edits: client coverage passed **265 suites / 2,518 tests**
with two workers; the production build and prebuild gates passed; the
startup-failure Node test passed; synthetic browser QA passed **10 scenarios**
with the same 13 screenshots. The two focused helper/layout suites passed
15 tests. These supersede the earlier local results for the changed paths.

GitHub CI passed all seven jobs on the earlier published head, including its
disposable-database and native build jobs. That is not CI evidence for the
unpublished review fixes. Final-commit CI and Codex review remain required.

Opening the PR also invoked the repository's existing Railway integration,
which automatically created a PR preview. Read-only configuration inspection
confirmed a dedicated preview Postgres connection, `GATE_CRON_JOBS=false`,
`GATE_TWILIO_SMS=false` and `SMS_PREVIEW_MODE=true`. No credentials were printed
or copied to a checkout, and no database/provider request was made by this
session. This automatic preview is separate from local frontend verification;
it must not be described as "no deployment occurred." Production and merge
operations remain outside the task's authorization.
