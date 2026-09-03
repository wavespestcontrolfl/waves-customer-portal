# Pricing data-quality audit (read-only)

Generated 2026-09-03T05:43:04.582Z · database host ma….pr….rl….net · window since 2026-06-01

## Service catalog overview

_Round 9 (Codex P2): `active_with_engine_key` / `active_without_engine_key` now require at least one non-empty string member (a `[null]`, `[{}]` or `[""]` array counts as unmapped, matching the runtime string-containment lookup). The row below is the 2026-09-03T05:43Z run under the old non-empty-array predicate and was not re-queried._

| services | active | active_with_engine_key | active_without_engine_key | quote_selectable | recurring_missing_cadence | with_base_price |
|---|---|---|---|---|---|---|
| 92 | 77 | 27 | 50 | 60 | 1 | 20 |

## Active catalog rows that claim the same engine key (slot-reservation refuses to stamp service_id on these)

_Round 7 (Codex P2): new check, not yet run against production — regenerate on the next read-only run. Executed on the local test schema: 0 rows. Round 8 (Codex P2): owners are now counted as distinct catalog rows, so a member repeated inside one row's array is no longer reported as two owners._

## Catalog rows whose frequency label disagrees with visits_per_year

_(0 rows)_

## Active, quote-selectable catalog rows with no engine key (priced by name matching only)

_Round 8 (Codex P2): the query now excludes the 13 cadence service_keys that `slot-reservation.js` resolves directly by `service_key` (`pest_general_*`, `lawn_care_monthly/6week/recurring/quarterly`, `mosquito_monthly/seasonal`, `tree_shrub_*`) and lists them under a separate "resolved by cadence service_key" section. The table below is the pre-exclusion 2026-09-03T05:43Z run and was not re-queried: its cadence rows (e.g. `lawn_care_6week`, `mosquito_seasonal`, the four `pest_general_*` rows) are linked at booking time, so the genuinely name-only population is the remainder._

| service_key | name | category | billing_type | frequency | visits_per_year | pricing_model_key |
|---|---|---|---|---|---|---|
| lawn_care_6week | Every 6 Weeks Lawn Care Service | lawn_care | recurring | every_6_weeks | 9 | sqft_lawn |
| lawn_care_monthly | Monthly Lawn Care Service | lawn_care | recurring | monthly | 12 | sqft_lawn |
| lawn_care_one_time | One-Time Lawn Care Service | lawn_care | one_time | NULL | NULL | sqft_lawn |
| lawn_care_quarterly | Quarterly Lawn Care Service | lawn_care | recurring | quarterly | 4 | sqft_lawn |
| lawn_care_recurring | Bi-Monthly Lawn Care Service | lawn_care | recurring | bimonthly | 6 | sqft_lawn |
| lawn_pest_knockdown | Lawn Pest Knockdown Service | lawn_care | one_time | NULL | NULL | sqft_lawn |
| mosquito_monthly | Monthly Mosquito Control Service | mosquito | recurring | monthly | 12 | NULL |
| mosquito_seasonal | Seasonal Mosquito Control Service | mosquito | recurring | seasonal_feb_oct | 9 | NULL |
| cockroach_control | Cockroach Treatment Service | pest_control | one_time | NULL | NULL | NULL |
| pest_general_bimonthly | Bi-Monthly Pest Control Service | pest_control | recurring | bimonthly | 6 | NULL |
| pest_general_monthly | Monthly Pest Control Service | pest_control | recurring | monthly | 12 | NULL |
| pest_general_quarterly | Quarterly Pest Control Service | pest_control | recurring | quarterly | 4 | NULL |
| pest_general_semiannual | Semiannual Pest Control Service | pest_control | recurring | semiannual | 2 | NULL |
| rodent_exclusion | Rodent Exclusion & Trapping Service | rodent | one_time | NULL | NULL | NULL |
| rodent_general_one_time | Rodent Pest Control Service | rodent | one_time | NULL | NULL | NULL |
| rodent_sanitation_heavy | Rodent Sanitation Service — Heavy | rodent | one_time | NULL | NULL | NULL |
| rodent_sanitation_light | Rodent Sanitation Service — Light | rodent | one_time | NULL | NULL | NULL |
| rodent_sanitation_standard | Rodent Sanitation Service — Standard | rodent | one_time | NULL | NULL | NULL |
| rodent_trapping_exclusion | Rodent Trapping & Exclusion Service | rodent | one_time | NULL | NULL | NULL |
| rodent_trapping_exclusion_sanitation | Rodent Trapping, Exclusion & Sanitation Service | rodent | one_time | NULL | NULL | NULL |
| rodent_trapping_sanitation | Rodent Trapping & Sanitation Service | rodent | one_time | NULL | NULL | NULL |
| fire_ant | Fire Ant Treatment Service | specialty | one_time | NULL | NULL | sqft_lawn |
| mud_dauber_removal | Mud Dauber Nest Removal Service | specialty | one_time | NULL | NULL | NULL |
| tick_control | Tick Control Service | specialty | one_time | NULL | NULL | NULL |
| wildlife_trapping | Wildlife Trapping Service | specialty | one_time | NULL | NULL | NULL |
| termite_bond_10yr | Termite Bond Service (10-Year Term) | termite | recurring | quarterly | 4 | NULL |
| termite_bond_1yr | Termite Bond Service (1-Year Term) | termite | recurring | quarterly | 4 | NULL |
| termite_bond_5yr | Termite Bond Service (5-Year Term) | termite | recurring | quarterly | 4 | NULL |
| termite_liquid | Termite Liquid Treatment Service | termite | one_time | NULL | NULL | linear_ft |
| termite_monitoring | Termite Monitoring Service | termite | recurring | quarterly | 4 | NULL |
| termite_pretreatment | Termite Pretreatment Service | termite | one_time | NULL | NULL | sqft_structure |
| palm_injection_semiannual | Semiannual Palm Injection Service | tree_shrub | recurring | semiannual | 2 | NULL |
| tree_shrub_6week | Every 6 Weeks Tree & Shrub Care Service | tree_shrub | recurring | every_6_weeks | 9 | bed_sqft |
| tree_shrub_program | Bi-Monthly Tree & Shrub Care Service | tree_shrub | recurring | bimonthly | 6 | bed_sqft |
| tree_shrub_quarterly | Quarterly Tree & Shrub Care Service | tree_shrub | recurring | quarterly | 4 | bed_sqft |

## Product catalog cost completeness (active products)

| total | active | no_cost_per_unit | no_best_price | no_cost_unit | needs_pricing | no_unit_size_oz | no_rate | no_rate_unit | label_unverified | best_price_never_updated | best_price_stale_90d | best_price_not_current |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 216 | 192 | 173 | 30 | 173 | 37 | 26 | 29 | 89 | 19 | 36 | 2 | 43 |

## Product cost_unit / rate_unit vocabulary (active)

| field | value | count |
|---|---|---|
| cost_unit | NULL | 173 |
| cost_unit | oz | 8 |
| cost_unit | fl_oz | 7 |
| cost_unit | lb | 2 |
| cost_unit | tablet | 1 |
| cost_unit | station | 1 |
| rate_unit | NULL | 89 |
| rate_unit | fl_oz | 58 |
| rate_unit | lb | 29 |
| rate_unit | oz | 15 |
| rate_unit | g | 1 |

## Duplicate product names / SKUs (active)

| kind | count |
|---|---|
| dup_name | 0 |
| dup_sku | 1 |

## Vendor pricing normalization

_Round 8 (Codex P2): `stale_90d` now also counts rows whose `last_checked_at` is NULL (never checked) and a separate `never_checked` column reports them. The row below is the 2026-09-03T05:43Z run under the old predicate (NULL excluded) and was not re-queried, so 177 is a lower bound._

| rows | active | no_normalized_unit_price | no_unit | approved | stale_90d |
|---|---|---|---|---|---|
| 179 | 178 | 136 | 160 | 179 | 177 |

## service_product_usage (the estimate audit COGS map) completeness

_Round 16 (Codex P2): `product_no_cost` now mirrors the COGS calculator's fallback prerequisites (`product-costing.js` `costLineFromUsage`) — a product without a positive `cost_per_unit` counts as costless unless `best_price` > 0 AND `unit_size_oz` > 0 AND the usage unit converts to ounces (`normalizeUnit`: trim, lower, spaces → `_`, one trailing `s` dropped). The row below is the 2026-09-03T05:43Z run under the price-only predicate (`cost_per_unit` or `best_price` > 0) and is a lower bound; it was not re-queried against prod._

| rows | service_types | no_quantity | no_unit | product_missing | product_no_cost | service_type_not_a_catalog_key |
|---|---|---|---|---|---|---|
| 32 | 24 | 0 | 0 | 0 | 6 | 32 |

## lawn_protocol_products rate / carrier / product-link completeness

| rows | unlinked_product | no_rate | no_rate_unit | no_carrier |
|---|---|---|---|---|
| 141 | 6 | 18 | 0 | 0 |

## Deterministic protocol templates and their product rows

| templates | active | product_rows | product_rows_without_rate |
|---|---|---|---|
| 1 | 1 | 3 | 3 |

## Equipment calibrations (field-verified status)

| system | system_type | tank_capacity_gal | carrier_gal_per_1000 | pump_output_reference_gpm | gun_output_reference_gpm | flow_output_reference_gpm | calibration_status | active | calibrated | verified |
|---|---|---|---|---|---|---|---|---|---|---|
| FlowZone Typhoon Backpack | backpack | 4.00 | 1.330 | NULL | NULL | 0.730 | estimated_not_field_verified | true | "2026-06-11T04:00:00.000Z" | NULL |
| 110-Gallon Spray Tank #1 | tank | 110.00 | 2.000 | 15.000 | 2.000 | NULL | estimated_not_field_verified | true | "2026-06-11T04:00:00.000Z" | NULL |
| Udor KAPPA-18/12V-HP + 110-gal tank #2 - Lawn Gun | tank | 110.00 | 2.000 | 4.200 | NULL | NULL | estimated_not_field_verified | true | "2026-06-11T04:00:00.000Z" | NULL |

## pricing_config rows (DB-authoritative knobs) and audit trail

| config_rows | audit_rows | changelog_rows | newest_config_update | newest_changelog |
|---|---|---|---|---|
| 65 | 72 | 50 | "2026-09-01T04:00:00.000Z" | "2026-09-01T04:00:00.000Z" |

## Core pricing_config values to compare against constants.js

| config_key | updated | value |
|---|---|---|
| global_admin_annual | "2026-04-15T04:00:00.000Z" | 51 |
| global_drive_time | "2026-04-15T04:00:00.000Z" | 20 |
| global_labor_rate | "2026-04-15T04:00:00.000Z" | 35 |
| global_margin_floor | "2026-04-17T04:00:00.000Z" | 0.35 |
| global_processing | "2026-04-15T04:00:00.000Z" | {"unit": "ratio", "value": 0.03, "description": "3% processing cost baked into all customer-facing prices"} |
| onetime_pest | "2026-05-29T04:00:00.000Z" | {"floor": 199, "multiplier": 2.2} |
| onetime_wdo | "2026-07-13T04:00:00.000Z" | 250 |
| pest_base | "2026-08-25T04:00:00.000Z" | 112 / floor 79 |
| pest_service_costs | "2026-04-15T04:00:00.000Z" | {"labor": {"drive_minutes": 20, "rate_per_hour": 35, "total_minutes": 53, "on_site_minutes": 33, "cost_per_service": 30. |
| rodent_waveguard | "2026-09-01T04:00:00.000Z" | tier_qualifier=true exclude_pct=false |
| ts_frequencies | "2026-06-11T04:00:00.000Z" | {"unit": "visits/yr", "light": 4, "standard": 6} |
| waveguard_caps | "2026-04-15T04:00:00.000Z" | {"composite_cap": 0.25, "lawn_premium_cap": 0.15, "lawn_enhanced_cap": 0.15, "recurring_customer_discount": 0.15} |
| waveguard_qualifying | "2026-04-15T04:00:00.000Z" | ["lawn_care", "pest_control", "tree_shrub", "mosquito", "termite_bait"] |
| waveguard_tiers | "2026-04-09T04:00:00.000Z" | 0.1/0.15/0.2 |

## Estimates by pricing authority and status (live rows)

| authority | status | count |
|---|---|---|
| SERVER | expired | 383 |
| NULL | draft | 254 |
| NULL | expired | 113 |
| LOCKED | accepted | 99 |
| SERVER | viewed | 25 |
| SERVER | draft | 17 |
| NULL | declined | 2 |

## Live estimates carrying synthetic / low-confidence scope inputs

| measurements_defaulted | measurements_defaulted_delivered | turf_lot_fallback | turf_lot_fallback_delivered | fixed_discount_not_replayable |
|---|---|---|---|---|
| 183 | 0 | 8 | 7 | 0 |

## Live estimates whose stored WaveGuard tier differs from the engine tier

_Round 3 (Codex P2): the engine tier is read from every persisted carrier `serviceOptOutEngineTierReference` enumerates (ten paths), not two. Round 2 (Codex P2): `differs_from_engine` now uses `IS DISTINCT FROM`, so a NULL stored tier beside a non-null engine tier counts. The table below is from the 2026-09-03T05:43Z run under the old `<>` predicate (NULL-tier rows could not register a difference) and was not re-queried; treat the NULL row's 0 as unmeasured until the next run._

| waveguard_tier | n | differs_from_engine |
|---|---|---|
| NULL | 236 | 0 |
| Bronze | 149 | 0 |
| Silver | 10 | 0 |

## Accepted estimates with a frozen cost/margin snapshot (plus the all-snapshot missing-cost count, scoped separately)

_Round 3 (Codex P2): `accepted_without_cost` now evaluates the LATEST snapshot per accepted estimate; the value below is from the any-snapshot predicate and was not re-queried._

| accepted | with_snapshot | accepted_without_cost | all_snapshots | all_snapshots_without_cost |
|---|---|---|---|---|
| 100 | 99 | 34 | 324 | 114 |

## Real customers by billing lane and fee coverage

_Round 7 (Codex P2): the query now excludes `INTERNAL_TEST_CUSTOMERS` (the same predicate as the uninvoiced mirror), so owner test accounts in an active pipeline stage no longer count as real customers. The table below is the pre-exclusion 2026-09-03T05:43Z run and was not re-queried; the 813-customer and 128-of-182 figures are upper bounds until the next read-only run._

| lane | n | with_monthly_rate | with_per_application_fee | per_app_without_fee | fee_equals_monthly |
|---|---|---|---|---|---|
| per_visit | 568 | 3 | 0 | 0 | 0 |
| per_application | 182 | 179 | 54 | 128 | 6 |
| annual_prepay | 42 | 37 | 12 | 0 | 1 |
| NULL | 18 | 0 | 0 | 0 | 0 |
| monthly_membership | 3 | 3 | 0 | 0 | 0 |

## Completed billable visits since 2026-06-01 with no invoice (by lane)

_Round 9 (Codex P2): the population is now scoped by completion time (`completed_at`, ET date ≥ --since) like the Billing Recovery workbench, not by `scheduled_date`. The table below is the 2026-09-03T05:43Z run under the scheduled-date scope and was not re-queried._

_Round 3 (Codex P1): the script's predicate now mirrors the Billing Recovery workbench's `uninvoicedLeakQuery` (effective price incl. per-application fee, dispositions, record-level callbacks, always-free types, self-pay only, autopay rule). The table below is the earlier, looser predicate and was not re-queried; the workbench figure supersedes it._

_Round 2 (Codex P2): membership-covered visits (`billing_mode = monthly_membership`) are excluded — dues cover them and no per-visit invoice is expected. The query groups by lane, so the filter removes exactly that lane's row (2 visits, $196.60); the remaining rows are unchanged from the 2026-09-03T05:43Z run and were not re-queried._

| lane | uninvoiced | no_invoice_within_3_days | est_price_at_risk |
|---|---|---|---|
| per_application | 26 | 15 | 966.20 |
| per_visit | 22 | 3 | 367.00 |
| NULL | 4 | 0 | 0.00 |
| annual_prepay | 1 | 0 | 0.00 |

## Completed-visit RECORDED span minutes (check-in→check-out, often includes drive — not on-site time) by service type since 2026-06-01 (n ≥ 3)

| service_type | n | scheduled_est_avg | median_min | avg_min | p75_min | p90_min | price_avg | realized_per_hour_over_recorded_span |
|---|---|---|---|---|---|---|---|---|
| Quarterly Pest Control Service | 89 | 62 | 44 | 48 | 63 | 78 | 118.51 | 304.85 |
| Pest Control Service | 33 | 63 | 57 | 58 | 65 | 78 | 173.96 | 241.84 |
| Quarterly Pest Control | 24 | 60 | 54 | 53 | 66 | 85 | 123.00 | 287.55 |
| Pest Control | 19 | 60 | 51 | 54 | 68 | 79 | 152.36 | 539.26 |
| Every 6 Weeks Lawn Care Service | 17 | 60 | 44 | 51 | 50 | 56 | 65.49 | 101.20 |
| Monthly Lawn Care Service | 7 | 66 | 37 | 40 | 46 | 54 | 41.49 | 92.36 |
| Monthly Pest Control Service | 6 | 60 | 37 | 41 | 51 | 61 | 77.84 | 123.78 |
| Lawn Care Visit | 6 | 60 | 46 | 61 | 69 | 100 | 32.77 | 77.05 |
| Pest Control Re-Service | 4 | 60 | 28 | 30 | 38 | 44 | 0.00 | NULL |
| One-Time Pest Control Service | 3 | 60 | 36 | 37 | 39 | 40 | 184.67 | 295.41 |
| Cockroach Treatment | 3 | 60 | 36 | 35 | 40 | 42 | 231.33 | 445.06 |
| Lawn Care | 3 | 70 | 54 | 58 | 64 | 70 | 62.43 | 67.22 |
| General Pest Control (Quarterly) | 3 | 60 | 37 | 37 | 41 | 43 | 107.67 | 180.80 |

## job_costs (actual costing ledger) sanity by service type (n ≥ 3)

| service_type | n | rev_avg | labor_avg | products_avg | drive_avg | equipment_avg | margin_avg | zero_products | zero_revenue | products_exceed_revenue |
|---|---|---|---|---|---|---|---|---|---|---|
| Quarterly Pest Control Service | 154 | 123.93 | 17.37 | 54.19 | 6.00 | 0.00 | 31.5 | 90 | 3 | 13 |
| Pest Control Service | 40 | 169.24 | 33.82 | 125.75 | 6.00 | 0.00 | -16.1 | 25 | 2 | 7 |
| Quarterly Pest Control | 21 | 97.48 | 29.67 | 180.41 | 6.00 | 0.00 | -141.2 | 3 | 0 | 7 |
| Pest Control | 20 | 177.66 | 26.48 | 25.08 | 6.00 | 0.00 | 20.1 | 15 | 1 | 1 |
| Every 6 Weeks Lawn Care Service | 19 | 0.00 | 26.40 | 5943.82 | 6.00 | 0.00 | NULL | 6 | 19 | 0 |
| Monthly Lawn Care Service | 11 | 0.00 | 15.11 | 810.96 | 6.00 | 0.00 | NULL | 7 | 11 | 0 |
| General Pest Control (Quarterly) | 8 | 142.63 | 8.17 | 200.58 | 6.00 | 0.00 | -113.3 | 5 | 0 | 2 |
| General Pest Control | 6 | 197.21 | 14.58 | 4.59 | 6.00 | 0.00 | 67.1 | 5 | 0 | 0 |
| One-Time Pest Control Service | 5 | 175.80 | 13.07 | 15.21 | 6.00 | 0.00 | 67.9 | 3 | 0 | 0 |
| Monthly Pest Control Service | 5 | 74.09 | 20.65 | 199.36 | 6.00 | 0.00 | -160.1 | 1 | 0 | 2 |
| Lawn Care Visit | 5 | 63.50 | 24.15 | 126.51 | 6.00 | 0.00 | -163.5 | 3 | 0 | 1 |
| Pest Control Re-Service | 5 | 0.00 | 14.00 | 226.36 | 6.00 | 0.00 | NULL | 0 | 5 | 0 |
| Rodent Trapping Service | 4 | 323.75 | 26.69 | 0.00 | 6.00 | 0.00 | 89.9 | 4 | 0 | 0 |
| Lawn Care Service | 4 | 0.00 | 4.81 | 0.00 | 6.00 | 0.00 | NULL | 4 | 4 | 0 |
| Pest & Rodent Control Service | 3 | 119.10 | 0.00 | 0.00 | 6.00 | 0.00 | 94.9 | 3 | 0 | 0 |
| Cockroach Treatment | 3 | 231.33 | 20.61 | 9.50 | 6.00 | 0.00 | 82.0 | 0 | 0 | 0 |

## Completed visits: service_type strings vs catalog names/keys

| distinct_service_types | match_catalog_name | match_catalog_key | visits_with_key_snapshot | visits |
|---|---|---|---|---|
| 42 | 21 | 0 | 219 | 434 |
