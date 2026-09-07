# Approved lawn supplier costs — September 7, 2026

The owner supplied two SiteOne listings and authorized applying their package prices. This change was applied and verified in an isolated, repository-seeded Railway development database. It is not evidence of deployed catalog values or an actual purchase. No production database was accessed.

| Product / supplier SKU | Supplied package | Sticker price | Unit cost |
| --- | --- | ---: | ---: |
| Celsius WG / D00001204 | 10 weight oz (0.625 lb) | $133.20 | $13.32 / weight oz |
| Acelepryn Xtra / 79572 | 30 fl oz | $150.00 | $5.00 / fl oz |

The observation was supplied at 2026-09-07T06:49:31.678Z. Purchase date, tax, freight, discounts and quantities purchased were not supplied. Listing availability counts are not Waves inventory. Those fields were not fabricated. Existing registrations and application rates were preserved.

## Implementation and database verification

`20260907000020_approved_lawn_supplier_costs.js` records approved vendor prices, price history, supplier snapshots and audit events. It calls the existing inventory unit correction and canonical best-price recalculation in the migration transaction. Celsius uses an explicit weight package and inventory unit; Acelepryn uses fluid ounces. The CSV mirror updates both 30-fl-oz Acelepryn entries while retaining the separate 2.5-gallon entry.

The migration refuses incompatible package/unit evidence, stock quantities without a known basis, existing cost overrides, or ambiguous product/vendor matches. A newer manual SiteOne quote is preserved. Repeated execution is audit-stamped and idempotent. The documented no-op rollback preserves price observations and later admin edits.

A real PostgreSQL transaction verified both catalog prices and backing vendor IDs, `needs_pricing=false`, unchanged null stock quantities, unchanged application rates, idempotency, and rollback restoration. Separate rollback cases exercised unknown stock, conflicting dimensions, conflicting package size and an existing zero cost override. The final migration then completed in development, and a subsequent SELECT confirmed both rows and their unit bases.

The cadence audit now accepts legacy plain ounces only with an explicit inventory measurement family and rejects conflicting evidence. It does not infer weight merely from a product name or formulation. Targeted verification passed 154 tests across the audit, inventory units, plan engine and inventory costing suites. Domain checks and diff checks passed. Scoped lint has only the unchanged `parsePackSize` complexity warning.

## Same audit before and after

These are **partial selected-material subtotals**, normalized by the existing reference checker to the sold 6/9/12 application counts at 4,500 sqft. They are not verified annual operating costs, proposed customer prices or profit estimates. Every row still has `catalogSelectedAnnual=null` and `catalogCalculationComplete=false`; the audit exits 2 as intended.

| Grass | Applications | Before subtotal | After subtotal | Remaining issue occurrences |
| --- | ---: | ---: | ---: | ---: |
| St Augustine | 6 | $34.51 | $37.07 | 5 |
| St Augustine | 9 | $73.19 | $65.32 | 14 |
| St Augustine | 12 | $173.11 | $162.63 | 18 |
| Bermuda | 6 | $40.83 | $42.11 | 11 |
| Bermuda | 9 | $74.47 | $84.15 | 24 |
| Bermuda | 12 | $148.61 | $161.52 | 28 |
| Zoysia | 6 | $51.99 | $53.27 | 8 |
| Zoysia | 9 | $82.88 | $92.56 | 18 |
| Zoysia | 12 | $140.25 | $153.16 | 19 |
| Bahia | 6 | $24.05 | $24.05 | 5 |
| Bahia | 9 | $30.82 | $38.58 | 15 |
| Bahia | 12 | $47.44 | $57.79 | 16 |

All selected missing-cost, needs-pricing and missing-inventory-price flags are cleared in this development snapshot. Remaining occurrences total 140 unit warnings and 41 unresolved combined-product warnings across the 12 combinations; these counts repeat products across visits and cadences.

The deltas are not pure price substitutions. The existing price-sensitive matcher previously resolved `Acelepryn Xtra liquid preventive` to Hydretain Liquid; with the new quote it resolves to Acelepryn Xtra. It also changes the heat-substitution reference line from SpeedZone Southern to Celsius WG. No matcher code was changed. These observations reinforce why this reference audit cannot certify actual selected treatments or supplier-verified annual costs.

## Remaining cost, calendar and timing review

Six distinct selected products still have unresolved cost-unit evidence: Armada 50 WDG, Prodiamine 65 WDG, LESCO K-Flow 0-0-25, LESCO 12-0-0 Chelated Iron Plus, Primo Maxx and SpeedZone Southern. Their existing seeded prices are not newly verified supplier quotes. Match each supplier package and price to its exact product and unit basis before correcting it.

Combined lines still require independent ingredient quantities and costs: Celsius + NIS; SpeedZone + NIS; Hydretain + Chelated AM; and Primo Maxx + Anuew EZ. Pricing the first matched product does not price the entire combination.

The active operating tables were read separately in development. Their eight Celsius rows use 0.057 weight oz per 1,000 sqft and are conditional (`default_in_plan=false`), while the catalog/reference calculation uses 0.085 oz per 1,000 sqft. Four active Acelepryn rows use 0.46 fluid oz per 1,000 sqft and are default inclusions. The cost update preserves all of these existing rates and gates; it does not select a replacement dose. The reference checker still reports `operatingLayerVerified=false`. Reconcile exact operating windows, grass restrictions, conditional selection and per-window rates before adopting a cost budget.

The reference calendar's flagged windows are not proof of the actual sold service calendar. Measured travel, setup and on-site production time remain needed; synthetic development fixtures cannot establish them. Customer rate grids, material budgets, floors, protocols, billing and retainer terms were not edited.
