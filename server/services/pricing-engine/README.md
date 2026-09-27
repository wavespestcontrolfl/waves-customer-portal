# Pricing Engine — Logic Inventory

Single source of truth for what this engine prices, how, and with what constants. All values are pulled from `constants.js` unless noted. Update this file when constants shift.

**Engine entrypoint:** `generateEstimate(input)` in `estimate-engine.js` → orchestrates per-service pricing in `service-pricing.js` → applies discounts via `discount-engine.js`.

**Public callers:**
- `server/routes/public-quote.js` — wavespestcontrol.com estimate and quote forms
- `client/src/pages/admin/EstimatePage.jsx` — admin estimate tool (full coverage)

---

## 1. Global Constants

| Constant | Value | Purpose |
|---|---|---|
| `LABOR_RATE` | $35.00/hr | Loaded wages + benefits + WC + vehicle + insurance |
| `DRIVE_TIME` | 20 min | Per-visit drive allowance baked into labor cost |
| `ADMIN_ANNUAL` | $51 | Per-service/yr admin overhead (billing, scheduling, CRM) |
| `MARGIN_FLOOR` | 35% | Margin REPORTING threshold for recurring lines (enforcement removed 2026-07-17 — owner ruling "forget all floors") |
| `MARGIN_TARGET_TS` | 45% | Tree & Shrub admin-inclusive margin target; `(annualDirectCost + ADMIN_ANNUAL) / (1 − target)` |
| `CONDITIONAL_CEILING` | $60 | Max conditional material/yr before reprice |
| `PROCESSING_ADJUSTMENT` | 1.00 | Retained no-op wrapper; checkout uses `computeChargeAmount` to add 2.90% only for confirmed credit funding |

**Service zones** (routing/metadata only; no pricing effect):

| Zone | Area | Pricing multiplier |
|---|---|---|
| A | Manatee/Sarasota core | 1.00 |
| B | Extended service area | 1.00 |
| C | Charlotte outskirts | 1.00 |
| D | Far reach | 1.00 |
| UNKNOWN | default | 1.00 |

**Urgency multipliers** (Routine is no-op):

| Urgency | Standard Hours | After Hours |
|---|---|---|
| SOON | 1.25 | 1.50 |
| URGENT | 1.50 | 2.00 |

**Property-type per-visit adjustments:** single_family $0, townhome_end −$8, townhome_interior −$12, duplex −$10, condo_ground −$18, condo_upper −$22.

---

## 2. Services Priced

| Service | Recurring? | One-Time? | Tier qualifier (WG)? |
|---|---|---|---|
| Pest Control | ✅ quarterly / bimonthly / monthly | ✅ | ✅ |
| Lawn Care | ✅ enhanced 9x / premium 12x (standard 6x is a hidden internal anchor; basic 4x retired) | ✅ per-treatment | ✅ |
| Tree & Shrub | ✅ standard/enhanced (light retired 2026-09-24) | — | ✅ |
| Palm Injection | ✅ (see the six-type treatment table in §6) | — | ❌ flat credit only |
| Mosquito | ✅ Seasonal/Monthly | ✅ treatable area | ✅ |
| Termite Bait | ✅ quarterly monitoring billed per application | install only | ✅ |
| Rodent | ✅ quarterly bait program + one-time trapping | — | ✅ bait program; trapping is separate |
| WDO Inspection | — | ✅ ($250 flat code default) | — |
| Specialty (plugging, top-dressing, dethatching, trenching, BoraCare, pre-slab Termidor, foam-drill, German roach, bed bug, flea, wasp, exclusion) | varies | mostly one-time | varies |

---

## 3. Pest Control

**Formula:** `max(floor, base + footprintAdj + additionalAdj + propAdj + ageAdj) × freqMult`

- `base` $112 (the $117 v4.3 anchor minus the light-tree-density $5 fold, owner ruling 2026-08-03), `floor` $89
- `initialFee` $99 WaveGuard setup/membership fee. Estimate acceptance waives it when the customer selects annual prepay.

**Footprint anchors (linear interpolation; code defaults):** 800 −$15 · 1200 −$10 · 1500 −$5 · 1750 −$5 · 2000 $0 · 2500 +$3 · 3000 +$6 · 4000 +$10 · 5500 +$16

**Additional adjustments:** indoor +$15 · shrubs light −$5 / moderate $0 / heavy +$6 · pool no-cage $0 · pool cage small +$5 / medium +$8 / large +$12 / oversized +$18 · complexity simple −$5 / complex +$3 · nearWater +$3 · attached garage +$5

Tree density is excluded from pest control entirely: prices since 2026-07-16, and the production-diagnostics minutes model plus the heavy-vegetation review flag since 2026-07-30 (owner directive — shrubs alone trigger `complex_heavy_vegetation` now). The observation remains property context and still feeds non-pest models (lawn complexity score, tree & shrub count fallback, and mosquito pressure). Large driveway is retired from the estimator entirely (owner directive 2026-07-30): it no longer affects any engine output — hardscape/turf estimation, complexity score, termite trenching, lawn cost-floor minutes, or production diagnostics — and survives only as property context outside the estimator (satellite/property-lookup detection).

**Roach handling:** recurring roach multiplier is retired (`german`, `regular`, and `none` are all 0%). Recurring pest with regular/German roach auto-adds a fixed, non-waivable, non-discounted first-visit cockroach line item (`pest_initial_roach`). The customer-facing name and the number of treatment visits it covers are admin-editable via `pest_base.initial_roach.display` (code defaults: "Cockroach Treatment Service" / "German Cockroach Treatment", 1 visit); the treatment count is display metadata and never multiplies the price. Recurring native roach is $119/$139/$169 by footprint; recurring German is $169/$199/$249. Standalone regular roach uses the higher native-roach scale: $202.50 under 1,500 sf, $239 from 1,500-2,500 sf, and $289 over 2,500 sf.

**Lot size:** recurring pest price currently has no lot-size dollar adder. Lot size feeds `productionDiagnostics.breakdown.lot` only, so it is visible for calibration/manual review but does not change `basePrice`, `perApp`, annual, or monthly price until the production-minute model is explicitly cut over.

**Annual prepay:** acceptance/conversion invoices annual prepay as `estimate.monthly_total × 12`, rounded to cents. This intentionally preserves the selected frequency, WaveGuard bundle discount, and any recurring price adjustments already reflected in the accepted quote; it is not `basePrice × 4`.

**Production diagnostics:** pest results include `productionDiagnostics` with estimated minutes, minute breakdown, `pricingConfidence` (`high`/`medium`/`low`), and `reviewReasons`. This is shadow-only and does not drive price until calibrated against Bouncie/on-site actuals.

**Frequency discounts (v2 — current code default):** quarterly 1.00, bimonthly 0.88, monthly 0.78
**v1 (historical explicit-version replay only):** quarterly 1.00, bimonthly 0.85, monthly 0.70

**Margin report (post-discount):** since the 2026-07-17 owner ruling ("forget all floors") the guard is REPORT-ONLY by default for Tree & Shrub and recurring pest. Discounts apply exactly as configured; the line reports displayed margin `(annual − costs.annualCost) / annual` as `finalMargin` plus `belowMarginFloor` / `belowProgramFloor` flags for the owner/estimator to judge — the signals compute UNCONDITIONALLY (the pest floor reference `programFloorAnnual` is always emitted), and the admin estimator renders them in its Pricing Review Notes panel. **Manual** owner discounts emit warn-only entries in `summary.marginWarnings` (`manual_discount_below_margin_floor`, `manual_discount_below_pest_program_floor`) and set `manualMarginWarning`/`manualFinalMargin` on the line — also unconditional, never capped. The pest post-discount program floor is DISARMED by default (`PEST.enforceFloorPostDiscount` false via migration 20260717120000); re-arming the DB flag (`pricing_config` `pest_base.enforce_floor_post_discount=true`) restores FULL enforcement end to end: `applyMarginGuard` lifts the saved WaveGuard-discounted pest total to the cadence floor, `service-pricing` stamps `programFloor*` tier metadata, and `estimate-public` clamps the public view/accept reprice to the same floor — save and accept always agree. The margin floor itself has no re-arm key and stays report-only.

---

## 4. Lawn Care

**Formula:** bracket lookup by `(track, tier, sqft)` → linear interpolation between rows.

**Source columns:** standard 6x · enhanced 9x · premium 12x. Each code-default
track has 20 size rows. Basic 4x is retired. Standard 6x is retained as a
hidden internal anchor; new residential offers expose Enhanced 9x and Premium
12x by default. See `constants.js:LAWN_BRACKETS` for tunable code defaults.

**Tracks:** `st_augustine` · `bermuda` · `zoysia` · `bahia` (bracket tables in `constants.js:LAWN_BRACKETS`)

**St. Augustine shade handling (PROTOCOL ONLY — not a pricing input):** sun/shade
affects the agronomic protocol (nitrogen rate / product selection) but NOT price —
every lawn prices on its track's full-sun material budget. Do not re-wire shade
into `priceLawnCare`.
- FULL_SUN: 0.75 lb N/1K, 3 N-apps, PGR + SpeedZone
- MODERATE_SHADE: 0.625 lb N, 2 N-apps, Pillar
- HEAVY_SHADE: 0.50 lb N, 2 N-apps, Pillar

---

## 5. Tree & Shrub

**Formula:** `annualDirectCost = materialCost + laborAnnual`, then
`annualPrice = (annualDirectCost + ADMIN_ANNUAL) / (1 − marginTarget)`, subject
to the tier's existing monthly list-price floor.

The code-default `marginTarget` is 45%, measured after the annual admin
allocation and before final discounts. Database pricing config can tune it.

| Tier (sold) | Freq | Floor (monthly, pre-discount) |
|---|---|---|
| Standard (default) | 6x | $35 |
| Enhanced (upsell) | 9x | $48 |

Material is a bottom-up model (`TREE_SHRUB.materialModel` in `constants.js`), not a flat $/sqft rate. Light (4x, $22 floor) remains in `constants.js` only to replay the grandfathered quarterly plan — it is not a sales tier.

The 6-visit Standard program is the mandated default and the pre-selected/auto-recommended tier (matches the protocol `six_x` cadence). Light (4x/Quarterly, protocol `four_x`) is RETIRED for new sales (owner directive 2026-09-24: "remove quarterly tree and shrub care from the estimates and services") — `TREE_SHRUB.tiers.light.hidden` drops it from every offering surface, mirroring lawn's 6x/bi-monthly retirement; it stays priceable only for the one grandfathered existing quarterly customer's plan. `tier: "premium"` (12x) is likewise retired and normalizes to Standard with a warning. Enhanced (9x) is a live, customer-selectable upsell (un-retired 2026-07-23), never auto-recommended.

**Standard positioning:** six core seasonal applications across the year.

**Access minutes:** easy 0, moderate 8, difficult 15.

**Bed area confidence:**
- `explicit` → high confidence, auto-price.
- `estimated` → medium confidence, generated from estimate fields or `lotSqFt × basePct + complexAdd` (heavy 25%, moderate 18%, light 10%).
- `fallback` → low confidence, uses 2,000 sqft and requires manual review.

Estimated bed area is priced in full. Manual review is required for fallback
bed area, bed area at or above 8,000 sqft, tree count 15+, or difficult access
with bed area 4,000 sqft+; the 8,000-sqft threshold does not clamp priced area.

**Recommendation logic:** The 6-visit Standard plan is the mandated default and is always the recommended tier. Light (4x) is RETIRED for new sales (owner directive 2026-09-24) — legacy/grandfathered-only, priceable but never offered or auto-recommended to a new customer. `recommendationReasons` (bed area 2,000 sqft+, heavy shrub density, moderate/complex landscaping, tree count 8+, difficult access, known pest/disease pressure) are advisory signals that the property warrants the full 6-visit program (originally: reasons not to downsell to the now-retired Light tier); they no longer change the recommended tier.

**Post-discount report:** after zone modifiers and WaveGuard discounts, Tree & Shrub reports true margin after direct cost and admin (`finalAnnual`, `finalMonthly`, `requestedDiscountPct`, `actualDiscountPct`, `finalMargin`, `belowMarginFloor`) — since the 2026-07-17 owner ruling nothing caps the discount; margins below 35% are surfaced for the owner to raise in the estimator.

---

## 6. Palm Injection

Palm injection pricing requires explicit `treatmentType` and positive integer `palmCount`; the service no longer silently defaults to combo or one palm.

**Minimum per visit:** $75. The visit minimum is billable and is reflected in annual/monthly pricing (`annual = max(rawPerVisit, 75) x appsPerYear`). Palm services are not WaveGuard tier qualifiers and are excluded from percentage discounts. Gold+ members get a capped $10/palm/year flat credit after gross annual pricing is calculated.

| Treatment | Pricing |
|---|---|
| Palm Nutrition Injection | $35/palm, default 1x/year; optional 2x/year for corrective protocol |
| Preventive Palm Insecticide | small $45, medium $55, large $75; default 2x/year; high-dose/large-diameter/nonstandard product is quote-based |
| Nutrition + Insecticide | small $65, medium $75, large $95; default 2x/year; high-dose/large-diameter/nonstandard product is quote-based |
| Palm Fungal Treatment | quote-based; requires confirmed diagnosis, selected product (`PHOSPHO-Jet` or `Propizol`), and apps/year or interval |
| Lethal Bronzing Preventive OTC Program | quote-based; floor $125/palm/application; every 3 months, 4 apps/year; 24-month minimum preventive program |
| Tree-Age G-4 Specialty Injection | quote-based/tiered; DBH <=10 $65, <=15 $85, <=20 $110, >20 custom quote; 24-month interval with annualized annual/monthly values |

**Methodology:** Palm rates combine operator baseline, supplied material-cost review, visit minimum economics, and product/protocol constraints. Internal material prices are stored for audit only and are not customer-facing.

---

## 7. Mosquito

**Area basis:** `mosquitoTreatableSqFt = lotSqFt - footprint - hardscape`. This is separate from lawn square footage because mosquito treatment includes beds, shrubs, fence lines, trees, shaded areas, and outdoor living edges. The bucket guardrail prevents moving more than one category below the gross-lot bucket until revenue impact is backtested.

**Formula:** interpolate the selected program's area anchors in 500-sqft
steps, then apply the pressure multiplier (capped at 2.0x). The values below
are code defaults; live database pricing can override them.

**Code-default source category prices:** these values build the interpolation
anchors; they are not flat prices across area buckets. Finite categories
anchor at their top edge. The terminal ACRE anchor location is derived by
`mosquitoRecurringAnchors` to preserve a non-steepening slope.

| Source category | seasonal9 | monthly12 |
|---|---|---|
| SMALL | $77 | $69 |
| QUARTER | $80 | $72 |
| THIRD | $83 | $77 |
| HALF | $90 | $81 |
| ACRE | $102 | $90 |

**Visits/yr:** seasonal9 = 9 · monthly12 = 12

**Pressure factors (add % to base):** trees heavy +15%, trees moderate +5%, complexity complex +10%, complexity moderate +5%, pool +5%, nearWater +10%, irrigation +8%, lot acre +15%, lot half +5%.

---

## 8. Termite Bait

**Install formula:** `stationCount × (stationCost + laborMaterial + misc) × installMultiplier` (code-default 1.45x) × `perimeterMultiplier`

- Standard perimeter 1.25, complex 1.35
- Station spacing: Trelona 15 ft; legacy Advance replay compatibility 10 ft; min 8 stations
- **Advance compatibility default:** $13.16/station, $5.25 labor/material, $0.75 misc
- **Trelona config fallback:** $24/station, same labor/misc. Fresh quotes may use an approved catalog-linked cost, and saved estimates may replay a stamped pricing snapshot.

**Quarterly monitoring:** the legacy Basic/Premier price distinction is
retired. The code-default monthly equivalent is
`$19 + $5 × max(0, ceil(stations / 5) − 2)` (≤10 stations $19; 11–15 $24;
16–20 $29; 21–25 $34; and so on). The customer-facing amount is displayed
and billed per quarterly application: monthly equivalent × 12 ÷ 4.

The gated annual protection plan is a distinct model. See
[`docs/TERMITE-PRICING.md`](../../../docs/TERMITE-PRICING.md); do not infer
that its gate is enabled from the presence of engine support.

---

## 9. Rodent

**Bait program (code defaults):** footprint brackets price each quarterly
application and include the listed station allowance.

| Footprint up to | Stations | Per application |
|---:|---:|---:|
| 1,750 sqft | 4 | $79 |
| 2,750 sqft | 5 | $89 |
| 3,750 sqft | 6 | $99 |
| 4,750 sqft | 7 | $109 |
| 5,750 sqft | 8 | $119 |
| 6,750 sqft | 9 | $129 |

Above 6,750 sqft the ladder extends by one station and $10 per application
for each additional 1,000 sqft. Annual/12 is reporting only. A standalone
rodent-bait customer pays the code-default $99 one-time setup; it is waived
when another qualifying recurring service supplies WaveGuard membership.

**Trapping:** flat $350 Standard plan covering the setup visit plus 1 trap
check for the same active trapping job (owner ruling 2026-09-26). Visit 3+ is
not priced on the estimate: the office books the `rodent_trap_check_additional`
catalog row ($95, billed at completion, members included, never
bundle-discounted). Jobs sold before 2026-09-27 keep unlimited included checks.
An emergency request adds the greater of 20% or $75.
The active pricer does not apply the legacy footprint/lot adjustment arrays.

**WaveGuard:** `rodent_bait` is a tier qualifier and is eligible for the
recurring tier percentage. The separate `rodent_guarantee` and
`rodent_bait_setup` keys remain excluded from percentage discounts.

---

## 10. One-Time Services

Standalone prices are applied via `priceOneTimePest` / `priceOneTimeLawn` /
`priceOneTimeMosquito` in `service-pricing.js`.

**Pest one-time:** `max($199, quarterlyPerApp × 2.2 multiplier)` — a straight multiple of the **quarterly** per-app rate (== pest line `basePrice`), never a discounted monthly/bimonthly per-app. Anchoring on the quarterly rate is the point: that rate already includes footprint and the current explicit pest adjustments described in §3, so one-time scales proportionally with real job difficulty — no separate sq-ft curve, no flat add-on. Lot size, tree density, and driveway do not add to the active pest price. The multiple keeps a one-off visit strictly **above** what a recurring customer pays on visit 1 ($99 setup + quarterly rate), preserving the incentive to commit. Urgency applies. Active recurring customers get the flat 15% one-time perk, with the $199 floor re-applied. Constants: `ONE_TIME.pest.{multiplier: 2.2, floor: $199}` (admin-editable via `onetime_pest` config keys `multiplier` / `floor`). `multiplier` is validated **`>= 2`** — combined with the $199 floor and the $89 pest quarterly floor, that guarantees one-time exceeds recurring visit-1 for every property; a lower value is rejected on sync.

**Lawn one-time (per treatment):**

| Treatment | Multiplier | Floor |
|---|---|---|
| Fertilization | 1.00 | $115 |
| Weed | 1.12 | $115 |
| Pest | 1.30 | $115 |
| Fungicide | 1.38 | $115 |

Then × 1.50 standalone multiplier on top of recurring per-app rate. Urgency applies. Active recurring customers get the flat 15% one-time perk, with the $115 floor re-applied.

**Mosquito one-time:** based on mosquito treatable area, not gross lot. The
code-default anchor prices are SMALL at 7,500 sqft $156 · STANDARD at 11,000
$177 · LARGE at 16,000 $198 · XL at 24,000 $219 · ESTATE at 32,000 $251 ·
ACRE_CLASS at 43,560 $282. Prices interpolate between anchors in 500-sqft
steps. OVER_ACRE starts at $282, adds $42 per additional 10,000-sqft increment,
and requires manual review. Add-ons remain stations × $75 and Bti dunks × $15.
Urgency and WaveGuard tier discounts do not apply; active recurring customers
receive the 15% one-time perk. Live database pricing can override these
defaults.

> **Public quote mapping:** `public-quote.js` maps supported website selections
> to recurring services and to one-time pest, lawn, mosquito, and specialty
> engine inputs. Cases marked quote-required or requiring unsupported/custom
> measurements still divert for human review; one-time frequency alone is not
> a recurring-only diversion rule.

---

## 11. Bed Bug Specialty

Bed bug pricing now lives in `server/services/pricing-engine/` as `priceBedBugTreatment(property, options)` and `constants.BED_BUG`. The old client `client/src/lib/estimateEngine.js` branch is deprecated and is not the source of truth.

Valid methods are `CHEMICAL`, `HEAT`, and `HYBRID`. Invalid values throw; `BOTH` is intentionally invalid. `HYBRID` must be explicitly selected and means heat plus targeted residual protection, not full heat plus a duplicate full chemical program.

Required inputs: positive integer `rooms`, `method`, `severity` (`light`, `moderate`, `heavy`, `severe`), `prepStatus` (`ready`, `partial`, `poor`, `refused`), and `occupancyType` (`singleFamily`, `apartment`, `hotel`, `studentHousing`). `stories` is optional but must be a positive integer if present. `footprint` is optional for chemical and room-only heat, but whole-home heat requires it.

Heat and hybrid require `equipment` (`INHOUSE` or `SUBCONTRACT`) and `heatScope` (`ROOMS_ONLY` or `WHOLE_HOME`). Subcontract heat requires positive `subcontractCost`.

Chemical is a 35% cost-ratio model: `price = directCost / 0.35`, which produces roughly 65% gross margin before modifiers. Light chemical infestations include 2 visits; moderate and heavy include 3 visits. Severe infestations require quote/inspection.

Modifiers apply after base price: footprint, severity, prep, occupancy, stories, then urgency. Prep refused requires quote/inspection. Poor prep adds a callback-risk warning.

Heat includes one treatment event plus post-inspection/monitoring. Protocol output includes target ambient temperature, required minimum temperature, hold time, sensor count, active monitoring, prep checklist, and heat-sensitive item plan. Heat has no residual effect.

Bed bug services are not eligible for the blanket recurring-customer one-time add-on discount. `recurringDiscountEligible` is false and `recurringDiscountApplied` is 0.

Product cost basis is internal-only and not customer-facing. PT Alpine WSG and Distance IGR metadata are stored for audit; product labels must be verified before adding specific products to customer-facing treatment plans. Distance IGR is disabled until internal label verification confirms valid indoor bed bug structural use.

Customer-facing notes: bed bug treatment requires customer preparation, follow-up monitoring is required, chemical treatment is part of an IPM program, heat has no residual effect, additional follow-up may be required if activity persists, and severe/cluttered/unprepared/multi-unit cases may require inspection and custom quote.

---

## 12. WaveGuard Tiers

Qualifies off count of **qualifying recurring services** bundled together:

| Tier | Min services | Discount |
|---|---|---|
| Bronze | 1 | 0% |
| Silver | 2 | 10% |
| Gold | 3 | 15% |
| Platinum | 4 | 20% |

**Qualifying services:** `lawn_care`, `pest_control`, `tree_shrub`, `mosquito`,
`termite_bait`, `rodent_bait`
**Non-qualifier (still priced but doesn't count):** `palm_injection`

**Excluded from % discount (flat credits instead):**
- `palm_injection` — $10/palm/year credit (Gold+ only), applied after billable annual pricing and capped at net $0
- `bed_bug`, `bed_bug_chemical`, `bed_bug_heat` — excluded from all blanket recurring-customer bed bug discounts; no flat credit
- `bora_care`, `pre_slab_termiticide`, `pre_slab_termidor` — fully excluded, no discount
- `german_roach_initial` — excluded to avoid double-dip with baked urgency/rc

**Recurring customer perk on one-time services:** flat 15% off. Does NOT stack with tier discount (recurring lines get tier; one-time lines get this perk; no line sees both). Bora-Care and pre-slab Termidor excluded from this perk too.

---

## 13. Specialty Services (summary)

Several cost-based specialty pricers use `price = cost / marginDivisor`; for
those pricers, a `marginDivisor` of 0.45 means a 55% target margin (margin is a
share of **price**, not markup over cost). Other services use fixed severity
tiers, bracket tables, or fixed floors as identified below.

| Service | Margin target | Floor | Notes |
|---|---|---|---|
| Plugging | 45% | $250 | 6in/9in/12in spacing rates; $1.111/plug |
| Top-dressing ⅛" | 60% | $250 | sand $4.09, delivery $2.62 |
| Top-dressing ¼" | 65% | $450 | sand $4.09, delivery $5.24 |
| Dethatching | 60% | $150 | material $2.10/1K |
| Trenching | — | $600 | dirt $10/LF, concrete $14/LF; renewal $325 |
| BoraCare | 55% | — | gal $91.98, coverage 275 sqft |
| Pre-slab Termidor | 55% | — | bottle $152.10, 1250 sqft; volume disc 10+ 15% / 5+ 10% |
| Foam-drill | 55% | none (default floor 0) | cost/margin formula; tiered by treatment points (5/10/15/20) |
| German roach cleanout (`german_roach`) | fixed tiers | $350/$450/$550 all-in | light/moderate/heavy include 2/3/4 visits; no setup or footprint factor |
| Bed bug chemical/IPM | 65% gross margin from 35% cost ratio | $400 base + $250/extra room | 2 visits light; 3 visits moderate/heavy; severe quote |
| Bed bug heat | — | $1000/$850/$750 by room count | requires equipment and heat scope; post-inspection included |
| Bed bug hybrid | — | heat base + $175 + $75/room residual add-on | explicit method only; not full heat + full chemical |
| Flea initial | — | floor $185 (base $225) | follow-up floor $95 |
| Wasp | — | tiered $150/$250/$435/$775 | free with recurring pest |
| Rodent exclusion V2 | fixed item/bracket model | $195 point-only; $295 with linear mesh | mesh points, bird boxes, and linear feet from `RODENT.exclusionV2`; $75 inspection subject to waiver rules |
| Legacy exclusion V1 | fixed item/bracket model | home-size minimums from $395 | $50/$95/$195 simple/moderate/advanced points from `SPECIALTY.exclusion`; $75 inspection subject to waiver rules |
| WDO inspection | fixed | $250 | flat code default for every footprint; database pricing may override defaults |

The recurring first-visit cockroach line uses the separate
`pest_initial_roach` scales in §3. The legacy explicit
`german_roach_initial` pricer starts at $100 before its urgency and
recurring-customer modifiers and represents a three-visit compatibility path;
it is not the active severity-tier cleanout above.

---

## 14. Payment Adjustments

**ACH discount:** retired (0%). Kept as a constant for legacy-caller safety.
**Card surcharge:** `computeChargeAmount` adds 2.90% only when card funding is
positively confirmed as credit. ACH, debit, prepaid, and unknown funding pay
the quoted base amount with no surcharge.

---

## TODOs in the engine (for v4.4 documentation)

`constants.js` flags several policy values as deserving written rationale:
- MARGIN_FLOOR 35% threshold justification
- URGENCY multiplier values (why 1.25/1.50/2.00)
- PEST base/floor anchor (market analysis vs historical)
- ONE_TIME pest multiplier (2.2× off quarterly) + floor rationale
