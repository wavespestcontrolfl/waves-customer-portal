# Chelated Iron Plus supplier cost repair

The owner supplied a SiteOne listing at 2026-09-07T09:30:07.566Z for LESCO
Chelated Iron Plus 12-0-0 6%Fe 2%Mn, product family `9999903964`, at **$36.15 per
2.5-gallon container**. That is 320 fluid ounces and $0.11296875 per fluid
ounce ($0.1130 at the catalog's four-decimal precision). The quote is the
account price. The [SiteOne listing](https://www.siteone.com/en/9999903964-lesco-chelated-iron-plus-12-0-0-6fe-2mn-all-purpose-liquid-fertilizer/p/571634)
and its [2.5-gallon label](https://www.siteone.com/en/pdf/sdsPDF?resourceId=22342)
identify the orderable item as `084043`. Tax, freight and a completed purchase were not supplied.
The listing's stock availability is supplier availability, not Waves stock.

## Deployment failure and correction

Production deployment `7ebd1862-f358-4bae-b90c-662d18f97699`, commit
`ada6257932bbc192f1b6986f35fcb6e44607e591`, logged
`Cost basis needs review: LESCO 12-0-0 Chelated Iron Plus` in migration
`20260907000021_lawn_cost_inventory_dimensions.js:43`. The prior patch skips
only retired rows; this failure still reaches the active/null-active cost
check. The log does not disclose the row's actual price and unit fields.

Migration `20260907000019_approved_iron_supplier_cost.js` deliberately sorts
before that pending migration. Knex still runs this new filename in previews
where the two dimension migrations are already recorded. No applied migration
is edited, renamed, deleted or marked complete by hand.

The new migration selects exactly one active canonical/legacy iron identity,
as the existing canonical-dimension migration does. It records the supplied
SiteOne quote through `vendor_pricing`, `price_history` and `price_snapshots`,
uses `recalcBestPrice` for the catalog winner, then reconciles this product's
stored unit-cost override with the winning package price. Another eligible
vendor can still win; the selected package price and its backing vendor row
stay authoritative. The separate catalog override needs reconciliation because
the existing writer preserves measured-product overrides when a package price
changes.

The existing inventory-unit correction helper fills a missing/ambiguous unit
only when no stock quantities need interpretation. Explicit volume units and
stock quantities remain intact. Conflicting package sizes, dimensions,
unsupported units and ambiguous active identities fail closed. Newer manual
SiteOne quotes and retired predecessors are preserved. A critical audit event
records prior and resulting price/unit evidence in the same transaction; a
repeat run and the documented no-op rollback preserve that history.

Migration `20260907000018_iron_newer_supplier_cost.js` handles the newer-quote
branch before the published quote migration returns. It validates the same
package and stock evidence, preserves the newer supplier observation and
reconciles the catalog cost through the existing winner calculation. This
works both before the pending dimension check and after that check is already
recorded. A dedicated critical audit makes the reconciliation atomic and
idempotent. The published quote migration remains unchanged.

The forward source correction
`20260907000022_iron_supplier_quote_link.js` fixes the initial quote writer
clearing the supplier URL. It preserves the published migration, appends a
source snapshot with the verified listing URL and item `084043`, and updates
the same quote only while its original timestamp and snapshot provenance match.
A subsequent manual quote wins. Price, stock and historical snapshots remain
unchanged, and a critical audit event makes the source correction atomic.

All six CSV aliases of the supplied product carry the same package and cost;
the verified label also identifies the 4% sulfur variant in those aliases.
The field reference removes fixed iron cost annotations from its lawn and
tree/shrub instructions, including the combined iron/manganese annotations.
The existing plan engine calculates material cost from the selected catalog
price and quantity. Keeping a second fixed amount in the instructions would
become wrong again when a newer quote or cheaper eligible vendor wins.
Product matching and selection rules are preserved. The operating tables hold
rates, gates and windows, with costs read from the catalog; no treatment
definition changes are needed. Customer rate grids, treatment rates, product
registrations, purchase records and customer communications are outside this
correction. The separately labeled legacy aggregate allowances remain the
unverified assumptions documented in `docs/lawn-material-audit.md`.

## Verification

The test database is a separate `waves_qa_…` database in the verified Railway
`codex-dev` environment, `platform-audit-postgres` service. Only the public
schema was copied from a previously migrated private development QA database;
no application records were copied. All regression fixtures use temporary
schemas inside transactions and roll back, including audit events and Knex
tracking tables. No production database was accessed.

- 27 PostgreSQL regressions passed: stale/missing/volume costs, active and
  null-active rows, active keeper with retired predecessor, unchanged stock and
  rates, newer manual quotes, a cheaper supplier, contradictory evidence,
  ambiguous identity, failed audit insertion and idempotency.
- The original cost-check stop was reproduced, then both dimension migrations
  completed after applying the repair.
- The actual Knex migration runner verified the recorded-history states: earlier
  migrations pending, dimension migrations already recorded, and the first
  published quote migration already recorded. Source-link preservation, newer
  quote protection and a failed source-correction audit are covered too. A second
  run performed no work. Newer-quote reconciliation also runs after both dimension
  migrations are recorded; unknown stock and a failed reconciliation audit roll
  back without changing the supplier quote.
- 64 existing inventory-costing, canonical-dimension and migration-state
  regressions passed. Scoped lint and whitespace checks passed.
- 95 protocol, matcher and tree/shrub checks passed. The new cases cover every
  CSV alias, all lawn iron lines, unchanged selection rules and catalog-derived
  cost for the supplied price, a newer price and a cheaper eligible price.
- The real ProtocolPanel rendered with synthetic local API fixtures at 1440 and
  390 pixels. Lawn mix quantities, calendar instructions and tree/shrub iron
  instructions retained their content without fixed iron prices. Closing and
  reopening worked; there were no browser errors, unexpected API requests or
  horizontal overflow. Screenshots were inspected with the actual admin font
  scope. Existing typography and warning styles are unchanged. This is fixture
  UI verification, separate from the PostgreSQL migration checks.

The new PostgreSQL suite joins the existing DB-gated CI discovery mechanism.
These development checks establish migration behavior against the repository
schema. Production deployment and its resulting catalog state remain to be
verified after release.
