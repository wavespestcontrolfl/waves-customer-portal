# Pricing Engine Regression Baselines — Notes

Captured 2026-04-17 from prod (`https://portal.wavespestcontrol.com`) during v4.3 Session 2.

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

## Governance note

Discovering prod Platinum at 20% instead of the expected 18% is a governance signal: either docs drifted from code, or live admin-UI edits bypassed the changelog. Going forward (post v4.3 ship), every pricing change — including manual admin-UI edits — must land a `pricing_changelog` row with rationale. Session 9's approval-queue-to-pricing-config wiring automates this for cost changes; rule and discount changes made manually still need manual changelog entries.
