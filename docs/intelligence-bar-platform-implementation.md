# Intelligence Bar platform implementation

> Review split: this is the evidence ledger for the integrated #4019 stack.
> The catalog-only branch does not yet contain that runtime, UI, or database
> integration. See [the split boundaries](intelligence-bar-foundation-review-split.md).

## Objective and authorization

Implement verified parity with supported admin operations, preserving domain
validation, role restrictions, operator confirmation, and external-action gates.
Development and synthetic testing are authorized. Production writes, migrations,
messages, purchases, charges, refunds, merges, and release-gate changes are not.

## Execution plan

1. Reproduce context and completion failures; inventory actual UI actions;
   establish one permission-aware discovery/execution registry and trustworthy
   outcomes on the existing route, confirmation store, and thread architecture.
2. Share authoritative customer/property, inventory, and estimate operations;
   verify each across page contexts with synthetic persisted fixtures.
3. Complete the uncovered scheduling, communications, billing, configuration,
   reporting, and other actions in the coverage ledger; verify dependent workflows.
4. Exercise adversarial, concurrency, uncertainty, and mobile/desktop scenarios;
   reconcile all coverage and record precise remaining blockers.

Each phase stays reviewable in dependency order. An executor registration or
mocked provider response is not evidence of end-to-end capability.

## Baseline

- Source: `a2bb0bc49`, isolated worktree `wt-ib-platform`, branch
  `feat/ib-platform-foundation`. The original checkout's active changes are
  preserved, including its Intelligence Bar embed retirement.
- `getToolsForContext` excludes procurement on Estimates. Existing procurement
  tools cannot be discovered there.
- Global palette passes only pathname, omitting selected record IDs; its epoch
  follows tool context rather than viewed entity, and persisted history spans
  navigation. The shared hook's Clear does not invalidate in-flight requests.
- Confirmation tests only `result.error`, although real executors also return
  `success:false`, `failed:true`, or `blocked:true`. A blocked estimate can be
  displayed as done. History already recognizes these failure forms.
- The prompt's ET date is evaluated at module load, not per request. Preview
  instructions compete with generic conversational confirmation instructions.
- Property create/label UI exists. No direct primary-selection control was found
  in the current property panel; the screenshot's claim that it exists is not
  evidence. Primary changes have an existing domain operation in
  `property-role-proposals.js` with address and appointment safeguards.
- Current proposal IDs are actor/hash/expiry-bound and claimed atomically;
  technician execution is already default-deny. These boundaries must remain.

## Foundation implementation

- `action-registry.js` validates explicit role/side-effect/approval policy for the
  existing 209 definitions and dynamically loads authorized cross-module tools.
  Unknown classifications and injected top-level actor/approval fields fail closed.
  Every entry also declares a data `scope` (see
  `intelligence-bar-read-scope-catalog.md`); a missing or invalid scope keeps the
  tool out of the registry and `task-context.js` refuses it as `scope_unclassified`.
- `outcomes.js` recognizes blocked/failed/unknown/partial/provider-accepted results.
  Confirmation and recovered cards use stored outcomes; accepted SMS audit failures
  retain provider acceptance without implying delivery or permitting a repeat send.
- `ib_tasks` extends the existing query, threads, and pending-action store with
  actor/session/request identity, immutable approval credentials, durable model
  checkpoints, runner leases, and same-step dedupe after target resolution.
  Only one unresolved write can exist in a task; subsequent writes require a
  completed or provider-accepted predecessor. Partial or unknown outcomes stop
  dependent continuation. No background agent/job framework was added.
- `task-context.js` reads current page and action identifiers from a whitelist,
  verifies parent-child relationships, and binds customer reads and writes to the current
  request's resolved target. Message/replacement text and old history cannot
  select a customer. Duplicate names and unmatched surnames require clarification.
  Unique exact surnames resolve through the same fresh customer lookup. Raw
  phone/email recipients must begin the current request's recipient expression;
  numbers inside a named recipient's message or a note cannot authorize a send.
  A resolved customer's phone is pinned from the live record and checked again.
- Bulk lead updates retain the existing server predicate preview, complete target
  disclosure and exact-set executor. An action-specific selection proof authorizes
  only that cohort, only for an explicit current bulk request without a narrower
  customer target. Full-precision lead versions are rechecked under write locks.
  Bulk customer IDs still need independently established targets; model-supplied
  ID lists are not treated as server-selected cohorts.
- Scoped email search returns linked customer messages and unlinked replies in
  exclusively owned threads; shared names, orphan messages and mixed-customer
  threads cannot widen the result. Unscoped inbox searches remain available.
  Gmail send failures distinguish uncertain message submission from definitive
  rejection and OAuth/pre-send errors. Unknown results persist without replay or
  dependent continuation. The existing pre-send transport classifier is shared
  with GBP, and message POST transport retries are explicitly disabled.
- The existing IB retention tick removes expired task recovery data after the
  30-day window, including while the platform gate is off. A live runner lease
  postpones deletion; separate actor-bound action receipts remain available for
  reconciliation. The shared identity helper uses Web Crypto, including
  `getRandomValues` for UUID v4 generation without native `crypto.randomUUID`.
- Navigation and Clear invalidate late UI updates. Saved tasks remain recoverable;
  closing or clearing a chat does not cancel already-confirmed operations.
  The phone sheet uses existing visual viewport variables and puts History/New
  chat in a disclosure. Recorded action cards take precedence over model prose.

## Transport exceptions

The census records every discovered request/export site, including Intelligence
Bar transport itself. The five current query, task, and receipt sites are
reviewed exceptions: a model must not receive a tool that invokes its own query
route, chooses another session, or obtains/consumes confirmation credentials.
These exceptions do not grant coverage to any customer, estimate, inventory,
financial, communications, or other domain operation.

`npm run check:ib-coverage` compares AST request fingerprints with the reviewed
manifest. New or changed calls need a concrete tool + outcome evidence, a genuine
capability exception, or a `reviewed_unmapped` acknowledgment for that exact
request fingerprint. The acknowledgment uses the same review-metadata checks but
remains in the unsupported/unverified count; formatting or UI retry work does
not remove a domain capability from the backlog. The original `a2bb0bc49` census
remains recorded. The task branch was updated to `e4de41345` before Phase 2;
25 additional upstream sites and ten upstream fingerprint changes are separately
marked with that source commit. Deleted upstream sites remain recorded, and no
task-authored operation was grandfathered. An unmapped baseline row is unsupported/unverified, never
an implicit exception. Wrapper/dynamic endpoints and local exports remain in
scope. Server-generated action variants need separate semantic review even when
one UI request site dispatches them.

The subsequent `625dc2c38` main integration records PR #4015's property lookup
and two address-aware slot-search changes with upstream provenance and prior
fingerprints. These three scheduling sites remain **unmapped**. Phase 3 must
verify selected-property ownership and completeness, address-specific availability,
and quote/property compatibility through the shared scheduling path; no scheduling
parity is claimed by importing already-merged portal code into this foundation.
The booking submission also carries `propertyId` in its separately constructed
body. Its unchanged request call is not flagged by the source fingerprint;
selected-property stamping and quote compatibility remain explicit Phase 3 work.

The `5e81129e7` integration imports the upstream email consolidation and editor/
mailbox extraction: 21 additional sites and one changed Communications site,
verified against that source commit and retained as **unmapped**. Older moved
sites and fingerprint history remain recorded. No email parity is implied.

The `bd735bc42` main integration adds the completion pricing source reader;
its exact upstream fingerprint is recorded as unmapped. No scheduling parity is
claimed by importing this already-merged portal action.

The desktop query site's reviewed fingerprint was refreshed in place when the
request identity became retained across a dropped response (the call now
serializes the request once and reuses its key until the server answers).
Same exception, same reason: transport is not a domain capability and no
action gained coverage. Refreshed again when settle became identity-bound
(the call spreads a captured identity instead of calling begin inline, so a
stale response cannot clear a newer request key); same exception, same
reason, no action gained coverage.

The `f2e61b677` integration imports the upstream Pipeline estimate lifecycle,
reviewed send dialog and customer SMS consolidation. Seventeen additional sites
and one changed customer-search fingerprint were checked against that exact
source commit and remain **unmapped**. The prior fingerprint and retired sites
remain recorded. This addresses CI's merged-main census drift without claiming
support for those new portal actions.

Current foundation census: 1,746 retained UI sites; seven current transport
exceptions; 1,739 sites still unsupported/unverified in the matrix. Historical
transport calls remain recorded after their frontend sites changed. Registration of existing tools
has deliberately not been relabeled as verified application parity.
The dependent property branch adds two UI sites and verifies four property
operations: 1,748 retained sites, seven transport exceptions, and 1,737 unverified.
The inventory branch adds its retained request site and four partially verified
admin inventory scopes; the technician and other remaining scopes continue to
count as unsupported/unverified. Its final census retains 1,750 sites: four
verified property sites, eight transport/navigation exceptions, and 1,738
unsupported/unverified sites including the four partial inventory entries.

## Verification evidence

The integrated runtime passes all 29 real PostgreSQL route scenarios in one
run (84.38 seconds), including receipt preservation in the response after
Continue. The bulk preview and execution use the same private approved cohort;
persisted approval formats stay unchanged. Model-proposed alternate SMS names
cannot replace a resolved customer before approval.

The final parent-integrated server run passes all 262 tests across ten suites.
The shared hook, shell, global bar, cards and session identity pass 43 client
tests. These cover duplicate-name selection, confirmations, continuation,
saved-task recovery, stale responses and unavailable status reads. The parent
recovery/target suites independently pass 28 real PostgreSQL cases. These are
scripted-model and isolated-database checks, not a live-model evaluation.

The shared ProtocolPanel bar uses the same durable task card and task endpoints
as the global bar. Navigation remounts it by appointment ID. Confirmed and
cancelled receipts remain visible when the following status refresh fails;
Clear removes the local transcript and leaves saved operations recoverable.
Dedicated agent-estimate and technician contexts remain isolated.

Repeated confirmations, an intervening model outage, and pre-model ambiguity
selection retain the original or latest successfully appended thread cursor.
An unseen concurrent conversation append is refused without changing its tail.
Review drafting rejects a foreign customer review before model generation;
review approval shows the review identity, hides its execution token, and
refuses changed customer linkage before publishing.

Desktop (1440) and mobile (390) Chrome screenshots verify the review identity
card and cancel action, with no JS exceptions or horizontal overflow. The
review reply remains unset in PostgreSQL after cancellation. Shared-shell browser
checks at both widths also select between duplicate names, confirm a note,
Continue, Clear, reload and recover the saved receipt. Independent database reads
verify that only the selected fixture changed; no console errors, network
failures or horizontal overflow occurred in that focused harness. Earlier runtime
screenshots verify A-only note persistence and expired approvals without
executable controls. Native iOS notches/keyboards, voice and live-provider
delivery remain unverified. Earlier regression evidence is retained below.

- Real Express route + bearer authentication + domain executor + isolated Railway
  development Postgres, scripted model and controlled Gmail: twenty-five tests pass in
  `server/tests/intelligence-bar-platform-db.test.js`. Independent row reads verify
  A changes while viewed B remains unchanged. Cases include ID tampering, bulk
  targeting, message-body names, surname mismatch, request replay, stale runner,
  actor/session mismatch, revoked auth, ambiguity selection, failed predecessor, and
  full-precision customer-version comparison under the domain row lock. Integrated
  regressions also cover saved-property destination changes, exact unlinked-email
  sender selection, cancellation receipts, and recovery before the first checkpoint.
  Ambiguous reads now stop before invoking the model; target selection retains
  the validated, bounded text history and original draft. Stale page hints do
  not block unrelated or explicitly named requests. Task list/detail states are
  derived from actor-bound receipts: settled actions become ready to continue,
  failed/canceled/partial/unknown steps retain their actual status.
  New cases prove a record read for A cannot return B's private details, broad
  lookup still works, expired task records are deleted with the gate off, active
  leases postpone deletion, and unknown action receipts survive under their actor.
  Visit/call IDs, customer names/phones and Gmail threads are included. Name and
  phone readers receive validated customer IDs; mixed-customer email threads
  refuse before model egress, and shared-phone SMS excludes other linked accounts.
  A scheduler regression proves both purges run in the one existing ET cron tick.
  Added cases cover surname ambiguity, body-number substitution (including an
  unresolved name and no delimiter), Gmail uncertainty/replay, exact bulk lead
  selection, locked lead versions and permission revocation after approval.
  A real Google SDK with an in-memory transporter separately checks message
  timeout/reset/408/503 and unreadable accepted response, known 4xx rejection,
  DNS/TLS failure, and OAuth refresh failure without a message POST. The six
  focused confirmation, registry, email, SDK and GBP suites pass 143 tests.
- Client regression tests: eighteen pass across GlobalCommandPalette,
  PendingActionsCard, and useIntelligenceBar. They cover query-only navigation,
  non-URL appointment selection, double Enter, close/reopen, Clear races, failed results, restored warnings, and
  timeout-after-commit recovery without a second POST.
  The latest bar suite passes thirteen tests, including legacy threaded cards
  retained across navigation with task recovery disabled and confirmation
  settlement that survives a later close/reopen. Sixty-seven focused server
  tests cover confirmation, pending receipts, and controlled Gmail/SMS outcomes.
  A provider-accepted SMS with an incomplete inbox update stays partial and
  blocks dependent writes; the accepted send ID is retained to prevent retries.
- Integrated IB regression run: 51 suites / 539 tests passed with one search SQL
  assertion failing; preserving the upstream query corrected it, and the two
  affected suites then passed all 15 tests. Four optional context tests and the
  ten database tests skip without a database; the database tests passed separately. An accidental whole-repository test
  selection was stopped; full-repository completion is not claimed.
- Coverage-check regressions: three pass (wrapper/dynamic census, changed-source
  fingerprint enforcement, required action policy and verification evidence).
- `npm run build` passes, including blog/affiliate vendor checks, portal brand,
  and domain rules. ESLint reports no errors; large legacy route/card functions
  still have structural warnings. Refactoring the rewritten route remains work.
  After the Pipeline main integration, the 24 foundation database cases and 34
  reviewed-send regressions pass together (58 total); bar, UUID, shared send dialog
  and layout badge suites pass 25 client tests. Build and brand checks pass.
  Recovery review adds a passing database case for completed-read non-resumability
  and interrupted attachment requests: missing images require a new request.
  All 25 foundation database cases and 25 bar/card client tests pass. Expired
  proposals retain their expiry state, hide approval controls and explain renewal.
  Desktop/mobile Chrome verifies that recovered expired proposals show neither
  awaiting-confirmation copy nor an executable approval; no JS exceptions.
  Artifacts: `.local/ib-recovery-{desktop,mobile}-expired.png`.
- Chrome via Playwright rendered the actual Customers page at 1440×1050 and
  390×844 against the isolated database. Confirmation used the real route and
  database; only the model and ancillary feature/notification/usage responses were
  controlled. Independent database read-back confirmed A changed and B unchanged.
  No JS exceptions or horizontal sheet overflow occurred. Payers/requests were
  not mounted in the isolated harness; disabled thread reads returned their
  expected 404. Screenshot files are private artifacts under `.local/`.
  A subsequent desktop/mobile run with threads enabled and platform tasks
  disabled verified navigation, confirmation and reopened legacy receipts with
  zero JS exceptions. Screenshots are `.local/ib-legacy-*-navigation.png` and
  `.local/ib-legacy-*-persisted.png`; earlier unstyled screenshots are superseded.
  A further desktop/mobile run removed `Crypto.prototype.randomUUID` before the
  app loaded: valid UUIDs, query, confirmation and persisted A-only mutation all
  passed with no JS errors or overflow. Artifacts: `.local/ib-uuid-*`. The latest
  client run passes 20 tests (17 bar, two identity, one hook); all six scheduler
  registration tests and the production build pass after current-main integration.
  Client-only native CI initially failed to resolve the server-owned UUID package.
  The identity helper now uses Web Crypto directly, with no client UUID dependency.
- Local preview: `http://127.0.0.1:5292/admin/customers` while the QA harness runs;
  this is not a deployed preview. The synthetic session is local-only.
- Live-model/provider evaluation has not run. No provider credentials are loaded
  in this harness, and no production customer records or external effects are QA.

## Migration and rollout

`20260906000061_ib_task_receipts.js` was checked up/down/up inside a rolled-back
transaction, then applied only to the dedicated schema-only development database.
No production migration, deployment, merge, release gate flip, or customer
communication was performed. `GATE_IB_PLATFORM` defaults off.

## Outstanding implementation

Phase 2 saved-property creation, labels/occupancy and primary switching are
implemented in `intelligence-bar-property-workflows.md`. Shared admin inventory
stock/request/receive operations are verified in `intelligence-bar-inventory-workflows.md`,
with technician coverage explicitly incomplete. Administrator existing-customer
residential lawn creation/revision is implemented in
`intelligence-bar-estimate-workflows.md`; the other estimate programs and lifecycle
remain incomplete. Phase 3 remaining domain operations
are enumerated in `intelligence-bar-remaining-capabilities.md`; this is engineering
work, not a credential blocker. Compound workflow and comprehensive adversarial
verification remain incomplete.

Customer 360 now has an overlay touch opener and matching-record refresh for
verified property mutations; the scoped context survives overlay open/close.
The property browser run supersedes the earlier unstyled harness screenshots.
Affected-view refresh for remaining domains is still required. Real iOS keyboard/safe-area behavior,
voice permission/error states, attachment failure, full live-model behavior,
and performance checks have not been verified. No full-parity completion claim
is supported by this foundation checkpoint.
# Review split

This ledger describes the complete development stack. The registry/coverage
foundation alone adds the catalog and drift check; runtime discovery, task
targeting and recovery are introduced by its dependent PRs. Recorded browser
and database evidence below was obtained against the integrated stack, not
against the registry-only commit. See `intelligence-bar-foundation-review-split.md`.

Customerless reservation protection: `unlinkedRecordIsReferenced` refuses an
appointment without a customer owner when the task has customer targets. This
keeps live estimate slot holds out of another customer's single/bulk move. The
bulk-move customer join qualifies `scheduled_services.id` so the query reaches
that target check. Own-customer and deliberately unscoped operations retain
their existing rules.

Evidence: two new unit regressions failed before the fix; the final scheduling,
target, and write-gate suites pass 176 tests. Two isolated PostgreSQL cases pass,
covering single/bulk proof validation and actual query → discovery → move
proposal refusal. The route test asserts `target_clarification_required`, no
approval row, and an unchanged hold. Focused DB runs exclude unrelated cases
whose prior evidence remains recorded above.

Read validation now runs for every platform read, including tasks with no
resolved customer. A misspelled current name or model-selected unlinked call
cannot expose an unrelated record. A phone at the start of an explicit
conversation/history lookup may establish one fresh read target; ambiguous or
substituted phones refuse, and that lookup never grants authority to write.

The affected route/target PostgreSQL suites pass all 60 cases (36 route and
24 target cases); the unchanged parent recovery suite passes 14. The route
proof covers token and phone canonicalization for all three flexible estimate
actions, then inserts a newer phone-matched estimate before confirmation and
verifies the original estimate changes once while the newer row stays untouched.
Server unit/contract checks pass 252 cases; four affected client suites pass
38 cases. The production build, brand, domain and coverage checks pass. The
controlled browser evidence above remains applicable to the unchanged UI.

The latest parent integration includes the focused selection correction #4094
and converted-lead email ownership checks. Route regressions now prove that a
stale selected customer cannot replace an unmatched name, authorize an incomplete
named cohort, or shrink a complete cohort. A duplicate normalized phone also
refuses conversation access without granting write authority.

Review status: #4019's unmatched-name finding is addressed by unconditional
platform read validation and the route acceptance tests. The client UUID
dependency is removed; the existing shared identity helper uses Web Crypto and
retains its fallback for browsers without `crypto.randomUUID`. Fallback tests
verify cryptographic randomness, UUID v4 formatting, distinct request keys,
actor isolation and unavailable storage. Final-head remote review remains required.
