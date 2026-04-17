# Pricing Engine Regression Baselines — Notes

Captured 2026-04-17 from prod (`https://portal.wavespestcontrol.com`) during v4.3 Session 2.

Extended 2026-04-17 during Session 3 with two v2 zone-coverage cases (see "Session 3 additions" below).

These baselines are the yardstick for Sessions 3-10. A failing regression test means a real pricing change, NOT a baseline bug — investigate before updating the baseline. Intentional baseline updates require a `pricing_changelog` entry.

---

## Baseline context that differed from the original v4.3 build brief

### Anomaly 1 — Platinum WaveGuard already at 20%, not 18%

`pricing-engine.baseline.json` captures Platinum at `discount: 0.20` (not 0.18 as the original build brief assumed).

Observed in: `edge_large_footprint_5500sf_platinum_bundle`, `platinum_bundle_4_qualifying_services_zone_a`.

**Implication for Session 6:** the "restore Platinum from 18% to 20%" line item is a **no-op** — prod is already there. Other Session 6 work (lawn Enhanced/Premium cap removal, discount engine simplification) still needs to happen.

**Root cause unknown.** Three possibilities, no investigation done:
1. Build brief authored from stale docs.
2. Someone edited `pricing_config` via the admin UI without a code commit or changelog entry.
3. A previous patch updated it and the change wasn't reflected in the doc → brief pipeline.

Current state is the truth; captured as-is.

### Anomaly 2 — v2 termite `tmBait` omits HexPro (`hi`) in prod

`pricing-engine-v2.baseline.json` case `v2_termite_bait_three_systems` captures `results.tmBait = { ai, ti, bmo, pmo }` — no `hi` field. Prod currently emits only Advance + Trelona installs in the lookup flow; HexPro install price is not surfaced.

At the time of capture there was an uncommitted local diff on `server/routes/property-lookup-v2.js` line 1159 adding `hi: tb.hexpro?.install || 0` to the emission. That diff was **reverted** so the baseline matches prod behavior.

**Open question for Session 11 (v2 retirement):** is HexPro omission a bug (the engine computes it at `pricing-engine-v2.js:929-938` but the route drops it during response shaping) or an intentional hide from the lookup flow? Business decision needed before surfacing HexPro install pricing in customer-facing estimates.

---

## Session 3 additions

Added two v2 regression cases to cover zones C and D, which Session 3's drift-prevention work in `pricing-engine-v2.js` (`zoneMultipliers: C=1.12, D=1.20`) would otherwise be untested against. The pre-existing 12 v2 cases all run zone A.

- `v2_zone_c_bimonthly_pest_lawn_treeshrub` — 2000 sqft Charlotte outskirts, PEST+LAWN+TREE_SHRUB. Exercises C=1.12x multiplier on v2's hot path.
- `v2_zone_d_quarterly_pest_bahia` — 2000 sqft far reach, PEST+LAWN. Exercises D=1.20x multiplier.

Baselines captured 2026-04-17 post-Session-3 deploy (`70a3109` hotfix). The pre-existing 12 cases were confirmed byte-identical via `git diff` on the baseline JSON — only the 2 new entries appended.

---

## Session 5 intentional baseline updates (2026-04-17)

Bermuda and Zoysia flat bracket segments at 4K-7K sqft were regenerated using each tier's native 8K→10K scaling rate (Basic $3/K, Standard $4.50/K, Enhanced $7/K). 4K Basic clamped to $32/mo for both grasses (raw $30 regeneration = 33% margin, below 35% floor). Premium tier untouched (already correctly progressive). 8K+ brackets untouched.

Customer impact: zero. No active customer has `lawn_type` set to bermuda or zoysia (verified via prod query pre-deploy). Fix is forward-only.

Cases with updated baselines:
- **v1 regression suite:** none. All 12 cases confirmed byte-identical — none of them exercise Bermuda/Zoysia at 4K-7K derived lawn sqft (Case 2 `zone_b_monthly_pest_bermuda_premium` uses Premium tier which was unchanged; Case 3 `zone_c_bimonthly_pest_zoysia_standard_treeshrub` resolves to a lawn sqft outside 4K-7K).
- **v2 regression suite:** `v2_zone_c_bimonthly_pest_lawn_treeshrub` — the only v2 case using Zoysia at low-sqft (2000 home × 10000 lot, 5000 estimatedTurfSf). Lawn tier prices dropped from `[40, 50, 60, 75]` to `[32, 44, 55, 75]` (Basic, Standard, Enhanced, Premium). Monthly recurring total dropped $134.97 → $130.72 (−$4.25/mo; Gold 15% discount applied to Zone C 1.12× multiplied total). All deltas trace to the regenerated Zoysia 4K-knot values. All other 13 v2 cases byte-identical.

See pricing_changelog id=5 for full rationale.

---

## Session 6 intentional baseline updates (2026-04-17)

Discount engine rewritten from stacked/capped to single-source. Four cases in the v1 suite drifted — all explained, all intentional, all documented in pricing_changelog id=6.

### The larger story: frequency-stack double-count

Pre-Session-6 `estimate-engine.js` passed `frequencyDiscount: 1 - item.freqMult` into `getEffectiveDiscount()`, where it was stacked multiplicatively onto the WaveGuard tier:

```js
discountStack = 1 - (1 - discountStack) * (1 - frequencyDiscount);
```

But `freqMult` is already baked into the per-visit price (`perApp = basePrice * freqMult`), which rolls up into `annual`. The "frequency discount" in the stack was double-counting the bulk benefit — customers on monthly/bimonthly pest were effectively getting the frequency reduction twice. Session 6 removes this. It's strictly a correctness fix, not a policy change.

Affected pest frequencies (v1 multipliers):
- `quarterly` — freqMult 1.00, stack contribution 0% → no behavior change
- `bimonthly` — freqMult 0.92, stack contribution 8% → small price ↑ post-fix
- `monthly` — freqMult 0.85, stack contribution 15% → larger price ↑ post-fix

The composite cap (0.25) was NOT engaging in any regression case — it was effectively dead code. The real behavioral change is the frequency-stack removal.

### Per-case diffs

| Case # | Name | Tier | Old total | New total | Δ | Cause |
|---|---|---|---|---|---|---|
| 2 | `zone_b_monthly_pest_bermuda_premium` | Silver | $2,161.53 | $2,358.90 | **+$197.37** | Monthly-pest frequency double-count removed. Pest line went from effective 23.5% to 10% (`1 − 0.9·0.85 = 0.235` → `0.10`). Cap not engaged. |
| 3 | `zone_c_bimonthly_pest_zoysia_standard_treeshrub` | Gold | $3,679.89 | $3,731.50 | **+$51.61** | Bimonthly-pest frequency double-count removed. Pest line went from effective 21.8% to 15% (`1 − 0.85·0.92 = 0.218` → `0.15`). Cap not engaged. |
| 6 | `edge_large_footprint_5500sf_platinum_bundle` | Platinum | $8,722.00 | $8,732.80 | **+$10.80** | Compound: Platinum 18→20 pushes total ↓; monthly-pest frequency removal pushes ↑; lawn-Enhanced cap removal pushes ↓. Frequency removal dominates slightly. |
| 9 | `platinum_bundle_4_qualifying_services_zone_a` | Platinum | $2,856.40 | $2,821.60 | **−$34.80** | Platinum 18→20 + lawn-Enhanced cap removed. Lawn Enhanced now gets the full 20% (was capped at 15%). Quarterly pest → no frequency-stack effect. |

### Math reconciliation for Cases 2 and 3

Line items (pre-discount annuals) are byte-identical pre/post Session 6 — pricing layer unchanged. Diffs live entirely in the discount application layer.

Case 2 (Silver monthly): `1462·(1−x) + 1159·0.90 = 2161.53` ⇒ `x = 0.2350`. Matches old stack exactly: `1 − (1−0.10)(1−0.15) = 0.235`. New code: `0.10` flat.

Case 3 (Gold bimonthly): `759·(1−x) + (712+2919)·0.85 = 3679.89` ⇒ `x = 0.2180`. Matches old stack exactly: `1 − (1−0.15)(1−0.08) = 0.218`. New code: `0.15` flat.

### Customer impact (estimated, not precise)

Intelligence Bar tools don't surface `scheduled_services.recurring_pattern`, so exact count requires psql-direct — skipped as precision wouldn't change the decision.

Tool-visible counts: 692 total active records, but only 5 have any WaveGuard tier and only 3 have any pest service history populated. Vast majority are untagged Square imports — they'll see the new prices on their next re-quote, not a change from existing billing.

Best estimate: ~20 real recurring pest customers potentially affected by the frequency-stack removal, at ~$50–$200/year price increase each. Aggregate impact **~$3K/year**, probably less. Silver monthly pest is the most-affected segment (~+13% on pest line).

### Cases unaffected

Cases 1, 4, 5, 7, 8, 10, 11, 12, 13 byte-identical pre/post Session 6. All use quarterly pest (freqMult 1.00 → zero stack contribution) or no pest at all, so none exercised the double-count path. Line-item `annual` values are identical across all 13 cases, confirming Session 6 is a pure discount-layer change with no pricing-layer drift.

See pricing_changelog id=6 for the full rationale.

---

## Governance note

Discovering prod Platinum at 20% instead of the expected 18% is a governance signal: either docs drifted from code, or live admin-UI edits bypassed the changelog. Going forward (post v4.3 ship), every pricing change — including manual admin-UI edits — must land a `pricing_changelog` row with rationale. Session 9's approval-queue-to-pricing-config wiring automates this for cost changes; rule and discount changes made manually still need manual changelog entries.
