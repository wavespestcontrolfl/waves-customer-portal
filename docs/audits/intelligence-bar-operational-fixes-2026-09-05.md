# Intelligence Bar operational fixes

Implemented locally on `fix/ib-operational-gaps`, based on `a2bb0bc49`.
The shared address-edit prerequisite is commit `2c3086803` from
`codex/appointment-address`, incorporated without modifying that worktree.
This branch extends that service with an explicit visit scope; its existing
Dispatch caller retains its series scope.

## Audit coverage

1. Customer detail includes saved properties, linked profiles, apartment units,
   and explicit unavailable-versus-empty coverage.
2. Admin schedule and tech route/detail tools use effective appointment addresses,
   with the same divergent-stamp unit rule used by the existing SQL readers.
3. `switch_appointment_property` prepares an actor-bound confirmation card for
   a saved property on the same customer. Commit reacquires scheduling, stop,
   customer-comms, and row locks; verifies the approved destination and stop set;
   then uses the shared address writer. Grouped service lines move together.
   Primary customer address, future visits, lifecycle, and billing are preserved;
   no messages are sent. Terminal visits and recurrence-template rows must use
   Dispatch review. The latter cannot honestly promise a visit-only effect.
4. The current ET date is supplied per request instead of frozen at process load.
5. Customers and Dispatch publish selected IDs and the viewed date to the global
   bar through one page-context provider; the prompt requires authoritative reads.
6. Customer, SMS, and call searches support a full first-and-last name.
7. Customer counts reflect all filtered matches; customer/schedule/message/call
   reads have continuation and coverage. Schedule defaults to today ET.
8. Advertised presence filters work; unsupported filter keys are rejected;
   health filters use the latest score and numeric zero bounds are retained.
9. SMS history supports older pages. Call IDs can retrieve full transcripts in
   bounded pages. Instructions distinguish excerpts and unavailable sources from
   complete evidence.
10. Tech next-stop and remaining counts exclude terminal appointments.
11. Clarification preserves pending cards, original expiry, and resolved status.
12. Explicit change requests authorize preparing the preview immediately;
    execution approval remains the existing confirmation card. Cancellation's
    tool description states the intentional Dispatch restriction.

## Verification

- 142 server tests passed across eight relevant suites, including new real-Knex
  SQL compilation tests with an in-memory transport (no database socket).
- 19 client tests passed across the admin shell, customer page, Dispatch
  completion predicate, and pending-card regression suites.
- Client production build passed.
- `check:portal-brand` and `check:domain-rules` passed.
- ESLint found no errors. The rewritten customer query and new functions are
  below the structural warning threshold; existing large component/route warnings
  remain outside this change's refactoring scope.
- Playwright with installed Chrome exercised the real global bar at 1440 and 390
  pixels against synthetic API fixtures: selected context arrived, a clarification
  retained the pending card, Confirm worked, and Done survived another question.
  Both screenshots were inspected in-session:
  `/tmp/ib-operational-qa/clarification-1440.png` and
  `/tmp/ib-operational-qa/clarification-390.png`.
  This was an isolated bar fixture, not live customer data or a full backend run.
  The temporary client fixture was removed.

## Release and verification limits

No deployment, production writes, customer messages, or gate flips were performed.
The address action uses the prerequisite's default-off `GATE_EDIT_APPT_ADDRESS`;
activation remains an owner release decision. No migration was added.
All 1,374 existing migrations completed in a newly created private database on
Railway codex-dev. Both PostgreSQL integration tests passed against those real
tables: rental discovery, grouped en-route writes, preserved future visits,
audit insertion, updated schedule reads and rejection of a changed destination.
Each fixture transaction was rolled back. This verifies the tool/database path;
it is not full HTTP/browser backend QA or a concurrent multi-session race test.
No live model call was used to claim a measured change in conversational behavior.

Before release, reconcile this branch with the final reviewed version of the
address-edit prerequisite. Do not ship an older copy over later changes on that
branch. This local branch includes the prerequisite's Dispatch UI/API changes,
which were not independently browser-exercised here; their shared writer tests
and this branch's production build passed.

## PR preparation

Reconciled with origin/main at `11e21a852` and address prerequisite review fixes
at `998513425` (including the `dbd362c19` review fixes). The IB writer now acquires technician-day fences explicitly
and locks the selected property before service rows, matching the updated
shared writer. Frozen grouped visits remain subject to the shared guard.
An opt-in PostgreSQL integration suite exercises real migrated tables, the
shared address writer and audit insert inside rollback-only synthetic fixtures;
CI runs it against its dedicated `waves_test` database.

Pre-push review identified a missing live dispatch refresh after an IB address
commit. The tool now broadcasts every affected job after the transaction resolves;
a broadcast failure retains committed success and surfaces a manual-refresh
warning. A regression covers both broadcast invocation and failure behavior.
The broader Intelligence Bar/tech/address/dispatch suite passed 620 tests before
this follow-up; its five switch-property tests passed after the broadcast fix.

CI initially caught a fixture-only date-helper misuse in the new PostgreSQL
suite. It now passes a Date and converts the result to an ET date string; both
PostgreSQL tests passed locally after that correction.

## GitHub review remediation

Customer-detail/search/schedule/tech-route reads are now classified as PII-bearing
for telemetry. Dispatch selection accepts the server's camel-case customerId;
schedule city uses the effective destination. Call drill-down reads the canonical
transcription column, and message/call pages use id tie-breakers. The 55 targeted
read/route tests and all three migrated-PostgreSQL tests passed after these fixes.

Deferred P2: get_customer_detail intentionally does not call ensurePrimaryProperty,
which INSERTs a property (customer-properties.js:178). A missing primary property
must be registered through the existing Properties screen before the saved-property
switch tool can target it. Adding that write to an ungated read would bypass the
IB confirmation boundary; a future registration action must use a write gate.

Second review fixes: the appointment editor identifies its property request so
the endpoint returns before lazy registration when the address gate is off;
the existing Properties screen keeps its registration behavior. Call counts now
match the filtered result. Auto-dispatch rechecks destination fields after scoring
and includes them in the existing rebooker atomic expected-state predicate.
All 37 targeted route/read/address tests, 130 auto-dispatch unit tests, and four
migrated-PostgreSQL tests passed; the production build passed. The new PostgreSQL
case proves that a destination changed after scoring is rejected. This is still
not a simultaneous multi-session race test.

Latest prerequisite reconciliation: incorporated `0634210e1`, including complete
address validation and preservation of completed template locations through future
address overrides. The IB visit scope still has no parent/default update. Its
preview now names route-position clearing and validates the same required address
components as the shared commit. Adopted the prerequisite's equivalent destination
freshness implementation rather than keeping two field sets. All 181 shared
address/recurrence/price-scope/IB tests and all four PostgreSQL tests passed.
The shared financial-stamp module changes address inheritance only; no pricing
values or payment behavior were changed or exercised against production.

Handled confirmation failures now persist their failed status and error across
follow-up questions, preventing a consumed action from offering Confirm again.
All four palette/card tests passed, including desktop/mobile integration cases.
The production build passed. Desktop 1440px and mobile 390px browser captures
were inspected using the real palette with synthetic responses; the failure
remained visible and Confirm stayed absent after a follow-up.

The pre-push review identified the parallel HTTP-error path. Caught failures
now persist through the same callback, including cancellation errors. Six
palette/card tests pass with both HTTP 200 handled failures and HTTP 409
responses on desktop/mobile. HTTP 409 was also exercised in the real palette
browser fixture at both widths; inspected captures retain the error and no
Confirm button. Build passed again.

CI on 914debcb5 passed 40,189 server tests but failed an outdated wizard source
contract that assumed the template carried only price provenance. Updated its
assertions to include appointment_address while requiring explicit price edits
to remove only the anchored price marker. All 87 tests in that suite now pass.
No production code was changed for this correction.
