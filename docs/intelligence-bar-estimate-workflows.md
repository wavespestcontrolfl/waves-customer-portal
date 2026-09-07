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
- The existing pending-action confirmation binds actor, target, facts, options,
  prices and estimate version. The commit locks estimate group address/send
  guards before estimate/customer rows, matching native revision lock order.
  Administrator permission and fresh facts are rechecked inside the transaction.
- The estimate, audit and pending-action receipt commit together. A missing
  receipt rolls back the mutation; an interruption after commit recovers the
  saved receipt. Replayed confirmation does not create another estimate.

The approval card shows the target/address, saved lawn area and grass, priced
WaveGuard tier, per-application charge, cadence and actual save effect. A saved
receipt links to `/admin/estimates?editEstimateId=...`. The list refreshes on an
estimate mutation; the matching editor reloads its persisted state while
preserving edits made before or during the refresh request.

## Verification

Review corrections preserve canonical unknown/mixed grass instead of falling
back to a stale property type, apply the estimator's shared field-review and
low-confidence predicates, and conditionally persist interrupted outcomes
without overwriting an atomic completed receipt. The affected confirmation and
pending-action unit suites pass 63 tests; the real PostgreSQL route suite passes
20 scenarios, including unknown/mixed grass, oversize lawns, transactional
rollback, and a failed recovery read after commit. Independent review found no
remaining issues in these corrections. Model output is scripted in this suite;
pricing, domain persistence, authentication and PostgreSQL are real.

All fixtures are synthetic in the dedicated development Postgres database.
The model is scripted and provider adapters are isolated. This is real
HTTP/auth/domain/persistence evidence, not live-model or provider-send evidence.

- Sixteen estimate DB scenarios cover create from Inventory with A targeted
  while B is viewed, no new lead, primary/secondary measurement authority,
  tampered parents, same-property estimate substitution, stale approval, cadence, percentage/fixed discount handling,
  membership changes in both directions, zero-area refusal, grouped revision
  lock order, live pricing failure before/after confirmation, receipt rollback
  and post-commit recovery. The shared native edit-source endpoint independently
  reads the persisted draft.
- Eight server suites pass 324 distinct tests across the final 203-test base
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
