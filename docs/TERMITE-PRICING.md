# Waves Termite Pricing Reference — v4.3 (minimal)

**Scope:** This doc covers two services with fully audit-verified v4.3 pricing (bait station monitoring, foam drill) plus the Termidor SC material cost correction shipped in Session 6. It is intentionally narrow.

**Deferred to v4.4 termite refactor:** Full pricing formulas for bait station install, trench, Bora-Care, and pre-slab Termidor. The pre-session reference draft had structural inaccuracies on 4 of 6 services (fabricated HexPro system, misdescribed trench add-vs-replace semantics, missing labor terms on Bora-Care and pre-slab). Rather than patch mid-session, full coverage is deferred to the v4.4 refactor reference doc where formulas are being re-derived alongside the code changes.

**Source of truth:** `server/services/pricing-engine/constants.js` (TERMITE + SPECIALTY.foamDrill blocks) + v2 equivalents in `server/services/pricing-engine-v2.js`.

---

## 1. Bait station monitoring (recurring monthly)

Flat monthly rate regardless of footprint, system, or station count.

| Tier | Monthly | Annual |
|------|---------|--------|
| Basic | $35 | $420 |
| Premier | $65 | $780 |

**WaveGuard qualification:** bait station monitoring is one of five qualifying services for WaveGuard tier discount (`lawn`, `pest`, `treeShrub`, `mosquito`, `termiteBait`). Tier discount applies to the monthly rate for recurring customers.

**Superseded 2026-07-28:** the flat Basic/Premier tiers above are RETIRED. Station checks price by 5-station bracket — `$19/mo + $5 × max(0, ceil(stations / 5) − 2)` (≤10 → $19 · 11-15 → $24 · 16-20 → $29 …), billed per application (monthly × 12 ÷ 4). Since 2026-09-09 the termite line also carries a report-only `costs` block (service labor, cartridge replacement, follow-up reserve) so the margin on this bracket is computed against real consumables; the annual-plan product that reprices monitoring is PR A2 of `docs/estimator-pricing-plan-2026-09-03.md`.

---

## 2. Foam drill (one-time, spot termite treatment)

Tier-based by infestation scope (points = detection activity indicators).

| Tier | Max points | Cans | Labor hours | Label |
|------|-----------|------|------------|-------|
| Spot | 5 | 1 | 1.0 | Spot |
| Moderate | 10 | 2 | 1.5 | Moderate |
| Extensive | 15 | 3 | 2.0 | Extensive |
| Full Perimeter | 20 | 4 | 3.0 | Full Perimeter |

**Constants:**
- Can cost: $39.08 (Termidor Foam, 21 oz)
- Drill bits cost: $8
- Labor rate: $35/hr
- Floor: $250
- Margin divisor: 0.45 → 55% target margin

**Formula:**

```
material_cost = (cans × $39.08) + $8 bits
labor_cost    = labor_hrs × $35
total_cost    = material_cost + labor_cost
price         = max($250 floor, round(total_cost / 0.45))
```

**Worked examples (verified against code):**

Spot tier (1 can, 1.0 hr):
- material_cost = $39.08 + $8 = $47.08
- labor_cost = $35
- total_cost = $82.08
- raw price = $82.08 / 0.45 = $182 → clamped to **$250** (floor)

Moderate tier (2 cans, 1.5 hrs):
- material_cost = 2 × $39.08 + $8 = $86.16
- labor_cost = 1.5 × $35 = $52.50
- total_cost = $138.66
- price = round($138.66 / 0.45) = **$308** (above floor)

---

## 3. Pre-Slab Termidor — material cost correction (v4.3)

Pre-slab Termidor bottle cost updated from $174.72 to $152.10 per current SiteOne invoice. Customer-facing impact: ~8–10% reduction in material cost on new-construction pre-slab quotes.

Full pre-slab pricing formula — including labor calculation, volume-discount bucket logic, and margin divisor application — deferred to the v4.4 termite refactor reference doc. The formula has structural complexity (labor curve varies with slab size, volume discount applies post-margin not pre-material-cost) that warrants careful derivation alongside the v4.4 refactor work.

Updated in three in-sync copies of the constant as part of Session 6:
- `server/services/pricing-engine/constants.js` (v1 modular, `SPECIALTY.preSlabTermidor.bottleCost`)
- `server/services/pricing-engine-v2.js` (v2 inline, `PS_BTL` in `calcPreslab`)
- `client/src/lib/estimateEngine.js` (client mirror)

---

## 4. Services deferred to v4.4 termite refactor

The following services are quoted in production but NOT documented here. The v4.4 refactor reference doc will cover them once the refactor lands:

- **Bait station install** — per-station material + 1.75× margin multiplier formula. Complication: pre-session draft included a fabricated HexPro system ($8.69/station) that does not exist in `TERMITE.systems` — only `advance` ($14) and `trelona` ($24) are in code. Needs product/offering confirmation before documenting.
- **Trench (perimeter liquid barrier)** — per-linear-foot, surface-type weighted. Complications: v1 and v2 engines diverge on the concrete-percentage cap (v1 = 0.60, v2 = 0.50), and the pool-feature composition has replace-vs-add semantics the pre-session draft misdescribed.
- **Bora-Care (attic wood treatment)** — per-gallon with margin divisor. Complications: formula includes a labor curve (variable by attic size, with multi-day split over 4500 sqft) and a min-3-gallons floor that were missing from the pre-session draft.
- **Pre-slab Termidor — full pricing formula** — the bottle-cost correction is in this doc (section 3); the full formula (labor curve, volume-discount placement, margin divisor) is deferred. Volume discount is seller-selected (`'NONE'` / `'5'` / `'10'` builder-contract tier), applied post-margin to price rather than pre-margin to material cost.

---

## Open items for v4.4 termite refactor

**Pricing/code cleanups:**
- **HexPro system:** present in pre-session reference drafts but absent from `TERMITE.systems` constant. Confirm whether HexPro is an offered detection system or was aspirational/removed; add to constants or drop from customer-facing materials accordingly.
- **Trench engine divergence:** v1 cap `SPECIALTY.trenching.concretePctCap = 0.60`; v2 cap inline `Math.min(0.50, cp)`. Reconcile during v4.4 consolidation. Also clarify pool-feature composition (currently `poolCage` replaces base to 0.35, `pool` replaces to 0.30 — no "pool deck" feature exists despite pre-session draft references; the former `largeDriveway` +0.05 was retired estimator-wide 2026-07-30).
- **Bora-Care labor curve:** `laborHrs = min(6, max(2, 1.5 + sqft/1000))`, doubling to `min(10, max(6, 1.5 + sqft/800))` over 4500 sqft. Document or simplify.
- **Pre-slab Termidor full formula:** document labor term (`lhr = min(5, max(1, 0.5 + sqft/1500))`) and discount placement (multiplier applied to rounded post-margin price, not to material cost).
- **`volumeDiscounts` map is dead code:** `SPECIALTY.preSlabTermidor.volumeDiscounts = { '10plus': 0.85, '5plus': 0.90, none: 1.00 }` exists in v1 constants but is unreachable — the only consumer (`service-pricing.js:pricePreSlabTermidor`) is exported but uncalled by v1's estimate-engine, and v2 + client use hardcoded string comparisons (`'10'` / `'5'` / `'NONE'`) rather than the map. Either wire the map into live paths in v4.4 OR delete the map and keep inline string comparisons as canonical. Align key strings (`'10plus'`/`'5plus'`) with UI/live code strings (`'10'`/`'5'`/`'NONE'`) as part of cleanup.

**Vendor cost refreshes:**
- **Trelona station cost:** DONE 2026-09-09 (PR A1 of the 2026-09-03 plan). The engine's fallback is $24.00/station ($384.00 / 16-station box, owner-verified 2026-09-02 — the earlier note had the two figures inverted: $22.05 was the stale April code value, $24 the catalog). In prod the station cost is read from the `products_catalog` row **"Trelona ATBS Bait Station"** (approved vendor best price ÷ units in `container_size`, sanity band [0.5×, 2×]) on every pricing sync; kill switch `pricing_config.termite_install.link_station_costs_to_catalog = false`. The priced line reports `materialCostSource.station` = `catalog` | `config`.
- **Advance station cost:** $13.16 in code (April 2026 wholesale), real vendor price unconfirmed — verify from current SiteOne invoice. Advance is off the menu (replay only).
- **Cartridge products:** the cost model links to the EXISTING catalog row **"Trelona Compressed Termite Bait Cartridges"**. That row currently carries the 16-station box ($384.00, `container_size` "16 cartridges/box") — mislabeled (the 09-02 correction); the link refuses it (unparseable pack label / sanity band) and reports `materialCostSource.cartridge = config` until the owner corrects the row in the inventory UI to the 25-pack ($170.75, `container_size` "25 cartridges"). No `service_product_usage` row is added for cartridges: the usage registry costs `usage_amount` as a fixed per-visit quantity and never scales it by station count, so per-station cartridge economics live only in the engine's cost model. Migration `20260909000001` corrects the station usage note (10 LF → 15 LF) on every legacy Trelona row; no new SKU is seeded. Cartridges are still in NO price — they feed the report-only cost model (`costs.cartridgeReplacementAnnual`: 2 per station × 33% × cartridge cost) until PR A2 prices the annual plan.
- **Annual protection plan (ruling A-1 = P1, 2026-09-11; DARK behind `GATE_TERMITE_ANNUAL_PLAN`):** `priceTermiteBait({ plan: 'annual_protection' })` prices a station **setup** fee (stations × $30, one-time, not tier-discounted — `installation.kind 'setup'`, mapped as "Station Setup") plus an **annual protection** fee ($249 + $50 per 5-station bracket above 10: ≤10 → $249 · 11-15 → $299 · 16-20 → $349; tier-discounted; `visitsPerYear 1`, `perApp` = the annual fee). Rental and the bond rider are retired on the plan; stations stay Waves-owned. DB-tunable via `pricing_config.termite_annual_plan`; the plan constants ride `pricingKnobs` and replay. Converter/prepay acceptance, agreement v3, renewal notices and the surfaces are the later A2 PRs — do not flip the gate before they land and the v3 agreement is signed off (ruling A-11).
- **Replay:** the termite line stamps `pricingKnobs { system, stationCost, stationCostSource }` at quote time (the Admin V1 fallback engine stamps too, off the server's `effective` basis served with `termite_install`); both authoritative replay paths inject it back (`estimate-tree-shrub-knob-replay#termiteKnobSignalForReplay`). A stored line with no stamp is read against its stored install: a row that reproduces at $24.00 replays at $24.00, otherwise the pre-2026-09-09 constant ($22.05) — a sent $610 install never re-prices to $653 on revisit, accept, or the options sheet.

**Structural/model:**
- **Bait station monitoring model:** Basic and Premier flat pricing doesn't reflect real COGS difference. Port to cartridge-based consumption model.
- **COGS wiring:** `service_product_usage` mappings exist for Bora-Care, pre-slab Termidor, foam drill. Session 9 + 10 will surface real material cost in estimates and validate margin floor.
- **v2 retirement (Session 11):** v2 emits termite output differently (`tmBait = { ai, ti, bmo, pmo }`). Either align v2 emission with v1's Advance/Trelona split or retire v2 entirely; either path surfaces install pricing cleanly in lookup estimates.

---

*Audit-verified 2026-04-17 (Session 6 close). All pricing figures in sections 1–3 confirmed against live code via `node -e` simulation.*
