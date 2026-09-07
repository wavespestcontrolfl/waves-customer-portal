# Intelligence Bar foundation review split

The implementation assignment remains platform-wide. This split narrows review
units without reducing the capability denominator or claiming unverified parity.
All branches remain drafts; production migration, gate activation, and customer
communications are outside the development/testing authorization.

## Dependency order

| Part | Branch | Scope |
| --- | --- | --- |
| A | `feat/ib-registry-coverage-foundation` | Typed catalog and explicit action policy over existing executors; source census and CI drift check. No runtime route or UI integration. |
| B | `feat/ib-target-context-foundation` | Fresh target resolution, parent scope and version checks, shared outcome classification, and identity-bound review publishing. |
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

Shared-wrapper remediation in A detects known admin requests regardless of
source directory. Five existing dispatch, equipment and Terminal request sites
are proved against merged main and retained as unsupported, for 1,744 cumulative
sites. Generic lookup verbs cannot turn an unsupported capability into a match.
The final catalog/coverage suites pass 23 tests.

Post-merge main integration at `a7c689301` records the nine request sites that
reached main after Part A's final head: the Customer 360 workspace and unread
conversation hooks from `481ad658f`, and the controlled staff documents from
`f4b3490f5`. Each is proved against that already-merged revision and retained
as unsupported/unverified, for 1,753 cumulative sites. Nothing gains coverage;
this restores the drift gate on main without grandfathering any new action.

Codex review of that integration tightened the census itself: React state
setters that merely end in `Request` (`setLinkRequest`), literal `/tech/`
router paths (the isolated tech portal), and a trailing interpolation glued to
a segment (`/unread-count${scope}`, a query suffix) no longer produce rows or
phantom `:param` routes. Six setter/tech rows left the denominator, fifteen
rows re-identified to their base route, and the unread hook re-baselined on
`481ad658f`, for 1,743 cumulative sites. Terminal and dispatch operations
mounted outside `/admin/` stay in the denominator.

