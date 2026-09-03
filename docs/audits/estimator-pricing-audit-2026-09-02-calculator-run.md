<!-- Generated 2026-09-02 by scripts/audit-estimator-pricing.js on in-code constants (origin/main 66ecc95dc). Re-run with --db to overlay pricing_config. -->
# Independent estimator pricing audit — run output

Generated 2026-09-02T22:41:21.377Z. Constants source: **constants.js (in-code defaults)**.
Scenarios: 1199 · independent-vs-engine matches: 1156 · mismatches: 0 · engine-only observations: 41.

## Findings raised by this run

- **P2** [pest_control] invalid input priced silently: decimal homeSqFt — perApp 112, footprint 2001 (footprint), no review flag / warning
- **P2** [pest_control] invalid input priced silently: huge homeSqFt 1e9 — perApp 128, footprint 1000000000 (footprint), no review flag / warning
- **P2** [pest_control] invalid input priced silently: negative stories — perApp 112, footprint 2000 (footprint), no review flag / warning
- **P2** [pest_control] invalid input priced silently: decimal stories — perApp 97, footprint 741 (footprint), no review flag / warning
- **P2** [lawn_care] invalid input priced silently: zero lawnSqFt — perApp 45.33 on lawnSqFt=0, tier enhanced, no review flag
- **P2** [lawn_care] invalid input priced silently: legacy lawnFreq 4 (retired basic) — perApp 64 on lawnSqFt=4500, tier enhanced, no review flag
- **P2** [rodent_bait] invalid input priced silently: zero homeSqFt — rodent bait priced 89/visit on footprint 2500 with no review flag
- **P2** [rodent_bait] invalid input priced silently: negative homeSqFt — rodent bait priced 89/visit on footprint 2500 with no review flag
- **P2** [rodent_bait] invalid input priced silently: missing homeSqFt — rodent bait priced 89/visit on footprint 2500 with no review flag
- **P1** [tree_shrub] palm count ignored when supplied at property level — 30 palms at property level: 53.08/mo (source property); as service-line: 95.17/mo; no palms: 53.08/mo
- **P2** [tree_shrub] explicit treeCount=0 suppresses density fallback without review — 0 trees → 45.25/mo vs density-estimated 10 trees → 58.75/mo
- **P2** [specialty] german roach severity defaulted (undefined) to cheapest tier silently — price 350 (light)
- **P2** [waveguard_discounts] FIXED manual discount can zero a Platinum estimate with no cap — year1Total 0, recurringAnnualAfterDiscount 0

## Mismatches (independent formula vs engine)

| section | scenario | independent | engine | diff |
|---|---|---:|---:|---:|

## Annual economics per recurring service (engine labor model vs production-observed on-site minutes)

| service | tier | list/visit | renewal revenue | year-1 revenue | modeled min | gross margin (modeled) | markup (modeled) | observed min (n) | gross margin (observed median) | gross margin (observed p75) | contribution (observed, all-card) | price/visit needed for 35% at observed |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| pest_control quarterly (2,000 sf) | bronze | $112.00 | $448.00 | $547.00 | 25 | 58.6% | 141.4% | 44 (98) | 48.7% | 38.8% | 45.8% | $88.44 |
| pest_control quarterly (2,000 sf) | silver | $112.00 | $403.20 | $502.20 | 25 | 54.0% | 117.2% | 44 (98) | 43.0% | 32.0% | 40.1% | $88.44 |
| pest_control quarterly (2,000 sf) | gold | $112.00 | $380.80 | $479.80 | 25 | 51.3% | 105.2% | 44 (98) | 39.6% | 28.0% | 36.7% | $88.44 |
| pest_control quarterly (2,000 sf) | platinum | $112.00 | $358.40 | $457.40 | 25 | 48.2% | 93.1% | 44 (98) | 35.8% | 23.5% | 32.9% | $88.44 |
| lawn_care 9x st_augustine (4,500 sf) | bronze | $64.00 | $576.00 | $576.00 | 23.25 | 30.7% | 44.3% | 44 (17) | 7.2% | 1.7% | 4.3% | $91.36 |
| lawn_care 9x st_augustine (4,500 sf) | silver | $64.00 | $518.40 | $518.40 | 23.25 | 23.0% | 29.8% | 44 (17) | -3.1% | -9.2% | -6.0% | $91.36 |
| lawn_care 9x st_augustine (4,500 sf) | gold | $64.00 | $489.60 | $489.60 | 23.25 | 18.4% | 22.6% | 44 (17) | -9.2% | -15.6% | -12.1% | $91.36 |
| lawn_care 9x st_augustine (4,500 sf) | platinum | $64.00 | $460.80 | $460.80 | 23.25 | 13.3% | 15.4% | 44 (17) | -16.0% | -22.8% | -18.9% | $91.36 |
| mosquito seasonal9 (8,000 sf lot) | bronze | $77.00 | $693.00 | $693.00 | 30 | 49.2% | 96.9% | — | — | — | — | — |
| mosquito seasonal9 (8,000 sf lot) | silver | $77.00 | $623.70 | $623.70 | 30 | 43.6% | 77.2% | — | — | — | — | — |
| mosquito seasonal9 (8,000 sf lot) | gold | $77.00 | $589.05 | $589.05 | 30 | 40.3% | 67.4% | — | — | — | — | — |
| mosquito seasonal9 (8,000 sf lot) | platinum | $77.00 | $554.40 | $554.40 | 30 | 36.5% | 57.5% | — | — | — | — | — |
| rodent_bait (2,000 sf) | bronze | $89.00 | $356.00 | $455.00 | 25 | 37.2% | 59.3% | — | — | — | — | — |
| rodent_bait (2,000 sf) | silver | $89.00 | $320.40 | $419.40 | 25 | 30.2% | 43.4% | — | — | — | — | — |
| rodent_bait (2,000 sf) | gold | $89.00 | $302.60 | $401.60 | 25 | 26.1% | 35.4% | — | — | — | — | — |
| rodent_bait (2,000 sf) | platinum | $89.00 | $284.80 | $383.80 | 25 | 21.5% | 27.4% | — | — | — | — | — |
| tree_shrub 6x (1,440 sf beds, 6 trees) | bronze | $95.83 | $574.98 | $574.98 | 42 | 45.0% | 81.8% | — | — | — | — | — |
| tree_shrub 6x (1,440 sf beds, 6 trees) | silver | $95.83 | $517.48 | $517.48 | 42 | 38.9% | 63.7% | — | — | — | — | — |
| tree_shrub 6x (1,440 sf beds, 6 trees) | gold | $95.83 | $488.73 | $488.73 | 42 | 35.3% | 54.6% | — | — | — | — | — |
| tree_shrub 6x (1,440 sf beds, 6 trees) | platinum | $95.83 | $459.98 | $459.98 | 42 | 31.3% | 45.5% | — | — | — | — | — |
| termite_bait monitoring (2,000 sf) | bronze | $72.00 | $288.00 | $288.00 | 75 | -65.0% | -39.4% | — | — | — | — | — |
| termite_bait monitoring (2,000 sf) | silver | $72.00 | $259.20 | $259.20 | 75 | -83.3% | -45.5% | — | — | — | — | — |
| termite_bait monitoring (2,000 sf) | gold | $72.00 | $244.80 | $244.80 | 75 | -94.1% | -48.5% | — | — | — | — | — |
| termite_bait monitoring (2,000 sf) | platinum | $72.00 | $230.40 | $230.40 | 75 | -106.2% | -51.5% | — | — | — | — | — |

## Markup vs margin sites

- TERMITE.installMultiplier ×1.45 on install MATERIAL only (service-pricing.js priceTermiteBait) — markup on material (equivalent margin 31.0%) — install labor (5 min/station × $35) is excluded from the marked-up base; reported installMargin only
- SPECIALTY.trenching.productPremiumMultiplier ×1.45 on chemical premium — markup on incremental material (equivalent margin 31.0%) — base install is $/LF, not cost-plus
- BED_BUG.heat.subcontractMarkup ×1.25 on vendor cost — markup (correctly named) (equivalent margin 20.0%)
- ONE_TIME.pest.multiplier ×2.2 on quarterly per-app — price multiple (not cost-based)
- SPECIALTY.*.marginDivisor and TREE_SHRUB.marginTarget — margin (price = cost ÷ (1 − m)) — correct

## Engine-only observations (no independent formula, recorded for the report)

- [pest_control] invalid: blank homeSqFt: {}
- [pest_control] invalid: zero homeSqFt: {}
- [pest_control] invalid: negative homeSqFt: {}
- [pest_control] invalid: decimal homeSqFt: {}
- [pest_control] invalid: huge homeSqFt 1e9: {}
- [pest_control] invalid: negative stories: {}
- [pest_control] invalid: decimal stories: {}
- [pest_control] invalid: unknown frequency semiannual: {}
- [pest_control] invalid: unknown propertyType Condo: {}
- [lawn_care] invalid: blank lawnSqFt (falls to lot-derived turf): {}
- [lawn_care] invalid: zero lawnSqFt: {}
- [lawn_care] invalid: negative lawnSqFt: {}
- [lawn_care] invalid: decimal lawnSqFt: {}
- [lawn_care] invalid: huge lawnSqFt 1e7: {}
- [lawn_care] invalid: legacy lawnFreq 4 (retired basic): {}
- [lawn_care] invalid: unknown grass paspalum: {}
- [mosquito] invalid: zero lot: {}
- [mosquito] invalid: negative lot: {}
- [mosquito] invalid: missing lot: {}
- [mosquito] invalid: lot smaller than footprint: {}
- [rodent_bait] invalid: zero homeSqFt: {}
- [rodent_bait] invalid: negative homeSqFt: {}
- [rodent_bait] invalid: missing homeSqFt: {}
- [one_time_pest] stand-alone vs paired with recurring pest (same visit): {"standalone":246,"paired":212,"pairedAfterDiscount":212}
- [tree_shrub] palm count contribution (30 palms): property-level vs service-line: {"monthlyNoPalms":53.08,"monthlyPropertyPalms":53.08,"monthlyServiceLinePalms":95.17,"propertyPalmSource":"property","serviceLinePalmSource":"service_line"}
- [tree_shrub] no bed area and no lot: fallback: {"bedArea":2000,"bedAreaSource":"fallback","treeCount":0,"treeCountSource":"default_zero","review":true,"reasons":["missing_bed_area_fallback"]}
- [tree_shrub] explicit treeCount 0 vs absent with heavy density: {"explicitZero":{"monthly":45.25,"treeCount":0,"source":"explicit","review":false},"absent":{"monthly":58.75,"treeCount":10,"source":"density_estimate"}}
- [specialty] palm {"treatmentType":"nutrition","palmCount":0}: {}
- [specialty] palm {"treatmentType":"nutrition","palmCount":-2}: {}
- [specialty] palm {"treatmentType":"nutrition","palmCount":2.5}: {}
- [waveguard_discounts] Platinum + 25% manual discount (stacked, uncapped by design): {"platinumAnnual":1883.2,"withManual":1412.4,"manualDiscount":{"amount":470.8,"capReason":null},"marginWarnings":[{"service":"lawn_care","type":"waveguard_discount_below_margin_floor","margin":0.133,"marginFloor":0.35,"finalAnnual":460.8,"annualCost":399.31,"message":"lawn_care WaveGuard discount drops collected margin to 13.3% (below the 35% review floor) — price stands as discounted"},{"service":"pest_control","type":"manual_discount_below_margin_floor","margin":0.237,"marginFloor":0.35,"finalAnnual":239.77,"annualCost":183,"manualDiscountShare":118.63,"message":"pest_control manual discount
- [waveguard_discounts] Platinum + FIXED $99,999 manual discount (zeroes the estimate?): {"year1Total":0,"manualDiscount":{"amount":1883.2,"value":99999}}
- [commercial] commercial pest office 5,000 sf: {"engineError":null,"tier":"bronze","lines":[{"service":"commercial_pest","annual":715.83,"price":null,"perApp":178.96,"visits":4,"manualQuote":false,"taxable":true,"taxCategory":"nonresidential_pest_control","margin":0.45,"review":false}]}
- [commercial] commercial lawn 60,000 sf turf: {"engineError":null,"tier":"bronze","lines":[{"service":"commercial_lawn","annual":6231.52,"price":null,"perApp":778.94,"visits":8,"manualQuote":false,"taxable":false,"taxCategory":"lawn_spraying_or_treatment","margin":0.45,"review":false}]}
- [commercial] commercial mosquito 40,000 sf lot: {"engineError":null,"tier":"bronze","lines":[{"service":"commercial_mosquito","annual":1321.09,"price":null,"perApp":146.79,"visits":9,"manualQuote":false,"taxable":true,"taxCategory":"nonresidential_pest_control","margin":0.45,"review":false}]}
- [commercial] commercial one-time pest (manual quote?): {"engineError":null,"tier":"bronze","lines":[{"service":"commercial_pest","annual":null,"price":null,"perApp":null,"visits":null,"manualQuote":true,"taxable":true,"taxCategory":"nonresidential_pest_control","margin":null,"review":true}]}
- [commercial] commercial WDO: {"engineError":null,"tier":"bronze","lines":[{"service":"commercial_pest","annual":null,"price":null,"perApp":null,"visits":null,"manualQuote":true,"taxable":true,"taxCategory":"nonresidential_pest_control","margin":null,"review":true}]}
- [commercial] commercial german roach: {"engineError":null,"tier":"bronze","lines":[{"service":"commercial_pest","annual":null,"price":null,"perApp":null,"visits":null,"manualQuote":true,"taxable":true,"taxCategory":"nonresidential_pest_control","margin":null,"review":true}]}
- [commercial] commercial rodent bait: {"engineError":null,"tier":"bronze","lines":[{"service":"commercial_rodent_bait","annual":476,"price":null,"perApp":119,"visits":4,"manualQuote":false,"taxable":true,"taxCategory":"nonresidential_pest_control","margin":null,"review":false},{"service":"rodent_bait_setup","annual":null,"price":99,"perApp":null,"visits":null,"manualQuote":false,"taxable":null,"taxCategory":null,"margin":null,"review":null}]}
- [commercial] commercial termite bait: {"engineError":null,"tier":"bronze","lines":[{"service":"commercial_termite_bait","annual":813.27,"price":null,"perApp":203.32,"visits":4,"manualQuote":false,"taxable":true,"taxCategory":"nonresidential_pest_control","margin":0.45,"review":false}]}
- [commercial] commercial tree & shrub: {"engineError":null,"tier":"bronze","lines":[{"service":"commercial_tree_shrub","annual":2670.91,"price":null,"perApp":445.15,"visits":6,"manualQuote":false,"taxable":false,"taxCategory":"lawn_spraying_or_treatment","margin":0.45,"review":false}]}
