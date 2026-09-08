# Intelligence Bar foundation review split

The implementation assignment remains platform-wide. This split narrows review
units without reducing the capability denominator or claiming unverified parity.
All branches remain drafts; production migration, gate activation, and customer
communications are outside the development/testing authorization.

## Dependency order

| Part | Branch | Scope |
| --- | --- | --- |
| A | `feat/ib-registry-coverage-foundation` | Typed catalog and explicit action policy over existing executors; source census and CI drift check. No runtime route or UI integration. |
| B1 | `feat/ib-target-validation-foundation` | Current-request identity resolution, fresh parent/child validation and scoped reader input preparation. |
| B2 | `feat/ib-target-context-foundation` / #4044 | Scoped domain readers, provider outcome classification and identity-bound review publishing. |
| C | `feat/ib-task-recovery-foundation` | Actor/session task ledger, confirmation receipts, safe resume and bounded sensitive-context retention. |
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
integrated commits, not to this catalog-only branch. Part D restores the ten
reviewed transport exceptions once their implementation is present. None of
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

Part A review remediation validates arguments again inside registry execution.
Trusted confirmation and private version pins use the server action context;
model-supplied approval or private fields fail schema validation. Discovery is
not offered on the technician surface. The coverage gate now proves baseline
IDs and fingerprints against source at a commit already merged on main and
retains dynamic admin verb-wrapper calls. All 1,736 recorded sites remain
unsupported/unverified. Backend registrations remain a manual inventory in
this split; automated backend drift enforcement is deferred to the final
capability reconciliation, so this gate currently enforces frontend sites only.

Part A integrates merged main `e7c4e9eb4` and records its changed property-editor
request as unsupported. Optional request calls now join the census; registry
tests detect omitted tool modules, and the dedicated agent-estimate workflow
preloads its own authorized estimate tools. Broader payload/helper dependency
fingerprinting remains deferred alongside backend drift enforcement. Current
fingerprints describe call expressions; changes outside those expressions still
require manual review until final capability reconciliation.

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

Shared-wrapper remediation in A detects known admin requests regardless of
source directory. Five existing dispatch, equipment and Terminal request sites
are proved against merged main and retained as unsupported, for 1,744 cumulative
sites. Generic lookup verbs cannot turn an unsupported capability into a match.
The final catalog/coverage suites pass 23 tests.

B1 fresh name authority queries up to two normalized matches before accepting an
unlinked lead or estimate. A duplicate inserted after resolution invalidates
both model-proposed IDs; explicit viewed-record selection still distinguishes
them. Linked and other-status duplicates count, while deleted leads do not.
The final checks pass 148 unit/write-boundary tests and 13 real PostgreSQL tests.
Generic action-object refusal hints (3947287736) remain deferred: recipient
parsing must preserve earlier explicit targets across compound clauses.

B1 also binds explicit child identifiers in the request, requires a deliberate
reference for customerless calls, and freshly validates every child owner.
Emails inherit a converted lead's customer and reject deleted or conflicting
ownership; an address-only reply requires exactly one matching thread. Relevant
page hints survive stale auxiliary hints, including compound “this customer and
that estimate” requests. Name lookup now uses the same punctuation and space
normalization as request matching. The resulting scope passes 154 unit/write
boundary cases and 19 rollback-only PostgreSQL cases. No provider was called.

The next B1 correction generalizes canonical name-selector guards to all
classified writes, including lead status, and requires explicit current-request
evidence for customerless appointments. A capped name query preserves its raw
completeness evidence before filtering incidental matches; incomplete cohorts
cannot become approved subsets. Independent compound actions retain their
explicit estimate IDs, while message-body commands grant no record authority.
Validation passes 179 unit/catalog/write-boundary tests and 23 isolated
PostgreSQL tests. Independent review closed both additional edge cases before
the fifth remote review. No provider, customer message or production write ran.

Post-merge main integration at `a7c689301` records the nine request sites that
reached main after Part A's final head: the Customer 360 workspace and unread
conversation hooks from `481ad658f`, and the controlled staff documents from
`f4b3490f5`. Each is proved against that already-merged revision and retained
as unsupported/unverified, for 1,753 cumulative sites. Nothing gains coverage;
this restores the drift gate on main without grandfathering any new action.

Codex review of that integration tightened one matcher: React state setters
that merely end in `Request` (`setLinkRequest`, `setNewLeadRequest`,
`setRequest`) perform no request and no longer produce rows, and neither do lazy
`import()` module loads, for 1,744 cumulative sites. Dynamic and glued-suffix endpoints stay recorded as
unresolved / `:param` routes pending hand mapping; the scanner is per-file and
cannot resolve a shared helper's callers or tell a query suffix from a path
segment, so nothing else left the denominator.

Main integration at `1bd165d6f` (#4016, SMS commitment follow-up) records the
`OwedCommitmentsSummary` component's two request sites — the collection GET now
takes the `open` / `sms` collection as a template segment, and the Mark done /
Dismiss PATCH moved lines — proved against that merged revision and retained
as unsupported/unverified; the superseded fixed-`open` GET row leaves the
denominator, which stays at 1,744 cumulative sites. Nothing gains coverage.

## B1 selection follow-up

Target validation #4062 stopped receiving pushes at `600841fa52` after its
fifth review introduced a new P1: an unmatched explicit customer name could
accept a stale `selectedTarget` (3948877186). Review history: round 1
`265f8c4173` had two P1/four P2; round 2 `7c15c116e7` had two P1/three P2;
round 3 on the same head had two P1/one P2; round 4 `27897bb40c` had two
P1/one P2; round 5 `600841fa52` had one P1/three P2. `e18a438cf` later merged
main after catalog #4041 squash-merged (graft merge, no conflicts).

`fix/ib-target-selection` is the focused child of B1 that fixes that P1. Its
first shape (five heads, `b9b2793b5` … `a4676a38b`) also carried a named-cohort
grammar ("both A and B", "these customers …", "all of these …": member runs,
field-set tails, action-clause splits, member matching, merged single-name
lookups). Rounds 2–5 each found a new P1 in that grammar and none in the
selection rule, so it hit the round cap. Owner decision 2026-09-08: fail closed
on named cohorts. The current shape keeps two rules and deletes the grammar:

- A selection never overrides current-request evidence. An explicit name that
  matched nothing, a capped lookup, or a named cohort refuses the selected
  customer with `context_mismatch`; a selection among the fresh matches (or
  with no name evidence at all) remains an operator selection.
- A set quantifier is never a target. Any request containing `both`,
  `these customers` or `all of these` resolves to no targets and
  `ambiguous: true`, so the caller asks for one target at a time; write
  validation and read preparation refuse an ambiguous context, and a selection
  is refused. This is deliberately literal: first-name cohorts with no fresh
  match ("text both Alice and Bob"), field pairs ("both the phone and email")
  and product pairs all refuse, because any evidence-based narrowing is the
  cohort grammar the round cap retired. Duplicate-name ambiguity stays
  distinct: an operator selection among complete same-name matches resolves
  it. Nothing downstream executes on a multi-customer cohort:
  `prepareReadInput` fills `customer_id` only from exactly one target, and the
  route reads `targets` solely as read-scope ids.

A capped name lookup refuses any selection, and `prepareReadInput` refuses an
ambiguous context or an unresolved explicit name (`namesRequested` now travels
in the context) before the empty-target broad-read fallback, so neither a
refused cohort nor an unresolved name widens into an unscoped read. An explicit
email or phone recipient is a contact, never a name. `namesTargetCustomer` no
longer accepts a name after `both` or `and`, and the
resolver keeps page errors in the page shape and anchors its recipient/review
matches, so its structural warning falls below the pre-split level.

The first remote round on the rebuilt head added `set`/`edit`/`mark`/`make`
to the selector verbs (a stale selection could survive "Set Alice Owner
inactive"), normalized the quantifier spellings (`those customers`, `all of
those`, repeated whitespace) on a contact-free clause so `both@example.invalid`
is a recipient, listed the common field nouns (`status`, `billing`, …) as
non-names so "Update customer status" keeps a selected customer, and took the
resolver under the structural threshold by making a broken page hint fail
closed for a page-referencing request even when a selection is supplied.

The second round added the ordinary set spellings (`all customers`,
`each`/`every customer`), stripped contact literals before the full-name
lookup as well, listed every `update_customer` field and the opening
contractions as non-names, and reads a `null` selection as absent.

The third round added the determiner forms (`all the customers`, `all of the
customers`, `each of the customers`, `every one of the customers`), made
`rename`/`relabel` selector verbs, and closed partly resolved compound
evidence: when one action clause accepted a customer and another clause's
person reference matches nobody ("update Jhon Smith and text Alice Owner"),
the request has no target, is ambiguous, and refuses any selection. A request
that resolved nobody keeps the plain unresolved-name handling, and a resolved
clause may still carry service nouns. `account`/`profile`/`record` and the
record nouns (`appointment`, `estimate`, `invoice`, …) are non-names. The
thing being sent introduces its recipient too (`send the response to`,
`forward the estimate to`), closing B2's open recipient-phrase thread here.

Validation: 157 target cases pass (133 unit and 24 rollback-only isolated
PostgreSQL cases). No model, provider, production query, migration, merge or
gate change occurred.
