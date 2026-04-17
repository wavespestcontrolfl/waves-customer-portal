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

**v4.4 note:** Basic and Premier currently price flat despite different COGS models. Refactor will tie monitoring price to cartridge consumption + visit frequency.

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
- **Trench engine divergence:** v1 cap `SPECIALTY.trenching.concretePctCap = 0.60`; v2 cap inline `Math.min(0.50, cp)`. Reconcile during v4.4 consolidation. Also clarify pool-feature composition (currently `poolCage` replaces base to 0.35, `pool` replaces to 0.30, `largeDriveway` adds 0.05 — no "pool deck" feature exists despite pre-session draft references).
- **Bora-Care labor curve:** `laborHrs = min(6, max(2, 1.5 + sqft/1000))`, doubling to `min(10, max(6, 1.5 + sqft/800))` over 4500 sqft. Document or simplify.
- **Pre-slab Termidor full formula:** document labor term (`lhr = min(5, max(1, 0.5 + sqft/1500))`) and discount placement (multiplier applied to rounded post-margin price, not to material cost).
- **`volumeDiscounts` map is dead code:** `SPECIALTY.preSlabTermidor.volumeDiscounts = { '10plus': 0.85, '5plus': 0.90, none: 1.00 }` exists in v1 constants but is unreachable — the only consumer (`service-pricing.js:pricePreSlabTermidor`) is exported but uncalled by v1's estimate-engine, and v2 + client use hardcoded string comparisons (`'10'` / `'5'` / `'NONE'`) rather than the map. Either wire the map into live paths in v4.4 OR delete the map and keep inline string comparisons as canonical. Align key strings (`'10plus'`/`'5plus'`) with UI/live code strings (`'10'`/`'5'`/`'NONE'`) as part of cleanup.

**Vendor cost refreshes:**
- **Trelona station cost:** $24 in code vs $22.05 real SiteOne price — update or wire from `products_catalog.best_price`.
- **Advance station cost:** $14 in code, real vendor price unconfirmed — verify from current SiteOne invoice.
- **Cartridge products:** Trelona cartridge 6-pack ($63.24) and 25-pack ($167.50) not in catalog yet — add in v4.4.

**Structural/model:**
- **Bait station monitoring model:** Basic and Premier flat pricing doesn't reflect real COGS difference. Port to cartridge-based consumption model.
- **COGS wiring:** `service_product_usage` mappings exist for Bora-Care, pre-slab Termidor, foam drill. Session 9 + 10 will surface real material cost in estimates and validate margin floor.
- **v2 retirement (Session 11):** v2 emits termite output differently (`tmBait = { ai, ti, bmo, pmo }`). Either align v2 emission with v1's Advance/Trelona split or retire v2 entirely; either path surfaces install pricing cleanly in lookup estimates.

---

*Audit-verified 2026-04-17 (Session 6 close). All pricing figures in sections 1–3 confirmed against live code via `node -e` simulation.*
