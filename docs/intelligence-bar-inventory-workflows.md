# Intelligence Bar inventory workflow evidence

This Phase 2 change shares manual stock/restock operations between the inventory
portal and the existing Intelligence Bar. It resolves inventory requests from
the global Estimates/Pipeline surface without pretending a saved restock request
is a supplier order. The dedicated Agent Estimate page still needs its own
platform-discovery integration and is not yet verified.
Full inventory and platform parity remain incomplete.

## Implemented scope

| Operation | Shared authority | Verified scope and outcome |
| --- | --- | --- |
| Adjust physical stock | `inventory-operations.adjustStock` | Admin confirmation writes the catalog count and movement atomically, with actor, entered unit and conversion provenance. |
| Save a restock request | `inventory-operations.createRestockRequest` | Admin confirmation saves an open request with product, quantity, unit, vendor, deadline and actor; stock and supplier orders remain unchanged. |
| Mark ordered, cancel, receive | `inventory-operations.updateRestockRequest` | Existing order guards remain; physically received quantities update stock and the movement ledger. Manual notes persist. |
| Read restock queue | `inventory-restock-queue.listRestockRequests` | UI and bar share active/closed filters and the provider-state projection, including late supplier orders. |

The portal continues to permit technicians for its existing stock endpoints.
The bar retains its existing admin-only inventory policy and read-only technician
isolation. These four census entries are **partially_verified**, with admin
evidence and an explicit remaining technician scope. They remain in the
unsupported/unverified denominator. No role parity is claimed.

The census retains 1,750 UI sites: four verified property sites, four partially
verified inventory sites, eight transport/navigation exceptions and 1,738 sites
still unsupported/unverified (including the four inventory sites). An unchanged
stats request moved into a callback; its old row remains, and Git proves the
identical call existed on main before allowing the relocation as still unmapped.
Copies, changed payloads, absent provenance, missing review, and a still-present
original site cannot use that allowance. The receipt link is navigation to an
already verified result, not an additional domain capability.

## Safety and completion truth

- Existing actor/hash/expiry confirmation remains authoritative. Model fields
  cannot provide confirmation or the fresh inventory version. Revoked roles block
  before domain mutation and persist a blocked receipt; old approvals cannot replay.
- The current operator request establishes the product. A fresh shared catalog
  lookup preserves full formulation punctuation and refuses duplicate exact names,
  partial-search truncation, unrelated model IDs/names and product IDs in message
  or note bodies. Explicit UUIDs and deictic inventory selections are checked
  against the preview. Named restock requests resolve through the current queue,
  filtered by product before a two-row ambiguity limit; explicit request IDs and
  viewed requests cannot be substituted, even for the same product.
- Restock requests recognize `before`/`by` deadlines using weekdays,
  today/tomorrow or ISO dates only after the full catalog-name lookup misses.
  Literal names and ambiguous matches are preserved; a deadline clause without
  the preview's `needed_by` date refuses before confirmation.
- Exact product ID and full-precision product/request versions bind approval.
  The domain rechecks under locks; a stock or identity change requires a fresh
  preview. Ambiguous names return candidates with formulation/package/SKU data.
- Product locks serialize adjustments and manual request creation. Existing
  live automatic requests cannot be duplicated. Active manual duplicates require
  the portal's explicit duplicate choice; the bar reports an existing request as
  blocked instead of displaying a newly saved card.
- Request actions preserve ledger → request → product lock order and existing
  dispatch guards. Concurrent receive actions produce one stock movement.
- Receiving defaults to what an actual supplier order bought, including package
  rounding. The existing late-order marker permits one additional physical
  receipt after an earlier manual receipt and is settled atomically.
- Units use `inventory-units`; count, weight and volume remain separate. Invalid
  numbers and impossible dates fail before persistence. An initial physical zero
  count enables tracking with the correct unit.
- Marking a request ordered records a staff action. It does not perform checkout.
  Saving or ordering never increases stock. Canceling a request does not claim to
  cancel an external supplier order.
- Receipts come from persisted domain results and contain record links. Saved
  requests, recorded orders, canceled requests and received stock have distinct
  labels. Recovery/remount displays the same receipt. Inventory views refresh
  after a verified mutation; older responses cannot overwrite refreshed data.

## Verification

- The deadline follow-up passes all **28 PostgreSQL scenarios**, including six
  new cases for visible/persisted dates, exact formulations, a missing preview
  date, literal catalog suffixes and ambiguity. All three positive deadline
  examples failed before the resolver correction. The six inventory server
  suites pass **175 tests**; domain and portal-brand checks pass.
- `node .local/run-ib-test.cjs tests/intelligence-bar-inventory-db.test.js`:
  **21 real PostgreSQL cases pass** (91.09 seconds), using actual Express/auth,
  registry, shared domain operations and an isolated dev database with a scripted
  model. Independent reads cover persisted IDs/quantities/actors, portal/bar
  equivalence, untouched viewed customers, zero order submission, stale versions,
  replay, concurrent requests/receives, invalid amounts/dates, saved notes,
  package conversion, late-order receipt, revoked roles, exact formulation,
  duplicate names, untrusted content, and request substitution.
- Four server suites (`intelligence-bar-stock-tools`, `write-gate-contract`,
  `action-registry`, `target-context`) pass **197 tests** before the additional ID-alternative regression. The final
  registry/tool-definition check passes 20 tests, including that new regression.
  A focused real-DB ID-only vendor comparison also passes (the other 21 already
  passing scenarios were excluded from that focused run). The coverage and legacy
  inventory costing suites pass **56 tests**, including proof that moved
  unsupported calls cannot silently become verified coverage. CI explicitly runs
  the inventory DB suite against its disposable migrated PostgreSQL service.
- Global bar, receipt-card and inventory-refresh client suites pass **35 tests**.
  These cover out-of-order responses, pinned record links, automatic refresh and
  closed-request Back navigation. The added rapid-Back case reproduced the browser
  defect before the fix (one failed, three passed); deriving queue status from the
  pinned ID makes all four inventory cases pass, even when React batches the
  intermediate navigation away.
- Production build passes (39.71 seconds); portal-brand, domain-rule and coverage
  checks pass. No new migration was needed.
- Final Chrome/Playwright proof at 1440×1050 and 390×844 exercises the actual
  Estimates/Pipeline, inventory queue and expanded-product pages: save request,
  open its record, record a staff-placed order, receive, change physical count,
  cancel a second request and inspect persisted state. Both widths pass rapid
  Back restoration after the regression fix. Independent state moves 10 → 12 →
  15 with two movements and zero supplier orders. No JavaScript errors or
  page-width overflow. Only the deliberately dark thread endpoint and unmounted
  communications unread count return 404s. Screenshots were inspected with vision;
  artifacts use `.local/ib-inventory-{desktop,mobile}-*.png`.
- The local preview is `http://127.0.0.1:5292/admin/estimates` while the synthetic
  harness runs; the application redirects to Pipeline's Estimates tab. There is
  no live-model evaluation, supplier delivery or dedicated Agent Estimate proof
  in this evidence.
- Independent review verified the product identity correction and named-request
  queue scope, and separately verified relocation provenance/denominator retention.

Structural follow-up: `resolveInventoryWriteTarget` and `verifiedBaselineProof`
retain complexity warnings (43 and 27), as do the changed legacy proposal,
confirmation and inventory UI functions and the partial-coverage validator.
They remain explicit P2 work; these warnings are not reported as passing review
or silently excluded from the final reconciliation.

## Remaining work and rollout

Technician capability parity, product/price/vendor administration, stock unit
review, forecast reads and provenance, protocol usage/associations, ordering
approval/configuration and supplier submission/reconciliation still require
shared operations and outcome tests. The existing procurement approval workflow
is preserved. This change does not complete those actions.

Cross-page discovery uses `GATE_IB_PLATFORM`, default off. The shared domain
corrections also apply to the existing portal and gated confirmation path. No new
migration, production data write, production gate change, supplier purchase,
customer communication or money movement was performed during QA.


The current product grammar conservatively refuses an unmatched sentence-final
period rather than stripping a possibly meaningful catalog qualifier. Broader
phrasing and compound product sets remain in the platform follow-up.
