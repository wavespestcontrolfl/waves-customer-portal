# Intelligence Bar inventory workflow evidence

This Phase 2 change shares manual stock/restock operations between the inventory
portal and the existing Intelligence Bar. It resolves inventory requests from
Estimates without pretending a saved restock request is a supplier order.
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

The census retains 1,735 UI sites: four verified property sites, four partially
verified inventory sites, ten transport exceptions and 1,721 sites still counted
as unsupported/unverified (including those four inventory sites). One additional
stats site records the exact unchanged request moved into `useCallback`; its
original unsupported entry is retained. The check accepts partial entries only
with registered tools, evidence, reviewed fingerprints, tested scopes, and named
remaining gaps. It never counts them as complete parity.

## Safety and completion truth

- Existing actor/hash/expiry confirmation remains authoritative. Model fields
  cannot provide confirmation or the fresh inventory version. Revoked roles block
  before domain mutation and persist a blocked receipt; old approvals cannot replay.
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

- Twelve real Express/auth/registry/shared-domain/Postgres cases pass in
  `server/tests/intelligence-bar-inventory-db.test.js`. The model adapter is
  scripted. Independent row reads verify request IDs, quantities, unit/actor
  parity, untouched viewed customers, zero order submission, stock changes,
  stale approvals, replay, revoked roles, staff-recorded orders and cancellations,
  concurrent request/receive behavior, invalid amounts,
  impossible deadlines, preserved notes, packaged quantities and late orders.
- Stock/write-gate suites pass 58 tests. The coverage suite passes four tests.
  The initial combined run passed all 71 tests; the integrated database suite passes all twelve cases. CI explicitly runs the inventory database
  suite against its disposable migrated Postgres service.
- Client suites pass 27 tests: 17 global bar, eight receipt-card and two inventory
  refresh cases. The refresh cases resolve responses out of order and verify
  product filters, movements, pinned request links and clearing the queue filter.
- The 48-case legacy inventory costing suite passes. Its fixture now retains
  product UPDATE values for the shared service’s persisted-state verification;
  the production read-back check remains intact. Independent review found no
  actionable issues in this repair or the two additional operation cases.
- Production build, portal-brand and coverage checks pass. New shared domain
  functions and the coverage check have no structural warnings. Legacy route,
  inventory page and receipt-card functions retain warnings.
- Chrome/Playwright at 1440×1050 and 390×844 uses the actual Estimates/Pipeline,
  inventory queue and expanded-product pages. Each viewport saves a request from
  Estimates, opens its persisted record, records a staff-placed order, receives
  stock, changes the physical count, cancels a second request, and verifies automatic refresh plus independent database state. Stock
  moves 10 → 12 → 15 with two movement rows and no supplier order. No JS exceptions
  or page-width overflow. Disabled thread reads and the unmounted communications unread-count route
  return 404s in the isolated harness.
  Artifacts are `.local/ib-inventory-*-saved.png`, `*-queue.png`,
  `*-received-refresh.png`, `*-stock-refresh.png` and browser evidence JSON.
- The checked local preview is `http://127.0.0.1:5292/admin/estimates` while the
  synthetic harness runs; the application redirects to Pipeline’s Estimates tab.
  No live-model evaluation or supplier integration delivery is claimed.

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
