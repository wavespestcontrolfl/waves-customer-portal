# Approved lawn supplier costs — September 7, 2026

The owner supplied two SiteOne listings and authorized applying their package prices, then authorized the remaining unit, treatment-rate and calendar reconciliation. This change was applied and verified in an isolated, repository-seeded Railway development database. It is not evidence of deployed catalog values or an actual purchase. No production database was accessed.

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

## Reconciliation after the six unit corrections

Six distinct selected products had unresolved cost-unit evidence: Armada 50 WDG, Prodiamine 65 WDG, LESCO K-Flow 0-0-25, LESCO 12-0-0 Chelated Iron Plus, Primo Maxx and SpeedZone Southern. Their existing seeded prices are not newly verified supplier quotes. Migration `20260907000021_lawn_cost_inventory_dimensions.js` now resolves their missing inventory dimensions from the existing explicit pound/gallon packages. For the four liquids it checks that the stored per-ounce cost matches package price divided by fluid ounces to four-decimal precision; the original derivation is `costPerUnit()` in `20260528000007_protocol_canonical_price_mappings.js`. Prices, rates and all other catalog fields remain unchanged. It refuses stock quantities with missing units or changed package/cost evidence, and preserves explicit admin unit choices.

Combined lines still require independent ingredient quantities and costs: Celsius + NIS; SpeedZone + NIS; Hydretain + Chelated AM; and Primo Maxx + Anuew EZ. Pricing the first matched product does not price the entire combination.

The active operating tables were read separately in development. Their eight Celsius rows use 0.057 weight oz per 1,000 sqft and are conditional (`default_in_plan=false`), while the catalog/reference calculation uses 0.085 oz per 1,000 sqft. Four active Acelepryn rows use 0.46 fluid oz per 1,000 sqft and are default inclusions. The cost update preserves all of these existing rates and gates; it does not select a replacement dose. The reference checker still reports `operatingLayerVerified=false`. Reconcile exact operating windows, grass restrictions, conditional selection and per-window rates before adopting a cost budget.

The established cadence mapping in `public-services-menu.js` and `estimate-converter.js` is standard = bimonthly (6), enhanced = every_6_weeks (9), premium = monthly (12). These are rolling schedules anchored to the initial service, not one universal set of treatment months; the reference calendar's flagged windows are not proof of an actual sold service calendar. Measured travel, setup and on-site production time remain needed; synthetic development fixtures cannot establish them. Customer rate grids, material budgets, floors, protocols, billing and retainer terms were not edited.


The six-dimension migration passed a real PostgreSQL rollback test proving every catalog field except `inventory_unit` and `updated_at` was unchanged. Repeat execution produced no extra audit rows; three contradictory stock/package/cost cases rolled back. The migration then applied, and the same 12-combination audit returned **zero unit warnings and 41 combined-product warnings**. All selected-material subtotals in the table above are unchanged; all annual-completeness fields remain false/null. This supersedes the earlier 140-unit-warning count.

### Celsius rate meaning

The [manufacturer label](https://bynder.envu.com/m/65d25e1e68990f59/original/Digital_TO_Celsius-WG_label_NA_US_EN.pdf), PDF page 5, identifies 0.057 oz/1,000 sqft as low and 0.085 as medium; selection depends on the target weeds. They are different treatment rates, not an ounce-conversion error. The operating plan's selected rate must control its cost; the catalog's medium default does not establish every operating application's rate. Neither rate was rewritten. The cost engine's existing three-decimal quantity rounding produces $3.42 at the low rate versus $5.10 at the medium rate for a hypothetical full 4,500-sqft treated area. These are cost comparisons, not instructions to select a rate or treat an entire lawn.

### Separate ingredient costing

The existing `calculateProductAmount` helper was run separately for each catalog product with a 4,500-sqft treated area. Rates and prices here are the existing development catalog inputs, not newly confirmed supplier costs or prescribed treatment choices. Optional/premium gates and actual treated area still apply.

| Ingredient | Modeled amount | Selected-material cost |
| --- | ---: | ---: |
| Hydretain Liquid | 40.5 fl oz | $23.39 |
| LESCO Chelated AM + Micros | 9 fl oz | $1.03 |
| Primo Maxx | 1.575 fl oz | $3.94 |
| Anuew EZ | 2.7 fl oz | $6.41 |
| Non-ionic Surfactant | Missing rate and exact product | Unknown |

NIS has no package, price or rate in the development catalog. No exact surfactant was inferred from the generic name. Its product/package cost and applicable mix-rate evidence were requested, as were measured travel/setup/treatment times. Until those inputs and actual conditional selections are available, combined treatments and a complete annual operating-cost model remain unverified.


### Review correction: canonical identities and dry cost overrides

The repository-seeded development catalog does not reproduce every imported canonical product row. Review identified three deduplication keepers that must be handled: `LESCO Chelated Iron Plus`, `LESCO K-Flow 0-0-25 17% S Turfgrass Liquid Fertilizer`, and `Primo Maxx Plant Growth Regulator for Turf`. Forward migration `20260907000100_canonical_lawn_cost_dimensions.js` selects exactly one active identity from each established keeper/legacy pair. It never selects a deactivated predecessor. The two earlier migrations remain intact because the preview already ran them.

The forward migration also checks per-unit costs against the package for dry products, including rows whose inventory unit was already filled. Weight/volume contradictions, stale overrides, ambiguous active identities and conflicting package sizes fail closed. Compatible explicit units and consistent costs are preserved.

Nine regression cases passed. A separate real PostgreSQL transaction created the three canonical keepers with inactive predecessors and verified the keepers received units, predecessor units were unchanged, prices were preserved and repetition added no audit rows. Both stale dry-cost cases failed even with a pre-filled weight unit. All fixtures rolled back. The unchanged seeded catalog also passed the complete forward migration in a rollback transaction. This supplements the fresh-catalog results above; neither fixture establishes production supplier-price freshness.
