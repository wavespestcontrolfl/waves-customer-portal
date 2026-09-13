# Existing-customer lawn estimates

This phase implements administrator creation and revision of residential lawn
estimates for existing customers from the global Intelligence Bar. It is a
bounded delivery within the full-platform assignment; other programs, estimate
sending/conversion, technician authoring and compound workflows remain open.

`get_customer_estimate_context` retrieves saved service properties, treatable
lawn measurements, grass, current services/membership and existing estimates.
`save_customer_estimate` previews and saves through the same
`createOrReuseAdminEstimate` / `reviseAdminEstimate` operations as the portal.
The model supplies intent and typed identifiers, never prices. No duplicate
lead, appointment, customer message or scheduled send is created.

## Authority and approval

- Customer and active property ownership are checked against fresh rows.
  Secondary properties use their own facts. A zero-area primary lawn profile
  cannot fall back to an older positive customer/property mirror.
- Explicit child-record IDs in the current request constrain the existing task
  validator, including two estimates on the same customer/property. Referenced
  IDs inside a message body do not select targets. Revision cards identify the
  saved estimate being changed.
- New drafts use the portal's nine-application default; revisions preserve
  their saved six/nine/twelve cadence unless a change is requested. Other
  service mixes refuse with an explicit unsupported-capability outcome.
- Live DB pricing must synchronize successfully. The shared engine computes
  price and current membership tier; its result digest is bound to approval
  and checked again by final persistence. An upward or downward membership
  change cannot retain an unrelated previous quote tier.
- Revisions preserve replayable approved discounts. A stored fixed discount
  without reconstructable allocation refuses for editor review instead of
  silently losing the discount.
- Estimates with a queued send refuse revision until the operator clears the
  schedule in the estimate editor. The whole multi-property group is judged,
  not only the targeted row: a scheduled anchor pins every sibling's offer in
  its receipt, so an unscheduled sibling refuses too. This is checked at
  preview and again under the confirmation's group and row locks, preserving
  the reviewed delivery offer.
- Revision pricing and slot caches clear only after the outer transaction
  commits. An audit/receipt rollback leaves the committed estimate and caches
  intact; public reads during the save cannot repopulate a prematurely cleared
  slot cache with the old property address.
- The existing pending-action confirmation binds actor, target, facts, options,
  prices and estimate version. The commit locks customer/property rows first,
  then estimate group address/send guards, then the estimate row. This keeps
  customer profile edits and estimate revisions in the same lock order.
  The estimate row lock refuses contention without waiting because customer
  acceptance takes the estimate before the customer. A busy revision rolls
  back and records a known failure; a fresh request can retry after it clears.
  Administrator permission and fresh facts are rechecked inside the transaction.
- The estimate, audit and pending-action receipt commit together. A missing
  receipt rolls back the mutation; an interruption after commit recovers the
  saved receipt. Replayed confirmation does not create another estimate.

The approval card shows the target/address, saved lawn area and grass, priced
WaveGuard tier, selected cadence and every customer-selectable cadence with its
per-application price, plus the actual save effect. These options reuse the
public pricing builder's discounts and minimum-price rules; an unsaved revision
cannot read or populate the saved estimate's pricing cache. A saved
receipt links to `/admin/estimates?editEstimateId=...`. The list refreshes on an
estimate mutation; the matching editor reloads its persisted state while
preserving edits made before or during the refresh request. A failed refresh
keeps the loaded editor usable and offers Retry without consuming the mutation.

## Verification

Review corrections preserve canonical unknown/mixed grass instead of falling
back to a stale property type, apply the estimator's shared field-review and
low-confidence predicates, and conditionally persist interrupted outcomes
without overwriting an atomic completed receipt. The real PostgreSQL route
suite passed all 25 scenarios in its full run, including alternate-cadence approval
drift, discounted same-link revision parity with public pricing, and preview
cache isolation. The authorization suite passes 42 tests, including disclosure
and approval hashing of all offered cadences. Both editor lifecycle suites
pass 21 tests, including failed-refresh retry and preservation of edits made
after the failure. All eight scoped estimate tool schema, database, smoke and
shape validators pass; side-effecting save smoke/shape checks are deliberately
skipped by the validator. After the acceptance-contention correction, all four
focused lock/deletion cases pass, including known-failure receipt persistence,
an unchanged estimate, release of the customer lock and a successful fresh
request after contention clears (26 distinct DB scenarios across the runs).
Model output is scripted in this suite; pricing,
domain persistence, authentication and PostgreSQL are real.

The latest browser checks at 1440×1050 and 390×844 use the actual approval card
and editor with synthetic responses. Every offered cadence is visible and
confirmable; a refresh error preserves the saved editor, and Retry loads the
persisted version. Both widths have loaded fonts, zero JavaScript exceptions
and zero horizontal overflow. Screenshots were visually inspected. These
component checks supplement the real route/database evidence below.

All fixtures are synthetic in the dedicated development Postgres database.
The model is scripted and provider adapters are isolated. This is real
HTTP/auth/domain/persistence evidence, not live-model or provider-send evidence.

- The 26 estimate DB scenarios cover create from Inventory with A targeted
  while B is viewed, no new lead, primary/secondary measurement authority,
  tampered parents, same-property estimate substitution, stale approval, cadence, percentage/fixed discount handling,
  membership changes in both directions, zero-area refusal, grouped revision
  lock order, live pricing failure before/after confirmation, receipt rollback
  and post-commit recovery. The shared native edit-source endpoint independently
  reads the persisted draft.
- Earlier baseline verification: eight server suites passed 324 distinct tests across the 203-test base
  run and 180-test target/registry/authorization run: action registry, tool definitions,
  write-gate mirror, authorization contracts, pending actions, shared estimate
  persistence, task target binding and estimate billing regression coverage.
- The full isolated estimate/platform/recovery run passed 53 cases; the added
  same-property substitution case passed separately (15 unrelated estimate
  cases excluded in that focused run), for 54 distinct passing DB cases.
- Four client suites pass 47 tests: global bar, desktop/mobile estimate lists,
  editor refresh/unsaved protection, record switching during hydration and
  page context publication. An unrelated receipt cannot cancel a matching
  estimate refresh already in flight.
- The production build passes. No new migration or dependency is required by
  this phase. The parent stack's development-only migration evidence is recorded
  in its own implementation documents.

Desktop (1440 pixels) and mobile (390 pixels) browser runs exercised real query
and confirmation requests: create a six-application draft from Inventory, open
the saved editor, ask to revise **this estimate** to twelve applications, confirm
the same estimate ID, observe the editor refresh, then reload and verify the
persisted identity/cadence. Both had zero JavaScript exceptions and zero
horizontal overflow. Screenshots were inspected visually and are attached to
the phase PR. Private artifacts are `.local/ib-estimate-*-{create,revise}-preview.png`,
`*-saved.png`, `*-opened-editor.png` and `*-refreshed-editor.png`.

The checked local preview is `http://127.0.0.1:5292/admin/inventory` while the
isolated harness runs; it is not a deployed production preview. Auxiliary
communications/payer/request/triage/pricing-preview endpoints are not mounted
in that harness and return expected errors; this does not verify those native
page integrations. The actual IB and saved-estimate edit-source requests pass.
Real iOS keyboard/voice/attachment behavior and live-model evaluation remain
unverified.

## Coverage and remaining work

The census retains all 1,750 historical sites: four fully verified property
sites, six partially verified inventory/estimate sites, eight reviewed transport
exceptions and 1,732 unmapped sites. Partial scopes remain in the unsupported/
unverified denominator (1,738), and do not count as full program or role parity.
The two estimate save sites have explicit limited scope and evidence. The
scanner's dynamic create/revise call has an unresolved method/URL; its fallback
`GET` identity is retained with a source-review explanation, not relabeled to
inflate coverage. Other estimate reads/actions remain unmapped.

`GATE_IB_PLATFORM` remains default off; existing UI-confirm and write-disable
controls apply. No production migration, merge, gate flip, customer message,
purchase or payment was performed. Shared target/retry findings in the parent
stack and the remaining capability matrix still require implementation before
the mission is complete.

## Local follow-up after the final published review

Published head `33588a1c1c` has green CI and two P2 findings, with no new P0/P1.
Both are corrected locally for integration after the property review split:

- Saved `presentationOverrides` survive the cadence revision. The existing
  public pricing builder reapplies their custom names after recomputation and
  retains the naming audit on the same customer link.
- The service-context version uses the existing approval fingerprint, which
  canonicalizes nested unordered collections while keeping prices and record
  identities bound. SQL row order alone cannot invalidate the confirmation.

The public-name, percentage-discount and property-drift DB scenarios pass. The
row-order regression also passes with two explicitly controlled SQL result
orders: context versions match and confirmation succeeds, while a real spend
change changes the version. Combined with the earlier runs, all 28 distinct
estimate DB scenarios have passed. The authorization/write-gate suites pass
87 tests. These corrections remain local while the owner considers the
property split; the published head and its existing review are unchanged.
