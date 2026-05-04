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

## Session 6 harness hardening — LOCAL mode (2026-04-17)

Regression suites (v1 + v2) gained a LOCAL execution mode alongside the existing HTTP mode. Trigger via `LOCAL=1 npx jest server/tests/pricing-engine.regression.test.js` (or the v2 file).

### Why LOCAL mode exists

HTTP mode exercises the full stack (route → engine → DB) but requires a running server, a valid admin JWT, and prod DB access. When Session 6 shipped the `paymentMethod` hotfix, that fix could not be regression-tested pre-deploy from a clean checkout — the tests only run against a live URL. LOCAL mode closes that gap: engine logic is exercised in-process, with no HTTP round-trip, no server boot, no JWT required. Loader-level bugs (undefined symbols, missing imports, syntax errors in hot paths) are now caught by `jest` directly.

### Architecture

- **v1 suite** — `pricing-engine.regression.test.js`: HTTP mode posts to `/api/admin/pricing/calculate`. LOCAL mode calls `generateEstimate()` from `server/services/pricing-engine/estimate-engine.js` directly, with the same fixtures.
- **v2 suite** — `pricing-engine-v2.regression.test.js`: HTTP mode posts to `/api/lookup/property/calculate-estimate-v2`. LOCAL mode calls `calculateEstimate()` from `server/services/pricing-engine-v2.js` and pipes the result through `mapV2ToLegacyShape()` from `server/services/pricing-engine/v2-legacy-mapper.js`. The mapper was extracted verbatim from `property-lookup-v2.js` during Session 6 to give both modes a shared remap surface.

### v2 legacy mapper extraction — Gate 1 proof

Extraction was behavior-preserving by construction. The 170-line inline remap (previously at `property-lookup-v2.js:1097-1258`) was moved to `server/services/pricing-engine/v2-legacy-mapper.js` with only indentation normalized (4-space nested → 2-space top-level). Byte-equivalence confirmed via `diff -w /tmp/v2-inline-old.js /tmp/v2-helper-new.js` → empty output. No logic reordering, no scope changes, no variable renames.

### Parity between modes

**Structural parity:** proven. LOCAL and HTTP produce envelopes with identical keys, types, and array shapes.

**Numeric parity:** data-state dependent. LOCAL mode reads `pricing_config` from the local DB, which lags prod. Cases touching DB-driven values (zone multipliers, lawn brackets, pest base rates, discount tiers) will diverge numerically in LOCAL runs until a prod-mirror seed script lands. See `project_prod_mirror_local_db.md` memory — tracked as a Session 9 dependency. Until then, treat LOCAL-mode numeric diffs as data-state drift, not engine regressions; use HTTP mode against prod for numeric baseline verification.

### Gate 3 — deliberate-break verification

LOCAL mode catches engine-level bugs that HTTP mode would only surface post-deploy.

**v1 suite:** injected `const _deliberateBreak = intentionallyUndefinedVariable;` at `server/services/pricing-engine/discount-engine.js:41`. `LOCAL=1` jest failed with:

```
ReferenceError: intentionallyUndefinedVariable is not defined
  at server/services/pricing-engine/discount-engine.js:41:28
  at Object.getEffectiveDiscount [as generateEstimate] (server/services/pricing-engine/estimate-engine.js:367:22)
```

**v2 suite:** injected `const _deliberateBreakV2 = intentionallyUndefinedV2Variable;` at `server/services/pricing-engine-v2.js:111`. `LOCAL=1` jest failed with:

```
ReferenceError: intentionallyUndefinedV2Variable is not defined
  at calculateEstimate (server/services/pricing-engine-v2.js:111:30)
  at postCalculateEstimate (server/tests/pricing-engine-v2.regression.test.js:209:16)
```

Both breaks produced file + line + symbol in the error. Both were reverted before committing.

---

## Session 6 — Termidor SC bottleCost correction baseline update (2026-04-17)

Pre-slab Termidor bottle cost corrected from $174.72 to $152.10 per current SiteOne invoice (commit `9a69c74`). Updated in three in-sync copies: `server/services/pricing-engine/constants.js`, `server/services/pricing-engine-v2.js` (inline `PS_BTL`), and `client/src/lib/estimateEngine.js`.

### Regression impact

**v1 suite:** 13/13 byte-identical. No pre-slab fixture in the v1 suite at current scope.

**v2 suite:** one case drifted — `v2_preslab_2000sf_basic_warranty`. Baseline updated from $952 → $852.

### Math reconciliation

Pre-fix: `round((2 × 174.72 + 1.833 × 35 + 15) / 0.45) = round(952.47) = 952`
Post-fix: `round((2 × 152.10 + 1.833 × 35 + 15) / 0.45) = round(852.00) = 852`

Delta: $100 exactly. Math traces through `bottles × (174.72 − 152.10) / 0.45 = 2 × 22.62 / 0.45 = $100.53`, rounded to $100 at the final `Math.round(cost / 0.45)` step. Clean reconciliation — no compounding or discount-layer interaction (case uses volume `'NONE'`, warranty `'BASIC'`).

### Scope

Termidor correction is a **material cost** change, not a rule/policy change. Customer-facing impact: ~8–10% reduction on new-construction pre-slab quotes. See `pricing_changelog` id=6 for full Session 6 rationale (discount engine rewrite is the primary change; Termidor fix shipped alongside).

---

## Session 7 — v1 mosquito constants aligned to v2 (2026-04-17)

Two single-number changes in `server/services/pricing-engine/constants.js` (commit `5e537a8`):
- `MOSQUITO.pressureCap`: `1.80` → `2.0`
- `MOSQUITO.tierVisits.platinum`: `18` → `17`

Both changes close v1/v2 drift discovered during Session 6's scope audit. v2 (Virginia's primary quoting flow) has produced customer-facing prices with `pressureCap=2.0` + `platinum visits=17` all along; v1's "theoretical" values never reached real customers. This aligns v1 to match v2's practical behavior ahead of Session 11's v2 retirement.

### Regression impact

**v1 suite:** 12/13 byte-identical. One case drifted — `mosquito_acre_waterfront_max_pressure`. Baseline updated from `{annual: 6480, monthly: 540}` → `{annual: 6426, monthly: 535.5}`.

**v2 suite:** 14/14 byte-identical. v2 wasn't touched.

### Math reconciliation — `mosquito_acre_waterfront_max_pressure`

Fixture: `{lotSqFt: 50000 → ACRE, trees: 'heavy', complexity: 'complex', nearWater: 'ADJACENT', mosquito: {tier: 'platinum'}}`

| Dimension | Old (v4.2 v1) | New (Session 7 v1) |
|---|---|---|
| Uncapped pressure | 1.89 | 1.89 |
| `pressureCap` | 1.80 | 2.0 |
| Applied pressure | **1.80** (clamped) | **1.89** (uncapped) |
| basePrice (Platinum ACRE) | 200 | 200 |
| perVisit = `round(basePrice × pressure)` | 360 | 378 |
| Platinum visits | **18** | **17** |
| annual = `perVisit × visits` | **6480** | **6426** |
| monthly = `round(annual/12, 2)` | 540.00 | 535.50 |

Both counterfactuals falsified (proves both drifts engaged together):
- visits-only (18→17, cap=1.80): `360 × 17 = 6120` ≠ 6426
- cap-only (1.80→2.0, visits=18): `378 × 18 = 6804` ≠ 6426
- both together: `378 × 17 = 6426` ✓

Net delta: $6480 → $6426 = **−$54 (−0.83%)**.

### Why only Case 7 drifted

The other two v1 mosquito cases neither hit the old cap nor used Platinum visits:
- `edge_large_footprint_5500sf_platinum_bundle` — mosquito at **gold** (visits=15 unchanged). Uncapped pressure ≈ 1.45 (below 1.80). Neither change engaged.
- `platinum_bundle_4_qualifying_services_zone_a` — mosquito at **silver** (visits=12 unchanged). Uncapped pressure = 1.05 (below 1.80). Neither change engaged.

Drift lands exactly where it should: Platinum tier + waterfront + max-pressure fixture. No scope leakage into unrelated cases.

### Scope

v1-only alignment to v2. Customer-facing change: zero (0 Platinum mosquito customers, 2 total mosquito customers; tool-visible 0-3 pattern per Session 6). See `pricing_changelog` id=7 for full Session 7 rationale.

---

## Governance note

Discovering prod Platinum at 20% instead of the expected 18% is a governance signal: either docs drifted from code, or live admin-UI edits bypassed the changelog. Going forward (post v4.3 ship), every pricing change — including manual admin-UI edits — must land a `pricing_changelog` row with rationale. Session 9's approval-queue-to-pricing-config wiring automates this for cost changes; rule and discount changes made manually still need manual changelog entries.

---

## Session 8.5 — `pricing_config` drift reconciliation (2026-04-17)

Interlude between Sessions 8 and 9. Session 9's scoping (approval-queue wire-up) surfaced a divergence between `constants.js` and the `pricing_config` DB rows on 8 config_keys. Full drift audit ran; every drift aligned in the same direction (DB → code); reconciliation landed transactionally via SQL (no code changes). Baselines re-captured against reconciled state. See `pricing_changelog` id=9 for full rationale.

### 8 config_keys reconciled — all DB → code

**Category A** (4 keys / 16 field drifts — attributable to commit `9ddbd01` "Pricing overhaul" updating code without DB sync):

| config_key | Fields changed | Direction |
|---|---|---|
| `pest_features` | `indoor` 10→15, `shrubs_heavy` 5→12, `shrubs_moderate` 0→5, `trees_heavy` 5→12, `trees_moderate` 0→5, `landscape_complex` 5→8 | Higher feature adjustments — prices UP where features present |
| `pest_footprint` | 7 of 8 brackets: 800 −12→−15, 1200 −8→−10, 1500 −4→−5, 2500 4→8, 3000 8→14, 4000 12→21, 5500 16→31 (2000 unchanged) | Flatter small-home discount, steeper large-home premium |
| `pest_frequency` | `v2_monthly` 0.70→0.78, `v2_bimonthly` 0.85→0.88 (v1 values `monthly`/`bimonthly`/`quarterly` unchanged) | Less aggressive v2 bulk discount — prices UP on recurring pest through v2 engine |
| `pest_property_type` | `townhome_interior` −15→−12, `condo_ground` −20→−18, `condo_upper` −25→−22 | Smaller attached-unit discounts — prices UP for those types |

**Category B** (4 keys — business decisions, direction locked by user sign-off during the 8.5 reconciliation):

| config_key | Drift | Decision |
|---|---|---|
| `global_margin_floor` | 0.55 → 0.35 | 35% is the intended policy; 55% was not the operating benchmark. Code comments (`pc.json` notes: "At $89 floor: margin = 53% (above 35% floor)") reference 35% as the working threshold. |
| `global_margin_target_ts` | 0.50 → 0.43 | 43% reflects T&S competitive-market reality. See Observation 1 below — this DB key turned out to be cosmetic. |
| `pest_roach` | `german` 0.40→0.25, `regular` 0.15→0.10 | Less-aggressive roach markup. |
| `waveguard_ach` | `percentage` 0.03 → 0 | Retirement completion. Code comment `// Retired. Kept at 0% so any legacy callers stay harmless.` — DB catches up. |

**Orphan keys not touched:** `pest_features.trees_light` (−5), `pest_features.shrubs_light` (−5) exist in DB but not in `constants.js`. Leaving them alone was the disciplined choice (deletion could break an unexpected reader; retention is benign). Separate cleanup pass if ever needed.

### Per-case diffs

Recurring customer impact in the reconciliation window (Apr 14 → Apr 17): **zero** — Phase 1 audit confirmed 2 estimates (1 quarterly recurring, 1 draft with NULL data), 2 one-time pest invoices (1 voided, 1 $0.91 test), none exercising drifted recurring-pest paths. No re-quote, true-up, or outreach required.

**v1 suite (13 cases):**

| # | Case | Old Y1 | New Y1 | Δ | Why |
|---|---|---|---|---|---|
| 1 | `baseline_single_family_zone_a_quarterly_pest_enhanced_lawn` | $1,048 | $1,084 | **+$36 (+3.4%)** | `pest_features` moderate trees/shrubs 0→5. Quarterly, no freq drift. |
| 2 | `zone_b_monthly_pest_bermuda_premium` | $2,359 | $2,552 | **+$193 (+8.2%)** | Heavy features + 2500 footprint + monthly freq compound. |
| 3 | `zone_c_bimonthly_pest_zoysia_standard_treeshrub` | $3,732 | $3,777 | **+$45 (+1.2%)** | Pest modest bump from moderate features + 3000 footprint + bimonthly freq. T&S $2,919 unchanged (see Observation 1). |
| 4 | `zone_d_quarterly_pest_bahia_basic` | $886 | $886 | **0** | homeSqFt 1800 interpolates 1500↔2000 footprint brackets; bracket delta (<$1/visit) rounds out after Silver. `light` features are orphan DB keys — untouched. |
| 5 | `edge_small_footprint_800sf_quarterly_pest` | $356 | $356 | **0** | Pest floor $89 binds: `117 − 15 (new 800 footprint) − 18 (new condo_ground) = 84`, clamped to 89 — same clamp pre/post. |
| 6 | `edge_large_footprint_5500sf_platinum_bundle` | $8,733 | $8,915 | **+$182 (+2.1%)** | Heavy features + 5500 footprint (+31 vs +16) + monthly freq. |
| 7 | `mosquito_acre_waterfront_max_pressure` | $6,426 | $6,426 | **0** | Mosquito uses `MOSQUITO.pressureFactors`, not `pest_features`. No drift exposure. |
| 8 | `termite_basic_standard_perimeter` | $1,628 | $1,628 | **0** | Termite not in drifted keys. |
| 9 | `platinum_bundle_4_qualifying_services_zone_a` | $2,822 | $2,854 | **+$32 (+1.1%)** | `pest_features` moderate drift; quarterly, no freq drift. |
| 10 | `onetime_pest_urgent_afterhours` | $304 | $330 | **+$26 (+8.6%)** | One-time pest uses recurring per-visit × 1.30 × URGENT (1.50) × afterHours (2.00). Moderate features drift compounds. |
| 11 | `specialty_bora_care_2000sf_attic` | $1,946 | $1,946 | **0** | Bora-Care is specialty, no pest path. |
| 12 | `recurring_customer_onetime_pest_discount` | $152 | $165 | **+$13 (+8.6%)** | Same as #10 mechanics × 0.85 recurring-customer perk. |
| 13 | `baseline_unknown_zone_minimal` | $468 | $508 | **+$40 (+8.5%)** | `pest_features` moderate × UNKNOWN zone 1.05. No WaveGuard discount. |

**v2 suite (14 cases):**

| Case | Old Y1 | New Y1 | Δ | Why |
|---|---|---|---|---|
| `v2_baseline_zone_a_quarterly_pest_lawn` | $1,099.80 | $1,132.20 | **+$32.40 (+2.9%)** | Moderate features drift (v2 engine). |
| `v2_platinum_bundle_4_services_zone_a` | $3,523.00 | $3,574.20 | **+$51.20 (+1.5%)** | Moderate features drift. |
| `v2_boracare_attic_2000sf` | $1,946 | $1,946 | **0** | No pest path. |
| `v2_preslab_2000sf_basic_warranty` | $852 | $852 | **0** | No pest path. |
| `v2_stinging_wasp_ground_tier2` | $250 | $250 | **0** | No pest path. |
| `v2_bedbug_3rooms_both_methods` | $3,351 | $3,351 | **0** | No pest path. |
| `v2_exclusion_moderate_waive_inspection` | $450 | $450 | **0** | No pest path. |
| `v2_onetime_pest_urgent_afterhours` | $300 | $318 | **+$18 (+6.0%)** | One-time pest with drifted features × urgency multiplier. |
| `v2_onetime_pest_recurring_customer` | $128 | $135 | **+$7 (+5.5%)** | One-time pest + moderate features drift. |
| `v2_mosquito_waterfront_heavy_pressure` | $3,780 | $3,780 | **0** | Mosquito engine doesn't read `pest_features`. |
| `v2_termite_bait_three_systems` | $1,733 | $1,733 | **0** | Termite not in drifted keys. |
| `v2_rodent_bait_large_footprint` | $840 | $840 | **0** | Rodent doesn't read `pest_features`. |
| `v2_zone_c_bimonthly_pest_lawn_treeshrub` | $1,667.66 | $1,711.31 | **+$43.65 (+2.6%)** | `pest_frequency.v2_bimonthly` + moderate features drift compound. T&S unchanged (Observation 1). |
| `v2_zone_d_quarterly_pest_bahia` | $1,127.16 | $1,166.04 | **+$38.88 (+3.4%)** | Drift exposure differs from v1 Case 4 — see Observation 2. |

**Direction: 100% code-ward.** Every case that moved moved UP. Every case marked "should be byte-identical" was byte-identical. No wrong-direction drifts, no unexpected changes in safe cases.

### Observation 1 — `global_margin_target_ts` is cosmetic in the DB

T&S was **unchanged** in `zone_c_bimonthly_pest_zoysia_standard_treeshrub` (v1 Case 3, $2,919) and `v2_zone_c_bimonthly_pest_lawn_treeshrub` despite `global_margin_target_ts` drifting from 0.50 to 0.43. The engine reads `TREE_SHRUB.marginTarget` directly from `constants.js` (already 0.43); `db-bridge.js` does not sync the `global_margin_target_ts` row into the in-memory constants.

Implication: the DB value was a dead/cosmetic field. The reconciliation cleaned it up for consistency with future readers but had zero engine-behavior impact. **Future-you: do NOT assume `global_margin_target_ts` is load-bearing.** If you need to change T&S margin target policy, edit `TREE_SHRUB.marginTarget` in `constants.js` — the DB row is a shadow.

### Observation 2 — v1 and v2 engines read pest frequency from different sources

v1 Case 4 (`zone_d_quarterly_pest_bahia_basic`) was unchanged, but `v2_zone_d_quarterly_pest_bahia` moved +$38.88 (+3.4%) despite identical-shape inputs. Not a reconciliation bug — the two engines have genuinely different read paths:

- **v1 engine** reads `PEST.frequencyDiscounts.v1 = { quarterly: 1.00, bimonthly: 0.92, monthly: 0.85 }` from `constants.js`. The DB keys `pest_frequency.{monthly, bimonthly, quarterly}` sync to `.v1` and did NOT drift.
- **v2 engine** reads `PEST.frequencyDiscounts.v2 = { quarterly: 1.00, bimonthly: 0.88, monthly: 0.78 }` from `constants.js`. The DB keys `pest_frequency.{v2_monthly, v2_bimonthly}` sync to `.v2` and DID drift.

Same conceptual value — "frequency discount multiplier" — read from two different config shapes by two different engines. v2 exercises the drifted path for this fixture; v1 does not.

**Resolution: Session 11 (v2 retirement) will consolidate these read paths.** Until then, v1 and v2 can respond differently to identical fixtures on pest-frequency changes. When diagnosing future pest-frequency regressions, check *which* engine is serving the fixture and *which* frequency key it reads.

### Sanity-check gates

**Gate 1 — pre-capture spot-check.** Quoted v1 Case 2 and Case 3 live against prod post-reconciliation/post-redeploy. Both returned code-ward values (+$193 and +$45 respectively) confirming the cache flushed and DB values flowed through. Direction and rough magnitude matched expectations.

**Gate 2 — post-capture diff review.** 27 cases diffed old-vs-new: 16 byte-identical where expected, 11 moving in the code-ward direction, zero wrong-direction moves. Both engines behaved consistently given their respective read paths (Observation 2).

Both gates passed before baselines were committed. "Drift becomes truth" moment gated by discipline, not trust.

### Customer-impact audit

Reconciliation window: 2026-04-14 22:39 → 2026-04-17. Phase 1 queries found:
- 2 estimates total (1 sent Silver quarterly+lawn quote, 1 NULL-data draft)
- 2 pest-touching invoices (1 voided one-time pest, 1 $0.91 test-transaction one-time pest)
- 0 unique customers received a quote priced through a drifted recurring-pest code path
- **$0 in drift-attributable revenue movement in the window**

No customer communication required on reconciliation grounds. Documented per standing "Customer-impact query + sign-off before pricing edits" rule.

### Why this session exists at all

Session 8 shipped rationale comments + TODO(v4.4) markers assuming `constants.js` was the single source of truth. Session 9 scoping surfaced `pricing_config` had drifted from code on 8 keys — 6 of them from commit `9ddbd01` "Pricing overhaul" updating code values without a matching DB UPDATE. Regression baselines captured against this drifted state (Sessions 1-8) were validating the drift, not the intended behavior. Session 8.5 is the cleanup: reconcile DB to code, re-capture baselines against reconciled state, document in changelog id=9. Session 9's approval-queue work resumes against a trustworthy baseline.

See `pricing_changelog` id=9 for the reconciliation SQL + rationale.

---

## 2026-05-04 — Synced pricing baseline refresh + v1 adapter totals fix

Regression baselines were stale against the current DB-synced pricing engine and the v1 adapter totals behavior from commit `8a2c38b` ("Fix estimate pricing engine totals"). Both pricing suites were recaptured in `LOCAL=1` mode after `syncConstantsFromDB()` successfully loaded 57 `pricing_config` rows.

Harness fix: the v1 adapter regression suite now runs the same DB-sync guard as the core pricing regression suite. This prevents adapter local mode from silently validating in-memory constants while the production route uses synced DB pricing. The core suite also now fails loud if `syncConstantsFromDB()` returns `false`.

### Core v1 regression changes

Affected cases:

| Case | Previous | Current | Direction |
|---|---:|---:|---|
| `zone_b_monthly_pest_bermuda_premium` recurring annual | $2,239.87 | $2,168.42 | down |
| `zone_c_bimonthly_pest_zoysia_standard_treeshrub` recurring annual | $3,662.63 | $3,657.78 | down |
| `zone_d_quarterly_pest_bahia_basic` recurring annual | $820.80 | $777.60 | down |
| `edge_large_footprint_5500sf_platinum_bundle` recurring annual | $8,660.80 | $8,583.52 | down |
| `termite_basic_standard_perimeter` year 1 | $1,628 | $1,355 | down |
| `german_roach_modifier_pest_quarterly` recurring annual | $584.20 | $508.00 | down |

Observed causes:

- Pest recurring cases moved with the current DB-synced pest feature/footprint/frequency values.
- Termite basic standard perimeter now captures Advance install at $695 plus $420 annual monitoring, producing $1,355 year 1.
- German roach recurring captures the lower synced roach modifier on pest recurring and includes the initial roach line in year 1.

### v1 adapter regression changes

Affected cases:

| Case | Previous | Current | Direction |
|---|---:|---:|---|
| `v1adapter_platinum_bundle_4_services_zone_a` recurring annual after discount | $3,143.20 | $3,120.80 | down |
| `v1adapter_onetime_pest_urgent_afterhours` one-time total | $330 | $444 | up |
| `v1adapter_onetime_pest_recurring_customer` one-time total | $150 | $199 | up |
| `v1adapter_termite_bait_three_systems` year 1 | $1,733 | $1,115 | down |
| `v1adapter_rodent_bait_large_footprint` recurring annual | $828 | $0 | down in `recurring`, still exposed via `results.rodBaitMo` |

Observed causes:

- `8a2c38b` changed adapter recurring totals to exclude rodent bait and palm injection from the WaveGuard-discounted recurring bucket, while still including them in year 1/year 2 totals.
- Adapter one-time pest now follows the translated v1 engine path with synced pest pricing instead of the stale v2 envelope values.
- `TERMITE_BAIT` adapter translation currently selects Advance, so the legacy envelope captures `tmBait.ai = 695` and `tmBait.ti = 0`.
