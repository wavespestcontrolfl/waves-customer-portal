# Property workflow review split

PR #4021 has a new P1 on its published head `30e6687302`: a tenant account
with an unclassified property can be promoted to owner occupancy. Its latest
review also found an incomplete legacy-primary restoration and historical
visits whose legacy estimate address contradicts the old primary.

All three corrections are implemented on the local branch
`fix/ib-property-review-invariants-20260909`. All 16 real PostgreSQL property
scenarios and 73 property/role/route unit tests pass. Domain and coverage checks
pass; lint reports zero errors and three existing structural warnings. These
corrections are not in the published PR head or its inventory/estimate children.

The tenant guard is shared by list eligibility and the preview rechecked inside
confirmation. A selected legacy account row now reaches the existing promotion
writer, including owner occupancy, labels, profile measurements and irrigation
review. Settled visits reuse `estimateQuotesCustomerAddress` before applying a
fill-only snapshot, preserving conflicting street and unit evidence.

## Proposed replacement stack

Use the current foundation `54c6e8b8cd1d70654a3f900c0361a3f13e1c5285` as the
explicit base. Replace #4021 with these four sequential Full-review PRs. Each
step includes its own assertions and required checks; keep each review diff
under roughly 600 changed lines, excluding mechanical fixture setup.

| Order | Result | Current implementation to carry | Verification to keep with it |
| --- | --- | --- | --- |
| 1 | Invoices and receipts retain their historical customer address. | The unchanged `20260906000062_invoice_customer_address_snapshot` migration; `invoice-address.js`; invoice/PDF consumers; the freeze and operational-error changes in `property-role-proposals.js` and `admin-triage.js`; public-contract documentation. | Invoice/PDF unit assertions and the billing-contention/concurrent-invoice scenarios currently in `intelligence-bar-properties-db.test.js`. Include the already-reviewed upstream arrival-window test fixture correction so these branches have the same CI baseline. |
| 2 | The portal's shared saved-property operations enforce tenant eligibility, complete primary restoration and preserve visit locations. | Manual property operations and list eligibility in `customer-properties.js`; shared routes in `admin-customers.js`; all three local corrections. | Native route/service tests and the primary eligibility, legacy-row, terminal-visit, duplicate-address and transaction-order DB scenarios. |
| 3 | Intelligence Bar property actions use the shared operations with confirmed targets and persisted receipts. | `property-tools.js`; action registry/policy and write gates; property approval effects in `authorization-contract.js`; property execution wiring in `admin-intelligence-bar.js`. | Authorization/write-gate tests and the real IB query → confirmation → persisted outcome scenarios, including A while viewing B, stale tenant approval, replay and native/IB parity. |
| 4 | Customer 360 opens the global bar, discloses primary impact above the drawer and refreshes the correct record. | The current changes in `AdminLayoutV2`, `Customer360ProfileV2`, `CustomerPropertiesPanelV2`, `GlobalCommandPalette`, `useIntelligenceBarPageData` and `CustomersPageV2`; their rendered tests; the capability ledger and completed workflow documentation. | Client suites, production build, brand/domain/coverage gates, and desktop 1440/mobile 390 interaction checks. Publish the UI coverage evidence with the UI sites it verifies. |

Move the current database assertions into the corresponding invoice, native
property and IB suites without dropping any of the 16 verified scenarios.
The existing fixture setup can be shared by those suites; it must continue to
require an isolated database and scripted model. The tenant case spans native
and IB behavior and should retain an assertion in each relevant step.

After the replacement stack is reviewed, mark #4021 superseded and retarget
#4029 to the fourth replacement branch. Keep #4080 based on #4029, then carry
the corrected property commits through both children and verify their new
heads. Existing migration contents and production rollout flags are unchanged
by this proposal. This is a review split, not production release authorization.

## Why this is an owner handoff

The complete GitHub history has 14 review results across 13 commits. Six commits
received inline findings; the others received clean issue comments. The latest
result is a new P1 plus two P2s. Under `waves-ship` section 4, a new P0/P1 at
round five or later requires a stop and split proposal; section 5 sends that
proposal back to the owner instead of treating the PR as merge-ready.

The exact history and current severity dispositions are recorded in the PR
body. The local corrections and their passing tests make the proposed work
reviewable before replacing the published stack.
