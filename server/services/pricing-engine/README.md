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
| `MARGIN_TARGET_TS` | 43% | Tree & Shrub conservative target |
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
| Tree & Shrub | ✅ standard/enhanced/premium | — | ✅ |
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
- `initialFee` $99 (marked "waived with annual prepay" — **copy-only; waiver not implemented in engine**)

**Footprint brackets (linear interp):** 800 −$15 · 1200 −$10 · 1500 −$5 · 2000 $0 · 2500 +$3 · 3000 +$6 · 4000 +$10 · 5500 +$16

**Additional adjustments:** indoor +$15 · shrubs light −$5 / moderate $0 / heavy +$6 · pool no-cage $0 · pool cage small +$5 / medium +$8 / large +$12 / oversized +$18 · trees light −$5 / moderate $0 / heavy +$6 · complexity simple −$5 / complex +$3 · nearWater +$3 · largeDriveway +$3 · attached garage +$5

**Roach handling:** recurring roach multiplier is retired (`german`, `regular`, and `none` are all 0%). Recurring pest with regular/German roach auto-adds a one-time Initial Roach Knockdown line item. Standalone regular roach uses the higher native-roach knockdown scale: $202.50 under 1,500 sf, $239 from 1,500-2,500 sf, and $289 over 2,500 sf.

**Lot size:** recurring pest price currently has no lot-size dollar adder. Lot size feeds `productionDiagnostics.breakdown.lot` only, so it is visible for calibration/manual review but does not change `basePrice`, `perApp`, annual, or monthly price until the production-minute model is explicitly cut over.

**Annual prepay:** acceptance/conversion invoices annual prepay as `estimate.monthly_total × 12`, rounded to cents. This intentionally preserves the selected frequency, zone multiplier, WaveGuard bundle discount, and any recurring price adjustments already reflected in the accepted quote; it is not `basePrice × 4`.

**Production diagnostics:** pest results include `productionDiagnostics` with estimated minutes and a minute breakdown. This is shadow-only and does not drive price until calibrated against Bouncie/on-site actuals.

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

**Formula:** `max(floor, bedArea × materialRate) + labor + access`, targeting 43% margin.

| Tier | Freq | Material rate | Floor |
|---|---|---|---|
| Standard | 6x | $0.110/sqft | $50 |
| Enhanced (recommended) | 9x | $0.190/sqft | $65 |
| Premium | 12x | $0.220/sqft | $80 |

**Access minutes:** easy 0, moderate 8, difficult 15.

**Bed area estimate:** `lotSqFt × basePct + complexAdd` — heavy 25%, moderate 18%, light 10%. Capped at 8000 sqft.

---

## 6. Palm Injection

| Treatment | $/palm | Apps/yr |
|---|---|---|
| Nutrition | $35 | 2 |
| Preventive Insecticide | $45 | 2 |
| Combo | $55 | 2 |
| Fungal | $40 | 2 |
| Lethal Bronzing | quote (floor $125) | 2 |
| Tree-Age Specialty | quote (floor $65) | 1 |

**Minimum per visit:** $75. Not a WaveGuard tier qualifier. Gold+ members get $10/palm/yr flat credit.

---

## 7. Mosquito

**Area basis:** `mosquitoTreatableSqFt = lotSqFt - footprint - hardscape`. This is separate from lawn square footage because mosquito treatment includes beds, shrubs, fence lines, trees, shaded areas, and outdoor living edges. The bucket guardrail prevents moving more than one category below the gross-lot bucket until revenue impact is backtested.

**Formula:** `basePrices[mosquitoLotCategory][programIndex] × pressureMultiplier`, pressure capped at 2.0x.

**Base prices by treatable area × program:**

| Treatable bucket | Seasonal | Monthly |
|---|---|---|
| SMALL (<8k sf) | $90 | $90 |
| QUARTER (8k-12k sf) | $100 | $100 |
| THIRD (12k-18k sf) | $110 | $110 |
| HALF (18k-35k sf) | $125 | $125 |
| ACRE (35k+ sf) | $155 | $155 |

**Visits/yr:** seasonal 9 · monthly 12

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

**Pest one-time:** `max($150, recurringPrice × 1.30)` — recurring price computed at quarterly cadence as anchor.

**Lawn one-time (per treatment):**

| Treatment | Multiplier | Floor |
|---|---|---|
| Fertilization | 1.00 | $85 |
| Weed | 1.15 | $85 |
| Pest | 1.30 | $85 |
| Fungicide | 1.45 | $95 |

Then × 1.30 standalone multiplier on top of recurring rate.

**Mosquito one-time (flat by lot):** SMALL $200 · QUARTER $250 · THIRD $275 · HALF $300 · ACRE $350

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
- `palm_injection` — $10/palm/yr credit (Gold+ only)
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
- PALM per-palm pricing methodology
- TERMITE monitoring subscription pricing
- RODENT bait subscription pricing
- ONE_TIME 1.30x multiplier + floor rationale
- TREE_SHRUB 43% target vs 35% global floor
