# Estimator pricing audit — owner follow-up, 2026-09-02

Addendum to `docs/estimator-pricing-audit.md`. Adam's response to the audit: disregard the pest labor comparison (check-out often happens while driving, so recorded minutes are not on-site time); the low-confidence areas are **termite bait stations, recurring lawn, and tree & shrub**; the open definitional question is **what "palm count" and "bedding area" mean**; the termite quotes sent have not converted; both the lawn and T&S protocols need review or clarity; and one-time services may not carry the same multiplier off the recurring price across all areas.

Everything below is read-only analysis. No price, protocol or record was changed. Market figures are third-party published ranges, cited at the end.

---

## 0. Correction to the main report (labor actuals)

Owner clarification: the `check_out_time` on completed visits frequently includes drive time to the next stop, so the observed "on-site minutes" (pest median 44, lawn 44) are **not** on-site time. Consequences applied to the main report:

- LAB-001 (pest 25 vs 44 min) is withdrawn as a P1 and re-filed as **MON-004 (P2)**: the system cannot measure on-site time today because check-in/check-out is not a reliable on-site pair. `time_on_site_adjusted_minutes` exists for corrections but is rarely used (252 completed visits have some minutes; how many are adjusted is UNKNOWN — query: `count(*) filter (where time_on_site_adjusted_minutes is not null)`).
- LAB-002 keeps its P1 on the **modeled** basis only: the lawn 9x reference lists at 30.7% by the engine's own cost model, below the 35% floor. The observed-labor sentences ("7% at observed labor, negative from Silver") are now labelled unreliable.
- The economics table's "observed" columns are labelled "recorded, includes drive". The realized $/hour figures are also affected and should be read as upper bounds on labor time, lower bounds on $/hour.
- The clean fix is operational, not analytical: check out at the truck before driving, or mark the visit complete from the driveway and let `time_on_site_adjusted_minutes` carry a correction. Until then the labor model cannot be validated from production data.

---

## 1. What the production data says about the three low-confidence lines

Engine-lined estimates (rows that carry engine line items), all statuses, aggregate:

| Line | Estimates | Accepted | Expired | Live | Draft | Quote shape observed |
|---|---|---|---|---|---|---|
| Termite bait | 3 | 0 | 1 | 0 | 2 | install $610 (2 drafts, 15 stations), monitoring not stored on the older row, 0 rentals offered |
| Lawn care | 12 | 0 | 6 | 1 | 5 | all 9x St. Augustine; 4,280 sf avg; $68.50/app avg on the expired six ($617/yr); the live one 2,500 sf at $56/app |
| Tree & shrub | 5 | 0 | 2 | 1 | 2 | 4 of 5 priced on a **fallback or lot-based bed area** (2,000 sf fallback / 1,209 sf lot-based); tree count density-estimated on 3 of 5; palms present on 1 (4 palms); $41–$49/mo |
| Pest control (for contrast) | 48 | 6 | 16 | 9 | 17 | converts |

Sample sizes are too small to prove price is the reason these lines do not close. What the shapes do show: the termite quote leads with a $610 up-front install and never offered the $0-install rental; the T&S quotes were mostly priced on **guessed** bed areas and tree counts (the two inputs Adam is unsure how to define); the lawn quotes are at or below the published competitor range (below).

---

## 2. Termite bait stations

### 2.1 What a Waves quote is today (Trelona, 15-ft spacing, standard perimeter)

| Home sf | Perimeter LF | Stations | Install (own) | Hardware cost (stations only) | Monitoring $/mo | Billed per application | Year-1 own | Year-1 rent ($0 install + uplift) | 5-yr bond rider |
|---|---|---|---|---|---|---|---|---|---|
| 1,200 | 173 | 12 | $488 | $265 | $24 | $72 | $776 | $288 + $24.40/app uplift | $54/app |
| 1,600 | 200 | 14 | $569 | $309 | $24 | $72 | $857 | $288 + $28.45/app | $54/app |
| 2,000 | 224 | 15 | $610 | $331 | $24 | $72 | $898 | $288 + $30.50/app | $54/app |
| 2,500 | 250 | 17 | $691 | $375 | $29 | $87 | $1,039 | $348 + $34.55/app | $54/app |
| 3,000 | 274 | 19 | $773 | $419 | $29 | $87 | $1,121 | $348 + $38.65/app | $54/app |
| 4,000 | 316 | 22 | $895 | $485 | $34 | $102 | $1,303 | $408 + $44.75/app | $54/app |

Formula (verified by the audit calculator, 0 mismatches): install = round(stations × ($22.05 station + $5.25 labor/material + $0.75 misc) × 1.45); monitoring = $19/mo + $5 per 5-station bracket above 10, billed as monthly × 12 ÷ 4 per quarterly check; rental uplift = install ÷ 20 quarters, permanent.

> **Correction 2026-09-02 (owner supplier pricing):** the `$22.05` station cost is stale. The 16-count Trelona ATBS RFID box is now **$384.00 = $24.00/station** (pre-baited, per the constants comment). At $24.00 the 2,000 sf install above would be **$653**, not $610. The `$384/16` figure quoted as "cartridges" in the original draft of §2.3 was this station box; real cartridge pricing is in §7.

### 2.2 Market check (published Florida ranges, 2026)

- Bait station installation on a standard Florida home: **$800–$1,800**; Sentricon Always Active installs **$1,000–$1,800** (Florida) and **$1,500–$3,800** in broader 2026 guides.
- Annual monitoring: **$200–$350** typical, **$250–$450** for quarterly inspection with bait refresh; some markets carry a **$400–$550** annual bond.
- Local reference already in the code comments (`constants.js:1003-1007`): a competitor installing **21 Sentricon stations for $375** (2026-04 review), which is why the multiplier was cut from 1.75× to 1.45×.
- **The one real local benchmark Adam has (2026-09-02):** an existing Waves customer rents Sentricon from Massey on an **annual** check. Massey's renewal notice (2026-08-26): **$225/yr** subterranean coverage; **$275/yr** to cover subterranean and drywood; **$400** one-time preventative drywood spray. The customer asked Waves to match on 08-25 and chased on 08-27 (contract expired). This is a renewal on stations already in the ground, so Massey has no install to recover.

Reading (revised 2026-09-02 with the Massey benchmark): Waves is below the *published* Florida ranges but **above the one real local number**. A 2,000 sf home pays Waves $610 install + $288/yr on quarterly checks ($898 year one, $410/yr on the rental option); Massey renews the same customer at **$225/yr all-in with one annual check**. The gap is not the price level of any single line, it is **cadence and install recovery**: Trelona ATBS is labelled as an annual-inspection system, yet Waves only sells and bills it quarterly, and the rental option (the only $0-install shape) has been used **0 times** in production quotes. An annual-check plan with a multi-year term is the missing product (numbers in §7.3).

### 2.3 Where the uncertainty actually is

1. **Station spacing** decides the price: 15 ft gives 15 stations on a 2,000 sf home; the `service_product_usage` map still says **1 station per 10 LF** → 23 stations → **$935** install (+53%). Owner confirmed 2026-09-02: Trelona allows **up to 20 ft, 10–15 ft recommended**, so the 15-ft pricing default is inside the recommended band and the usage map is the row to correct. Remaining ruling: whether field practice is 10, 12 or 15 ft on the properties actually quoted.
2. **Monitoring economics**: with the owner's real cartridge prices (§7.1) the quarterly line is **negative to thin**, not "negative at every tier": at 15 stations, 4 checks/yr cost $222 of labor by the engine's own minutes (5 min/station + 20 min drive at $35) before any cartridge, against $288/yr collected. It turns positive only if cartridge replacement is well under 100%/yr or checks move to annual. Either monitoring is a loss-leader paid for by the install (then the rental offer, which removes the install, needs its own economics) or the cadence is wrong for the product. Owner decision — §7.3 has the annual-check scenarios.
3. **Cartridges** (corrected 2026-09-02, again 2026-09-03): Trelona Compressed Termite Bait costs **$10.70/cartridge** in 6-packs ($64.17), **$6.83** in 25-packs ($170.75) or **$6.70** by the case (4 × 25, $670.00). Each Annual station holds **two** cartridges (BASF FAQ: replace a cartridge when more than 1/3 of its matrix is consumed or missing), so 15 stations carry 30; full annual replacement is **$205–$321/yr** and a third is **$68–$107/yr** — not the $360 of the first draft (that was the station box) and not the $102–$160 of the second draft (which assumed one cartridge per station). Cartridges are still in no price. UNKNOWN: the actual replacement rate per inspection; Adam's field data decides it.
4. **Bond and rental** are riders with clean math; nothing to fix.

Recommendation for the quote (revised): build an **annual-check Trelona plan** priced against the $225–$275/yr local benchmark, with a minimum term that recovers the stations (§7.3), and show it beside the own-and-install option and the 5-yr bond. That matches the competitor's shape (one annual price, one visit) without matching a loss. Quarterly monitoring stays only if a customer wants it and it is priced to cover four visits. Then correct the usage-map spacing row, put cartridges into the cost basis, and reprice monitoring so each line stands on its own.

---

## 3. Recurring lawn

### 3.1 Price vs market

| Waves 9x St. Augustine | $/app | $/yr | Published comparison |
|---|---|---|---|
| 2,000 sf | $42.67 | $384 | TruGreen Sarasota basic from **$449/yr** (0–2,000 sf); TruComplete from **$544/yr**; Bradenton from **$427/yr** |
| 2,500 sf | $56.00 | $504 | (live quote in production) |
| 4,500 sf | $64.00 | $576 | Florida fertilization guides: **$80–$185 per application** for 5,000 sf |
| 8,000 sf | $89.33 | $804 | — |

Waves is **below** the published competitor range at every size. The lawn line's problem is not that it is too expensive; the audit's finding is that it is priced under its own cost floor (30.7% modeled margin at 4,500 sf before any WaveGuard discount).

### 3.2 Protocol vs price — the clarity gap

The St. Augustine protocol (`server/config/protocols.json`, v4) is a **12-month calendar**. Its tier flags define which months each program gets:

| Protocol tier flag | Months flagged | Visits | What that means for the sold program |
|---|---|---|---|
| bronze | Jan, Mar, Jul, Aug, Oct, Dec | 6 | the sold **6-application** program; Aug is "drive-by scout (no product)" and Dec is "optional touchpoint" → **4 product visits** out of 6 |
| silver | Jan, Mar, Apr, Jun, Aug, Sep, Oct, Dec | 8 | **owner 2026-09-02: the sold 9-application program is this 8-visit calendar** ("it's 6/9/12 applications, 6/8/12 visits") — one visit carries two applications; which one is UNKNOWN |
| enhanced | all 12 | 12 | **what the code uses for the 9x budget** — `server/tests/waveguard-pricing-exposure.test.js:15-19` maps sold `enhanced` → protocol flag `enhanced` (12 months), not `silver` (8) |
| premium | all 12 | 12 | sold 12-application program |

So the 9x program is defined in the protocol (8 visits, silver flag) but the pricing side derived its 9x material budget and its accepted margin-exposure ledger from the 12-month `enhanced` flag. The per-visit `material_cost` in the JSON is the top-tier product list (Premium-only products included), so summing flagged visits gives $190/yr for bronze, $229 for silver and $365 for the 12-month flags, while the pricing budgets are **$103 (6x) / $182 (9x) / $225 (12x)** at 4,500 sf. The budgets cannot be re-derived from the protocol as written; they were hand-derived once (2026-07-16) and are not checked by any test or sweep. **New finding LAWN-CAL-001 (P2):** the 9x material budget and the exposure test point at the wrong protocol calendar; re-derive 9x from the silver flag and state which visit carries the ninth application.

The protocol's labor line is **$26.96 per visit** (= 46 min at $35), which is also the dead literal in `service-pricing.js:2113`; the cost floor that actually reports margin uses **12 + 2.5 min/1,000 sf + 5 min drive** (≈ 28 min at 4,500 sf). Two labor assumptions for the same visit, neither validated (see §0).

The structured operating layer (`lawn_protocols` / windows / products, 2026.05) is the better source: 12 windows with carrier volume (1 gal/1,000 routine, 2 gal insecticide/fungicide/hydretain, 3 gal heavy soil), 141 product rows with rate + unit, but **18 rows without a rate** (the nutrition lines carry a target lb N/1,000 instead of a product rate) and 6 unlinked products. It has no cost figures and no tier/visit mapping.

### 3.3 What to decide, in order

1. **Define the 9x calendar** (and confirm the 6x one): which 9 of the 12 windows a 9x customer gets, and whether Aug scout / Dec touchpoint count as paid applications on the 6x program.
2. Give every nutrition window a product and a rate (the 18 blanks), so material per visit can be priced from the catalog instead of a hand-typed budget.
3. Pick one labor assumption per visit and measure it (see §0).
4. Re-derive `LAWN_MATERIAL_BUDGETS` from the operating layer × catalog cost per window and pin it with a test; then decide the price grid against a real 35% floor. Today's grid is below competitors and below the floor at the same time, which suggests the floor inputs, not the grid, are what to fix first.

---

## 4. Tree & shrub

### 4.1 What "palm count" and "bedding area" mean today (code) vs in the protocol

| Term | Pricing engine (what it does with the number) | Protocol (2026.06-swfl-tree-shrub-10) | Gap |
|---|---|---|---|
| **Bed area** (`bedArea`) | material $0.055/sf/yr (×0.75 light, ×1.25 9x) and labor bed ÷ 500 min per visit; explicit if typed, else lot × density % (light 10% / moderate 18% / heavy 25%, +5% complex), else 2,000 sf fallback with review | Snapshot 2.5TG **per 1,000 sf of beds** (2.3–4.6 lb by weed pressure) on 4 granular visits; 13-0-13 per 1,000 sf; costing basis "average property = 2,000 sf ornamental beds" | consistent unit (bed sf); the gap is **how it is measured** — 4 of 5 production T&S quotes used a fallback or lot guess |
| **Tree count** (`treeCount`, non-palm) | material $4/tree/yr, labor 1.5 min/tree/visit; if absent, density estimate {light 3 / moderate 6 / heavy 10} | no per-tree term; foliar work is **per 100 gal of mix** (Kontos 1.7–3.4 fl oz/100 gal etc.) with a 20-gal-per-application basis | the protocol prices foliar by tank volume, the engine by count — a 20-tree property and a 6-tree property use the same 20 gal in the protocol |
| **Palm count** (`palmCount`) | on the service line: folds into the tree terms ($4/yr + 1.5 min/visit each); at the property level (admin builder): **ignored** (INP-001); routine palm reserve knobs exist but are 0/0 | 8-2-12 palm fertilizer at **1.5 lb per 100 sf of canopy/root zone**, 3 in-window apps, on 4 granular visits; costing basis "400 sf palm canopy/root-zone area"; injections are add-ons only ($35/palm minimum, billed separately) | the protocol prices palms by **root-zone area**, the engine by **count**; $4/palm/yr ≈ 100 sf of root zone at $0.93/lb — so 1 palm ≈ 100 sf is the implicit conversion |

Proposed definitions for the owner to confirm (these are the definitions the numbers already assume, made explicit):

- **Bed area** = square feet of maintained ornamental beds and hedge lines that receive Snapshot, granular fertilizer and foliar PHC: mulched beds, foundation plantings, hedge runs, palm root zones inside beds. Excludes turf, hardscape, pool-cage interior, natural/unmaintained areas. Measured on site or from the satellite bed estimate; the estimate must show the number and its source.
- **Tree count** = non-palm ornamental trees within spray reach that are on the foliar/soil program (crape myrtle, ligustrum, magnolia, citrus, oaks under about 25 ft canopy height). Large shade trees beyond spray reach are not counted; they are injection add-ons.
- **Palm count** = palms on the maintained program that receive 8-2-12 granular and foliar micronutrients (queen, foxtail, sabal, Christmas, pygmy date, etc.), each assumed to carry ~100 sf of root zone. Injections (Palm-Jet, IMA-jet, Propizol) are never inside the T&S price.

### 4.2 Price sensitivity (standard 6x, easy access, base 2,000 sf beds + 6 trees = $53.08/mo, $637/yr)

| Change | New monthly | Δ per year | Driver |
|---|---|---|---|
| +100 sf bed | $53.92 | +$10 | $5.50 material, ~0 labor |
| +1,000 sf bed | $62.50 | +$113 | $55 material, +2 min/visit |
| +1 tree | $54.75 | +$20 | $4 material, +1.5 min/visit |
| +10 trees | $67.08 | +$168 | — |
| +1 palm (service line) | $54.75 | +$20 | identical to a tree today |
| +10 palms (service line) | $67.08 | +$168 | — |
| +10 palms (admin builder, property level) | $53.08 | **$0** | INP-001 |
| difficult access | $61.08 | +$96 | +15 min/visit |
| light 4x | $39.83 | −$159 | material ×0.75, 4 visits |
| 9x | $70.17 | +$205 | material ×1.25, 9 visits |
| bed from lot (8,000 sf lot, no bed typed) | $47.92 | −$62 | lot × 18% = 1,440 sf |
| no bed, no lot, no trees (fallback) | $45.25 | −$94 | 2,000 sf fallback, 0 trees, review flag |

Every $20/yr per tree or palm and $10/yr per 100 sf is a labor + material amortisation at a 45% admin-inclusive margin. The numbers are internally consistent; what is not settled is the **calendar** and the **inputs**.

### 4.3 Protocol vs price — the clarity gap

- The T&S protocol is a **12-month calendar**: 10 product months ($139.73 base material at the 2,000 sf / 400 sf / 20 gal basis, plus $126.35 of conditional work), Aug is scout-only, Dec is report-only. The estimator sells **4 / 6 / 9** visits. Correction 2026-09-03: the protocol does define the 4x and 6x month subsets — `tier_4x` = Jan Apr Jul Oct (the four granular Snapshot visits) and `tier_6x` = Jan Mar May Jul Sep Oct — what has no calendar is the un-retired **9x** tier (no `tier_9x` flag, no `nine_x` entry).
- The engine's annual material model ($15 + $4/tree + $0.055/sf; $149 at 2,000 sf + 6 trees) is close to the protocol's 12-month base ($139.73), then charged on **6 visits of labor**. If a 6x customer gets 6 of the 12 months, the material term should be roughly half the 12-month base (or the protocol should say the 6-visit program consolidates the products). This is the single biggest source of the "I don't trust this price" feeling: the material is budgeted for 12 touchpoints and the labor for 6.
- The 9x tier multiplies material by 1.25 for "visits 7–9 lighter foliar apps" — again with no calendar behind it.
- Palms: the protocol wants palm root-zone area; the engine wants a count; the admin tool drops the count.

### 4.4 What to decide, in order

1. Fix the calendar: for each sold cadence (4/6/9) list the months and what happens in them; state whether Aug scout and Dec report are visits or included touches.
2. Confirm the three definitions in §4.1 and make the admin builder collect **bed sf, tree count, palm count, access** explicitly (today it collects bed and trees only, sends palms at the wrong level, and never asks access or tier).
3. Re-derive the material model from the cadence calendar × protocol rates × catalog costs, so a 6x price carries 6 visits of product.
4. Decide palm economics: keep "1 palm = 1 tree = $20/yr" or arm the routine palm reserve with a real per-palm material and minutes value.

---

## 5. One-time services — is it "recurring × multiplier" everywhere? No.

| One-time service | Basis today | Ratio to the recurring per-application price (engine, reference sizes) |
|---|---|---|
| One-time pest | quarterly per-app × **2.2**, floor $199, urgency, 15% recurring-customer perk, strict "> quarterly + $99" clamp | **2.20** at 1,200 / 2,000 / 3,000 sf |
| One-time lawn | recurring per-app × treatment multiplier (fert 1.00 / weed 1.12 / pest 1.30 / fungicide 1.38) × **1.50**, floor $115 | 2,500 sf: 2.05–2.84; 4,500 sf: 1.80–2.48; 8,000 sf: **1.58**–2.18 (the ratio falls with size because the $115 floor lifts small lawns) |
| One-time mosquito | **flat ladder by treatable bucket** ($156 / $177 / $198 / $219 / $251 / $282, +$42 per 10,000 sf over an acre), not derived from the recurring price | 5,000–8,000 sf: 2.03; 12,000: 2.15; 20,000: 2.34; 40,000: **2.54** |
| One-time T&S | **does not exist** (2.2 × the 6x per-app would be ≈ $234 at the reference property) | — |
| One-time rodent bait | does not exist | — |
| Termite treatments (foam, trenching, Bora-Care, pre-slab), German roach, flea, bed bug, stinging, exclusion, sanitation, WDO | cost-plus or flat; no recurring anchor by nature | — |

So: pest is the only line that carries the 2.2× rule cleanly. Lawn drifts from 1.58× to 2.84× depending on size and treatment. Mosquito is a separate table that happens to land near 2.0–2.5×. If the rule is "look at the recurring price and apply one multiplier", the change is: mosquito one-time = seasonal per-visit × 2.2 (which would move the 8,000 sf lot from $156 to $169, and the 40,000 sf lot from $262 down to $227), lawn one-time = 9x per-app × 2.2 (4,500 sf: $141 for every treatment type instead of $115–$159), and T&S/rodent one-time visits defined as 2.2× their per-app. Owner decision: one multiplier everywhere, or keep the treatment-specific lawn multipliers and the mosquito ladder.

---

## 6. Updated decision list for the three lines

1. Termite: field spacing (10/12/15 ft on real quotes), cartridge replacement rate per inspection, an annual-check plan with a term (price point vs Massey $225/$275), whether Waves offers a drywood preventative (no catalog row today), and who answers the waiting Massey customer.
2. Lawn (owner order 2026-09-02): **product rates first** (18 blank nutrition windows + 173/192 products without `cost_per_unit`), then a protocol double-check (9x = silver 8-visit calendar, 6x product months), then one labor assumption, then re-derive budgets and only then the floor and grid.
3. Tree & shrub: a bed-area **measurement protocol** modelled on the tightened lawn measurement, palm count by the Gemini vision tier, editable "estimated palm count" and "estimated bedding area" beside "estimated treatable lawn", the three definitions, the 4/6/9 month calendars and the material-per-cadence rule; fix the admin builder inputs (palms on the service line, access, tier).
4. One-time: tighten to one rule (owner asked 2026-09-02) — pest 2.2× is the candidate; lawn treatment multipliers and the mosquito ladder are the exceptions to resolve.

## 7. Owner inputs 2026-09-02 (evening) — costs, benchmark, rulings

Everything in this section came from Adam on 2026-09-02 after reading §§0–6, plus the supplier app screenshots he attached (agency pricing). Nothing here is field-observed by the auditor; labor minutes are marked ASSUMED.

### 7.1 Real Trelona costs (supplier app, 2026-09-02)

| Item | Pack price | Per unit | In code today | Drift |
|---|---|---|---|---|
| Trelona ATBS Annual Bait Station RFID, 16-count box (pre-baited) | $384.00 | **$24.00/station** | `stationCost 22.05` (`constants.js:1001`, from a $352.80 box) | +$1.95/station; catalog row already says $24.00 |
| Trelona Compressed Termite Bait, 6 cartridges | $64.17 | **$10.70/cartridge** | not in any price | replacements only |
| Trelona Compressed Termite Bait, 25 cartridges | $170.75 | **$6.83/cartridge** | not in any price | best per-unit for a 15-station book |
| Trelona Compressed Termite Bait, case 4 × 25 | $670.00 | **$6.70/cartridge** | not in any price | |

Label facts confirmed by the owner: Trelona stations may be set **up to 20 ft apart, 10–15 ft recommended**. The pricing default (15 ft) is inside the band; the `service_product_usage` row (1 per 10 LF) is not. BASF FAQ (PSS 26-1201, verified 2026-09-03): each Annual station holds **two** bait cartridges (the 16-count box ships with 32), the label allows an annual inspection interval, a cartridge is replaced when more than 1/3 of its matrix is consumed or missing, cartridges stay viable at least five years under typical conditions, and the stations are owned and managed by the pest company.

### 7.2 The Massey benchmark (only local data point)

| Massey (Sentricon, renewal on existing stations) | Price |
|---|---|
| Subterranean coverage, one annual inspection | **$225/yr** |
| Subterranean + drywood coverage | **$275/yr** |
| One-time preventative drywood spray | **$400** |

Waves today for the same 2,000 sf home: $610 install + $72 per quarterly check ($288/yr), or $0 install + $102.50 per quarterly check ($410/yr) on the rental option. Waves has **no drywood preventative row** in the catalog matrix (UNKNOWN whether it is offered ad hoc). The customer is waiting on a Waves answer since 08-27 (owner action, outside the audit).

### 7.3 Corrected cost stacks (15 stations, 2,000 sf) — for the plan, not a price

Assumptions, all ASSUMED until Adam confirms: install labor 120 min; inspection 5 min/station + 20 min drive (the engine's own model, 95 min); $35/hr loaded; cartridges at the 25-pack rate ($6.83) unless noted; stations are pre-baited so year 1 needs no cartridges.

> **Correction 2026-09-03:** the first draft of this table assumed ONE cartridge per station. Each station holds two, so 15 stations carry 30 cartridges: "33% replacement" is 10 cartridges = **$68/yr** ($107 at the 6-pack rate) and 100% is **$205–$321/yr**. The table and the cumulative figures below are regenerated on that basis. The approved plan (`docs/estimator-pricing-plan-2026-09-03.md`) supersedes the $0-install / 36-month shape discussed here with a setup fee + prepaid annual protection.

| Line | Revenue/yr | Materials/yr | Labor/yr | Margin/yr |
|---|---|---|---|---|
| Quarterly monitoring as sold ($24/mo), 0% replacement | $288 | $0 | $222 | +$66 (23%) |
| Quarterly, 33% replacement (10 of 30 cartridges) | $288 | $68 ($107 at 6-pack) | $222 | −$2 to −$41 |
| Quarterly, 100% replacement (30 cartridges) | $288 | $205 ($321 at 6-pack) | $222 | −$139 to −$255 |
| Annual check at Massey's $225, 33% replacement | $225 | $68 ($107) | $55 | +$102 (45%) to +$63 |
| Annual check at $225, 100% replacement | $225 | $205 ($321) | $55 | −$35 to −$151 |
| Annual check at $275, 100% replacement | $275 | $205 ($321) | $55 | +$15 to −$101 |

Install as a separate line at real cost: 15 × ($24.00 + $5.25 + $0.75) × 1.45 = **$653** (vs $610 today); hardware $360 of that (a whole 16-box is $384).

If the install is **absorbed into an annual plan** (Massey's shape for a takeover, since the customer will not pay $610 to leave a $225/yr renewal): sunk year-1 cost ≈ $360 hardware + $70 install labor (ASSUMED) + $55 inspection = $485. At $225/yr with 33% replacement (+$102/yr at the 25-pack rate) the plan is cumulative-negative through year 4 (−$383, −$281, −$179, −$77) and breaks even during year 5; at $275/yr (+$152/yr) it turns positive during year 4. A 3-year minimum term no longer covers the hardware on its own: **a 4–5-year term, a reduced-but-nonzero install fee, or a lower replacement rate** is what makes the annual-check plan stand. These are planning numbers; the plan should let Adam set the labor minutes and replacement rate and see the term fall out.

### 7.4 Rulings and direction from the owner (2026-09-02)

1. **Product rates before the lawn floor.** Fix the product rates (the 18 blank nutrition windows and the catalog `cost_per_unit` gaps) and double-check the protocols first; the lawn cost floor waits until the inputs are real.
2. **Tree & shrub measurement.** Bed areas are measurable now that lawn measurement has been tightened; develop a bed-area measurement protocol on the same footing, and account for palms explicitly. Candidate: have the Gemini vision tier already used for property/lawn imagery count palms (the configured id is in `server/config/models.js`; never hardcode it — import the tier).
3. **Editable overrides.** There is no place to edit palm count the way "estimated treatable lawn" can be edited. Add "estimated palm count" and "estimated bedding area" as the same kind of editable, audited override.
4. **Clear up the T&S calendar mismatch** (12-month protocol with 10 product months sold as 4/6/9 visits with no defined month subset) and **tighten the three definitions** (bed area, non-palm tree count, palm count) in the plan, not by assumption.
5. **Tighten the one-time multiplier** so one rule holds across lines (today only pest is a clean 2.2×).
6. **Continue in a new session** (owner's call, to avoid context compaction). Start from this file, the main report, and the memory note; nothing has been built.

Sources (market ranges): [Termite Treatment Cost in Florida 2026](https://termitetreatmentprice.com/termite-treatment-cost-florida) · [Sentricon Bait Station Cost 2026](https://termitetreatmentprice.com/sentricon-bait-station-cost) · [Florida Pest Control Cost 2026](https://pestcontrolpricing.com/florida-pest-control-cost/) · [Termite Treatment Cost in Tampa 2026](https://pestcontrolpricing.com/termite-treatment-cost-tampa/) · [All U Need Pest — termite treatment costs](https://alluneedpest.com/blog/termite-treatment-costs-methods-and-effectiveness/) · [TruGreen Sarasota](https://content.trugreen.com/local-lawn-care/florida/sarasota) · [TruGreen Bradenton](https://www.trugreen.com/local-lawn-care/florida/bradenton-municipality) · [Lawn Fertilization Cost in Florida 2026](https://lawnbyseason.com/lawn-fertilization-cost/florida) · [Florida lawn-care pricing 2026](https://theyardquote.com/lawn-care-pricing/florida) · owner supplier app screenshots 2026-09-02 (Trelona ATBS 16-ct $384.00; Trelona Compressed Termite Bait 6-ct $64.17, 25-ct $170.75, 4×25 case $670.00) · customer renewal notice from Massey, 2026-08-26 (portal message thread; no PII reproduced)
