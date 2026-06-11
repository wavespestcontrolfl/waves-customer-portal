# Pricing Engine — Logic Inventory

Single source of truth for what this engine prices, how, and with what constants. All values are pulled from `constants.js` unless noted. Update this file when constants shift.

**Engine entrypoint:** `generateEstimate(input)` in `estimate-engine.js` → orchestrates per-service pricing in `service-pricing.js` → applies discounts via `discount-engine.js`.

**Public callers:**
- `server/routes/public-quote.js` — homepage quote wizard (recurring only)
- `client/src/pages/admin/EstimatePage.jsx` — admin estimate tool (full coverage)
- `client/src/pages/QuotePage.jsx` — portal quote page (recurring only)

---

## 1. Global Constants

| Constant | Value | Purpose |
|---|---|---|
| `LABOR_RATE` | $35.00/hr | Loaded wages + benefits + WC + vehicle + insurance |
| `DRIVE_TIME` | 20 min | Per-visit drive allowance baked into labor cost |
| `ADMIN_ANNUAL` | $51 | Per-service/yr admin overhead (billing, scheduling, CRM) |
| `MARGIN_FLOOR` | 35% | Minimum contribution margin for recurring lines |
| `DIRECT_COST_RATIO_TARGET_TS` | 43% | Tree & Shrub direct-cost ratio target |
| `CONDITIONAL_CEILING` | $60 | Max conditional material/yr before reprice |
| `PROCESSING_ADJUSTMENT` | 1.00 | Card-fee multiplier (currently no-op; 3.99% added at checkout) |

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
| Lawn Care | ✅ basic/standard/enhanced/premium | ✅ per-treatment | ✅ |
| Tree & Shrub | ✅ light/standard | — | ✅ |
| Palm Injection | ✅ (4 treatment types) | — | ❌ flat credit only |
| Mosquito | ✅ Seasonal/Monthly | ✅ treatable area | ✅ |
| Termite Bait | ✅ monthly subscription | install only | ✅ |
| Rodent | ✅ bait subscription + trapping | — | ❌ excluded from % |
| WDO Inspection | — | ✅ (bracketed) | — |
| Specialty (plugging, top-dressing, dethatching, trenching, BoraCare, pre-slab Termidor, foam-drill, German roach, bed bug, flea, wasp, exclusion) | varies | mostly one-time | varies |

---

## 3. Pest Control

**Formula:** `max(floor, base + footprintAdj + additionalAdj + propAdj + ageAdj) × freqMult`

- `base` $117, `floor` $89
- `initialFee` $99 WaveGuard setup/membership fee. Estimate acceptance waives it when the customer selects annual prepay.

**Footprint brackets (linear interp):** 800 −$15 · 1200 −$10 · 1500 −$5 · 2000 $0 · 2500 +$3 · 3000 +$6 · 4000 +$10 · 5500 +$16

**Additional adjustments:** indoor +$15 · shrubs light −$5 / moderate $0 / heavy +$6 · pool no-cage $0 · pool cage small +$5 / medium +$8 / large +$12 / oversized +$18 · trees light −$5 / moderate $0 / heavy +$6 · complexity simple −$5 / complex +$3 · nearWater +$3 · largeDriveway +$3 · attached garage +$5

**Roach handling:** recurring roach multiplier is retired (`german`, `regular`, and `none` are all 0%). Recurring pest with regular/German roach auto-adds a fixed, non-waivable, non-discounted first-visit Initial Roach Knockdown line item. Recurring native roach is $119/$139/$169 by footprint; recurring German is $169/$199/$249. Standalone regular roach uses the higher native-roach knockdown scale: $202.50 under 1,500 sf, $239 from 1,500-2,500 sf, and $289 over 2,500 sf.

**Lot size:** recurring pest price currently has no lot-size dollar adder. Lot size feeds `productionDiagnostics.breakdown.lot` only, so it is visible for calibration/manual review but does not change `basePrice`, `perApp`, annual, or monthly price until the production-minute model is explicitly cut over.

**Annual prepay:** acceptance/conversion invoices annual prepay as `estimate.monthly_total × 12`, rounded to cents. This intentionally preserves the selected frequency, WaveGuard bundle discount, and any recurring price adjustments already reflected in the accepted quote; it is not `basePrice × 4`.

**Production diagnostics:** pest results include `productionDiagnostics` with estimated minutes, minute breakdown, `pricingConfidence` (`high`/`medium`/`low`), and `reviewReasons`. This is shadow-only and does not drive price until calibrated against Bouncie/on-site actuals.

**Frequency discounts (v1 — currently live):** quarterly 1.00, bimonthly 0.85, monthly 0.70
**v2 (experimental):** quarterly 1.00, bimonthly 0.88, monthly 0.78

**Margin guard (post-discount):** like Tree & Shrub, recurring pest now enforces the 35% margin floor against **auto** discounts. The WaveGuard tier discount is capped so displayed margin `(annual − costs.annualCost) / annual` never drops below the floor; capped lines return `marginGuardApplied`, `discountCapped`, `requestedDiscountPct`, `actualDiscountPct`, `finalMargin`, `minAnnualForMargin`. **Manual** owner discounts are NOT capped (loss-leader pricing is allowed) — instead they emit a warn-only entry in `summary.marginWarnings` (`type: manual_discount_below_margin_floor`) and set `manualMarginWarning`/`manualFinalMargin` on the line. At default constants the cap never binds (margins sit ~47–61% even at Platinum); it only engages if base is lowered or discounts deepened.

---

## 4. Lawn Care

**Formula:** bracket lookup by `(track, tier, sqft)` → linear interpolation between rows.

**Tiers:** basic 4x/yr · standard 6x · enhanced 9x · premium 12x

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

**Formula:** `annualDirectCost = materialCost + laborAnnual`, then `annualPrice = annualDirectCost / 0.43`.

Tree & Shrub uses a 43% direct-cost ratio target, not a 43% margin target. This usually produces roughly 50%+ service-level margin after admin before final discounts.

| Tier | Freq | Material rate | Floor |
|---|---|---|---|
| Light | 4x | $0.075/sqft | $40 |
| Standard | 6x | $0.110/sqft | $50 |

The 6-visit Standard program is the mandated default (matches the protocol `six_x` cadence) and the only auto-recommended tier. Light (4x, protocol `four_x`) is a manual downsell for clean / low-pest-history landscapes. The 9-visit Enhanced and 12-visit Premium tiers are retired; legacy `tier: "enhanced"` / `tier: "premium"` requests are normalized to Standard with a warning.

**Standard positioning:** six core seasonal applications across the year.

**Access minutes:** easy 0, moderate 8, difficult 15.

**Bed area confidence:**
- `explicit` → high confidence, auto-price.
- `estimated` → medium confidence, generated from estimate fields or `lotSqFt × basePct + complexAdd` (heavy 25%, moderate 18%, light 10%).
- `fallback` → low confidence, uses 2,000 sqft and requires manual review.

Estimated bed area is capped at 8,000 sqft. Manual review is required for fallback bed area, bed area at/above the cap, tree count 15+, or difficult access with bed area 4,000 sqft+.

**Recommendation logic:** The 6-visit Standard plan is the mandated default and is always the recommended tier. Light (4x) is never auto-recommended — it is offered only as an explicit downsell. `recommendationReasons` (bed area 2,000 sqft+, heavy shrub density, moderate/complex landscaping, tree count 8+, difficult access, known pest/disease pressure) are advisory signals that the property warrants the full 6-visit program (i.e. reasons not to downsell to Light); they no longer change the recommended tier.

**Post-discount guard:** after zone modifiers and WaveGuard discounts, Tree & Shrub final annual revenue is guarded so true margin after direct cost and admin cannot fall below the recurring 35% floor. If needed, the effective discount is capped and audit fields are returned (`finalAnnual`, `finalMonthly`, `requestedDiscountPct`, `actualDiscountPct`, `finalMargin`, `marginGuardApplied`, `discountCapped`).

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

**Formula:** `basePrices[mosquitoLotCategory][programIndex] × pressureMultiplier`, pressure capped at 2.0x.

**Base prices by treatable area × program:**

| Treatable bucket | seasonal9 | monthly12 |
|---|---|---|
| SMALL (<8k sf) | $105 | $90 |
| QUARTER (8k-12k sf) | $115 | $100 |
| THIRD (12k-18k sf) | $130 | $115 |
| HALF (18k-35k sf) | $155 | $135 |
| ACRE (35k+ sf) | $195 | $175 |

**Visits/yr:** seasonal9 = 9 · monthly12 = 12

**Pressure factors (add % to base):** trees heavy +15%, trees moderate +5%, complexity complex +10%, complexity moderate +5%, pool +5%, nearWater +10%, irrigation +8%, lot acre +15%, lot half +5%.

---

## 8. Termite Bait

**Install formula:** `stationCount × (stationCost + laborMaterial + misc) × installMultiplier` (1.75x) × `perimeterMultiplier`

- Standard perimeter 1.25, complex 1.35
- Station spacing 10 ft, min 8 stations
- **Advance:** $14 station, $5.25 labor/material, $0.75 misc
- **Trelona:** $24 station, same labor/misc

**Monitoring subscription:** Basic $35/mo, Premier $65/mo.

---

## 9. Rodent

**Bait score** = footprint ≥2500 (+2) / ≥1800 (+1), lot ≥20000 (+2) / ≥12000 (+1), nearWater (+1), trees_heavy (+1).

| Score | Plan | Monthly |
|---|---|---|
| ≤1 | Small | $75 |
| ≤2 | Medium | $89 |
| >2 | Large | $109 |

**Trapping:** base $350, floor $350, footprint and lot adjustments per bracket (see `constants.js:RODENT.trapping`).

**WaveGuard:** NOT a tier qualifier. Excluded from % discounts, setup credits, coupons, and tier benefits.

---

## 10. One-Time Services

Standalone prices (customer not on WaveGuard). Applied via `pricePestControlOneTime` / `priceLawnOneTime` / `priceMosquitoOneTime` in `service-pricing.js`.

**Pest one-time:** `max($199, quarterlyPerApp × 2.2 multiplier)` — a straight multiple of the **quarterly** per-app rate (== pest line `basePrice`), never a discounted monthly/bimonthly per-app. Anchoring on the quarterly rate is the point: that rate already encodes every property metric (footprint, lot, tree/shrub, pool/cage, driveway, complexity, type, age), so one-time scales proportionally with real job difficulty — no separate sq-ft curve, no flat add-on. The multiple keeps a one-off visit strictly **above** what a recurring customer pays on visit 1 ($99 setup + quarterly rate), preserving the incentive to commit. Urgency applies. Active recurring customers get the flat 15% one-time perk, with the $199 floor re-applied. Constants: `ONE_TIME.pest.{multiplier: 2.2, floor: $199}` (admin-editable via `onetime_pest` config keys `multiplier` / `floor`). `multiplier` is validated **`>= 2`** — combined with the $199 floor and the $89 pest quarterly floor, that guarantees one-time exceeds recurring visit-1 for every property; a lower value is rejected on sync.

**Lawn one-time (per treatment):**

| Treatment | Multiplier | Floor |
|---|---|---|
| Fertilization | 1.00 | $115 |
| Weed | 1.12 | $115 |
| Pest | 1.30 | $115 |
| Fungicide | 1.38 | $115 |

Then × 1.50 standalone multiplier on top of recurring per-app rate. Urgency applies. Active recurring customers get the flat 15% one-time perk, with the $115 floor re-applied.

**Mosquito one-time:** based on mosquito treatable area, not gross lot. SMALL 0-7,500 = $225 · STANDARD 7,501-11,000 = $275 · LARGE 11,001-16,000 = $325 · XL 16,001-24,000 = $385 · ESTATE 24,001-32,000 = $425 · ACRE_CLASS 32,001-43,560 = $475 · OVER_ACRE = $475 + $75 per additional 10,000 sq ft and manual review. Add-ons: stations × $75 and Bti dunks × $15. Urgency and WaveGuard tier discounts do not apply.

> **Note:** Public quote wizard (`public-quote.js`) is recurring-only. One-time and "not sure" frequencies divert to `/api/leads` (lead-webhook) for human triage — engine doesn't price them from the homepage form.

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

**Qualifying services:** `lawn_care`, `pest_control`, `tree_shrub`, `mosquito`, `termite_bait`
**Non-qualifiers (still priced but don't count):** palm_injection, rodent_bait

**Excluded from % discount (flat credits instead):**
- `rodent_bait` — no WaveGuard credit, coupon, setup credit, discount, or tier benefit
- `palm_injection` — $10/palm/year credit (Gold+ only), applied after billable annual pricing and capped at net $0
- `bed_bug`, `bed_bug_chemical`, `bed_bug_heat` — excluded from all blanket recurring-customer bed bug discounts; no flat credit
- `bora_care`, `pre_slab_termiticide`, `pre_slab_termidor` — fully excluded, no discount
- `german_roach_initial` — excluded to avoid double-dip with baked urgency/rc

**Recurring customer perk on one-time services:** flat 15% off. Does NOT stack with tier discount (recurring lines get tier; one-time lines get this perk; no line sees both). Bora-Care and pre-slab Termidor excluded from this perk too.

---

## 13. Specialty Services (summary)

All priced via margin-divisor formula: `price = cost / marginDivisor`. A `marginDivisor` of 0.45 = 55% target margin (margin is share of **price**, not markup over cost).

| Service | Margin target | Floor | Notes |
|---|---|---|---|
| Plugging | 45% | $250 | 6in/9in/12in spacing rates; $1.111/plug |
| Top-dressing ⅛" | 60% | $250 | sand $4.09, delivery $2.62 |
| Top-dressing ¼" | 65% | $450 | sand $4.09, delivery $5.24 |
| Dethatching | 60% | $150 | material $2.10/1K |
| Trenching | — | $600 | dirt $10/LF, concrete $14/LF; renewal $325 |
| BoraCare | 55% | — | gal $91.98, coverage 275 sqft |
| Pre-slab Termidor | 55% | — | bottle $152.10, 1250 sqft; volume disc 10+ 15% / 5+ 10% |
| Foam-drill | 55% | $250 | tiered by treatment points (5/10/15/20) |
| German roach (initial) | — | $400 (base $450) | $100 setup, footprint-bracketed |
| Bed bug chemical/IPM | 65% gross margin from 35% cost ratio | $400 base + $250/extra room | 2 visits light; 3 visits moderate/heavy; severe quote |
| Bed bug heat | — | $1000/$850/$750 by room count | requires equipment and heat scope; post-inspection included |
| Bed bug hybrid | — | heat base + $175 + $75/room residual add-on | explicit method only; not full heat + full chemical |
| Flea initial | — | floor $185 (base $225) | follow-up floor $95 |
| Wasp | — | tiered $150/$250/$435/$775 | free with recurring pest |
| Exclusion | — | $150 | simple/moderate/advanced per-point ($37.50/$75/$150); inspection $85 |
| WDO inspection | — | — | ≤2500 $175 · ≤3500 $200 · >3500 $225 |

---

## 14. Payment Adjustments

**ACH discount:** retired (0%). Kept as a constant for legacy-caller safety.
**Card surcharge:** 3.99% added at checkout, not baked into engine output.

---

## TODOs in the engine (for v4.4 documentation)

`constants.js` flags several policy values as deserving written rationale:
- MARGIN_FLOOR 35% threshold justification
- URGENCY multiplier values (why 1.25/1.50/2.00)
- PEST base/floor anchor (market analysis vs historical)
- TERMITE monitoring subscription pricing
- RODENT bait subscription pricing
- ONE_TIME pest multiplier (2.2× off quarterly) + floor rationale
- TREE_SHRUB 43% target vs 35% global floor
