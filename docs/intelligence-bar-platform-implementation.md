# Intelligence Bar platform implementation

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
  existing 208 definitions and dynamically loads authorized cross-module tools.
  Unknown classifications and injected top-level actor/approval fields fail closed.
- `outcomes.js` recognizes blocked/failed/unknown/partial/provider-accepted results.
  Confirmation and recovered cards use stored outcomes; accepted SMS audit failures
  retain provider acceptance without implying delivery or permitting a repeat send.
- `ib_tasks` extends the existing query, threads, and pending-action store with
  actor/session/request identity, immutable approval credentials, durable model
  checkpoints, runner leases, and same-step dedupe after target resolution.
  Only one unresolved write can exist in a task; subsequent writes require a
  completed or provider-accepted predecessor. Partial or unknown outcomes stop
  dependent continuation. No background agent/job framework was added.
- `task-context.js` reads current page and mutation identifiers from a whitelist,
  verifies parent-child relationships, and binds customer writes to the current
  request's resolved target. Message/replacement text and old history cannot
  select a customer. Duplicate names and unmatched surnames require clarification.
- Navigation and Clear invalidate late UI updates. Saved tasks remain recoverable;
  closing or clearing a chat does not cancel already-confirmed operations.
  The phone sheet uses existing visual viewport variables and puts History/New
  chat in a disclosure. Recorded action cards take precedence over model prose.

## Transport exceptions

The census records every discovered request/export site, including Intelligence
Bar transport itself. The ten changed/new query, task, and receipt sites are
reviewed exceptions: a model must not receive a tool that invokes its own query
route, chooses another session, or obtains/consumes confirmation credentials.
These exceptions do not grant coverage to any customer, estimate, inventory,
financial, communications, or other domain operation.

`npm run check:ib-coverage` compares AST request fingerprints with the reviewed
manifest. New or changed calls need a concrete tool + outcome evidence or an
explicit exception for that exact fingerprint. The original `a2bb0bc49` census
remains the baseline; an unmapped baseline row is unsupported/unverified, never
an implicit exception. Wrapper/dynamic endpoints and local exports remain in
scope. Server-generated action variants need separate semantic review even when
one UI request site dispatches them.

Current foundation census: 1,667 UI sites; ten transport exceptions; 1,657 domain
sites still unsupported/unverified in the matrix. Registration of existing tools
has deliberately not been relabeled as verified application parity.

## Verification evidence

- Real Express route + bearer authentication + domain executor + isolated Railway
  development Postgres, scripted model: ten tests pass in
  `server/tests/intelligence-bar-platform-db.test.js`. Independent row reads verify
  A changes while viewed B remains unchanged. Cases include ID tampering, bulk
  targeting, message-body names, surname mismatch, request replay, stale runner,
  actor/session mismatch, revoked auth, ambiguity selection, failed predecessor, and
  full-precision customer-version comparison under the domain row lock.
- Client regression tests: eight pass across GlobalCommandPalette,
  PendingActionsCard, and useIntelligenceBar. They cover query-only navigation,
  double Enter, close/reopen, Clear races, failed results, restored warnings, and
  timeout-after-commit recovery without a second POST.
- Focused existing IB suites: 49 suites / 474 tests passed, followed by all
  36 write-gate contract tests after adding the new helper/discovery classifications. The DB suite skips in the
  no-DB run and passes separately above. An accidental whole-repository test
  selection was stopped; full-repository completion is not claimed.
- Coverage-check regressions: three pass (wrapper/dynamic census, changed-source
  fingerprint enforcement, required action policy and verification evidence).
- `npm run build` passes, including blog/affiliate vendor checks, portal brand,
  and domain rules. ESLint reports no errors; large legacy route/card functions
  still have structural warnings. Refactoring the rewritten route remains work.
- Chrome via Playwright rendered the actual Customers page at 1440×1050 and
  390×844 against the isolated database. Confirmation used the real route and
  database; only the model and ancillary feature/notification/usage responses were
  controlled. Independent database read-back confirmed A changed and B unchanged.
  No JS exceptions or horizontal sheet overflow occurred. Payers/requests were
  not mounted in the isolated harness; disabled thread reads returned their
  expected 404. Screenshot files are private artifacts under `.local/`.
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

Phase 2 property creation/labels/primary switching, shared inventory operations,
and existing-customer estimates are next. Phase 3 remaining domain operations
are enumerated in `intelligence-bar-remaining-capabilities.md`; this is engineering
work, not a credential blocker. Compound workflow and comprehensive adversarial
verification remain incomplete.

Browser review also found that Customer 360's modal covers the global touch
opener; keyboard activation works. A touch entry inside record overlays and
refresh of affected views remain required. Real iOS keyboard/safe-area behavior,
voice permission/error states, attachment failure, full live-model behavior,
and performance checks have not been verified. No full-parity completion claim
is supported by this foundation checkpoint.
