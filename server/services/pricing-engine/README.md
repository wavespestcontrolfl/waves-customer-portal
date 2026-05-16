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

**Zone multipliers** (applied after all service pricing):

| Zone | Area | Multiplier |
|---|---|---|
| A | Manatee/Sarasota core | 1.00 |
| B | Extended service area | 1.05 |
| C | Charlotte outskirts | 1.12 |
| D | Far reach | 1.20 |
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
| Tree & Shrub | ✅ standard/enhanced | — | ✅ |
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

**Annual prepay:** acceptance/conversion invoices annual prepay as `estimate.monthly_total × 12`, rounded to cents. This intentionally preserves the selected frequency, zone multiplier, WaveGuard bundle discount, and any recurring price adjustments already reflected in the accepted quote; it is not `basePrice × 4`.

**Production diagnostics:** pest results include `productionDiagnostics` with estimated minutes, minute breakdown, `pricingConfidence` (`high`/`medium`/`low`), and `reviewReasons`. This is shadow-only and does not drive price until calibrated against Bouncie/on-site actuals.

**Frequency discounts (v1 — currently live):** quarterly 1.00, bimonthly 0.85, monthly 0.70
**v2 (experimental):** quarterly 1.00, bimonthly 0.88, monthly 0.78

---

## 4. Lawn Care

**Formula:** bracket lookup by `(track, tier, sqft)` → linear interpolation between rows.

**Tiers:** basic 4x/yr · standard 6x · enhanced 9x · premium 12x

**Tracks:** `st_augustine` · `bermuda` · `zoysia` · `bahia` (bracket tables in `constants.js:LAWN_BRACKETS`)

**St. Augustine shade handling:**
- FULL_SUN: 0.75 lb N/1K, 3 N-apps, PGR + SpeedZone
- MODERATE_SHADE: 0.625 lb N, 2 N-apps, Pillar
- HEAVY_SHADE: 0.50 lb N, 2 N-apps, Pillar

---

## 5. Tree & Shrub

**Formula:** `annualDirectCost = materialCost + laborAnnual`, then `annualPrice = annualDirectCost / 0.43`.

Tree & Shrub uses a 43% direct-cost ratio target, not a 43% margin target. This usually produces roughly 50%+ service-level margin after admin before final discounts.

| Tier | Freq | Material rate | Floor |
|---|---|---|---|
| Standard | 6x | $0.110/sqft | $50 |
| Enhanced | 9x | $0.190/sqft | $65 |

Premium 12-visit Tree & Shrub pricing is removed from active/customer-facing tiers. Legacy `tier: "premium"` requests are normalized to Enhanced with a warning.

**Enhanced positioning:** six core seasonal applications plus three monitoring/targeted-treatment visits.

**Access minutes:** easy 0, moderate 8, difficult 15.

**Bed area confidence:**
- `explicit` → high confidence, auto-price.
- `estimated` → medium confidence, generated from estimate fields or `lotSqFt × basePct + complexAdd` (heavy 25%, moderate 18%, light 10%).
- `fallback` → low confidence, uses 2,000 sqft and requires manual review.

Estimated bed area is capped at 8,000 sqft. Manual review is required for fallback bed area, bed area at/above the cap, tree count 15+, or difficult access with bed area 4,000 sqft+.

**Recommendation logic:** Standard is the core/default plan. Enhanced is recommended for bed area 2,000 sqft+, heavy shrub density, moderate/complex landscaping, tree count 8+, difficult access, or known pest/disease pressure.

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

**WaveGuard:** NOT a tier qualifier. Excluded from % discounts. $50 one-time setup credit for members.

---

## 10. One-Time Services

Standalone prices (customer not on WaveGuard). Applied via `pricePestControlOneTime` / `priceLawnOneTime` / `priceMosquitoOneTime` in `service-pricing.js`.

**Pest one-time:** `max($199, recurringPrice × 1.75)` — recurring price computed at quarterly cadence as anchor. Urgency applies. Active recurring customers get the flat 15% one-time perk, with the $199 floor re-applied.

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

## 11. WaveGuard Tiers

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
- `rodent_bait` — $50 setup credit
- `palm_injection` — $10/palm/year credit (Gold+ only), applied after billable annual pricing and capped at net $0
- `bed_bug_chemical`, `bed_bug_heat` — $50 flat member credit
- `bora_care`, `pre_slab_termidor` — fully excluded, no discount
- `german_roach_initial` — excluded to avoid double-dip with baked urgency/rc

**Recurring customer perk on one-time services:** flat 15% off. Does NOT stack with tier discount (recurring lines get tier; one-time lines get this perk; no line sees both). Bora-Care and pre-slab Termidor excluded from this perk too.

---

## 12. Specialty Services (summary)

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
| Bed bug chemical | 65% | $400 base + $250/extra room | $50.42/room material |
| Bed bug heat | — | $1000/$850/$750 by room count | + $150 in-house base |
| Flea initial | — | floor $185 (base $225) | follow-up floor $95 |
| Wasp | — | tiered $150/$250/$435/$775 | free with recurring pest |
| Exclusion | — | $150 | simple/moderate/advanced per-point ($37.50/$75/$150); inspection $85 |
| WDO inspection | — | — | ≤2500 $175 · ≤3500 $200 · >3500 $225 |

---

## 13. Payment Adjustments

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
- ONE_TIME 1.30x multiplier + floor rationale
- TREE_SHRUB 43% target vs 35% global floor
