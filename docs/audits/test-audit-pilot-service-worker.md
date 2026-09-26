# Service-worker test-audit pilot

The original pilot is recorded below at its audited revision. The final section
records the authorized implementation of its eight improvement candidates.

## Scope and result

Audited revision: `c71cbebfe1353aa1ea33e1a85868a6fe117da5c9`.
The test and production files matched that revision throughout the audit;
only the new skill, this report, and `CLAUDE.md` authoring guidance changed.
The pilot used `.claude/skills/waves-test-audit/SKILL.md` with an independent
read-only investigation and a focused baseline run.

**Retain all 50 tests.** Seven source-contract tests warrant stronger
behavioral assertions; one runtime test can improve its clock control.
There is no demonstrated whole-test consolidation or removal candidate.
The 42 cache cases exercise distinct failure modes despite sharing a harness.
No production code, test, test-support code, threshold, or CI selection changed.

Counts were verified against both the working file and `git show HEAD`:
8 update-contract tests plus 42 cache-behavior tests. Of the 50, 42 are marked
keep and 8 improve; improve means retain the contract pending an evidenced
replacement, not remove its existing protection.

## Owners and history

All line numbers below refer to the audited revision.

- `client/src/main.jsx:44` registers `client/public/sw.js`.
- `client/public/sw.js` owns shell/build claims and pruning (`42`, `333`,
  `508`), install/activate/fetch handling (`535`, `596`, `604`), and push,
  badges, and notification clicks (`720`).
- `client/vite.config.js:33` produces the build-asset manifest.
- `server/services/notification-triggers.js:1096` produces push/badge payloads.
  `client/src/components/NotificationBell.jsx:30` and
  `client/src/hooks/useUnreadConversations.js:40` consume push-refresh messages.
- History: `1b21465b32` (#4335) added bounded-cache/race regressions;
  `77468ce2ea` (#4389) added manifest ownership; `d1dd608dfc` (#3541)
  covered badge ordering; `67647ed4f4` added visible-page synchronization.
- `.github/workflows/tests.yml:254` runs client coverage and the production
  build. The target suite is included in that broad Vitest selection.

## Candidate ledger

References in this table are test starts in
`client/src/service-worker-contract.test.js`. No production seam deletion is
justified. The runtime harness evaluates the real worker with fake Cache API,
network, and Web Locks; it does not replace the cache algorithm under test.

| Test | Decision | Failure protected and remaining proof |
| --- | --- | --- |
| `158`: preloads assets before shell | Improve | A shell must not replace its required assets prematurely. Literal names/order are refactor-sensitive; runtime tests at `244`, `276`, `971`, `1036` cover parts, not every assertion. Map individual assertions before replacing them. |
| `172`: origin-wide Web Locks | Improve | Different worker instances must serialize shared-cache writes. Runtime cases at `518` and `932` provide stronger ordering proof; preserve cross-instance lock scope. |
| `182`: install failure and cache scope | Improve | Failed installs must propagate and unrelated caches must survive. Runtime quota/non-quota cases at `878`, `912`, `971` cover parts; lifecycle/cache-scope assertions still need an explicit runtime mapping. |
| `191`: legacy cache sweep | Improve | Old Waves caches should be removed while badge/unrelated caches survive. The copied regex tests itself. Reclaim behavior at `878` does not establish activate-event deletion behavior. |
| `203`: same-origin notification destination | Improve | Untrusted push URLs must not navigate outside the portal. Keep this security guard until an executed push/notification assertion covers malicious and valid URLs. |
| `208`: numeric badge gating | Improve | Invalid badge payloads must not call badge APIs. No executed worker badge assertion was found; source strings alone are weak proof. |
| `215`: badge ordering and cache isolation | Improve | Older pushes must not overwrite newer counts, and cache cleanup must preserve ordering state. `NotificationBell.test.jsx:274` covers the page path, not the worker path. The literal-string comparison at `227` supplies no independent production proof. |
| `230`: visible-page refresh after push | Keep | Executes a push and asserts a message to visible clients and none to hidden clients. `useUnreadConversations.test.jsx:71` checks the consumer's distinct behavior. |
| `1153`: active navigation predating install | Improve | A late active-worker response must not replace the newly installed shell; a newer navigation may. Keep this cross-worker regression, replacing two real 5 ms delays with the harness's controllable clock when this test is next changed. |

Remaining cache cases are grouped below only to keep the ledger readable;
each listed declaration is retained independently.

| Test starts | Decision | Distinct proof retained |
| --- | --- | --- |
| `244`, `276`, `309` | Keep | Generation retention, overlapping refresh serialization, and shared-chunk retagging. |
| `325`, `357`, `396` | Keep | Chunks loaded before shell refresh, out-of-order completion, and late-refresh retention. |
| `428`, `442` | Keep | Same-shell preservation and cache-hit versus network-fetch behavior. |
| `463`, `492`, `518`, `545`, `576` | Keep | Cold-start memo race, prune/retag race, cross-worker lock, delayed body, and consumed-response cloning. |
| `597` | Keep | Stable build identity across asset ordering, distinct builds, and bounded header size. |
| `607`, `639`, `666`, `689` | Keep | Firm claims, repeated failed navigations, first-load inference, and quota recovery from provisional claims. |
| `739`, `767`, `807`, `829`, `840`, `853` | Keep | Manifest ownership, provisional upgrade, exclusion, shell/list mismatch, cleanup, and old cached-build recovery. |
| `878`, `912`, `932`, `971` | Keep | Stale-bucket quota recovery, failed retry preservation, installer ordering, and non-quota failure propagation. |
| `979`, `1015`, `1036`, `1055`, `1076` | Keep | Stale memo reads, interrupted claims, partial-batch cleanup, current-bucket quota recovery, and shell-write rollback. |
| `1095`, `1130`, `1189`, `1225`, `1284`, `1317`, `1336`, `1372` | Keep | Supersession during different write phases, preserving newer claims, restoring shell/memo, same-tick ordering, marker-store failure, late responses, and queued retag merging. |

## Baseline and limits

Executed with the repository's Node 20 runtime, installed lockfile
dependencies, and an environment without provider/database credentials:

```sh
npm --prefix client test -- src/service-worker-contract.test.js
```

Result: **50 passed, 0 failed, 0 skipped**, exit 0. Vitest reported 795 ms
total and 136 ms test execution; process wall time was 2.83 s. These are one
local baseline sample, not a performance benchmark. No after-change speedup
or coverage improvement is claimed because no test implementation changed.

This was not browser/native end-to-end proof. The worker's badge, activation,
and notification behavior needs executable coverage before removing its
remaining source guards. The response double currently lacks `json()` and
the harness does not expose badge APIs or notification assertions, so a
follow-up should extend the existing harness rather than create a parallel one.
Database and full server suites were outside this pilot's scope.

No entire test met the skill's deletion threshold. Static shape and shared
setup alone supplied no removal evidence. Pilot feedback added one clarification: assess
mixed assertion groups separately before dropping any entire test.

## Follow-up: executable contracts

The follow-up starts from `7ab29d674281a23635e2b2a55f7c516bf973805a`.
It extends the same test harness with response JSON parsing, request cache
options, observed badge/lifecycle APIs, activation, and notification clicks.
Production `sw.js`, CI selection, and coverage thresholds are unchanged.

The seven source-contract cases now have executable proof. All 42 cache
regressions and the visible-client push case remain. The worker suite grows
from 50 to 66 cases because valid/invalid URL and badge inputs are parameterized.
The assertion replacements are mapped here; test names refer to
`client/src/service-worker-contract.test.js`.

| Original candidate | Retained executable proof |
| --- | --- |
| Preload/order (`158`) | `reloads shell assets and finishes their writes before replacing the shell or activating` observes reload-mode requests and holds an asset write while the old shell remains. `waits for every started asset write before rolling back a failed install` proves a rejected write cannot release the batch before a delayed sibling settles. Existing navigation/memo/rollback cases retain the other behavioral contracts; private helper spelling and write-count shape are obsolete. |
| Shared locks (`172`) | `uses cache lock names shared with previously installed workers` observes the stable cross-version lock names. The existing two-worker prune/re-tag and install-shell-fetch races retain serialization proof. |
| Install failure/cache scope (`182`) | `does not sweep buckets when the precache fails for a non-quota reason` now also rejects activation via `skipWaiting`; the successful install case observes it only after the writes. Existing quota-reclaim and failed-retry cases preserve the active shell and stale buckets. |
| Legacy sweep (`191`) | `activates by sweeping only stale Waves buckets and preserving current, badge, and unrelated caches` drives the actual activate event and asserts exact cache survivors plus client claiming. |
| Notification destination (`203`) | `constrains pushed notification URL … through click navigation to …` covers eight valid, foreign, malformed, and missing URL inputs through push, notification data, and click/openWindow. |
| Numeric badge gate (`208`) | `sets positive unread badges and clears zero without Web Locks support`, seven `ignores non-integer badge …` cases, and `still shows a notification when the Badging API is unavailable` observe real handler calls and fallbacks. |
| Badge order/isolation (`215`) | `preserves badge ordering through activation and restart, including equal stamps and a newer clear` verifies durable state, older snapshots, tied counts, and clears. `waits for the page badge lock so a delayed push cannot undo a newer page clear` holds the page's shared lock and checks the resulting badge state. |
| Timing (`1153`) | `does not let an active navigation that began before an install replace the installed shell (two instances)` uses explicit clock values 1000 → 2000 → 3000 instead of two 5 ms sleeps. Its shell and asset assertions are retained. |

Validation used Node 20, lockfile dependencies, and a credential-free environment:

```sh
npm --prefix client test -- src/service-worker-contract.test.js src/components/NotificationBell.test.jsx src/hooks/useUnreadConversations.test.jsx
```

Baseline: **88 passed** (50 worker + 38 related notification tests).
After: **104 passed** (66 worker + the same 38), zero failures or skips.
ESLint for the changed test, `check:portal-brand`, `check:domain-rules`, and
`git diff --check` pass. No performance improvement is claimed from local
timing samples. Browser/native end-to-end and database migrations were not run.

Nineteen temporary production mutations each failed the intended assertion:
asset reload removal; batch `allSettled` → `all`; premature shell write;
each cache lock rename; cache-lock bypass; swallowed install failure;
premature `skipWaiting`; omitted legacy sweep; overly broad cache sweep;
foreign-origin acceptance; unsanitized notification data; removed integer
badge gate; removed API-support guard; removed older/tied badge guards;
page badge-lock bypass; badge-cache rename into the app prefix; and disabled
install-order marker. Each probe ran in the task-owned checkout, then restored
`sw.js` byte for byte before the clean suite. Its SHA-256 remained
`2e2cbedf500a2934da5f8882156b9a5464887a38c0d32ecbd42bccf19a1865ab`.
