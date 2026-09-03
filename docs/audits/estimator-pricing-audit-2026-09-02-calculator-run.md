# Independent estimator pricing audit — run output

Generated 2026-09-03T23:31:31.907Z. Constants source: **constants.js (in-code defaults)**.
Scenarios: 1737 · independent-vs-engine matches: 1685 · mismatches: 2 · expected a price but the engine returned none: 0 · engine-only observations: 50 (1685 + 2 + 0 + 50 = 1737) · commercial engine errors: 0 · P0/P1 findings without a row: 0

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
- **P1** [cadence_identities] tree_shrub (9/yr) annual-prepay coverage cadence — expected every_6_weeks, resolver returned bimonthly — the term would cover 6 of 9 prepaid visits

## Mismatches (independent formula vs engine)

| section | scenario | independent | engine | diff |
|---|---|---:|---:|---:|
| tree_shrub | palm count ignored when supplied at property level | invariant holds | 30 palms at property level: 53.08/mo (source property); as service-line: 95.17/mo; no palms: 53.08/mo | — |
| cadence_identities | tree_shrub (9/yr) annual-prepay coverage cadence | every_6_weeks | bimonthly | — |

## Annual economics per recurring service (engine labor model; recorded visit spans shown for context only)

Recorded span = check-in → check-out, which often includes driving to the next stop — NOT on-site time (owner 2026-09-02, MON-004). Span columns are fed with no extra drive minutes and carry no pricing recommendation; the engine model columns are the ones the audit prices from.

| service | tier | list/visit | renewal revenue | year-1 revenue | modeled min | gross margin (modeled) | markup (modeled) | recorded span median min (n) | gross margin at recorded median span | gross margin at recorded p75 span | contribution at recorded span (card: debit / credit+surcharge) |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| pest_control quarterly (2,000 sf) | bronze | $112.00 | $448.00 | $547.00 | 25 | 58.8% | 143.0% | 44 (98) | 59.4% | 49.5% | 56.2% / 59.0% |
| pest_control quarterly (2,000 sf) | silver | $112.00 | $403.20 | $502.20 | 25 | 54.3% | 118.7% | 44 (98) | 54.8% | 43.9% | 51.7% / 54.5% |
| pest_control quarterly (2,000 sf) | gold | $112.00 | $380.80 | $479.80 | 25 | 51.6% | 106.5% | 44 (98) | 52.2% | 40.6% | 49.0% / 51.8% |
| pest_control quarterly (2,000 sf) | platinum | $112.00 | $358.40 | $457.40 | 25 | 48.6% | 94.4% | 44 (98) | 49.2% | 36.8% | 46.0% / 48.8% |
| lawn_care 9x st_augustine (4,500 sf) | bronze | $64.00 | $576.00 | $576.00 | 23.25 | 30.7% | 44.3% | 44 (17) | 16.3% | 10.9% | 13.0% / 15.8% |
| lawn_care 9x st_augustine (4,500 sf) | silver | $64.00 | $518.40 | $518.40 | 23.25 | 23.0% | 29.8% | 44 (17) | 7.0% | 0.9% | 3.6% / 6.4% |
| lawn_care 9x st_augustine (4,500 sf) | gold | $64.00 | $489.60 | $489.60 | 23.25 | 18.4% | 22.6% | 44 (17) | 1.6% | -4.9% | -1.9% / 0.9% |
| lawn_care 9x st_augustine (4,500 sf) | platinum | $64.00 | $460.80 | $460.80 | 23.25 | 13.3% | 15.4% | 44 (17) | -4.6% | -11.4% | -8.1% / -5.3% |
| mosquito seasonal9 (8,000 sf lot) | bronze | $77.00 | $693.00 | $693.00 | 30 | 49.2% | 96.9% | — | — | — | — |
| mosquito seasonal9 (8,000 sf lot) | silver | $77.00 | $623.70 | $623.70 | 30 | 43.6% | 77.2% | — | — | — | — |
| mosquito seasonal9 (8,000 sf lot) | gold | $77.00 | $589.05 | $589.05 | 30 | 40.3% | 67.4% | — | — | — | — |
| mosquito seasonal9 (8,000 sf lot) | platinum | $77.00 | $554.40 | $554.40 | 30 | 36.5% | 57.5% | — | — | — | — |
| rodent_bait (2,000 sf) | bronze | $89.00 | $356.00 | $455.00 | 25 | 37.2% | 59.3% | — | — | — | — |
| rodent_bait (2,000 sf) | silver | $89.00 | $320.40 | $320.40 | 25 | 30.2% | 43.4% | — | — | — | — |
| rodent_bait (2,000 sf) | gold | $89.00 | $302.60 | $302.60 | 25 | 26.1% | 35.4% | — | — | — | — |
| rodent_bait (2,000 sf) | platinum | $89.00 | $284.80 | $284.80 | 25 | 21.5% | 27.4% | — | — | — | — |
| tree_shrub 6x (1,440 sf beds, 6 trees) | bronze | $95.83 | $574.98 | $574.98 | 42 | 45.0% | 81.8% | — | — | — | — |
| tree_shrub 6x (1,440 sf beds, 6 trees) | silver | $95.83 | $517.48 | $517.48 | 42 | 38.9% | 63.7% | — | — | — | — |
| tree_shrub 6x (1,440 sf beds, 6 trees) | gold | $95.83 | $488.73 | $488.73 | 42 | 35.3% | 54.6% | — | — | — | — |
| tree_shrub 6x (1,440 sf beds, 6 trees) | platinum | $95.83 | $459.98 | $459.98 | 42 | 31.3% | 45.5% | — | — | — | — |
| termite_bait monitoring (2,000 sf) | bronze | $72.00 | $288.00 | $898.00 | 75 | -22.9% | -18.7% | — | — | — | — |
| termite_bait monitoring (2,000 sf) | silver | $72.00 | $259.20 | $869.20 | 75 | -36.6% | -26.8% | — | — | — | — |
| termite_bait monitoring (2,000 sf) | gold | $72.00 | $244.80 | $854.80 | 75 | -44.6% | -30.9% | — | — | — | — |
| termite_bait monitoring (2,000 sf) | platinum | $72.00 | $230.40 | $840.40 | 75 | -53.7% | -34.9% | — | — | — | — |

## Markup vs margin sites

- TERMITE.installMultiplier ×1.45 on install MATERIAL only (service-pricing.js priceTermiteBait) — markup on material (equivalent margin 31.0%) — install labor (5 min/station × $35) is excluded from the marked-up base; reported installMargin only
- SPECIALTY.trenching.productPremiumMultiplier ×1.45 on chemical premium — markup on incremental material (equivalent margin 31.0%) — base install is $/LF, not cost-plus
- BED_BUG.heat.subcontractMarkup ×1.25 on vendor cost — markup (correctly named) (equivalent margin 20.0%)
- ONE_TIME.pest.multiplier ×2.2 on quarterly per-app — price multiple (not cost-based)
- SPECIALTY.*.marginDivisor and TREE_SHRUB.marginTarget — margin (price = cost ÷ (1 − m)) — correct

## Engine-only observations (no independent formula, recorded for the report)

- [pest_control] invalid: blank homeSqFt: {"engineError":null,"review":true,"warnings":["invalid_or_zero_pest_footprint"],"footprintUsed":2000,"footprintSource":"invalid_or_zero_footprint_fallback","frequency":"quarterly"}
- [pest_control] invalid: zero homeSqFt: {"engineError":null,"review":true,"warnings":["invalid_or_zero_pest_footprint"],"footprintUsed":2000,"footprintSource":"invalid_or_zero_footprint_fallback","frequency":"quarterly"}
- [pest_control] invalid: negative homeSqFt: {"engineError":null,"review":true,"warnings":["invalid_or_zero_pest_footprint"],"footprintUsed":2000,"footprintSource":"invalid_or_zero_footprint_fallback","frequency":"quarterly"}
- [pest_control] invalid: decimal homeSqFt: {"engineError":null,"review":false,"warnings":[],"footprintUsed":2001,"footprintSource":"footprint","frequency":"quarterly"}
- [pest_control] invalid: huge homeSqFt 1e9: {"engineError":null,"review":false,"warnings":[],"footprintUsed":1000000000,"footprintSource":"footprint","frequency":"quarterly"}
- [pest_control] invalid: negative stories: {"engineError":null,"review":false,"warnings":[],"footprintUsed":2000,"footprintSource":"footprint","frequency":"quarterly"}
- [pest_control] invalid: decimal stories: {"engineError":null,"review":false,"warnings":[],"footprintUsed":741,"footprintSource":"footprint","frequency":"quarterly"}
- [pest_control] invalid: unknown frequency semiannual: {"engineError":null,"review":false,"warnings":["invalid_pest_frequency_defaulted_to_quarterly"],"footprintUsed":2000,"footprintSource":"footprint","frequency":"quarterly"}
- [pest_control] invalid: unknown propertyType Condo: {"engineError":null,"review":false,"warnings":["invalid_property_type_defaulted_to_single_family"],"footprintUsed":2000,"footprintSource":"footprint","frequency":"quarterly"}
- [lawn_care] invalid: blank lawnSqFt (falls to lot-derived turf): {"engineError":null,"lawnSqFtUsed":4044,"tier":"enhanced","review":true,"reasons":["low_confidence_turf_requires_field_verification"],"customQuote":false,"basis":"TABLE_INTERPOLATION"}
- [lawn_care] invalid: zero lawnSqFt: {"engineError":null,"lawnSqFtUsed":0,"tier":"enhanced","review":false,"reasons":[],"customQuote":false,"basis":"TABLE_INTERPOLATION"}
- [lawn_care] invalid: negative lawnSqFt: {"engineError":null,"lawnSqFtUsed":4044,"tier":"enhanced","review":true,"reasons":["low_confidence_turf_requires_field_verification"],"customQuote":false,"basis":"TABLE_INTERPOLATION"}
- [lawn_care] invalid: decimal lawnSqFt: {"engineError":null,"lawnSqFtUsed":4500.5,"tier":"enhanced","review":false,"reasons":[],"customQuote":false,"basis":"TABLE_INTERPOLATION"}
- [lawn_care] invalid: huge lawnSqFt 1e7: {"engineError":null,"lawnSqFtUsed":10000000,"tier":"enhanced","review":false,"reasons":[],"customQuote":true,"basis":"EXTRAPOLATED_ABOVE_TABLE_MAX"}
- [lawn_care] invalid: legacy lawnFreq 4 (retired basic): {"engineError":null,"lawnSqFtUsed":4500,"tier":"enhanced","review":false,"reasons":[],"customQuote":false,"basis":"TABLE_INTERPOLATION"}
- [lawn_care] invalid: unknown grass paspalum: {"engineError":null,"lawnSqFtUsed":4500,"tier":"enhanced","review":true,"reasons":["unknown_grass_type_priced_st_augustine"],"customQuote":false,"basis":"TABLE_INTERPOLATION"}
- [mosquito] invalid: zero lot: {"engineError":null,"category":"SMALL","review":true,"reasons":["missing_mosquito_treatable_area"]}
- [mosquito] invalid: negative lot: {"engineError":null,"category":"SMALL","review":true,"reasons":["missing_mosquito_treatable_area"]}
- [mosquito] invalid: missing lot: {"engineError":null,"category":"ACRE","review":true,"reasons":["missing_mosquito_treatable_area","acre_or_larger_property"]}
- [mosquito] invalid: lot smaller than footprint: {"engineError":null,"category":"SMALL","review":true,"reasons":["missing_mosquito_treatable_area"]}
- [rodent_bait] invalid: zero homeSqFt: {"footprintUsed":2500,"stations":5}
- [rodent_bait] invalid: negative homeSqFt: {"footprintUsed":2500,"stations":5}
- [rodent_bait] invalid: missing homeSqFt: {"footprintUsed":2500,"stations":5}
- [one_time_pest] stand-alone vs paired with recurring pest (same visit): {"standalone":246,"paired":212,"pairedAfterDiscount":212}
- [tree_shrub] palm count contribution (30 palms): property-level vs service-line: {"monthlyNoPalms":53.08,"monthlyPropertyPalms":53.08,"monthlyServiceLinePalms":95.17,"propertyPalmSource":"property","serviceLinePalmSource":"service_line"}
- [tree_shrub] no bed area and no lot: fallback: {"bedArea":2000,"bedAreaSource":"fallback","treeCount":0,"treeCountSource":"default_zero","review":true,"reasons":["missing_bed_area_fallback"]}
- [tree_shrub] explicit treeCount 0 vs absent with heavy density: {"explicitZero":{"monthly":45.25,"treeCount":0,"source":"explicit","review":false},"absent":{"monthly":58.75,"treeCount":10,"source":"density_estimate"}}
- [specialty] foam drill points=25: {"refusedOverMaxPoints":true}
- [specialty] palm {"treatmentType":"nutrition","palmCount":0}: {"perVisitExpected":null,"perVisitActual":null,"minimumApplied":null,"engineError":"Palm count is required for palm injection pricing.","palmSizeUsed":null}
- [specialty] palm {"treatmentType":"nutrition","palmCount":-2}: {"perVisitExpected":null,"perVisitActual":null,"minimumApplied":null,"engineError":"Palm count is required for palm injection pricing.","palmSizeUsed":null}
- [specialty] palm {"treatmentType":"nutrition","palmCount":2.5}: {"perVisitExpected":null,"perVisitActual":null,"minimumApplied":null,"engineError":"Palm count is required for palm injection pricing.","palmSizeUsed":null}
- [specialty] palm {"treatmentType":"combo","palmCount":3}: {"perVisitExpected":null,"perVisitActual":null,"minimumApplied":null,"engineError":"palmSize is required for this palm treatment","palmSizeUsed":null}
- [specialty] palm {"treatmentType":"fungal","palmCount":2,"diagnosisConfirmed":false,"selectedProduct":"PHOSPHO-Jet","appsPerYear":2}: {"perVisitExpected":null,"perVisitActual":null,"minimumApplied":null,"engineError":"diagnosisConfirmed must be true for fungal palm treatment pricing","palmSizeUsed":null}
- [specialty] palm {"treatmentType":"fungal","palmCount":2,"diagnosisConfirmed":true,"selectedProduct":"PHOSPHO-Jet"}: {"perVisitExpected":null,"perVisitActual":null,"minimumApplied":null,"engineError":"fungal palm treatment pricing requires appsPerYear or intervalMonths","palmSizeUsed":null}
- [specialty] palm {"treatmentType":"lethalBronzing","palmCount":2,"palmStatus":"symptomatic"}: {"perVisitExpected":null,"perVisitActual":null,"minimumApplied":null,"engineError":"Palm is not eligible for lethal bronzing injection pricing and should be handled outside this service","palmSizeUsed":null}
- [specialty] palm {"treatmentType":"treeAge","palmCount":2,"dbhInches":25}: {"perVisitExpected":null,"perVisitActual":null,"minimumApplied":null,"engineError":"customPricePerPalm is required for Tree-Age pricing above 20 DBH inches","palmSizeUsed":null}
- [specialty] palm {"treatmentType":"insecticide","palmCount":2,"palmSize":"large","highDose":true}: {"perVisitExpected":null,"perVisitActual":null,"minimumApplied":null,"engineError":"customPricePerPalm is required for quote-based insecticide palm pricing","palmSizeUsed":null}
- [specialty] palm {"treatmentType":"combo","palmCount":1,"palmSize":"medium","nonstandardProduct":true}: {"perVisitExpected":null,"perVisitActual":null,"minimumApplied":null,"engineError":"customPricePerPalm is required for quote-based combo palm pricing","palmSizeUsed":null}
- [specialty] palm {"treatmentType":"treeAge","palmCount":1,"dbhInches":12,"product":"Tree-Age R10"}: {"perVisitExpected":null,"perVisitActual":null,"minimumApplied":null,"engineError":"licensedApplicator is required for restricted-use Tree-Age product pricing","palmSizeUsed":null}
- [specialty] palm {"treatmentType":"treeAge","palmCount":2,"dbhInches":18,"restrictedUseProduct":true}: {"perVisitExpected":null,"perVisitActual":null,"minimumApplied":null,"engineError":"licensedApplicator is required for restricted-use Tree-Age product pricing","palmSizeUsed":null}
- [specialty] palm {"treatmentType":"treeAge","palmCount":2,"dbhInches":18,"restrictedUseProduct":true,"licensedApplicator":"yes"}: {"perVisitExpected":null,"perVisitActual":null,"minimumApplied":null,"engineError":"licensedApplicator is required for restricted-use Tree-Age product pricing","palmSizeUsed":null}
- [commercial] commercial pest office 5,000 sf: {"engineError":null,"expectedLine":{"service":"commercial_pest","manual":false},"tier":"bronze","autoPricedLines":1,"manualQuoteLines":0,"lines":[{"service":"commercial_pest","annual":715.83,"price":null,"perApp":178.96,"visits":4,"manualQuote":false,"taxable":true,"taxCategory":"nonresidential_pest_control","margin":0.45,"review":false}]}
- [commercial] commercial lawn 60,000 sf turf: {"engineError":null,"expectedLine":{"service":"commercial_lawn","manual":false},"tier":"bronze","autoPricedLines":1,"manualQuoteLines":0,"lines":[{"service":"commercial_lawn","annual":6231.52,"price":null,"perApp":778.94,"visits":8,"manualQuote":false,"taxable":false,"taxCategory":"lawn_spraying_or_treatment","margin":0.45,"review":false}]}
- [commercial] commercial mosquito 40,000 sf lot: {"engineError":null,"expectedLine":{"service":"commercial_mosquito","manual":false},"tier":"bronze","autoPricedLines":1,"manualQuoteLines":0,"lines":[{"service":"commercial_mosquito","annual":1321.09,"price":null,"perApp":146.79,"visits":9,"manualQuote":false,"taxable":true,"taxCategory":"nonresidential_pest_control","margin":0.45,"review":false}]}
- [commercial] commercial one-time pest (manual quote): {"engineError":null,"expectedLine":{"service":"commercial_pest","manual":true},"tier":"bronze","autoPricedLines":0,"manualQuoteLines":1,"lines":[{"service":"commercial_pest","annual":null,"price":null,"perApp":null,"visits":null,"manualQuote":true,"taxable":true,"taxCategory":"nonresidential_pest_control","margin":null,"review":true}]}
- [commercial] commercial WDO (manual quote): {"engineError":null,"expectedLine":{"service":"commercial_pest","manual":true},"tier":"bronze","autoPricedLines":0,"manualQuoteLines":1,"lines":[{"service":"commercial_pest","annual":null,"price":null,"perApp":null,"visits":null,"manualQuote":true,"taxable":true,"taxCategory":"nonresidential_pest_control","margin":null,"review":true}]}
- [commercial] commercial german roach (manual quote): {"engineError":null,"expectedLine":{"service":"commercial_pest","manual":true},"tier":"bronze","autoPricedLines":0,"manualQuoteLines":1,"lines":[{"service":"commercial_pest","annual":null,"price":null,"perApp":null,"visits":null,"manualQuote":true,"taxable":true,"taxCategory":"nonresidential_pest_control","margin":null,"review":true}]}
- [commercial] commercial rodent bait: {"engineError":null,"expectedLine":{"service":"commercial_rodent_bait","manual":false},"tier":"bronze","autoPricedLines":2,"manualQuoteLines":0,"lines":[{"service":"commercial_rodent_bait","annual":476,"price":null,"perApp":119,"visits":4,"manualQuote":false,"taxable":true,"taxCategory":"nonresidential_pest_control","margin":null,"review":false},{"service":"rodent_bait_setup","annual":null,"price":99,"perApp":null,"visits":null,"manualQuote":false,"taxable":null,"taxCategory":null,"margin":null,"review":null}]}
- [commercial] commercial termite bait: {"engineError":null,"expectedLine":{"service":"commercial_termite_bait","manual":false},"tier":"bronze","autoPricedLines":1,"manualQuoteLines":0,"lines":[{"service":"commercial_termite_bait","annual":813.27,"price":null,"perApp":203.32,"visits":4,"manualQuote":false,"taxable":true,"taxCategory":"nonresidential_pest_control","margin":0.45,"review":false}]}
- [commercial] commercial tree & shrub: {"engineError":null,"expectedLine":{"service":"commercial_tree_shrub","manual":false},"tier":"bronze","autoPricedLines":1,"manualQuoteLines":0,"lines":[{"service":"commercial_tree_shrub","annual":2670.91,"price":null,"perApp":445.15,"visits":6,"manualQuote":false,"taxable":false,"taxCategory":"lawn_spraying_or_treatment","margin":0.45,"review":false}]}
