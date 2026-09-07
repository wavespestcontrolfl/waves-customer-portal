# Intelligence Bar foundation review split

The implementation assignment remains platform-wide. This split narrows review
units without reducing the capability denominator or claiming unverified parity.
All branches remain drafts; production migration, gate activation, and customer
communications are outside the development/testing authorization.

## Dependency order

| Part | Branch | Scope |
| --- | --- | --- |
| A | `feat/ib-registry-coverage-foundation` / #4041 | Typed catalog and explicit action policy over existing executors; source census and CI drift check. No runtime route or UI integration. |
| B1 | `feat/ib-target-validation-foundation` / #4062 | Current-request identity resolution, fresh parent/child validation and scoped reader input preparation. |
| B2 | `feat/ib-target-context-foundation` / #4044 | Scoped domain readers, provider outcome classification and identity-bound review publishing. |
| C | `feat/ib-task-recovery-foundation` / #4049 | Actor/session task ledger, confirmation receipts, safe resume and bounded sensitive-context retention. |
| D | `feat/ib-platform-foundation` / #4019 | Route and UI integration, durable conversation continuation, desktop/mobile and real dev-database acceptance tests. |

Property #4021 and inventory #4029 remain dependent on D. Existing-customer
estimate work is preserved separately until these foundations are integrated.

## Why the split is required

The original #4019 review had meaningful rounds on `a5ff3dd9b2`, `228b347`,
`8b67`, `ab89c7e`, and `1cb0b90`. Earlier actionable findings were repaired;
the fourth round had only P2 findings. The fifth round found new P1s:
review IDs were not scoped to the selected customer (3946394606), and History
could describe an unknown outcome as executed or failed (3946394610).
Its P2s concerned omitted conversation identity during continuation
(3946394614) and full task context retained in pending-action parameters
(3946394616). These are assigned to B/C/D above and require regression proof.
The original scope stopped receiving pushes at `1cb0b90` under the
`waves-ship` round-cap rule. Integration resumes only after the smaller parts
are independently reviewable.

## Evidence boundaries

Part A starts from main `4322d6203563083feac3d4980bddba313f6c38de`.
Its manifest retains all 1,732 previously recorded sites, including historical
sites and four task/receipt transport sites introduced only in D. All 1,732
remain unsupported/unverified in A. The current main source scan finds 1,647
sites; historical rows are retained rather than erased when handlers move or
disappear. The one changed query fingerprint is checked against that exact
main source. No runtime or browser proof is attributed to A.

The platform implementation document is the full-stack evidence ledger from
#4019. Its execution, UI, migration, and test evidence applies to the recorded
integrated commits, not to this catalog-only branch. Part D restores the five current
reviewed transport exceptions after checking their exact fingerprints. The five
retired transport rows remain unsupported historical entries. None of
those exceptions grants domain-action coverage.

Part A local checks: catalog/coverage unit suites (9 tests) passed. The coverage
and domain-rule gates must pass before push. It has no DB or UI change, so no
migration or browser run is claimed for this split.

Part A main integration at `801b4fbf303ece9fc58f7340f10b33a29b5cfcf2`
adds four commercial-proposal request sites to the retained census, all
unmapped, for 1,736 cumulative unsupported/unverified sites. The existing
write-gate scanner now recognizes `action-registry.js` as a non-tool helper;
catalog, coverage, and write-gate suites pass all 46 tests. These resolve the
first CI run's exact failures (new upstream sites and the helper allowlist).

Part C persists request identity, runner leases, action-step deduplication and
actor/session-bound recovery through the existing confirmation store. It adds
the `ib_tasks` migration and extends the existing daily Eastern retention tick;
it does not add a worker/job system or authorize background writes. The platform
gate defaults off. Route and conversation-cursor integration remain in D.

Before storage, the same target validator replaces full resolution context with
IDs, an exact-action fingerprint, and a fingerprint of the freshly authorized
records. Confirmation compares both again. This preserves raw-number SMS,
vendor replies, explicit unlinked records, and approved bulk cohorts without
retaining their names, addresses, candidates or request text in receipt params.
The existing sweep strips old private context only after approval expiry,
including receipts whose task FK is already null; results and receipt IDs stay.

Part C validation: 79 unit/contract/scheduler tests passed and six tests passed
against the already-migrated isolated Postgres database. The latter cover
request replay, competing resumes, predecessor gating, privacy-preserving
confirmation hashes, non-resumable reads/attachments, and legacy retention.
Their recorded provider outcomes are synthetic ledger fixtures; no provider or
domain send ran. Full natural-language/route/UI proof is required in D.

Part B introduces the target-context reader for integration in D. Review IDs
participate in the same parent/customer checks as other records; an unlinked
review needs its native deep link or an explicit UUID, and cannot be substituted
for a selected customer. Its approval pin includes raw customer attribution,
location, content, and review identity separately from the public-copy grounding
fingerprint. The existing publisher checks that pin inside its claim and after
the Google read; its local-only path also rechecks under the review row lock.
The route must call review read validation even with no customer target and
carry the server-authored pin through confirmation; those calls belong to D.

History now uses the same outcome classifier as receipts, including unknown,
provider-accepted, partial, failed, blocked, and completed states. Copied shared
email/provider changes preserve uncertain sends and acceptance IDs; copied
customer/bulk-lead changes compare full-precision versions under existing locks.
Part B uses controlled provider/unit fixtures; the integrated dev-DB/browser
proof remains in D. No real communication or publication is authorized for QA.

### Deferred P2s in B

- `server/services/intelligence-bar/task-context.js:229`: the shared target
  validator exceeds the structural complexity warning. Its ordered ownership,
  bulk-cohort, and recipient checks remain together; moving them into one-use
  helpers would only relocate the decisions. Further simplification must
  preserve every independently tested authorization path.

Part A review remediation validates arguments again inside registry execution.
Trusted confirmation and private version pins use the server action context;
model-supplied approval or private fields fail schema validation. Discovery is
not offered on the technician surface. The coverage gate now proves baseline
IDs and fingerprints against source at a commit already merged on main and
retains dynamic admin verb-wrapper calls. All 1,736 recorded sites remain
unsupported/unverified. Backend registrations remain a manual inventory in
this split; automated backend drift enforcement is deferred to the final
capability reconciliation, so this gate currently enforces frontend sites only.

Part B review remediation resolves prepositional and overlapping customer
selectors before considering page fallback. Target versions use PostgreSQL
`updated_at::text` throughout fresh page, operator, full-name and single-name
lookups. Two isolated Postgres tests verify microsecond preservation and
misspelling refusal with actual synthetic rows, rolled back after each test.
The affected six service/confirmation suites pass 165 tests.

The shared outcome classifier now requires affirmative success. Optimizer
no-op, unavailable tax-advisor, and empty bulk-update paths explicitly block;
dry runs remain previews. Estimate flag toggles report success only after an
affected row. Message-only, warning-only and unnormalized legacy output stays
unknown. Legacy payout, SEO enqueue and SEO approval results still need
individual lifecycle adapters before those capabilities can be verified; no
platform coverage is claimed for them by this split.

Part A integrates merged main `e7c4e9eb4` and records its changed property-editor
request as unsupported. Optional request calls now join the census; registry
tests detect omitted tool modules, and the dedicated agent-estimate workflow
preloads its own authorized estimate tools. Broader payload/helper dependency
fingerprinting remains deferred alongside backend drift enforcement. Current
fingerprints describe call expressions; changes outside those expressions still
require manual review until final capability reconciliation.

Part C after parent integration passes 110 unit/contract/scheduler tests and
eight isolated Postgres tests (six recovery, two targeting). Registry, coverage
and domain-rule gates pass. The new task schema remains the unchanged
`20260906000061_ib_task_receipts` migration already tested on the dedicated
dev database; no production migration or gate activation is authorized.

### Deferred P2s in C

- `server/services/intelligence-bar/task-context.js:231`: compact approval
  proof adds decisions to the already-complex shared target validator. The
  ordered relationship, recipient and proof checks remain together; extracting
  one-use helpers would only move branches. Further simplification must keep
  every tested authorization path.

Part D preserves private execution pins outside model schemas, the native
owner/idempotency endpoint and persisted approval formats. Its 29 PostgreSQL
route scenarios pass, including durable receipts returned after Continue.
The shared hook/shell and global bar pass 33 client tests. Desktop/mobile Chrome
verifies target selection, confirmation, continuation, Clear/reload recovery,
A-only persistence, expiry and review cancellation with zero publishing.
The shared ProtocolPanel consumes the existing task card/endpoints and remounts
by appointment ID. Trusted confirmation receipts survive failed status reads.
The current census retains 1,740 sites, including six reviewed task transport
exceptions and 1,734 unsupported/unverified entries; no domain parity is inferred.

Main integration at `db70ae441` adds the three new prep-guide/Quick Links
request sites, retaining 1,739 cumulative sites as unsupported/unverified in A.
Their baseline fingerprints are proved against that already-merged main
revision. The former Communications handlers remain recorded as historical
sites; moving the UI does not remove work from the capability denominator.


## Target validation review split

The broad B review ran on `f523688`, `f05c6ec`, `3dc3e90`, `9d72925`, and
`cb4b81f`. Round five identified a new P1 (3947072372): the standalone
validator accepted a name-only SMS input without establishing a customer ID.
Its P2 (3947072379) found that email/call/lead page references did not establish
the owning customer even though they constrained child record selection.
The broad review stopped at `cb4b81f`; B1 now isolates target validation from
the scoped reader and provider adapters in B2. B2 preserves its history and
will be retargeted to B1 before receiving integration changes.

B1 rejects name-only SMS proposals, including the unsupported camel-case alias,
until the caller supplies a canonical resolved customer ID. Email, call and
lead references establish a freshly read customer only in the request's target
clause, never inside message or note content. Regression tests resolve the
actual viewed child without manually injecting a customer target, reject a
same-customer sibling and missing/deleted records, and reread phone data.

B1 has no provider calls, migrations, live-route wiring or UI change. Its
isolated PostgreSQL tests run in rollback transactions. Approval proof storage
and resume belong to C; actual request/confirmation acceptance remains in D.
Exact product/formulation request binding remains required in inventory #4029;
this resolver does not claim inventory write verification or complete parity.

B1 independent review also closed incidental page/note authority for unlinked
leads and estimates and normalized UUID comparisons to PostgreSQL identity.
The final scope passes 147 distinct unit/write-boundary cases and five isolated
PostgreSQL cases. No provider adapter or live action ran in those checks.
